import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { iterPluginFiles } from './plugins-scanner.mjs';
import { createZipBuffer, readZipBuffer } from './zip.mjs';

const SAFE_DIR_RE = /^[A-Za-z0-9._-]+$/;

/** Validate that `dirName` is a single safe directory name without traversal. */
export function validatePluginDirName(dirName) {
  if (!dirName || dirName === '.' || dirName === '..' || dirName.includes('/') || dirName.includes('\\') || !SAFE_DIR_RE.test(dirName)) {
    throw new Error(`Unsafe plugin directory name: ${JSON.stringify(dirName)}`);
  }
  return dirName;
}

/** Pack `pluginDir` into a deterministic in-memory ZIP Buffer. */
export function createPluginArchive(pluginDir, { excludeNodeModules = true } = {}) {
  const files = iterPluginFiles(pluginDir, excludeNodeModules);
  const entries = files.map(({ absPath, relPosix }) => {
    let mode = 0o644;
    try {
      const st = statSync(absPath);
      mode = (st.mode & 0o111) ? 0o755 : 0o644;
    } catch {}
    return {
      name: relPosix,
      data: readFileSync(absPath),
      mode,
    };
  });
  return createZipBuffer(entries);
}

function timestampTag() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
}

function isInsideRoot(rootResolved, targetResolved) {
  const rel = relative(rootResolved, targetResolved);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function moveDir(src, dst) {
  for (let i = 0; i < 8; i++) {
    try {
      renameSync(src, dst);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || i === 7) throw err;
      sleepSync(80);
    }
  }
}

/** Safely extract `archiveBuffer` into `<pluginsDir>/<dirName>` atomically. */
export function extractPluginArchiveAtomic(archiveBuffer, pluginsDir, dirName, backupDir) {
  validatePluginDirName(dirName);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  const stageDir = join(pluginsDir, `.sync-tmp-${dirName}-${randomBytes(4).toString('hex')}`);
  const targetDir = join(pluginsDir, dirName);
  const backupPath = join(backupDir, `${dirName}-${timestampTag()}`);
  const hadExisting = existsSync(targetDir);

  mkdirSync(stageDir, { recursive: false });
  try {
    const stageRoot = resolve(stageDir);
    const entries = readZipBuffer(archiveBuffer);

    for (const entry of entries) {
      const rawName = entry.name.replace(/\\/g, '/');
      if (rawName.startsWith('/') || rawName.split('/')[0].includes(':')) {
        throw new Error(`Unsafe absolute zip path: ${JSON.stringify(entry.name)}`);
      }
      const dest = resolve(stageRoot, rawName);
      if (!isInsideRoot(stageRoot, dest)) {
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

    if (hadExisting) {
      moveDir(targetDir, backupPath);
    }
    moveDir(stageDir, targetDir);
  } catch (err) {
    if (hadExisting && !existsSync(targetDir) && existsSync(backupPath)) {
      try {
        moveDir(backupPath, targetDir);
      } catch {}
    }
    throw err;
  } finally {
    if (existsSync(stageDir)) {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  return targetDir;
}

/** Move `<pluginsDir>/<dirName>` into `<trashDir>/<dirName>-<timestamp>`. */
export function movePluginToTrash(pluginsDir, dirName, trashDir) {
  validatePluginDirName(dirName);
  const targetDir = join(pluginsDir, dirName);
  if (!existsSync(targetDir)) {
    throw new Error(`Plugin directory not found: ${targetDir}`);
  }
  mkdirSync(trashDir, { recursive: true });
  const dest = join(trashDir, `${dirName}-${timestampTag()}`);
  moveDir(targetDir, dest);
  return dest;
}
