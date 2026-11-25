import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteJson } from '../lib/config-store.mjs';

export const PLUGIN_NAME = 'plugin-sync';

/** Remove installed plugin-sync and optionally purge sync data/trash. */
export function uninstallPlugin(homeDir, { purgeData = false } = {}) {
  const targetDir = join(homeDir, '.gemini', 'config', 'plugins', PLUGIN_NAME);
  let removed = false;
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    removed = true;
  }

  const configPath = join(homeDir, '.gemini', 'config', 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        let changed = false;
        if (cfg.plugins && PLUGIN_NAME in cfg.plugins) {
          delete cfg.plugins[PLUGIN_NAME];
          changed = true;
        }
        const sidecarKey = `${PLUGIN_NAME}/${PLUGIN_NAME}`;
        if (cfg.sidecars && sidecarKey in cfg.sidecars) {
          delete cfg.sidecars[sidecarKey];
          changed = true;
        }
        if (changed) atomicWriteJson(configPath, cfg, { privateFile: true });
      }
    } catch {}
  }

  if (purgeData) {
    const sidecarData = join(homeDir, '.gemini', 'antigravity', 'sidecar_data');
    if (existsSync(sidecarData)) {
      for (const ent of readdirSync(sidecarData, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name.includes(PLUGIN_NAME)) {
          rmSync(join(sidecarData, ent.name), { recursive: true, force: true });
        }
      }
    }
  }
  return removed;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const homeIdx = args.indexOf('--home');
  const homeDir = resolve(homeIdx >= 0 && args[homeIdx + 1] ? args[homeIdx + 1] : homedir());
  const purgeData = args.includes('--purge-data');
  const removed = uninstallPlugin(homeDir, { purgeData });
  console.log(removed ? `已卸载 ${PLUGIN_NAME}` : `未检测到已安装的 ${PLUGIN_NAME}`);
}
