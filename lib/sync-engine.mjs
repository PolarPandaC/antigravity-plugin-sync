import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPluginArchive,
  extractPluginArchiveAtomic,
  movePluginToTrash,
  validatePluginDirName,
} from './archiver.mjs';
import { utcNowIso } from './config-store.mjs';
import {
  BackendError,
  buildBackend,
  detectGdriveCli,
  GdriveCliBackend,
} from './drive-backend.mjs';
import {
  queryLsPlugins,
  sanitizeArchiveName,
  scanLocalPlugins,
} from './plugins-scanner.mjs';

function parseIsoTs(val) {
  if (!val) return 0;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function emptyManifest() {
  return {
    schemaVersion: 1,
    updatedAt: utcNowIso(),
    plugins: {},
  };
}

/** Async serialized orchestrator for multi-device plugin sync via Google Drive. */
export class SyncEngine {
  constructor({
    configStore,
    pluginsDir,
    backendFactory = buildBackend,
    lsQueryFn = queryLsPlugins,
    selfDirName,
  }) {
    this.configStore = configStore;
    this.pluginsDir = String(pluginsDir);
    this.backendFactory = backendFactory;
    this.lsQueryFn = lsQueryFn;
    this.selfDirName = selfDirName;
    this._queue = Promise.resolve();
    this._lastRemoteManifest = null;
    this._lastPendingDeletions = [];
    this._gdriveAuthCache = null;
    this._gdriveAuthCacheTs = 0;
  }

  #serialized(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  invalidateAuthCache() {
    this._gdriveAuthCache = null;
    this._gdriveAuthCacheTs = 0;
  }

  #getGdriveAuthCached(binary = '') {
    const now = Date.now() / 1000;
    if (this._gdriveAuthCache && now - this._gdriveAuthCacheTs < 15) {
      return this._gdriveAuthCache;
    }
    const status = new GdriveCliBackend({ binary }).checkAuthStatus();
    this._gdriveAuthCache = status;
    this._gdriveAuthCacheTs = now;
    return status;
  }

  #isExcluded(dirName, localInfo, settings) {
    if (localInfo?.isSelf) return true;
    if (dirName === 'plugin-sync' || (this.selfDirName && dirName === this.selfDirName)) return true;
    return new Set(settings.excludePlugins || []).has(dirName);
  }

  #computePendingDeletions(localPlugins, remoteManifest, state, settings) {
    const known = state.knownPlugins || {};
    const ignoredRemote = state.ignoredRemoteDeletions || {};
    const remotePlugins = remoteManifest?.plugins || {};
    const pending = [];

    const allDirs = [...new Set([...Object.keys(localPlugins), ...Object.keys(remotePlugins), ...Object.keys(known)])].sort();
    for (const dirName of allDirs) {
      const localInfo = localPlugins[dirName];
      if (this.#isExcluded(dirName, localInfo, settings)) continue;

      const remoteInfo = remotePlugins[dirName];
      const knownInfo = known[dirName];

      if (!localInfo && knownInfo && remoteInfo && !remoteInfo.deleted) {
        const label = remoteInfo.displayName || remoteInfo.name || dirName;
        pending.push({
          dirName,
          name: label,
          version: remoteInfo.version || '',
          kind: 'local_deleted',
          message: `本机已删除插件「${label}」，是否同步删除云端记录？`,
          deletedByDevice: settings.deviceName || '本机',
          deletedAt: null,
          updatedAt: remoteInfo.updatedAt || null,
        });
      } else if (
        localInfo &&
        remoteInfo &&
        remoteInfo.deleted &&
        ignoredRemote[dirName] !== remoteInfo.deletedAt
      ) {
        const byDev = remoteInfo.deletedByDevice || '其他设备';
        const label = localInfo.displayName || localInfo.name || dirName;
        pending.push({
          dirName,
          name: label,
          version: localInfo.version || '',
          kind: 'remote_deleted',
          message: `设备「${byDev}」已删除插件「${label}」，是否同步从本机删除？`,
          deletedByDevice: byDev,
          deletedAt: remoteInfo.deletedAt || null,
          updatedAt: remoteInfo.updatedAt || null,
        });
      }
    }
    return pending;
  }

  async syncNow() {
    return this.#serialized(async () => {
      const settings = this.configStore.getSettings();
      const state = this.configStore.getState();
      const excludeNm = Boolean(settings.excludeNodeModules ?? true);
      const deviceName = String(settings.deviceName || 'unknown-device');
      const deviceId = String(settings.deviceId || '');

      const backend = this.backendFactory(this.configStore);
      if (!backend) {
        const localPlugins = scanLocalPlugins(this.pluginsDir, {
          excludeNodeModules: excludeNm,
          selfDirName: this.selfDirName,
        });
        this._lastPendingDeletions = [];
        return {
          ok: false,
          error: '尚未配置 Google Drive 同步后端',
          uploaded: [],
          installed: [],
          updated: [],
          pendingDeletions: [],
          localCount: Object.keys(localPlugins).length,
        };
      }

      try {
        const localPlugins = scanLocalPlugins(this.pluginsDir, {
          excludeNodeModules: excludeNm,
          selfDirName: this.selfDirName,
        });
        let manifest = await backend.readManifest();
        let manifestDirty = false;
        if (!manifest || typeof manifest !== 'object') {
          manifest = emptyManifest();
          manifestDirty = true;
        }
        if (!manifest.plugins || typeof manifest.plugins !== 'object') manifest.plugins = {};
        const remotePlugins = manifest.plugins;
        const knownPlugins = state.knownPlugins || (state.knownPlugins = {});

        const uploaded = [];
        const installed = [];
        const updated = [];

        const allDirs = [...new Set([...Object.keys(localPlugins), ...Object.keys(remotePlugins), ...Object.keys(knownPlugins)])].sort();
        for (const dirName of allDirs) {
          const localInfo = localPlugins[dirName];
          if (this.#isExcluded(dirName, localInfo, settings)) continue;

          const remoteInfo = remotePlugins[dirName];
          const knownInfo = knownPlugins[dirName];

          // 1) Local present, Remote absent -> upload new local plugin
          if (localInfo && !remoteInfo) {
            const archiveName = sanitizeArchiveName(dirName, localInfo.contentHash);
            const archiveBuf = createPluginArchive(localInfo.path, { excludeNodeModules: excludeNm });
            await backend.uploadArchive(archiveName, archiveBuf);
            const now = utcNowIso();
            remotePlugins[dirName] = {
              dirName,
              name: localInfo.name,
              displayName: localInfo.displayName,
              version: localInfo.version,
              description: localInfo.description,
              contentHash: localInfo.contentHash,
              archiveName,
              updatedAt: now,
              updatedByDevice: deviceName,
              updatedByDeviceId: deviceId,
              deleted: false,
              deletedAt: null,
              deletedByDevice: null,
            };
            knownPlugins[dirName] = {
              contentHash: localInfo.contentHash,
              version: localInfo.version,
              name: localInfo.name,
              lastSyncedAt: now,
            };
            manifestDirty = true;
            uploaded.push(dirName);
            this.configStore.appendLog(`已上传新插件 ${dirName} 到 Google Drive`);
            continue;
          }

          // 2) Local absent, Remote active, NOT previously known -> auto-install!
          if (!localInfo && remoteInfo && !remoteInfo.deleted && !knownInfo) {
            const archiveName = remoteInfo.archiveName || sanitizeArchiveName(dirName, remoteInfo.contentHash);
            const archiveBuf = await backend.downloadArchive(archiveName);
            extractPluginArchiveAtomic(archiveBuf, this.pluginsDir, dirName, this.configStore.backupsDir);
            const now = utcNowIso();
            knownPlugins[dirName] = {
              contentHash: remoteInfo.contentHash,
              version: remoteInfo.version || '',
              name: remoteInfo.name || dirName,
              lastSyncedAt: now,
            };
            installed.push(dirName);
            this.configStore.appendLog(`已从 Google Drive 自动同步安装插件 ${dirName}`);
            continue;
          }

          // 3) Local absent, Remote already deleted -> prune local known record
          if (!localInfo && (!remoteInfo || remoteInfo.deleted)) {
            delete knownPlugins[dirName];
            continue;
          }

          // 4) Remote deleted while local present -> handled in pendingDeletions
          if (localInfo && remoteInfo?.deleted) {
            continue;
          }

          // 5) Local deleted while remote active & previously known -> handled in pendingDeletions
          if (!localInfo && remoteInfo && !remoteInfo.deleted && knownInfo) {
            continue;
          }

          // 6) Both present and active -> reconcile hashes
          if (localInfo && remoteInfo && !remoteInfo.deleted) {
            const localHash = localInfo.contentHash;
            const remoteHash = String(remoteInfo.contentHash || '');
            const knownHash = String(knownInfo?.contentHash || '');

            if (localHash === remoteHash) {
              if (!knownInfo || knownHash !== localHash) {
                knownPlugins[dirName] = {
                  contentHash: localHash,
                  version: localInfo.version,
                  name: localInfo.name,
                  lastSyncedAt: utcNowIso(),
                };
              }
              continue;
            }

            let uploadLocal = false;
            let downloadRemote = false;
            if (knownInfo && localHash !== knownHash && remoteHash === knownHash) {
              uploadLocal = true;
            } else if (knownInfo && remoteHash !== knownHash && localHash === knownHash) {
              downloadRemote = true;
            } else {
              const remoteTs = parseIsoTs(remoteInfo.updatedAt);
              const localTs = Number(localInfo.latestMtime || 0);
              if (localTs > remoteTs + 2) {
                uploadLocal = true;
                this.configStore.appendLog(`插件 ${dirName} 双端均有改动，本机较新，已上传覆盖云端`, 'warn');
              } else {
                downloadRemote = true;
                this.configStore.appendLog(`插件 ${dirName} 双端存在差异，云端较新，已备份本地并用云端更新`, 'warn');
              }
            }

            if (uploadLocal) {
              const oldArchive = remoteInfo.archiveName;
              const newArchive = sanitizeArchiveName(dirName, localHash);
              const archiveBuf = createPluginArchive(localInfo.path, { excludeNodeModules: excludeNm });
              await backend.uploadArchive(newArchive, archiveBuf);
              if (oldArchive && oldArchive !== newArchive) {
                try {
                  await backend.deleteArchive(oldArchive);
                } catch {}
              }
              const now = utcNowIso();
              remotePlugins[dirName] = {
                dirName,
                name: localInfo.name,
                displayName: localInfo.displayName,
                version: localInfo.version,
                description: localInfo.description,
                contentHash: localHash,
                archiveName: newArchive,
                updatedAt: now,
                updatedByDevice: deviceName,
                updatedByDeviceId: deviceId,
                deleted: false,
                deletedAt: null,
                deletedByDevice: null,
              };
              knownPlugins[dirName] = {
                contentHash: localHash,
                version: localInfo.version,
                name: localInfo.name,
                lastSyncedAt: now,
              };
              manifestDirty = true;
              updated.push(dirName);
              this.configStore.appendLog(`已上传插件 ${dirName} 的更新到 Google Drive`);
            } else if (downloadRemote) {
              const archiveName = remoteInfo.archiveName || sanitizeArchiveName(dirName, remoteHash);
              const archiveBuf = await backend.downloadArchive(archiveName);
              extractPluginArchiveAtomic(archiveBuf, this.pluginsDir, dirName, this.configStore.backupsDir);
              knownPlugins[dirName] = {
                contentHash: remoteHash,
                version: remoteInfo.version || '',
                name: remoteInfo.name || dirName,
                lastSyncedAt: utcNowIso(),
              };
              updated.push(dirName);
              this.configStore.appendLog(`已更新本机插件 ${dirName}（旧版本已备份）`);
            }
          }
        }

        if (manifestDirty) {
          manifest.updatedAt = utcNowIso();
          await backend.writeManifest(manifest);
        }

        const refreshedLocal = scanLocalPlugins(this.pluginsDir, {
          excludeNodeModules: excludeNm,
          selfDirName: this.selfDirName,
        });
        const pending = this.#computePendingDeletions(refreshedLocal, manifest, state, settings);
        this._lastRemoteManifest = manifest;
        this._lastPendingDeletions = pending;

        state.lastSyncAt = utcNowIso();
        state.lastSyncStatus = 'ok';
        state.lastSyncError = '';
        this.configStore.saveState(state);

        return {
          ok: true,
          uploaded,
          installed,
          updated,
          pendingDeletions: pending,
          localCount: Object.keys(refreshedLocal).length,
        };
      } catch (err) {
        const errMsg = err.message || String(err);
        state.lastSyncAt = utcNowIso();
        state.lastSyncStatus = 'error';
        state.lastSyncError = errMsg;
        this.configStore.saveState(state);
        this.configStore.appendLog(`同步失败: ${errMsg}`, 'error');
        return {
          ok: false,
          error: errMsg,
          uploaded: [],
          installed: [],
          updated: [],
          pendingDeletions: this._lastPendingDeletions,
        };
      }
    });
  }

  async confirmLocalDeletion(dirName) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      const backend = this.backendFactory(this.configStore);
      if (!backend) throw new BackendError('尚未配置 Google Drive 后端');
      const settings = this.configStore.getSettings();
      const state = this.configStore.getState();
      const manifest = (await backend.readManifest()) || emptyManifest();
      if (!manifest.plugins) manifest.plugins = {};
      const entry = manifest.plugins[dirName];
      const now = utcNowIso();
      if (entry) {
        if (entry.archiveName) {
          try {
            await backend.deleteArchive(entry.archiveName);
          } catch {}
        }
        entry.deleted = true;
        entry.deletedAt = now;
        entry.deletedByDevice = settings.deviceName || 'unknown-device';
        entry.updatedAt = now;
      } else {
        manifest.plugins[dirName] = {
          dirName,
          name: dirName,
          deleted: true,
          deletedAt: now,
          deletedByDevice: settings.deviceName || 'unknown-device',
          updatedAt: now,
        };
      }
      manifest.updatedAt = now;
      await backend.writeManifest(manifest);
      this._lastRemoteManifest = manifest;

      delete state.knownPlugins?.[dirName];
      this.configStore.saveState(state);
      this.configStore.appendLog(`已确认同步删除云端插件 ${dirName}`);
      return this.#buildSnapshot();
    });
  }

  async restoreLocalDeletion(dirName) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      const backend = this.backendFactory(this.configStore);
      if (!backend) throw new BackendError('尚未配置 Google Drive 后端');
      const manifest = (await backend.readManifest()) || emptyManifest();
      this._lastRemoteManifest = manifest;
      const entry = manifest.plugins?.[dirName];
      if (!entry || entry.deleted) {
        throw new BackendError(`云端不存在可恢复的插件 ${dirName}`);
      }
      const archiveName = entry.archiveName || sanitizeArchiveName(dirName, entry.contentHash);
      const archiveBuf = await backend.downloadArchive(archiveName);
      extractPluginArchiveAtomic(archiveBuf, this.pluginsDir, dirName, this.configStore.backupsDir);
      const state = this.configStore.getState();
      state.knownPlugins = state.knownPlugins || {};
      state.knownPlugins[dirName] = {
        contentHash: entry.contentHash,
        version: entry.version || '',
        name: entry.name || dirName,
        lastSyncedAt: utcNowIso(),
      };
      this.configStore.saveState(state);
      this.configStore.appendLog(`已从云端恢复插件 ${dirName}`);
      return this.#buildSnapshot();
    });
  }

  async confirmRemoteDeletion(dirName) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      const pluginPath = join(this.pluginsDir, dirName);
      if (existsSync(pluginPath)) {
        movePluginToTrash(this.pluginsDir, dirName, this.configStore.trashDir);
      }
      const state = this.configStore.getState();
      delete state.knownPlugins?.[dirName];
      delete state.ignoredRemoteDeletions?.[dirName];
      this.configStore.saveState(state);
      this.configStore.appendLog(`已同步从本机删除插件 ${dirName}（已移至回收站 trash）`);
      return this.#buildSnapshot();
    });
  }

  async keepLocalIgnoreRemoteDeletion(dirName) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      let manifest = this._lastRemoteManifest;
      if (!manifest) {
        const backend = this.backendFactory(this.configStore);
        manifest = backend ? await backend.readManifest() : null;
      }
      const deletedAt = String(manifest?.plugins?.[dirName]?.deletedAt || utcNowIso());
      const state = this.configStore.getState();
      state.ignoredRemoteDeletions = state.ignoredRemoteDeletions || {};
      state.ignoredRemoteDeletions[dirName] = deletedAt;
      this.configStore.saveState(state);
      this.configStore.appendLog(`已选择仅在本地保留插件 ${dirName}`);
      return this.#buildSnapshot();
    });
  }

  async reuploadDeletedPlugin(dirName) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      const settings = this.configStore.getSettings();
      const excludeNm = Boolean(settings.excludeNodeModules ?? true);
      const localPlugins = scanLocalPlugins(this.pluginsDir, {
        excludeNodeModules: excludeNm,
        selfDirName: this.selfDirName,
      });
      const localInfo = localPlugins[dirName];
      if (!localInfo) throw new BackendError(`本机不存在插件 ${dirName}，无法重新上传`);

      const backend = this.backendFactory(this.configStore);
      if (!backend) throw new BackendError('尚未配置 Google Drive 后端');

      const archiveName = sanitizeArchiveName(dirName, localInfo.contentHash);
      const archiveBuf = createPluginArchive(localInfo.path, { excludeNodeModules: excludeNm });
      await backend.uploadArchive(archiveName, archiveBuf);

      const manifest = (await backend.readManifest()) || emptyManifest();
      const now = utcNowIso();
      manifest.plugins = manifest.plugins || {};
      manifest.plugins[dirName] = {
        dirName,
        name: localInfo.name,
        displayName: localInfo.displayName,
        version: localInfo.version,
        description: localInfo.description,
        contentHash: localInfo.contentHash,
        archiveName,
        updatedAt: now,
        updatedByDevice: settings.deviceName || 'unknown-device',
        updatedByDeviceId: settings.deviceId || '',
        deleted: false,
        deletedAt: null,
        deletedByDevice: null,
      };
      manifest.updatedAt = now;
      await backend.writeManifest(manifest);
      this._lastRemoteManifest = manifest;

      const state = this.configStore.getState();
      state.knownPlugins = state.knownPlugins || {};
      state.knownPlugins[dirName] = {
        contentHash: localInfo.contentHash,
        version: localInfo.version,
        name: localInfo.name,
        lastSyncedAt: now,
      };
      delete state.ignoredRemoteDeletions?.[dirName];
      this.configStore.saveState(state);
      this.configStore.appendLog(`已重新上传插件 ${dirName} 到 Google Drive`);
      return this.#buildSnapshot();
    });
  }

  async setPluginExcluded(dirName, excluded) {
    validatePluginDirName(dirName);
    return this.#serialized(async () => {
      const settings = this.configStore.getSettings();
      const current = new Set(settings.excludePlugins || []);
      if (excluded) current.add(dirName);
      else current.delete(dirName);
      this.configStore.updateSettings({ excludePlugins: [...current].sort() });
      this.configStore.appendLog(`已将插件 ${dirName} ${excluded ? '排除出同步' : '重新加入同步'}`);
      return this.#buildSnapshot();
    });
  }

  async confirmAllPendingDeletions() {
    const snap = await this.getSnapshot();
    for (const item of snap.pendingDeletions || []) {
      if (item.kind === 'local_deleted') {
        await this.confirmLocalDeletion(item.dirName);
      } else if (item.kind === 'remote_deleted') {
        await this.confirmRemoteDeletion(item.dirName);
      }
    }
    return this.getSnapshot();
  }

  async getSnapshot({ refreshRemote = false } = {}) {
    if (refreshRemote) {
      const backend = this.backendFactory(this.configStore);
      if (backend) {
        try {
          this._lastRemoteManifest = await backend.readManifest();
        } catch {}
      }
    }
    return this.#buildSnapshot();
  }

  async #buildSnapshot() {
    const settings = this.configStore.getSettings();
    const publicSettings = this.configStore.getPublicSettings();
    const state = this.configStore.getState();
    const excludeNm = Boolean(settings.excludeNodeModules ?? true);

    const localPlugins = scanLocalPlugins(this.pluginsDir, {
      excludeNodeModules: excludeNm,
      selfDirName: this.selfDirName,
    });
    const remoteManifest = this._lastRemoteManifest;
    const remotePlugins = remoteManifest?.plugins || {};
    const knownPlugins = state.knownPlugins || {};
    const pending = this.#computePendingDeletions(localPlugins, remoteManifest, state, settings);
    this._lastPendingDeletions = pending;
    const pendingByDir = Object.fromEntries(pending.map((p) => [p.dirName, p]));

    const lsPlugins = await this.lsQueryFn();
    const lsByDir = Object.fromEntries(lsPlugins.filter((p) => p.dirName).map((p) => [p.dirName, p]));

    const pluginsList = [];
    const seenDirs = new Set();

    const allDirs = [...new Set([...Object.keys(localPlugins), ...Object.keys(remotePlugins), ...Object.keys(knownPlugins)])].sort();
    for (const dirName of allDirs) {
      const localInfo = localPlugins[dirName];
      const remoteInfo = remotePlugins[dirName];
      const lsInfo = lsByDir[dirName];
      seenDirs.add(dirName);

      const isSelf = Boolean(localInfo?.isSelf) || dirName === 'plugin-sync' || (this.selfDirName && dirName === this.selfDirName);
      const excluded = new Set(settings.excludePlugins || []).has(dirName);
      const pendingItem = pendingByDir[dirName] || null;

      if (!localInfo && !pendingItem && (!remoteInfo || remoteInfo.deleted)) {
        continue;
      }

      let syncStatus;
      if (isSelf) syncStatus = 'self';
      else if (excluded) syncStatus = 'excluded';
      else if (pendingItem) syncStatus = pendingItem.kind;
      else if (localInfo && remoteInfo && !remoteInfo.deleted) {
        syncStatus = localInfo.contentHash === remoteInfo.contentHash ? 'synced' : 'out_of_sync';
      } else if (localInfo && !remoteInfo) syncStatus = 'local_only';
      else if (!localInfo && remoteInfo && !remoteInfo.deleted) syncStatus = 'remote_only';
      else syncStatus = 'local_only';

      const src = localInfo || remoteInfo || lsInfo || {};
      pluginsList.push({
        dirName,
        name: src.name || dirName,
        displayName: src.displayName || src.name || dirName,
        version: src.version || '',
        description: src.description || '',
        installedLocally: Boolean(localInfo),
        inCloud: Boolean(remoteInfo && !remoteInfo.deleted),
        isSelf,
        isBuiltin: false,
        excluded,
        disabled: Boolean(lsInfo?.disabled),
        syncStatus,
        pendingDeletion: pendingItem,
        updatedAt: remoteInfo?.updatedAt || null,
        updatedByDevice: remoteInfo?.updatedByDevice || null,
        fileCount: localInfo?.fileCount || 0,
        totalBytes: localInfo?.totalBytes || 0,
      });
    }

    for (const lsItem of lsPlugins) {
      const dname = lsItem.dirName || '';
      if (!dname || seenDirs.has(dname)) continue;
      if (lsItem.isBuiltin) {
        pluginsList.push({
          dirName: dname,
          name: lsItem.name || dname,
          displayName: lsItem.displayName || lsItem.name || dname,
          version: lsItem.version || '',
          description: lsItem.description || '',
          installedLocally: true,
          inCloud: false,
          isSelf: false,
          isBuiltin: true,
          excluded: true,
          disabled: Boolean(lsItem.disabled),
          syncStatus: 'builtin',
          pendingDeletion: null,
          updatedAt: null,
          updatedByDevice: null,
          fileCount: 0,
          totalBytes: 0,
        });
      }
    }

    const tokens = this.configStore.getTokens();
    const backendKind = settings.backend || 'none';
    const gdriveBin = String(settings.gdrive?.binary || '');
    const gdriveInstalled = Boolean(detectGdriveCli(gdriveBin));
    let connected = false;
    let accountLabel = '未配置同步后端';

    if (backendKind === 'gdrive') {
      if (!gdriveInstalled) {
        accountLabel = '未检测到官方 gdrive 插件';
      } else {
        const gst = this.#getGdriveAuthCached(gdriveBin);
        if (gst.authenticated) {
          connected = true;
          accountLabel = gst.account ? `Google Drive (${gst.account})` : 'Google Drive (官方插件已登录)';
        } else {
          accountLabel = '官方 Google Drive（点击设置一键登录）';
        }
      }
    } else if (backendKind === 'oauth') {
      if (tokens?.access_token) {
        connected = true;
        accountLabel = tokens.account_email || 'Google Drive (OAuth 2.0)';
      } else {
        accountLabel = 'Google Drive OAuth（待登录）';
      }
    } else if (backendKind === 'rclone') {
      const remote = settings.rclone?.remote || '';
      if (remote) {
        connected = true;
        accountLabel = `rclone: ${remote}:`;
      } else {
        accountLabel = 'rclone（待选择远程）';
      }
    }

    return {
      backend: backendKind,
      connected,
      accountLabel,
      gdriveInstalled,
      deviceName: settings.deviceName || '',
      deviceId: settings.deviceId || '',
      lastSyncAt: state.lastSyncAt,
      lastSyncStatus: state.lastSyncStatus || 'idle',
      lastSyncError: state.lastSyncError || '',
      pendingDeletions: pending,
      plugins: pluginsList,
      activityLog: [...(state.activityLog || []).slice(-40)].reverse(),
      settings: publicSettings,
    };
  }
}
