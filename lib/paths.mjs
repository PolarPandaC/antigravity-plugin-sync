import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Return the user home directory or an explicit override path. */
export function getHomeDir(override) {
  if (override) return resolve(String(override));
  if (process.env.PLUGIN_SYNC_HOME) return resolve(process.env.PLUGIN_SYNC_HOME);
  return resolve(homedir());
}

/** Return `<home>/.gemini/config/plugins` and ensure it exists. */
export function getPluginsDir(home) {
  const base = home ? resolve(home) : getHomeDir();
  const pluginsDir = join(base, '.gemini', 'config', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  return pluginsDir;
}

/** Return the directory name of this plugin (defaults to `plugin-sync`). */
export function getSelfPluginDirName() {
  const pluginRoot = resolve(__dirname, '..');
  return basename(pluginRoot) || 'plugin-sync';
}

/** Return the persistent sidecar/plugin data directory and ensure it exists. */
export function getDataDir(override, home) {
  let dataDir;
  if (override) {
    dataDir = resolve(String(override));
  } else if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    dataDir = resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  } else if (process.env.PLUGIN_DATA) {
    dataDir = resolve(process.env.PLUGIN_DATA);
  } else {
    const base = home ? resolve(home) : getHomeDir();
    const selfDir = getSelfPluginDirName();
    dataDir = join(base, '.gemini', 'antigravity', 'sidecar_data', `${selfDir}_plugin-sync`, 'data');
  }
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** Locate Antigravity's `sidecar_sdk/preload.js` if installed locally. */
export function getPreloadJsPath(home) {
  const candidates = [];
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    candidates.push(join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'));
  }
  const base = home ? resolve(home) : getHomeDir();
  candidates.push(join(base, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Restrict file permissions to owner read/write (0600) on POSIX platforms. */
export function ensurePrivateFile(filePath) {
  if (process.platform !== 'win32' && existsSync(filePath)) {
    chmodSync(filePath, 0o600);
  }
}
