import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getSelfPluginDirName } from './paths.mjs';

export const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
]);

export const DEFAULT_IGNORE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.agy-install.json',
  'credentials.json',
  'token.json',
]);

export const DEFAULT_IGNORE_SUFFIXES = ['.pyc', '.pyo', '.pem', '.key'];

/** Strip JSONC comments and trailing commas while preserving string literals. */
export function stripJsonc(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\r' && text[i] !== '\n') i++;
      i--;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }

  let result = '';
  inString = false;
  escape = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inString) {
      result += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && ' \t\r\n'.includes(out[k])) k++;
      if (k < out.length && (out[k] === '}' || out[k] === ']')) continue;
    }
    result += ch;
  }
  return result;
}

/** Return true if a relative POSIX path inside a plugin should be ignored. */
export function shouldIgnoreRelpath(relPosix, excludeNodeModules = true) {
  const parts = relPosix.split('/').filter((p) => p && p !== '.');
  if (parts.length === 0) return true;
  const dirParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1];

  for (const part of dirParts) {
    if (DEFAULT_IGNORE_DIRS.has(part)) return true;
    if (excludeNodeModules && part === 'node_modules') return true;
  }
  if (DEFAULT_IGNORE_FILES.has(filename)) return true;
  if (excludeNodeModules && filename === 'node_modules') return true;
  if (DEFAULT_IGNORE_SUFFIXES.some((s) => filename.endsWith(s))) return true;
  if (filename === '.env' || filename.startsWith('.env.')) return true;
  return false;
}

/** Read `.antigravity-plugin/plugin.json` or `plugin.json` (JSONC supported). */
export function readPluginManifest(pluginDir) {
  const candidates = [
    join(pluginDir, '.antigravity-plugin', 'plugin.json'),
    join(pluginDir, 'plugin.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(stripJsonc(readFileSync(candidate, 'utf8')));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** Return sorted list of `{ absPath, relPosix }` for non-ignored files inside `pluginDir`. */
export function iterPluginFiles(pluginDir, excludeNodeModules = true) {
  const files = [];
  if (!existsSync(pluginDir)) return files;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      const absPath = join(dir, ent.name);
      let lst;
      try {
        lst = lstatSync(absPath);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
        if (excludeNodeModules && ent.name === 'node_modules') continue;
        walk(absPath);
      } else if (lst.isFile()) {
        const relPosix = relative(pluginDir, absPath).split('\\').join('/');
        if (!shouldIgnoreRelpath(relPosix, excludeNodeModules)) {
          files.push({ absPath, relPosix });
        }
      }
    }
  }

  walk(pluginDir);
  files.sort((a, b) => (a.relPosix < b.relPosix ? -1 : a.relPosix > b.relPosix ? 1 : 0));
  return files;
}

/** Compute deterministic SHA-256 hash over relative POSIX paths and file contents. */
export function computePluginHash(pluginDir, excludeNodeModules = true) {
  const hasher = createHash('sha256');
  for (const { absPath, relPosix } of iterPluginFiles(pluginDir, excludeNodeModules)) {
    hasher.update(Buffer.from(relPosix, 'utf8'));
    hasher.update(Buffer.from([0]));
    hasher.update(readFileSync(absPath));
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest('hex');
}

function latestMtimeMs(pluginDir, files) {
  let latest = 0;
  try {
    latest = statSync(pluginDir).mtimeMs;
  } catch {}
  for (const f of files) {
    try {
      const mt = statSync(f.absPath).mtimeMs;
      if (mt > latest) latest = mt;
    } catch {}
  }
  return latest / 1000;
}

/** Scan `<home>/.gemini/config/plugins` one level deep for installed plugins. */
export function scanLocalPlugins(pluginsDir, { excludeNodeModules = true, selfDirName } = {}) {
  const results = {};
  if (!existsSync(pluginsDir)) return results;

  const selfName = selfDirName || getSelfPluginDirName();
  const entries = readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;

    const entryPath = join(pluginsDir, ent.name);
    const manifest = readPluginManifest(entryPath);
    const files = iterPluginFiles(entryPath, excludeNodeModules);
    let totalBytes = 0;
    for (const f of files) {
      try {
        totalBytes += statSync(f.absPath).size;
      } catch {}
    }

    const contentHash = computePluginHash(entryPath, excludeNodeModules);
    const dirName = ent.name;
    const pluginName = String(manifest.name || dirName);
    const displayName = String(manifest.displayName || pluginName);
    const version = String(manifest.version || '');
    const description = String(manifest.description || '');
    const isSelf = dirName === selfName || pluginName === 'plugin-sync';

    results[dirName] = {
      dirName,
      name: pluginName,
      displayName,
      version,
      description,
      contentHash,
      path: entryPath,
      hasPackageJson: existsSync(join(entryPath, 'package.json')),
      fileCount: files.length,
      totalBytes,
      latestMtime: latestMtimeMs(entryPath, files),
      isSelf,
    };
  }
  return results;
}

/** Query Antigravity's local LanguageServerService/GetAllPlugins if available. */
export async function queryLsPlugins(timeoutMs = 2000) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  if (!addr) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetAllPlugins`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const payload = await resp.json();
    const rawPlugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
    return rawPlugins
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const pathStr = String(item.path || '');
        const dirName = pathStr ? pathStr.replace(/\/+$/, '').split('/').pop() : String(item.name || '');
        return {
          name: item.name || dirName,
          displayName: item.displayName || item.name || dirName,
          dirName,
          disabled: Boolean(item.disabled),
          isGlobal: Boolean(item.isGlobal),
          isBuiltin: Boolean(item.isBuiltin) || pathStr.includes('/builtin/plugins/'),
          version: String(item.version || ''),
          description: String(item.description || ''),
        };
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function findAgyCli() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['agy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function sanitizeArchiveName(dirName, contentHash) {
  const safeDir = String(dirName).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safeDir}--${String(contentHash).slice(0, 12)}.zip`;
}
