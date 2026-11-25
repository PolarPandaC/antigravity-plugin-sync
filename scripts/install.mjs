import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson } from '../lib/config-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_NAME = 'plugin-sync';
const COPY_ITEMS = ['package.json', 'plugin.json', 'assets', 'lib', 'scripts', 'sidecars', 'skills', 'README.md'];

const STALE_PYTHON_FILES = [
  'install.py',
  'uninstall.py',
  'sidecars/plugin-sync/server.py',
  'scripts/__init__.py',
  'scripts/paths.py',
  'scripts/config_store.py',
  'scripts/plugins_scanner.py',
  'scripts/archiver.py',
  'scripts/drive_backend.py',
  'scripts/sync_engine.py',
  'scripts/cli.py',
  'scripts/__pycache__',
];

function cleanStaleFiles(targetDir) {
  for (const rel of STALE_PYTHON_FILES) {
    const p = join(targetDir, rel);
    if (existsSync(p)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
}

/** Install plugin-sync into `<homeDir>/.gemini/config/plugins/plugin-sync`. */
export function installPlugin({ sourceRoot, homeDir, enableSidecar = false }) {
  const pluginsDir = join(homeDir, '.gemini', 'config', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const targetDir = join(pluginsDir, PLUGIN_NAME);
  const stageDir = join(pluginsDir, `.install-tmp-${PLUGIN_NAME}`);

  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  try {
    for (const item of COPY_ITEMS) {
      const src = join(sourceRoot, item);
      if (!existsSync(src)) continue;
      const dst = join(stageDir, item);
      cpSync(src, dst, {
        recursive: true,
        force: true,
        filter: (p) => !p.includes('__pycache__') && !p.endsWith('.pyc') && !p.endsWith('.DS_Store'),
      });
    }

    if (existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(stageDir, targetDir);
      } catch {
        // On Windows, running sidecar holds CWD lock on sidecars/plugin-sync; copy in-place cleanly.
        cpSync(stageDir, targetDir, { recursive: true, force: true });
        rmSync(stageDir, { recursive: true, force: true });
      }
      cleanStaleFiles(targetDir);
    } else {
      try {
        renameSync(stageDir, targetDir);
      } catch {
        cpSync(stageDir, targetDir, { recursive: true, force: true });
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }

  if (enableSidecar) {
    const configPath = join(homeDir, '.gemini', 'config', 'config.json');
    let cfg = {};
    if (existsSync(configPath)) {
      try {
        cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch {}
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
    cfg.plugins = cfg.plugins || {};
    cfg.plugins[PLUGIN_NAME] = { enabled: true };
    cfg.sidecars = cfg.sidecars || {};
    cfg.sidecars[`${PLUGIN_NAME}/${PLUGIN_NAME}`] = { enabled: true };
    atomicWriteJson(configPath, cfg, { privateFile: true });
  }

  return targetDir;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const homeIdx = args.indexOf('--home');
  const homeDir = resolve(homeIdx >= 0 && args[homeIdx + 1] ? args[homeIdx + 1] : homedir());
  const enableSidecar = args.includes('--enable-sidecar');
  const sourceRoot = resolve(__dirname, '..');

  const target = installPlugin({ sourceRoot, homeDir, enableSidecar });
  console.log(`已安装 Plugin Sync 到: ${target}`);
  if (enableSidecar) {
    console.log('已在 config.json 中启用 plugin-sync 与侧边栏 Sidecar。请重启 Antigravity App 生效。');
  } else {
    console.log('请重启 Antigravity 桌面端（或打开 Customizations 开关一次插件）即可加载新版 Sidecar。');
  }
}
