import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { installPlugin } from '../scripts/install.mjs';
import { utcNowIso } from './config-store.mjs';
import { readZipBuffer } from './zip.mjs';

export const DEFAULT_REPO = 'PolarPandaC/antigravity-plugin-sync';
export const DEFAULT_BRANCH = 'main';

const ALLOWED_ZIP_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]);

/** Parse a semantic version string (e.g. `v0.3.0-beta.1`). */
export function parseSemver(version) {
  const cleaned = String(version || '').trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Compare two semantic versions: returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }

  const preA = pa.prerelease;
  const preB = pb.prerelease;
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;

  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    if (i >= preA.length) return -1;
    if (i >= preB.length) return 1;
    const x = preA[i];
    const y = preB[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const nx = Number.parseInt(x, 10);
      const ny = Number.parseInt(y, 10);
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** Read installed plugin version from plugin.json (fallback package.json). */
export function getInstalledVersion(pluginRoot) {
  for (const file of ['plugin.json', 'package.json']) {
    const p = join(pluginRoot, file);
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data && typeof data.version === 'string' && data.version.trim()) {
        return data.version.trim();
      }
    } catch {}
  }
  return '0.0.0';
}

async function fetchJsonWithTimeout(url, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      headers: {
        'User-Agent': 'antigravity-plugin-sync',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Check GitHub Releases (with fallback to main branch plugin.json) for a newer version. */
export async function checkForUpdate({
  currentVersion,
  repo = DEFAULT_REPO,
  branch = DEFAULT_BRANCH,
  fetchFn = fetch,
  timeoutMs = 15000,
} = {}) {
  const curVer = String(currentVersion || '0.0.0').trim().replace(/^v/i, '');
  let latestVersion = '';
  let releaseUrl = `https://github.com/${repo}`;
  let releaseNotes = '';
  let publishedAt = null;
  let zipUrl = '';
  let source = '';
  let releaseErr = '';

  const releaseApiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const rel = await fetchJsonWithTimeout(releaseApiUrl, fetchFn, timeoutMs);
    if (rel.ok && rel.json) {
      const tag = String(rel.json.tag_name || rel.json.name || '').trim();
      const parsed = parseSemver(tag);
      if (parsed) {
        latestVersion = tag.replace(/^v/i, '');
        releaseUrl = String(rel.json.html_url || releaseUrl);
        releaseNotes = String(rel.json.body || '').trim();
        publishedAt = rel.json.published_at || null;
        zipUrl = String(
          rel.json.zipball_url || `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.zip`,
        );
        source = 'github_release';
      } else {
        releaseErr = `Release tag format invalid: ${tag || 'empty'}`;
      }
    } else {
      releaseErr = `HTTP ${rel.status}`;
    }
  } catch (err) {
    releaseErr = err.message || String(err);
  }

  if (!source) {
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/plugin.json`;
    try {
      const raw = await fetchJsonWithTimeout(rawUrl, fetchFn, timeoutMs);
      if (raw.ok && raw.json && typeof raw.json.version === 'string') {
        const ver = raw.json.version.trim().replace(/^v/i, '');
        if (parseSemver(ver)) {
          latestVersion = ver;
          releaseUrl = `https://github.com/${repo}`;
          releaseNotes = '';
          publishedAt = null;
          zipUrl = `https://github.com/${repo}/archive/refs/heads/${branch}.zip`;
          source = 'github_main';
        } else {
          throw new Error(`main 分支 plugin.json 版本号无效: ${raw.json.version}`);
        }
      } else {
        throw new Error(`HTTP ${raw.status}`);
      }
    } catch (fallbackErr) {
      const fbMsg = fallbackErr.message || String(fallbackErr);
      throw new Error(`检查更新失败（Releases: ${releaseErr || '不可用'}；main 分支: ${fbMsg}）`);
    }
  }

  const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, curVer) > 0);
  return {
    ok: true,
    checkedAt: utcNowIso(),
    currentVersion: curVer,
    latestVersion,
    hasUpdate,
    source,
    releaseUrl,
    releaseNotes,
    publishedAt,
    zipUrl,
    repo,
  };
}

function isInsideRoot(rootResolved, targetResolved) {
  const rel = relative(rootResolved, targetResolved);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function locateExtractedPluginRoot(extractDir) {
  if (existsSync(join(extractDir, 'plugin.json'))) return extractDir;
  for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractDir, entry.name);
    if (existsSync(join(candidate, 'plugin.json'))) return candidate;
  }
  return null;
}

/** Extract a downloaded GitHub ZIP buffer and install it in place without overwriting user settings. */
export function applyUpdateFromZipBuffer({ zipBuffer, homeDir, installFn = installPlugin }) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plugin-sync-update-'));
  try {
    const extractRoot = resolve(tmpRoot);
    const entries = readZipBuffer(zipBuffer);

    for (const entry of entries) {
      const rawName = entry.name.replace(/\\/g, '/');
      if (!rawName || rawName === './') continue;
      if (rawName.startsWith('/') || rawName.split('/')[0].includes(':')) {
        throw new Error(`Unsafe absolute zip path: ${JSON.stringify(entry.name)}`);
      }
      const dest = resolve(extractRoot, rawName);
      if (!isInsideRoot(extractRoot, dest)) {
        throw new Error(`Zip Slip detected for entry: ${JSON.stringify(entry.name)}`);
      }
      if (entry.isDir || rawName.endsWith('/')) {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
      if (process.platform !== 'win32' && (entry.unixMode & 0o111) !== 0) {
        chmodSync(dest, 0o755);
      }
    }

    const repoRoot = locateExtractedPluginRoot(extractRoot);
    if (!repoRoot || !existsSync(join(repoRoot, 'plugin.json')) || !existsSync(join(repoRoot, 'sidecars', 'plugin-sync', 'main.mjs'))) {
      throw new Error('更新包结构不完整，缺少 plugin.json 或 sidecars/plugin-sync/main.mjs');
    }

    const targetDir = installFn({ sourceRoot: repoRoot, homeDir, enableSidecar: false });
    const installedVersion = getInstalledVersion(targetDir);
    return {
      ok: true,
      targetDir,
      installedVersion,
      requiresRestart: true,
    };
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    } catch {}
  }
}

/** Download a verified GitHub ZIP archive and apply the update in place. */
export async function downloadAndApplyUpdate({
  zipUrl,
  homeDir,
  fetchFn = fetch,
  installFn = installPlugin,
  timeoutMs = 60000,
}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(zipUrl || ''));
  } catch {
    throw new Error('无效的更新包下载地址');
  }
  if (parsedUrl.protocol !== 'https:' || !ALLOWED_ZIP_HOSTS.has(parsedUrl.hostname)) {
    throw new Error(`不允许的更新包来源域名: ${parsedUrl.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(parsedUrl.href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'antigravity-plugin-sync' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`下载更新包失败 (HTTP ${resp.status})`);
    }
    const zipBuffer = Buffer.from(await resp.arrayBuffer());
    return applyUpdateFromZipBuffer({ zipBuffer, homeDir, installFn });
  } finally {
    clearTimeout(timer);
  }
}
