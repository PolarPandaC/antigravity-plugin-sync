import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateFile } from './paths.mjs';

/** Return current UTC timestamp in ISO-8601 format (seconds precision). */
export function utcNowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/** Atomically write JSON data to `filePath` via temp file + renameSync. */
export function atomicWriteJson(filePath, data, { privateFile = false } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: privateFile ? 0o600 : 0o644 });
    let moved = false;
    for (let i = 0; i < 6; i++) {
      try {
        renameSync(tmpPath, filePath);
        moved = true;
        break;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || i === 5) throw err;
        sleepSync(50);
      }
    }
    if (!moved) writeFileSync(filePath, content, 'utf8');
    if (privateFile) ensurePrivateFile(filePath);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }
}

/** Read JSON from `filePath`, returning a deep clone of `fallback` on missing/corrupt file. */
export function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) !== Array.isArray(fallback)) {
      return structuredClone(fallback);
    }
    return parsed;
  } catch {
    return structuredClone(fallback);
  }
}

function deepMerge(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

function maskSecret(secret) {
  if (!secret) return '';
  if (secret.length <= 4) return '*'.repeat(secret.length);
  return `****${secret.slice(-4)}`;
}

/** Persistent store for Plugin Sync settings, state, and OAuth tokens. */
export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = String(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.statePath = join(this.dataDir, 'local_state.json');
    this.tokensPath = join(this.dataDir, 'oauth_tokens.json');
    this.backupsDir = join(this.dataDir, 'backups');
    this.trashDir = join(this.dataDir, 'trash');
    this.#ensureInitialized();
  }

  #defaultSettings() {
    return {
      backend: 'none',
      folderName: 'AntigravityPluginSync',
      autoSyncOnStartup: true,
      pollIntervalSec: 60,
      excludePlugins: [],
      excludeNodeModules: true,
      preferAgyCli: false,
      gdrive: { binary: '' },
      oauth: { clientId: '', clientSecret: '' },
      rclone: { binary: 'rclone', remote: '' },
      deviceId: randomUUID(),
      deviceName: hostname() || 'unknown-device',
    };
  }

  #defaultState() {
    return {
      knownPlugins: {},
      ignoredRemoteDeletions: {},
      lastSyncAt: null,
      lastSyncStatus: 'idle',
      lastSyncError: '',
      activityLog: [],
    };
  }

  #ensureInitialized() {
    if (!existsSync(this.settingsPath)) {
      atomicWriteJson(this.settingsPath, this.#defaultSettings(), { privateFile: true });
    } else {
      const current = readJsonFile(this.settingsPath, {});
      const merged = deepMerge(this.#defaultSettings(), current);
      if (!merged.deviceId) merged.deviceId = randomUUID();
      if (!merged.deviceName) merged.deviceName = hostname() || 'unknown-device';
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        atomicWriteJson(this.settingsPath, merged, { privateFile: true });
      }
    }
    if (!existsSync(this.statePath)) {
      atomicWriteJson(this.statePath, this.#defaultState());
    }
  }

  getSettings() {
    const current = readJsonFile(this.settingsPath, {});
    return deepMerge(this.#defaultSettings(), current);
  }

  getPublicSettings() {
    const settings = this.getSettings();
    const oauth = settings.oauth || {};
    const rawSecret = String(oauth.clientSecret || '');
    oauth.hasClientSecret = Boolean(rawSecret);
    oauth.clientSecretMasked = maskSecret(rawSecret);
    oauth.clientSecret = '';
    settings.oauth = oauth;
    return settings;
  }

  updateSettings(patch) {
    const current = this.getSettings();
    const sanitized = structuredClone(patch || {});

    if ('backend' in sanitized) {
      if (!['gdrive', 'oauth', 'rclone', 'none'].includes(sanitized.backend)) {
        throw new Error(`Unsupported backend: ${sanitized.backend}`);
      }
    }
    if ('pollIntervalSec' in sanitized) {
      const val = Number.parseInt(sanitized.pollIntervalSec, 10);
      sanitized.pollIntervalSec = Math.max(15, Math.min(Number.isFinite(val) ? val : 60, 86400));
    }
    if ('folderName' in sanitized) {
      const folder = String(sanitized.folderName || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
      if (!folder || folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') {
        throw new Error('Invalid Google Drive folderName');
      }
      sanitized.folderName = folder;
    }
    if ('excludePlugins' in sanitized) {
      if (!Array.isArray(sanitized.excludePlugins)) {
        throw new Error('excludePlugins must be a list');
      }
      sanitized.excludePlugins = [...new Set(sanitized.excludePlugins.map((x) => String(x).trim()).filter(Boolean))].sort();
    }
    if (sanitized.oauth && typeof sanitized.oauth === 'object') {
      const oauthPatch = sanitized.oauth;
      const clearSecret = Boolean(oauthPatch.clearClientSecret);
      delete oauthPatch.clearClientSecret;
      if (oauthPatch.clientSecret === '' && !clearSecret) {
        delete oauthPatch.clientSecret;
      }
      delete oauthPatch.hasClientSecret;
      delete oauthPatch.clientSecretMasked;
    }

    const merged = deepMerge(current, sanitized);
    atomicWriteJson(this.settingsPath, merged, { privateFile: true });
    return merged;
  }

  getState() {
    const current = readJsonFile(this.statePath, {});
    return deepMerge(this.#defaultState(), current);
  }

  saveState(state) {
    const merged = deepMerge(this.#defaultState(), state);
    if (Array.isArray(merged.activityLog) && merged.activityLog.length > 100) {
      merged.activityLog = merged.activityLog.slice(-100);
    }
    atomicWriteJson(this.statePath, merged);
  }

  appendLog(message, level = 'info') {
    const state = this.getState();
    const entries = Array.isArray(state.activityLog) ? state.activityLog : [];
    entries.push({ ts: utcNowIso(), level, message });
    state.activityLog = entries.slice(-100);
    atomicWriteJson(this.statePath, state);
  }

  getTokens() {
    if (!existsSync(this.tokensPath)) return null;
    const data = readJsonFile(this.tokensPath, {});
    return Object.keys(data).length > 0 ? data : null;
  }

  saveTokens(tokens) {
    atomicWriteJson(this.tokensPath, tokens, { privateFile: true });
  }

  clearTokens() {
    if (existsSync(this.tokensPath)) {
      rmSync(this.tokensPath, { force: true });
    }
  }
}
