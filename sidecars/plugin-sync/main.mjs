import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigStore } from '../../lib/config-store.mjs';
import {
  buildBackend,
  GdriveAuthFlowManager,
  listRcloneRemotes,
  OAuthFlowManager,
} from '../../lib/drive-backend.mjs';
import { getDataDir, getHomeDir, getPluginsDir, getPreloadJsPath } from '../../lib/paths.mjs';
import { SyncEngine } from '../../lib/sync-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_PRELOAD_JS = `(function(){
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  function secureFetch(url, options) {
    options = options || {};
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(url, Object.assign({}, options, { headers: headers }));
  }
  window.sidecar = { fetch: secureFetch, ui: {}, agent: {}, auth: {} };
})();
`;

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(Object.assign(new Error('Payload too large'), { statusCode: 400 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolveBody(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        rejectBody(Object.assign(new Error('Invalid JSON payload'), { statusCode: 400 }));
      }
    });
    req.on('error', rejectBody);
  });
}

/** Hosts the local HTTP API, Web UI, OAuth managers, and background sync loop. */
export class SidecarApp {
  constructor({ engine, token = '', port = 0, oauthManagerFactory, startBackground = true }) {
    this.engine = engine;
    this.token = token;
    this.requestedPort = port;
    this.oauthManager = oauthManagerFactory
      ? oauthManagerFactory(engine.configStore)
      : new OAuthFlowManager(engine.configStore);
    this.gdriveAuthManager = new GdriveAuthFlowManager();
    this.startBackground = startBackground;
    this.uiHtmlPath = join(__dirname, 'ui.html');
    this._preloadJs = this.#loadPreloadJs();
    this._stopped = false;
    this._bgTimer = null;
    this._wakeResolve = null;
    this.server = null;
    this.port = 0;
  }

  #loadPreloadJs() {
    const p = getPreloadJsPath();
    if (p && existsSync(p)) {
      try {
        return readFileSync(p, 'utf8');
      } catch {}
    }
    return FALLBACK_PRELOAD_JS;
  }

  #isAuthorized(req, url) {
    if (!this.token) return true;
    const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token') || '';
    return provided === this.token;
  }

  #sendJson(res, status, payload) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': raw.length,
    });
    res.end(raw);
  }

  #wakeBackground() {
    if (this._wakeResolve) {
      const fn = this._wakeResolve;
      this._wakeResolve = null;
      fn();
    }
  }

  #waitOrWake(ms) {
    return new Promise((resolveWait) => {
      if (this._stopped) {
        resolveWait();
        return;
      }
      const timer = setTimeout(() => {
        if (this._wakeResolve === wake) this._wakeResolve = null;
        resolveWait();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolveWait();
      };
      this._wakeResolve = wake;
    });
  }

  async #backgroundLoop() {
    await this.#waitOrWake(2000);
    if (this._stopped) return;

    let consecutiveRateLimits = 0;
    const isRateLimit = (res) =>
      Boolean(res && !res.ok && /ratelimit|quota exceeded|配额限流|429/i.test(res.error || ''));

    let settings = this.engine.configStore.getSettings();
    if (settings.autoSyncOnStartup !== false && settings.backend && settings.backend !== 'none') {
      try {
        const res = await this.engine.syncNow();
        consecutiveRateLimits = isRateLimit(res) ? 1 : 0;
      } catch {}
    }

    while (!this._stopped) {
      settings = this.engine.configStore.getSettings();
      const baseSec = Math.max(15, Number.parseInt(settings.pollIntervalSec || 300, 10) || 300);
      const waitSec = consecutiveRateLimits > 0
        ? Math.min(Math.max(baseSec, 300) * (2 ** Math.min(consecutiveRateLimits - 1, 4)), 3600)
        : baseSec;
      await this.#waitOrWake(waitSec * 1000);
      if (this._stopped) break;
      settings = this.engine.configStore.getSettings();
      if (settings.backend && settings.backend !== 'none') {
        try {
          const res = await this.engine.syncNow();
          consecutiveRateLimits = isRateLimit(res) ? consecutiveRateLimits + 1 : 0;
        } catch {}
      }
    }
  }

  async start() {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.port || 80}`);

      if (req.method === 'GET' && url.pathname === '/preload.js') {
        const raw = Buffer.from(this._preloadJs, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': raw.length });
        res.end(raw);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const raw = readFileSync(this.uiHtmlPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': raw.length });
        res.end(raw);
        return;
      }

      if (url.pathname.startsWith('/api/') && !this.#isAuthorized(req, url)) {
        this.#sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      try {
        if (req.method === 'GET') {
          if (url.pathname === '/api/status') {
            const refresh = url.searchParams.get('refresh') === '1';
            this.#sendJson(res, 200, await this.engine.getSnapshot({ refreshRemote: refresh }));
            return;
          }
          if (url.pathname === '/api/rclone/remotes') {
            const binary = this.engine.configStore.getSettings().rclone?.binary || 'rclone';
            this.#sendJson(res, 200, { remotes: listRcloneRemotes(binary) });
            return;
          }
          if (url.pathname === '/api/oauth/status') {
            this.#sendJson(res, 200, this.oauthManager.getStatus());
            return;
          }
          if (url.pathname === '/api/gdrive/auth/status') {
            const st = this.gdriveAuthManager.getStatus();
            if (st.status === 'success') this.engine.invalidateAuthCache();
            this.#sendJson(res, 200, st);
            return;
          }
          this.#sendJson(res, 404, { error: 'not found' });
          return;
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req);

          if (url.pathname === '/api/sync') {
            const sync = await this.engine.syncNow();
            const snapshot = await this.engine.getSnapshot();
            this.#sendJson(res, 200, { sync, snapshot });
            return;
          }

          if (url.pathname === '/api/deletions/confirm') {
            let snapshot;
            if (body.all) {
              snapshot = await this.engine.confirmAllPendingDeletions();
            } else {
              const dirName = String(body.dirName || '');
              const kind = String(body.kind || '');
              if (kind === 'local_deleted') {
                snapshot = await this.engine.confirmLocalDeletion(dirName);
              } else if (kind === 'remote_deleted') {
                snapshot = await this.engine.confirmRemoteDeletion(dirName);
              } else {
                this.#sendJson(res, 400, { error: 'invalid deletion kind' });
                return;
              }
            }
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/deletions/restore') {
            const snapshot = await this.engine.restoreLocalDeletion(String(body.dirName || ''));
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/deletions/keep') {
            const dirName = String(body.dirName || '');
            const mode = String(body.mode || 'ignore');
            const snapshot = mode === 'reupload'
              ? await this.engine.reuploadDeletedPlugin(dirName)
              : await this.engine.keepLocalIgnoreRemoteDeletion(dirName);
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/plugins/exclude') {
            const snapshot = await this.engine.setPluginExcluded(String(body.dirName || ''), Boolean(body.excluded));
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/plugins/push') {
            const snapshot = await this.engine.pushLocalPlugin(String(body.dirName || ''));
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/plugins/pull') {
            const snapshot = await this.engine.pullRemotePlugin(String(body.dirName || ''));
            this.#sendJson(res, 200, { ok: true, snapshot });
            return;
          }

          if (url.pathname === '/api/settings') {
            this.engine.configStore.updateSettings(body);
            this.engine.invalidateAuthCache();
            this.#wakeBackground();
            this.#sendJson(res, 200, { ok: true, snapshot: await this.engine.getSnapshot() });
            return;
          }

          if (url.pathname === '/api/backend/test') {
            const backend = buildBackend(this.engine.configStore);
            if (!backend) {
              this.#sendJson(res, 400, { ok: false, error: '同步后端尚未配置或未登录' });
              return;
            }
            this.#sendJson(res, 200, await backend.testConnection());
            return;
          }

          if (url.pathname === '/api/oauth/start') {
            const resObj = await this.oauthManager.startFlow({ openBrowser: body.openBrowser !== false });
            this.#sendJson(res, 200, resObj);
            return;
          }

          if (url.pathname === '/api/oauth/disconnect') {
            this.engine.configStore.clearTokens();
            this.engine.configStore.clearDriveIdCache();
            this.#sendJson(res, 200, { ok: true, snapshot: await this.engine.getSnapshot() });
            return;
          }

          if (url.pathname === '/api/gdrive/auth/start') {
            const gdriveBin = String(this.engine.configStore.getSettings().gdrive?.binary || '');
            const resObj = await this.gdriveAuthManager.startLogin({
              binary: gdriveBin,
              openBrowser: body.openBrowser !== false,
            });
            this.#sendJson(res, 200, resObj);
            return;
          }

          if (url.pathname === '/api/gdrive/auth/logout') {
            const gdriveBin = String(this.engine.configStore.getSettings().gdrive?.binary || '');
            this.gdriveAuthManager.logout(gdriveBin);
            this.engine.configStore.clearDriveIdCache();
            this.engine.invalidateAuthCache();
            this.#sendJson(res, 200, { ok: true, snapshot: await this.engine.getSnapshot() });
            return;
          }

          this.#sendJson(res, 404, { error: 'not found' });
          return;
        }

        this.#sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        const status = err.statusCode || (err.message?.startsWith('Unsupported ') || err.message?.startsWith('Unsafe ') || err.message?.startsWith('Invalid ') ? 400 : 500);
        this.#sendJson(res, status, { error: err.message || String(err) });
      }
    });

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.requestedPort, '127.0.0.1', () => resolveListen());
    });

    this.server = server;
    this.port = server.address().port;

    if (this.startBackground) {
      void this.#backgroundLoop();
    }
    return this.port;
  }

  async stop() {
    this._stopped = true;
    this.#wakeBackground();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise((resolveClose) => {
        try {
          srv.close(() => resolveClose());
          if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        } catch {
          resolveClose();
        }
      });
    }
  }
}

function parseCliArgs(argv) {
  const out = { port: Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10) || 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) out.port = Number.parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--home' && argv[i + 1]) out.home = argv[++i];
    else if (argv[i] === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
  }
  return out;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const args = parseCliArgs(process.argv.slice(2));
  const home = getHomeDir(args.home);
  const pluginsDir = getPluginsDir(home);
  const dataDir = getDataDir(args.dataDir, home);
  const store = new ConfigStore(dataDir);
  const engine = new SyncEngine({ configStore: store, pluginsDir });
  const token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

  const app = new SidecarApp({ engine, token, port: args.port, startBackground: true });
  const port = await app.start();
  console.log(`[plugin-sync] sidecar listening on 127.0.0.1:${port}`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await app.stop();
      process.exit(0);
    });
  }
}
