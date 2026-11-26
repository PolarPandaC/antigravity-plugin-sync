import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPluginArchive, extractPluginArchiveAtomic, movePluginToTrash } from '../lib/archiver.mjs';
import { ConfigStore } from '../lib/config-store.mjs';
import { GdriveCliBackend, GoogleDriveOAuthBackend, RcloneDriveBackend } from '../lib/drive-backend.mjs';
import { computePluginHash, readPluginManifest, scanLocalPlugins } from '../lib/plugins-scanner.mjs';
import { SyncEngine } from '../lib/sync-engine.mjs';
import { applyUpdateFromZipBuffer, checkForUpdate, compareSemver, parseSemver } from '../lib/updater.mjs';
import { createZipBuffer, readZipBuffer } from '../lib/zip.mjs';
import { installPlugin } from '../scripts/install.mjs';
import { uninstallPlugin } from '../scripts/uninstall.mjs';
import { SidecarApp } from '../sidecars/plugin-sync/main.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sync-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

function writePlugin(pluginsDir, dirName, version = '1.0.0', extraFiles = {}) {
  const pdir = join(pluginsDir, dirName);
  mkdirSync(join(pdir, 'skills', 'hello'), { recursive: true });
  writeFileSync(
    join(pdir, 'plugin.json'),
    JSON.stringify({ name: dirName, displayName: dirName, version, description: `Test plugin ${dirName}` }),
    'utf8',
  );
  writeFileSync(join(pdir, 'skills', 'hello', 'SKILL.md'), `# ${dirName} v${version}\n`, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const dest = join(pdir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, 'utf8');
  }
  return pdir;
}

class InMemoryDriveBackend {
  constructor() {
    this.manifest = null;
    this.archives = new Map();
  }
  async testConnection() {
    return { ok: true, account: 'test@gmail.com', detail: 'mock ok' };
  }
  async readManifest() {
    return this.manifest ? structuredClone(this.manifest) : null;
  }
  async writeManifest(manifest) {
    this.manifest = structuredClone(manifest);
  }
  async uploadArchive(name, data) {
    this.archives.set(name, Buffer.from(data));
  }
  async downloadArchive(name) {
    if (!this.archives.has(name)) throw new Error(`Missing archive ${name}`);
    return Buffer.from(this.archives.get(name));
  }
  async deleteArchive(name) {
    this.archives.delete(name);
  }
  async listArchives() {
    return [...this.archives.keys()].sort();
  }
}

test('zip round-trip preserves unicode filenames and unix mode', () => {
  const zipBuf = createZipBuffer([
    { name: 'scripts/run.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
    { name: '文档/说明.txt', data: Buffer.from('你好 Antigravity'), mode: 0o644 },
  ]);
  const entries = readZipBuffer(zipBuf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'scripts/run.sh');
  assert.equal(entries[0].unixMode & 0o111, 0o111);
  assert.equal(entries[1].name, '文档/说明.txt');
  assert.equal(entries[1].data.toString('utf8'), '你好 Antigravity');
});

test('scanner parses JSONC, ignores sensitive/cache files, and hashes deterministically', async () => {
  await withTempDir(async (tmp) => {
    const pluginsDir = join(tmp, 'plugins');
    const pdir = writePlugin(pluginsDir, 'alpha', '1.0.0', {
      '.git/config': 'secret',
      'node_modules/pkg/index.js': 'ignored',
      '.env': 'SECRET=1',
      '.agy-install.json': 'local-only',
      'src/main.mjs': "console.log('ok');\n",
    });
    writeFileSync(join(pdir, 'plugin.json'), '{\n// comment\n"name": "alpha",\n"version": "1.2.3",\n}\n', 'utf8');

    const manifest = readPluginManifest(pdir);
    assert.equal(manifest.name, 'alpha');
    assert.equal(manifest.version, '1.2.3');

    const h1 = computePluginHash(pdir, true);
    writeFileSync(join(pdir, 'node_modules', 'pkg', 'index.js'), 'changed', 'utf8');
    const h2 = computePluginHash(pdir, true);
    assert.equal(h1, h2);

    const scanned = scanLocalPlugins(pluginsDir, { excludeNodeModules: true, selfDirName: 'plugin-sync' });
    assert.ok(scanned.alpha);
    assert.equal(scanned.alpha.fileCount, 3);
  });
});

test('archiver rejects Zip Slip, creates atomic backups, and moves deleted plugins to trash', async () => {
  await withTempDir(async (tmp) => {
    const pluginsDir = join(tmp, 'plugins');
    const backupDir = join(tmp, 'backups');
    const trashDir = join(tmp, 'trash');
    writePlugin(pluginsDir, 'q', '1.0.0');

    const evilZip = createZipBuffer([{ name: '../../evil.txt', data: Buffer.from('pwned') }]);
    assert.throws(() => extractPluginArchiveAtomic(evilZip, pluginsDir, 'q', backupDir), /Zip Slip/);
    assert.ok(existsSync(join(pluginsDir, 'q', 'plugin.json')));

    const v2Src = join(tmp, 'src');
    writePlugin(v2Src, 'q', '2.0.0');
    const arc = createPluginArchive(join(v2Src, 'q'));
    extractPluginArchiveAtomic(arc, pluginsDir, 'q', backupDir);
    assert.equal(readPluginManifest(join(pluginsDir, 'q')).version, '2.0.0');
    assert.equal(readdirSync(backupDir).length, 1);

    const trashed = movePluginToTrash(pluginsDir, 'q', trashDir);
    assert.ok(!existsSync(join(pluginsDir, 'q')));
    assert.ok(existsSync(join(trashed, 'plugin.json')));
  });
});

test('end-to-end multi-device sync, updates, and deletion confirmations', async () => {
  await withTempDir(async (tmp) => {
    const cloud = new InMemoryDriveBackend();
    const makeDevice = (name) => {
      const home = join(tmp, name);
      const pluginsDir = join(home, '.gemini', 'config', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      const store = new ConfigStore(join(home, 'data'));
      store.updateSettings({ backend: 'oauth', deviceName: name, existingPluginPolicy: 'auto_overwrite' });
      return new SyncEngine({
        configStore: store,
        pluginsDir,
        backendFactory: () => cloud,
        lsQueryFn: async () => [],
        selfDirName: 'plugin-sync',
      });
    };

    const devA = makeDevice('device-a');
    const devB = makeDevice('device-b');

    // 1. Device A installs q -> syncs -> Device B auto-installs q (skips self plugin)
    writePlugin(devA.pluginsDir, 'q', '1.0.0');
    writePlugin(devA.pluginsDir, 'plugin-sync', '0.2.0');

    const resA1 = await devA.syncNow();
    assert.equal(resA1.ok, true);
    assert.deepEqual(resA1.uploaded, ['q']);
    assert.equal((await cloud.readManifest()).plugins['plugin-sync'], undefined);

    const resB1 = await devB.syncNow();
    assert.equal(resB1.ok, true);
    assert.deepEqual(resB1.installed, ['q']);
    assert.ok(existsSync(join(devB.pluginsDir, 'q', 'skills', 'hello', 'SKILL.md')));

    // 2. Device A updates q -> Device B updates q
    await new Promise((r) => setTimeout(r, 25));
    writePlugin(devA.pluginsDir, 'q', '1.1.0');
    const resA2 = await devA.syncNow();
    assert.deepEqual(resA2.updated, ['q']);

    const resB2 = await devB.syncNow();
    assert.deepEqual(resB2.updated, ['q']);
    assert.equal(readPluginManifest(join(devB.pluginsDir, 'q')).version, '1.1.0');

    // 3. Device A deletes q -> surfaces local_deleted without touching cloud
    rmSync(join(devA.pluginsDir, 'q'), { recursive: true, force: true });
    const resA3 = await devA.syncNow();
    assert.equal(resA3.pendingDeletions.length, 1);
    assert.equal(resA3.pendingDeletions[0].kind, 'local_deleted');
    assert.equal((await cloud.readManifest()).plugins.q.deleted, false);

    // 3a. Restore from cloud works
    await devA.restoreLocalDeletion('q');
    assert.ok(existsSync(join(devA.pluginsDir, 'q', 'plugin.json')));
    assert.equal((await devA.getSnapshot()).pendingDeletions.length, 0);

    // 3b. Confirm local deletion propagates tombstone
    rmSync(join(devA.pluginsDir, 'q'), { recursive: true, force: true });
    await devA.syncNow();
    const snapA = await devA.confirmLocalDeletion('q');
    assert.equal(snapA.pendingDeletions.length, 0);
    assert.equal((await cloud.readManifest()).plugins.q.deleted, true);

    // 4. Device B syncs -> surfaces remote_deleted without auto-deleting local q
    const resB3 = await devB.syncNow();
    assert.ok(existsSync(join(devB.pluginsDir, 'q', 'plugin.json')));
    assert.equal(resB3.pendingDeletions.length, 1);
    assert.equal(resB3.pendingDeletions[0].kind, 'remote_deleted');

    // 4a. Keep local ignores notice
    const snapBKeep = await devB.keepLocalIgnoreRemoteDeletion('q');
    assert.equal(snapBKeep.pendingDeletions.length, 0);
    assert.ok(existsSync(join(devB.pluginsDir, 'q')));

    // 4b. Reupload restores active in cloud
    await devB.reuploadDeletedPlugin('q');
    assert.equal((await cloud.readManifest()).plugins.q.deleted, false);

    // 4c. Delete on A -> confirm -> confirm remote deletion on B moves to trash
    await devA.syncNow();
    rmSync(join(devA.pluginsDir, 'q'), { recursive: true, force: true });
    await devA.syncNow();
    await devA.confirmLocalDeletion('q');
    await devB.syncNow();
    const snapBDel = await devB.confirmRemoteDeletion('q');
    assert.ok(!existsSync(join(devB.pluginsDir, 'q')));
    assert.equal(snapBDel.pendingDeletions.length, 0);
    assert.equal(readdirSync(devB.configStore.trashDir).length, 1);
  });
});

test('keep_local default preserves diverged plugins, supports manual push/pull, and isolates per-plugin errors', async () => {
  await withTempDir(async (tmp) => {
    const cloud = new InMemoryDriveBackend();
    const makeDevice = (name) => {
      const home = join(tmp, name);
      const pluginsDir = join(home, '.gemini', 'config', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      const store = new ConfigStore(join(home, 'data'));
      assert.equal(store.getSettings().existingPluginPolicy, 'keep_local');
      store.updateSettings({ backend: 'oauth', deviceName: name });
      return new SyncEngine({
        configStore: store,
        pluginsDir,
        backendFactory: () => cloud,
        lsQueryFn: async () => [],
        selfDirName: 'plugin-sync',
      });
    };

    const devA = makeDevice('device-a');
    const devB = makeDevice('device-b');

    writePlugin(devA.pluginsDir, 'q', '1.0.0');
    assert.deepEqual((await devA.syncNow()).uploaded, ['q']);
    assert.deepEqual((await devB.syncNow()).installed, ['q']);

    // Diverge on A: keep_local leaves cloud at 1.0.0 and surfaces hasDiff
    writePlugin(devA.pluginsDir, 'q', '1.1.0');
    const resA2 = await devA.syncNow();
    assert.equal(resA2.ok, true);
    assert.deepEqual(resA2.updated, []);
    assert.deepEqual(resA2.diverged, ['q']);
    assert.equal((await cloud.readManifest()).plugins.q.version, '1.0.0');

    const diffItemA = (await devA.getSnapshot()).plugins.find((p) => p.dirName === 'q');
    assert.equal(diffItemA.hasDiff, true);
    assert.equal(diffItemA.localVersion, '1.1.0');
    assert.equal(diffItemA.remoteVersion, '1.0.0');

    // Manual push updates cloud and clears diff on A
    const snapAfterPush = await devA.pushLocalPlugin('q');
    const pushedItemA = snapAfterPush.plugins.find((p) => p.dirName === 'q');
    assert.equal(pushedItemA.hasDiff, false);
    assert.equal(pushedItemA.syncStatus, 'synced');
    assert.equal((await cloud.readManifest()).plugins.q.version, '1.1.0');

    // Sync on B keeps local 1.0.0 untouched
    const resB2 = await devB.syncNow();
    assert.equal(resB2.ok, true);
    assert.deepEqual(resB2.updated, []);
    assert.deepEqual(resB2.diverged, ['q']);
    assert.equal(readPluginManifest(join(devB.pluginsDir, 'q')).version, '1.0.0');

    // Manual pull updates B to 1.1.0 and clears diff
    const snapAfterPull = await devB.pullRemotePlugin('q');
    const pulledItemB = snapAfterPull.plugins.find((p) => p.dirName === 'q');
    assert.equal(pulledItemB.hasDiff, false);
    assert.equal(pulledItemB.syncStatus, 'synced');
    assert.equal(readPluginManifest(join(devB.pluginsDir, 'q')).version, '1.1.0');

    // Per-plugin error isolation: broken remote plugin doesn't block uploading good plugin
    const manifest = await cloud.readManifest();
    manifest.plugins.broken = {
      dirName: 'broken',
      name: 'broken',
      displayName: 'broken',
      version: '1.0.0',
      description: '',
      contentHash: 'deadbeef',
      archiveName: 'broken--deadbeef.zip',
      updatedAt: '2026-11-26T00:00:00Z',
      updatedByDevice: 'other',
      updatedByDeviceId: 'other-id',
      deleted: false,
    };
    await cloud.writeManifest(manifest);
    writePlugin(devB.pluginsDir, 'good', '1.0.0');

    const resErr = await devB.syncNow();
    assert.equal(resErr.ok, false);
    assert.equal(resErr.errors.length, 1);
    assert.equal(resErr.errors[0].dirName, 'broken');
    assert.deepEqual(resErr.uploaded, ['good']);
    assert.ok((await cloud.readManifest()).plugins.good);
  });
});

test('GoogleDriveOAuthBackend handles token refresh, folders, manifest, and archives', async () => {
  const filesDb = new Map();
  let nextId = 1;
  let refreshCalls = 0;

  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname === '/token') {
        refreshCalls++;
        const out = Buffer.from(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(out);
        return;
      }

      assert.equal(req.headers.authorization, 'Bearer fresh-token');

      if (req.method === 'GET' && url.pathname === '/drive/v3/about') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { emailAddress: 'alice@gmail.com', displayName: 'Alice' } }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
        const q = url.searchParams.get('q') || '';
        const matched = [];
        for (const item of filesDb.values()) {
          const nameOk = !q.includes('name =') || q.includes(`name = '${item.name}'`);
          const parentOk = item.parents.some((p) => q.includes(`'${p}' in parents`));
          const mimeOk = !q.includes('mimeType =') || q.includes(`mimeType = '${item.mimeType}'`);
          if (nameOk && parentOk && mimeOk) matched.push({ id: item.id, name: item.name });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: matched }));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/drive/v3/files/') && url.searchParams.get('alt') === 'media') {
        const fid = url.pathname.split('/').pop();
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(filesDb.get(fid).content);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
        const meta = JSON.parse(raw.toString('utf8'));
        const fid = `id-${nextId++}`;
        filesDb.set(fid, {
          id: fid,
          name: meta.name,
          mimeType: meta.mimeType || 'application/octet-stream',
          parents: meta.parents || ['root'],
          content: Buffer.alloc(0),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: fid }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const marker = Buffer.from(`--${boundary}`);
        const firstSep = raw.indexOf(marker);
        const secondSep = raw.indexOf(marker, firstSep + marker.length);
        const thirdSep = raw.indexOf(marker, secondSep + marker.length);
        const part1 = raw.subarray(firstSep + marker.length, secondSep);
        const part2 = raw.subarray(secondSep + marker.length, thirdSep);
        const metaBuf = part1.subarray(part1.indexOf('\r\n\r\n') + 4, part1.length - 2);
        const dataBuf = part2.subarray(part2.indexOf('\r\n\r\n') + 4, part2.length - 2);
        const meta = JSON.parse(metaBuf.toString('utf8'));
        const fid = `id-${nextId++}`;
        filesDb.set(fid, {
          id: fid,
          name: meta.name,
          mimeType: 'application/octet-stream',
          parents: meta.parents || ['root'],
          content: Buffer.from(dataBuf),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: fid }));
        return;
      }

      if (req.method === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
        const fid = url.pathname.split('/').pop();
        filesDb.get(fid).content = Buffer.from(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: fid }));
        return;
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/drive/v3/files/')) {
        const fid = url.pathname.split('/').pop();
        filesDb.delete(fid);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    await withTempDir(async (tmp) => {
      const store = new ConfigStore(tmp);
      store.updateSettings({ backend: 'oauth', oauth: { clientId: 'cid', clientSecret: 'csec' } });
      store.saveTokens({
        access_token: 'expired-token',
        refresh_token: 'rtok',
        expires_at: Math.floor(Date.now() / 1000) - 120,
      });
      const backend = new GoogleDriveOAuthBackend({
        configStore: store,
        folderName: 'AntigravityPluginSync',
        tokenUrl: `${base}/token`,
        apiBase: `${base}/drive/v3`,
        uploadBase: `${base}/upload/drive/v3`,
      });
      const conn = await backend.testConnection();
      assert.equal(conn.ok, true);
      assert.equal(conn.account, 'alice@gmail.com');
      assert.equal(refreshCalls, 1);

      assert.equal(await backend.readManifest(), null);
      await backend.writeManifest({ schemaVersion: 1, plugins: { q: { version: '1.0' } } });
      await backend.writeManifest({ schemaVersion: 1, plugins: { q: { version: '2.0' } } });
      assert.equal((await backend.readManifest()).plugins.q.version, '2.0');

      await backend.uploadArchive('q--abc.zip', Buffer.from('PK-zip-data'));
      assert.deepEqual(await backend.listArchives(), ['q--abc.zip']);
      assert.equal((await backend.downloadArchive('q--abc.zip')).toString('utf8'), 'PK-zip-data');
      await backend.deleteArchive('q--abc.zip');
      assert.deepEqual(await backend.listArchives(), []);
    });
  } finally {
    srv.close();
  }
});

test('GdriveCliBackend handles plain-text mutate output and root ls', async () => {
  await withTempDir(async (tmp) => {
    const store = new ConfigStore(tmp);
    assert.equal(store.updateSettings({ backend: 'gdrive' }).backend, 'gdrive');

    const driveItems = new Map();
    let nextId = 1;
    const calls = [];

    const fakeExec = (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'status') {
        return Buffer.from(JSON.stringify({ authenticated: true, email: 'u@gmail.com' }));
      }
      if (args[0] === 'readonly' && args[1] === 'ls') {
        const parent = args[2];
        assert.ok(parent && !parent.startsWith('-'));
        const items = [...driveItems.values()]
          .filter((v) => v.parent === parent && !v.trashed)
          .map(({ id, name, mimeType, trashed }) => ({ id, name, mimeType, trashed: Boolean(trashed) }));
        return Buffer.from(JSON.stringify(items));
      }
      if (args[0] === 'mutate' && args[1] === 'mkdir') {
        const name = args[2];
        const parent = args.includes('--parent') ? args[args.indexOf('--parent') + 1] : 'root';
        const fid = `gid-${nextId++}`;
        driveItems.set(fid, { id: fid, name, parent, mimeType: 'application/vnd.google-apps.folder', content: Buffer.alloc(0) });
        return Buffer.from(`Created folder: ${name} (ID: ${fid})\n`);
      }
      if (args[0] === 'mutate' && args[1] === 'upload') {
        const srcPath = args[2];
        const parent = args[args.indexOf('--parent') + 1];
        const name = srcPath.split(/[/\\]/).pop();
        const fid = `gid-${nextId++}`;
        driveItems.set(fid, { id: fid, name, parent, mimeType: 'application/octet-stream', content: readFileSync(srcPath) });
        return Buffer.from(`Uploaded file: ${name} (ID: ${fid})\n`);
      }
      if (args[0] === 'mutate' && args[1] === 'update') {
        const fid = args[2];
        const srcPath = args[3];
        driveItems.get(fid).content = readFileSync(srcPath);
        return Buffer.from(`Updated file (ID: ${fid})\n`);
      }
      if (args[0] === 'readonly' && args[1] === 'download') {
        const fid = args[2];
        const outPath = args[args.indexOf('--out') + 1];
        writeFileSync(outPath, driveItems.get(fid).content);
        return Buffer.alloc(0);
      }
      if (args[0] === 'mutate' && args[1] === 'trash') {
        driveItems.get(args[2]).trashed = true;
        return Buffer.from('Trashed');
      }
      throw new Error(`Unexpected gdrive args: ${args.join(' ')}`);
    };

    // Temporarily ensure detectGdriveCli finds something via gdrive binary override
    const fakeBin = join(tmp, 'gdrive');
    writeFileSync(fakeBin, '');
    const backend = new GdriveCliBackend({ folderName: 'AntigravityPluginSync', binary: fakeBin, execFn: fakeExec });

    const conn = await backend.testConnection();
    assert.equal(conn.ok, true);
    assert.equal(conn.account, 'u@gmail.com');
    assert.equal(await backend.readManifest(), null);

    await backend.writeManifest({ schemaVersion: 1, plugins: { q: { version: '1.0' } } });
    await backend.writeManifest({ schemaVersion: 1, plugins: { q: { version: '2.0' } } });
    assert.equal((await backend.readManifest()).plugins.q.version, '2.0');

    await backend.uploadArchive('q--111.zip', Buffer.from('zipdata'));
    assert.deepEqual(await backend.listArchives(), ['q--111.zip']);
    assert.equal((await backend.downloadArchive('q--111.zip')).toString('utf8'), 'zipdata');
    await backend.deleteArchive('q--111.zip');
    assert.deepEqual(await backend.listArchives(), []);
    assert.ok(calls.some((c) => c[0] === 'mutate' && c[1] === 'update'));
  });
});

test('RcloneDriveBackend builds safe argument arrays', async () => {
  const calls = [];
  const backend = new RcloneDriveBackend({
    remote: 'gdrive:',
    folderName: 'AntigravityPluginSync',
    binary: 'rclone',
    detectFn: () => '/usr/bin/rclone',
    execFn: (_exe, args, opts) => {
      assert.equal(opts.windowsHide, true);
      calls.push(args);
      if (args[0] === 'lsjson' && args.includes('--files-only')) {
        return Buffer.from(JSON.stringify([{ Name: 'manifest.json' }]));
      }
      if (args[0] === 'cat') {
        return Buffer.from(JSON.stringify({ schemaVersion: 1, plugins: {} }));
      }
      return Buffer.from('[]');
    },
  });

  const conn = await backend.testConnection();
  assert.equal(conn.ok, true);
  assert.equal((await backend.readManifest()).schemaVersion, 1);
  await backend.uploadArchive('q--123.zip', Buffer.from('zipbytes'));
  assert.ok(calls.some((c) => c[0] === 'mkdir'));
  assert.ok(calls.some((c) => c[0] === 'copyto'));
});

test('SidecarApp HTTP auth and endpoints work end-to-end', async () => {
  await withTempDir(async (tmp) => {
    const cloud = new InMemoryDriveBackend();
    const pluginsDir = join(tmp, 'plugins');
    writePlugin(pluginsDir, 'demo', '0.2.0');
    const store = new ConfigStore(join(tmp, 'data'));
    store.updateSettings({ backend: 'oauth', deviceName: 'win-box' });
    const engine = new SyncEngine({
      configStore: store,
      pluginsDir,
      backendFactory: () => cloud,
      lsQueryFn: async () => [],
    });

    const app = new SidecarApp({ engine, token: 'secret-tok', port: 0, startBackground: false });
    const port = await app.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const htmlTxt = await (await fetch(`${base}/`)).text();
      assert.ok(htmlTxt.includes('/preload.js'));
      const preloadTxt = await (await fetch(`${base}/preload.js`)).text();
      assert.ok(preloadTxt.includes('window.sidecar'));

      const unauth = await fetch(`${base}/api/status`);
      assert.equal(unauth.status, 401);

      const syncResp = await (
        await fetch(`${base}/api/sync`, {
          method: 'POST',
          headers: { 'X-Sidecar-Token': 'secret-tok', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json();
      assert.equal(syncResp.sync.ok, true);
      assert.deepEqual(syncResp.sync.uploaded, ['demo']);

      const cfgResp = await (
        await fetch(`${base}/api/settings`, {
          method: 'POST',
          headers: { 'X-Sidecar-Token': 'secret-tok', 'Content-Type': 'application/json' },
          body: JSON.stringify({ pollIntervalSec: 120 }),
        })
      ).json();
      assert.equal(cfgResp.ok, true);
      assert.equal(cfgResp.snapshot.settings.pollIntervalSec, 120);

      const exResp = await (
        await fetch(`${base}/api/plugins/exclude`, {
          method: 'POST',
          headers: { 'X-Sidecar-Token': 'secret-tok', 'Content-Type': 'application/json' },
          body: JSON.stringify({ dirName: 'demo', excluded: true }),
        })
      ).json();
      assert.equal(exResp.ok, true);
      const demo = exResp.snapshot.plugins.find((p) => p.dirName === 'demo');
      assert.equal(demo.syncStatus, 'excluded');
    } finally {
      await app.stop();
    }
  });
});

test('installer and uninstaller work in temp home and clean stale python files', async () => {
  await withTempDir(async (tmp) => {
    const fakeHome = join(tmp, 'home');
    const staleDir = join(fakeHome, '.gemini', 'config', 'plugins', 'plugin-sync', 'sidecars', 'plugin-sync');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'server.py'), '# stale');

    const installedDir = installPlugin({ sourceRoot: REPO_ROOT, homeDir: fakeHome, enableSidecar: true });
    assert.ok(existsSync(join(installedDir, 'plugin.json')));
    assert.ok(existsSync(join(installedDir, 'sidecars', 'plugin-sync', 'main.mjs')));
    assert.ok(!existsSync(join(installedDir, 'sidecars', 'plugin-sync', 'server.py')));

    const sc = JSON.parse(readFileSync(join(installedDir, 'sidecars', 'plugin-sync', 'sidecar.json'), 'utf8'));
    assert.equal(sc.command, 'node');
    assert.deepEqual(sc.args, ['main.mjs']);

    const cfg = JSON.parse(readFileSync(join(fakeHome, '.gemini', 'config', 'config.json'), 'utf8'));
    assert.equal(cfg.plugins['plugin-sync'].enabled, true);
    assert.equal(cfg.sidecars['plugin-sync/plugin-sync'].enabled, true);

    assert.equal(uninstallPlugin(fakeHome, { purgeData: true }), true);
    assert.ok(!existsSync(installedDir));
  });
});

test('GdriveCliBackend caches Drive IDs in ConfigStore and recovers on stale file ID', async () => {
  await withTempDir(async (tmp) => {
    const store = new ConfigStore(tmp);
    assert.equal(store.getSettings().pollIntervalSec, 300);

    store.setDriveIdCache('gdrive:AntigravityPluginSync', { rootFolderId: 'r1', manifestFileId: 'm1' });
    assert.deepEqual(store.getDriveIdCache('gdrive:AntigravityPluginSync'), {
      rootFolderId: 'r1',
      manifestFileId: 'm1',
    });
    store.clearDriveIdCache();
    assert.deepEqual(store.getDriveIdCache('gdrive:AntigravityPluginSync'), {});

    const fakeBin = join(tmp, 'gdrive');
    writeFileSync(fakeBin, '');

    let manifestId = 'm-initial';
    let manifestObj = { schemaVersion: 1, plugins: { demo: { version: '1.0' } } };
    const calls = [];

    const execFn = (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'readonly' && args[1] === 'ls') {
        const parent = args[2];
        if (parent === 'root') {
          return Buffer.from(JSON.stringify([{ id: 'root-folder', name: 'AntigravityPluginSync', mimeType: 'application/vnd.google-apps.folder' }]));
        }
        if (parent === 'root-folder') {
          return Buffer.from(JSON.stringify([{ id: manifestId, name: 'manifest.json', mimeType: 'application/json' }]));
        }
        return Buffer.from('[]');
      }
      if (args[0] === 'readonly' && args[1] === 'download') {
        const fid = args[2];
        if (fid !== manifestId) {
          const err = new Error('404 Not Found');
          err.stderr = Buffer.from('googleapi: Error 404: File not found');
          throw err;
        }
        writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(manifestObj));
        return Buffer.alloc(0);
      }
      if (args[0] === 'mutate' && args[1] === 'update') {
        manifestObj = JSON.parse(readFileSync(args[3], 'utf8'));
        return Buffer.from(`Updated file (ID: ${args[2]})\n`);
      }
      throw new Error(`Unexpected gdrive args: ${args.join(' ')}`);
    };

    const backend1 = new GdriveCliBackend({
      configStore: store,
      folderName: 'AntigravityPluginSync',
      binary: fakeBin,
      execFn,
      retryDelaysMs: [1, 1],
    });
    const m1 = await backend1.readManifest();
    assert.equal(m1.plugins.demo.version, '1.0');
    assert.equal(store.getDriveIdCache('gdrive:AntigravityPluginSync').manifestFileId, 'm-initial');

    // New backend instance sharing ConfigStore reads & writes manifest with 0 ls calls
    calls.length = 0;
    const backend2 = new GdriveCliBackend({
      configStore: store,
      folderName: 'AntigravityPluginSync',
      binary: fakeBin,
      execFn,
      retryDelaysMs: [1, 1],
    });
    const m2 = await backend2.readManifest();
    assert.equal(m2.plugins.demo.version, '1.0');
    assert.equal(calls.filter((c) => c[0] === 'readonly' && c[1] === 'ls').length, 0);

    await backend2.writeManifest({ schemaVersion: 1, plugins: { demo: { version: '2.0' } } });
    assert.equal(calls.filter((c) => c[0] === 'readonly' && c[1] === 'ls').length, 0);

    // Stale manifestFileId (404) triggers automatic re-lookup and recovery
    manifestId = 'm-replaced';
    calls.length = 0;
    const m3 = await backend2.readManifest();
    assert.equal(m3.plugins.demo.version, '2.0');
    assert.equal(store.getDriveIdCache('gdrive:AntigravityPluginSync').manifestFileId, 'm-replaced');
    assert.ok(calls.some((c) => c[0] === 'readonly' && c[1] === 'ls'));
  });
});

test('GdriveCliBackend retries transient EOF/403 rateLimitExceeded and formats exhausted quota errors', async () => {
  await withTempDir(async (tmp) => {
    const store = new ConfigStore(tmp);
    const fakeBin = join(tmp, 'gdrive');
    writeFileSync(fakeBin, '');

    let attempts = 0;
    const backendOk = new GdriveCliBackend({
      configStore: store,
      folderName: 'AntigravityPluginSync',
      binary: fakeBin,
      retryDelaysMs: [1, 1],
      execFn: (_cmd, args) => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('EOF');
          err.stderr = Buffer.from('listing files: Get "https://www.googleapis.com/drive/v3/files": EOF');
          throw err;
        }
        if (attempts === 2) {
          const err = new Error('403');
          err.stderr = Buffer.from('googleapi: Error 403: Quota exceeded, rateLimitExceeded');
          throw err;
        }
        if (args[0] === 'readonly' && args[1] === 'ls') {
          return Buffer.from(JSON.stringify([{ id: 'root-id', name: 'AntigravityPluginSync', mimeType: 'application/vnd.google-apps.folder' }]));
        }
        throw new Error(`Unexpected gdrive args: ${args.join(' ')}`);
      },
    });
    assert.equal(await backendOk.readManifest(), null);
    assert.equal(attempts, 4);

    // Exhausted retries on 403 rateLimitExceeded produces friendly message
    let failAttempts = 0;
    const backendFail = new GdriveCliBackend({
      configStore: new ConfigStore(join(tmp, 'data2')),
      folderName: 'AntigravityPluginSync',
      binary: fakeBin,
      retryDelaysMs: [1, 1],
      execFn: () => {
        failAttempts++;
        const err = new Error('403');
        err.stderr = Buffer.from('googleapi: Error 403: Quota exceeded for quota metric, rateLimitExceeded');
        throw err;
      },
    });
    await assert.rejects(() => backendFail.readManifest(), /Google Drive API 配额限流 \(403 rateLimitExceeded\)/);
    assert.equal(failAttempts, 3);
  });
});

test('updater parses semver, checks GitHub Releases with main fallback, and applies zip updates safely', async () => {
  assert.deepEqual(parseSemver('v0.3.0-beta.1'), {
    major: 0,
    minor: 3,
    patch: 0,
    prerelease: ['beta', '1'],
  });
  assert.equal(compareSemver('0.3.0', '0.2.0'), 1);
  assert.equal(compareSemver('v0.3.0', '0.3.0'), 0);
  assert.equal(compareSemver('0.3.0', '0.3.0-beta.1'), 1);
  assert.equal(compareSemver('0.2.9', '0.3.0'), -1);

  const releaseRes = await checkForUpdate({
    currentVersion: '0.2.0',
    fetchFn: async (url) => {
      assert.match(url, /api\.github\.com\/repos\/PolarPandaC\/antigravity-plugin-sync\/releases\/latest/);
      return new Response(
        JSON.stringify({
          tag_name: 'v0.3.0',
          html_url: 'https://github.com/PolarPandaC/antigravity-plugin-sync/releases/tag/v0.3.0',
          body: '- Added check for updates\n- Fixed quota backoff',
          published_at: '2026-11-26T08:00:00Z',
          zipball_url: 'https://api.github.com/repos/PolarPandaC/antigravity-plugin-sync/zipball/v0.3.0',
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(releaseRes.hasUpdate, true);
  assert.equal(releaseRes.source, 'github_release');
  assert.equal(releaseRes.latestVersion, '0.3.0');
  assert.match(releaseRes.releaseNotes, /Added check for updates/);

  const fallbackRes = await checkForUpdate({
    currentVersion: '0.2.0',
    fetchFn: async (url) => {
      if (url.includes('api.github.com')) {
        return new Response('Not Found', { status: 404 });
      }
      assert.match(url, /raw\.githubusercontent\.com\/PolarPandaC\/antigravity-plugin-sync\/main\/plugin\.json/);
      return new Response(JSON.stringify({ name: 'plugin-sync', version: '0.3.1' }), { status: 200 });
    },
  });
  assert.equal(fallbackRes.hasUpdate, true);
  assert.equal(fallbackRes.source, 'github_main');
  assert.equal(fallbackRes.latestVersion, '0.3.1');
  assert.match(fallbackRes.zipUrl, /archive\/refs\/heads\/main\.zip$/);

  await withTempDir(async (tmp) => {
    const evilZip = createZipBuffer([{ name: '../../evil.txt', data: Buffer.from('bad') }]);
    assert.throws(() => applyUpdateFromZipBuffer({ zipBuffer: evilZip, homeDir: tmp }), /Zip Slip/);

    const prefix = 'PolarPandaC-antigravity-plugin-sync-abc123/';
    const validZip = createZipBuffer([
      { name: `${prefix}plugin.json`, data: Buffer.from(JSON.stringify({ name: 'plugin-sync', version: '0.3.0' })) },
      { name: `${prefix}package.json`, data: Buffer.from(JSON.stringify({ name: 'plugin-sync', version: '0.3.0' })) },
      { name: `${prefix}sidecars/plugin-sync/main.mjs`, data: Buffer.from('// upgraded\n') },
    ]);
    const applied = applyUpdateFromZipBuffer({ zipBuffer: validZip, homeDir: tmp });
    assert.equal(applied.ok, true);
    assert.equal(applied.installedVersion, '0.3.0');
    assert.equal(applied.requiresRestart, true);
    assert.ok(existsSync(join(tmp, '.gemini', 'config', 'plugins', 'plugin-sync', 'sidecars', 'plugin-sync', 'main.mjs')));
  });
});

test('SidecarApp exposes /api/update/check and /api/update/apply endpoints', async () => {
  await withTempDir(async (tmp) => {
    const cloud = new InMemoryDriveBackend();
    const pluginsDir = join(tmp, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const store = new ConfigStore(join(tmp, 'data'));
    const engine = new SyncEngine({
      configStore: store,
      pluginsDir,
      backendFactory: () => cloud,
      lsQueryFn: async () => [],
    });

    const app = new SidecarApp({
      engine,
      token: 'upd-tok',
      port: 0,
      startBackground: false,
      homeDir: tmp,
      pluginRoot: REPO_ROOT,
      updateChecker: async ({ currentVersion }) => ({
        ok: true,
        checkedAt: '2026-11-26T08:00:00Z',
        currentVersion,
        latestVersion: '0.4.0',
        hasUpdate: true,
        source: 'github_release',
        releaseUrl: 'https://github.com/PolarPandaC/antigravity-plugin-sync/releases/tag/v0.4.0',
        releaseNotes: 'Release 0.4.0',
        zipUrl: 'https://github.com/PolarPandaC/antigravity-plugin-sync/archive/refs/tags/v0.4.0.zip',
      }),
      updateApplier: async ({ zipUrl }) => {
        assert.match(zipUrl, /v0\.4\.0\.zip$/);
        return { ok: true, targetDir: pluginsDir, installedVersion: '0.4.0', requiresRestart: true };
      },
    });

    const port = await app.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const headers = { 'X-Sidecar-Token': 'upd-tok', 'Content-Type': 'application/json' };

      const checkResp = await (await fetch(`${base}/api/update/check`, { method: 'POST', headers, body: '{}' })).json();
      assert.equal(checkResp.ok, true);
      assert.equal(checkResp.update.hasUpdate, true);
      assert.equal(checkResp.update.latestVersion, '0.4.0');

      const applyResp = await (await fetch(`${base}/api/update/apply`, { method: 'POST', headers, body: '{}' })).json();
      assert.equal(applyResp.ok, true);
      assert.equal(applyResp.result.installedVersion, '0.4.0');
      assert.equal(applyResp.update.requiresRestart, true);
      assert.equal(applyResp.update.hasUpdate, false);
    } finally {
      await app.stop();
    }
  });
});
