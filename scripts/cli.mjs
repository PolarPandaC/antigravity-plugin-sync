import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigStore } from '../lib/config-store.mjs';
import { buildBackend, listRcloneRemotes, OAuthFlowManager } from '../lib/drive-backend.mjs';
import { getDataDir, getHomeDir, getPluginsDir } from '../lib/paths.mjs';
import { SyncEngine } from '../lib/sync-engine.mjs';
import { checkForUpdate, downloadAndApplyUpdate, getInstalledVersion } from '../lib/updater.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printUsage() {
  console.log(`Usage: node scripts/cli.mjs [--home <dir>] [--data-dir <dir>] <command> [options]

Commands:
  status [--json] [--refresh]            Show plugin sync status
  sync [--json]                          Run bidirectional plugin sync now
  push <dir>                             Force push local plugin to Google Drive
  pull <dir>                             Force pull remote plugin from Google Drive
  confirm-delete <dir> [--kind local|remote]
  restore <dir>                          Restore locally deleted plugin from Google Drive
  keep-local <dir>                       Keep local plugin and ignore remote deletion
  reupload <dir>                         Re-upload local plugin deleted remotely
  test-connection                        Test configured Google Drive backend
  list-rclone-remotes                    List detected rclone remotes
  auth-oauth [--no-browser]              Start Google Drive OAuth 2.0 browser sign-in
  check-update [--json]                  Check GitHub for a newer plugin-sync version
  self-update                            Download and apply the latest plugin-sync update`);
}

function parseGlobalFlags(argv) {
  let home;
  let dataDir;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home' && argv[i + 1]) home = argv[++i];
    else if (argv[i] === '--data-dir' && argv[i + 1]) dataDir = argv[++i];
    else rest.push(argv[i]);
  }
  return { home, dataDir, rest };
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    printUsage();
    return 0;
  }

  const { home, dataDir, rest } = parseGlobalFlags(argv);
  const cmd = rest[0];
  if (!cmd) {
    printUsage();
    return 1;
  }

  const resolvedHome = getHomeDir(home);
  const pluginsDir = getPluginsDir(resolvedHome);
  const resolvedDataDir = getDataDir(dataDir, resolvedHome);
  const store = new ConfigStore(resolvedDataDir);
  const engine = new SyncEngine({ configStore: store, pluginsDir });

  if (cmd === 'status') {
    const isJson = rest.includes('--json');
    const refresh = rest.includes('--refresh');
    const snap = await engine.getSnapshot({ refreshRemote: refresh });
    if (isJson) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(`Backend: ${snap.backend} (${snap.accountLabel})`);
      console.log(`Device: ${snap.deviceName} | Last sync: ${snap.lastSyncAt || 'never'}`);
      console.log(`Plugins (${snap.plugins.length}):`);
      for (const item of snap.plugins) {
        console.log(`  - ${item.dirName} [${item.syncStatus}] ${item.version}`);
      }
      if (snap.pendingDeletions.length > 0) {
        console.log('Pending Deletions:');
        for (const p of snap.pendingDeletions) {
          console.log(`  * ${p.dirName} (${p.kind}): ${p.message}`);
        }
      }
    }
    return 0;
  }

  if (cmd === 'sync') {
    const isJson = rest.includes('--json');
    const res = await engine.syncNow();
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      const divergedPart = res.diverged?.length ? `, diverged=${JSON.stringify(res.diverged)}` : '';
      console.log(
        `Sync OK. uploaded=${JSON.stringify(res.uploaded)}, installed=${JSON.stringify(res.installed)}, updated=${JSON.stringify(res.updated)}${divergedPart}, pending_deletions=${res.pendingDeletions.length}`,
      );
    } else {
      console.error(`Sync failed: ${res.error}`);
    }
    return res.ok ? 0 : 1;
  }

  if (cmd === 'push') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    await engine.pushLocalPlugin(dirName);
    console.log(`Pushed local plugin ${dirName} to Google Drive`);
    return 0;
  }

  if (cmd === 'pull') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    await engine.pullRemotePlugin(dirName);
    console.log(`Pulled remote plugin ${dirName} from Google Drive`);
    return 0;
  }

  if (cmd === 'confirm-delete') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    const kindIdx = rest.indexOf('--kind');
    const kind = kindIdx >= 0 && rest[kindIdx + 1] ? rest[kindIdx + 1] : 'local';
    if (kind === 'local') await engine.confirmLocalDeletion(dirName);
    else if (kind === 'remote') await engine.confirmRemoteDeletion(dirName);
    else throw new Error(`Invalid --kind: ${kind}`);
    console.log(`Confirmed ${kind} deletion for ${dirName}`);
    return 0;
  }

  if (cmd === 'restore') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    await engine.restoreLocalDeletion(dirName);
    console.log(`Restored ${dirName} from Google Drive`);
    return 0;
  }

  if (cmd === 'keep-local') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    await engine.keepLocalIgnoreRemoteDeletion(dirName);
    console.log(`Kept local plugin ${dirName}`);
    return 0;
  }

  if (cmd === 'reupload') {
    const dirName = rest[1];
    if (!dirName) throw new Error('Missing plugin directory name');
    await engine.reuploadDeletedPlugin(dirName);
    console.log(`Re-uploaded plugin ${dirName} to Google Drive`);
    return 0;
  }

  if (cmd === 'test-connection') {
    const backend = buildBackend(store);
    if (!backend) {
      console.error('Backend is not configured yet.');
      return 1;
    }
    const res = await backend.testConnection();
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (cmd === 'list-rclone-remotes') {
    const binary = store.getSettings().rclone?.binary || 'rclone';
    console.log(JSON.stringify(listRcloneRemotes(binary), null, 2));
    return 0;
  }

  if (cmd === 'check-update') {
    const isJson = rest.includes('--json');
    const info = await checkForUpdate({ currentVersion: getInstalledVersion(PLUGIN_ROOT) });
    if (isJson) {
      console.log(JSON.stringify(info, null, 2));
    } else if (info.hasUpdate) {
      console.log(`Update available: v${info.currentVersion} -> v${info.latestVersion} (${info.source})\n${info.releaseUrl}`);
    } else {
      console.log(`Already up to date: v${info.currentVersion} (latest: v${info.latestVersion}, source: ${info.source})`);
    }
    return 0;
  }

  if (cmd === 'self-update') {
    const info = await checkForUpdate({ currentVersion: getInstalledVersion(PLUGIN_ROOT) });
    if (!info.hasUpdate) {
      console.log(`Already up to date: v${info.currentVersion}`);
      return 0;
    }
    const res = await downloadAndApplyUpdate({ zipUrl: info.zipUrl, homeDir: resolvedHome });
    console.log(`Updated plugin-sync to v${res.installedVersion}. Please restart Antigravity Desktop App.`);
    return 0;
  }

  if (cmd === 'auth-oauth') {
    const mgr = new OAuthFlowManager(store);
    const info = await mgr.startFlow({ openBrowser: !rest.includes('--no-browser') });
    console.log(`Open this URL in your browser to authorize Google Drive:\n${info.authUrl}`);
    while (true) {
      const st = mgr.getStatus();
      if (st.status === 'success') {
        console.log(`Authorized as ${st.accountEmail || 'Google user'}`);
        return 0;
      }
      if (st.status === 'error') {
        console.error(`Authorization failed: ${st.error}`);
        return 1;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  return 1;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message || String(err));
      process.exitCode = 1;
    });
}
