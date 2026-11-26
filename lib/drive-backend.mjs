import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { getHomeDir } from './paths.mjs';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const GOOGLE_DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class BackendError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendError';
  }
}

export function openBrowserUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

function whichSync(cmdName) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [cmdName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function wrapCliCmd(executable) {
  if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())) {
    return ['cmd.exe', ['/c', executable]];
  }
  return [executable, []];
}

function runExec(cmdSpec, args, { timeout = 120000 } = {}) {
  const [exe, prefix] = cmdSpec;
  return execFileSync(exe, [...prefix, ...args], {
    encoding: null,
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function escapeDriveQuery(val) {
  return String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generatePkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(detail) {
  const lower = String(detail || '').toLowerCase();
  return (
    lower.includes('ratelimitexceeded') ||
    lower.includes('userratelimitexceeded') ||
    lower.includes('quota exceeded') ||
    lower.includes('error 429') ||
    lower.includes('too many requests')
  );
}

function isRetryableGdriveError(detail) {
  if (isRateLimitError(detail)) return true;
  const lower = String(detail || '').toLowerCase();
  return (
    lower.includes(': eof') ||
    /\beof\b/.test(lower) ||
    lower.includes('connection reset') ||
    lower.includes('tls handshake timeout') ||
    lower.includes('i/o timeout') ||
    lower.includes('broken pipe') ||
    lower.includes('error 500') ||
    lower.includes('error 502') ||
    lower.includes('error 503') ||
    lower.includes('service unavailable')
  );
}

/** Locate Antigravity's official `gdrive` CLI executable or launcher script. */
export function detectGdriveCli(binary = '', home) {
  if (binary) {
    if (existsSync(binary)) return wrapCliCmd(binary);
    const resolved = whichSync(binary);
    if (resolved) return wrapCliCmd(resolved);
  }

  const baseHome = home || getHomeDir();
  const appData = process.env.ANTIGRAVITY_APP_DATA_DIR || join(baseHome, '.gemini', 'antigravity');

  // Prefer downloaded native binary under plugin_data/gdrive/bin/
  const binDir = join(appData, 'plugin_data', 'gdrive', 'bin');
  if (existsSync(binDir)) {
    try {
      const files = readdirSync(binDir)
        .filter((f) => f.startsWith('gdrive-') && (!['win32'].includes(process.platform) || f.endsWith('.exe')))
        .sort()
        .reverse();
      for (const f of files) {
        const full = join(binDir, f);
        if (existsSync(full)) return [full, []];
      }
    } catch {}
  }

  const onPath = whichSync('gdrive');
  if (onPath) return wrapCliCmd(onPath);

  const shimName = process.platform === 'win32' ? 'gdrive.cmd' : 'gdrive';
  const shim = join(appData, 'bin', shimName);
  if (existsSync(shim)) return wrapCliCmd(shim);

  const launcher = join(baseHome, '.gemini', 'config', 'plugins', 'gdrive', 'skills', 'gdrive', 'scripts', shimName);
  if (existsSync(launcher)) return wrapCliCmd(launcher);

  return null;
}

/** Google Drive backend powered by Antigravity's official `gdrive` plugin CLI. */
export class GdriveCliBackend {
  constructor({
    configStore = null,
    folderName = 'AntigravityPluginSync',
    binary = '',
    home,
    execFn,
    retryDelaysMs = [1200, 3000, 6000],
  } = {}) {
    this.configStore = configStore;
    this.folderName = folderName;
    this.binary = binary;
    this.home = home;
    this._execFn = execFn || runExec;
    this._retryDelaysMs = Array.isArray(retryDelaysMs) ? retryDelaysMs : [1200, 3000, 6000];
    this._cacheKey = `gdrive:${this.folderName}`;
    const cached = this.configStore?.getDriveIdCache?.(this._cacheKey) || {};
    this._rootFolderId = cached.rootFolderId || null;
    this._archivesFolderId = cached.archivesFolderId || null;
    this._manifestFileId = cached.manifestFileId || null;
  }

  #saveCache() {
    this.configStore?.setDriveIdCache?.(this._cacheKey, {
      rootFolderId: this._rootFolderId,
      archivesFolderId: this._archivesFolderId,
      manifestFileId: this._manifestFileId,
    });
  }

  #baseCmd() {
    const cmd = detectGdriveCli(this.binary, this.home);
    if (!cmd) {
      throw new BackendError('未检测到官方 gdrive 插件命令行工具，请先安装并初始化 Google Drive 插件');
    }
    return cmd;
  }

  async #runMutate(args, timeout = 120000) {
    const cmd = this.#baseCmd();
    for (let attempt = 0; attempt <= this._retryDelaysMs.length; attempt++) {
      try {
        const out = this._execFn(cmd, args, { timeout });
        return Buffer.isBuffer(out) ? out.toString('utf8').trim() : String(out || '').trim();
      } catch (err) {
        const stderr = err.stderr ? Buffer.from(err.stderr).toString('utf8') : '';
        const stdout = err.stdout ? Buffer.from(err.stdout).toString('utf8') : '';
        const detail = (stderr || stdout || err.message || '').trim();
        if (detail.toLowerCase().includes('no credentials found') || detail.toLowerCase().includes('auth login')) {
          throw new BackendError('官方 gdrive 插件尚未登录，请在设置中点击「一键登录 Google 账号」');
        }
        if (isRetryableGdriveError(detail) && attempt < this._retryDelaysMs.length) {
          await sleepAsync(this._retryDelaysMs[attempt]);
          continue;
        }
        if (isRateLimitError(detail)) {
          const be = new BackendError(
            `Google Drive API 配额限流 (403 rateLimitExceeded)：官方 gdrive 插件共享配额暂时达到上限，稍后将自动重试（建议调大轮询间隔或切换自建 OAuth）。详情: ${detail}`,
          );
          be.isRateLimit = true;
          throw be;
        }
        throw new BackendError(`gdrive 命令执行失败: ${detail}`);
      }
    }
  }

  async #runJson(args, timeout = 120000) {
    const raw = await this.#runMutate(args, timeout);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BackendError(`gdrive 输出 JSON 解析失败: ${raw.slice(0, 200)}`);
    }
  }

  static extractItems(parsed) {
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object');
    if (parsed && typeof parsed === 'object') {
      for (const key of ['files', 'items', 'entries', 'data']) {
        if (Array.isArray(parsed[key])) {
          return parsed[key].filter((x) => x && typeof x === 'object');
        }
      }
    }
    return [];
  }

  static extractIdFromText(text) {
    const stripped = String(text || '').trim();
    if (!stripped) return null;
    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === 'object') {
        if (parsed.id) return String(parsed.id);
        for (const k of ['file', 'folder', 'data']) {
          if (parsed[k]?.id) return String(parsed[k].id);
        }
      }
    } catch {}
    const m1 = stripped.match(/\(ID:\s*([A-Za-z0-9_-]+)\)/);
    if (m1) return m1[1];
    const m2 = stripped.match(/\bID:\s*([A-Za-z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
  }

  checkAuthStatus() {
    const cmd = detectGdriveCli(this.binary, this.home);
    if (!cmd) return { authenticated: false, account: '', detail: '未安装 gdrive CLI' };
    try {
      const buf = this._execFn(cmd, ['auth', 'status', '--json'], { timeout: 10000 });
      const txt = Buffer.isBuffer(buf) ? buf.toString('utf8').trim() : String(buf || '').trim();
      let data = {};
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {}
      const account = String(data.email || data.account || data.user?.emailAddress || '');
      if (data.authenticated === false || data.loggedIn === false) {
        return { authenticated: false, account, detail: '尚未登录 Google 账号' };
      }
      return { authenticated: true, account, detail: txt };
    } catch (err) {
      const msg = err.stderr ? Buffer.from(err.stderr).toString('utf8').trim() : err.message;
      return { authenticated: false, account: '', detail: msg || '尚未登录 Google 账号' };
    }
  }

  async #findChild(name, parentId = null, folderOnly = false) {
    const targetParent = parentId || 'root';
    const parsed = await this.#runJson(['readonly', 'ls', targetParent, '--max', '0', '--json'], 60000);
    for (const item of GdriveCliBackend.extractItems(parsed)) {
      if (item.name !== name || item.trashed) continue;
      if (folderOnly && item.mimeType && item.mimeType !== 'application/vnd.google-apps.folder') continue;
      if (item.id) return String(item.id);
    }
    return null;
  }

  async #ensureFolder(name, parentId = null) {
    const found = await this.#findChild(name, parentId, true);
    if (found) return found;
    const args = ['mutate', 'mkdir', name];
    if (parentId) args.push('--parent', parentId);
    const out = await this.#runMutate(args, 60000);
    const fid = GdriveCliBackend.extractIdFromText(out);
    if (fid) return fid;
    const recheck = await this.#findChild(name, parentId, true);
    if (!recheck) throw new BackendError(`无法获取创建的 Google Drive 文件夹 ID: ${name}`);
    return recheck;
  }

  async #ensureRootFolder() {
    if (!this._rootFolderId) {
      this._rootFolderId = await this.#ensureFolder(this.folderName, null);
      this.#saveCache();
    }
    return this._rootFolderId;
  }

  async #ensureArchivesFolder() {
    const hadCachedRoot = Boolean(this._rootFolderId);
    const rootId = await this.#ensureRootFolder();
    if (!this._archivesFolderId) {
      try {
        this._archivesFolderId = await this.#ensureFolder('archives', rootId);
      } catch (err) {
        if (!err.isRateLimit && hadCachedRoot) {
          this._rootFolderId = null;
          this._archivesFolderId = null;
          this._manifestFileId = null;
          this.#saveCache();
          const freshRoot = await this.#ensureRootFolder();
          this._archivesFolderId = await this.#ensureFolder('archives', freshRoot);
        } else {
          throw err;
        }
      }
      this.#saveCache();
    }
    return { rootId: this._rootFolderId, archivesId: this._archivesFolderId };
  }

  async testConnection() {
    const status = this.checkAuthStatus();
    if (!status.authenticated) {
      throw new BackendError('官方 gdrive 插件尚未登录，请点击「一键登录 Google 账号」');
    }
    const rootId = await this.#ensureRootFolder();
    const account = status.account || 'Google Drive (官方插件)';
    return {
      ok: true,
      account,
      detail: `已通过官方 gdrive 插件连接文件夹 ${this.folderName} (ID: ${rootId.slice(0, 8)}…)`,
    };
  }

  async readManifest() {
    if (this._manifestFileId) {
      const tmp = mkdtempSync(join(tmpdir(), 'agysync-'));
      try {
        const outPath = join(tmp, 'manifest.json');
        await this.#runMutate(['readonly', 'download', this._manifestFileId, '--out', outPath], 60000);
        return JSON.parse(readFileSync(outPath, 'utf8'));
      } catch (err) {
        if (err.isRateLimit) throw err;
        this._manifestFileId = null;
        this.#saveCache();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    const hadCachedRoot = Boolean(this._rootFolderId);
    let rootId = await this.#ensureRootFolder();
    let fileId;
    try {
      fileId = await this.#findChild('manifest.json', rootId);
    } catch (err) {
      if (!err.isRateLimit && hadCachedRoot) {
        this._rootFolderId = null;
        this._archivesFolderId = null;
        this._manifestFileId = null;
        this.#saveCache();
        rootId = await this.#ensureRootFolder();
        fileId = await this.#findChild('manifest.json', rootId);
      } else {
        throw err;
      }
    }
    if (!fileId) return null;
    this._manifestFileId = fileId;
    this.#saveCache();

    const tmp = mkdtempSync(join(tmpdir(), 'agysync-'));
    try {
      const outPath = join(tmp, 'manifest.json');
      await this.#runMutate(['readonly', 'download', fileId, '--out', outPath], 60000);
      return JSON.parse(readFileSync(outPath, 'utf8'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async writeManifest(manifest) {
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-'));
    try {
      const srcPath = join(tmp, 'manifest.json');
      writeFileSync(srcPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      if (this._manifestFileId) {
        try {
          await this.#runMutate(['mutate', 'update', this._manifestFileId, srcPath], 60000);
          return;
        } catch (err) {
          if (err.isRateLimit) throw err;
          this._manifestFileId = null;
          this.#saveCache();
        }
      }

      const rootId = await this.#ensureRootFolder();
      const existingId = await this.#findChild('manifest.json', rootId);
      if (existingId) {
        await this.#runMutate(['mutate', 'update', existingId, srcPath], 60000);
        this._manifestFileId = existingId;
      } else {
        const out = await this.#runMutate(['mutate', 'upload', srcPath, '--parent', rootId], 60000);
        const fid = GdriveCliBackend.extractIdFromText(out);
        if (fid) this._manifestFileId = fid;
      }
      this.#saveCache();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async uploadArchive(archiveName, data) {
    const { archivesId } = await this.#ensureArchivesFolder();
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-'));
    try {
      const srcPath = join(tmp, archiveName);
      writeFileSync(srcPath, data);
      const existingId = await this.#findChild(archiveName, archivesId);
      if (existingId) {
        await this.#runMutate(['mutate', 'update', existingId, srcPath], 120000);
      } else {
        await this.#runMutate(['mutate', 'upload', srcPath, '--parent', archivesId], 120000);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async downloadArchive(archiveName) {
    const { archivesId } = await this.#ensureArchivesFolder();
    const fileId = await this.#findChild(archiveName, archivesId);
    if (!fileId) throw new BackendError(`Google Drive 上未找到插件压缩包: ${archiveName}`);
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-'));
    try {
      const outPath = join(tmp, archiveName);
      await this.#runMutate(['readonly', 'download', fileId, '--out', outPath], 120000);
      return readFileSync(outPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async deleteArchive(archiveName) {
    const { archivesId } = await this.#ensureArchivesFolder();
    const fileId = await this.#findChild(archiveName, archivesId);
    if (fileId) {
      await this.#runMutate(['mutate', 'trash', fileId], 60000);
    }
  }

  async listArchives() {
    const { archivesId } = await this.#ensureArchivesFolder();
    const parsed = await this.#runJson(['readonly', 'ls', archivesId, '--max', '0', '--json'], 60000);
    return GdriveCliBackend.extractItems(parsed)
      .filter((item) => item.name && !item.trashed)
      .map((item) => String(item.name));
  }
}

/** Manages interactive `gdrive auth login` subprocess flow. */
export class GdriveAuthFlowManager {
  constructor(home) {
    this.home = home;
    this._proc = null;
    this._status = { status: 'idle', authUrl: '', accountEmail: '', error: '' };
  }

  getStatus() {
    return { ...this._status };
  }

  logout(binary = '') {
    const cmd = detectGdriveCli(binary, this.home);
    if (cmd) {
      try {
        runExec(cmd, ['auth', 'logout'], { timeout: 15000 });
      } catch {}
    }
    this._status = { status: 'idle', authUrl: '', accountEmail: '', error: '' };
  }

  async startLogin({ binary = '', openBrowser = true, timeoutMs = 300000 } = {}) {
    const cmd = detectGdriveCli(binary, this.home);
    if (!cmd) throw new BackendError('未检测到官方 gdrive 插件工具');

    if (this._proc && this._proc.exitCode === null) {
      try {
        this._proc.kill();
      } catch {}
    }

    this._status = { status: 'waiting', authUrl: '', accountEmail: '', error: '' };
    const [exe, prefix] = cmd;
    const child = spawn(exe, [...prefix, 'auth', 'login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._proc = child;

    let collected = '';
    let opened = false;
    let urlTimer = null;

    const urlPromise = new Promise((resolveUrl) => {
      urlTimer = setTimeout(() => resolveUrl(null), 5000);
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        collected += text;
        const m = text.match(/https:\/\/[^\s"'<>]+/);
        if (m && !this._status.authUrl) {
          this._status.authUrl = m[0];
          if (openBrowser && !opened) {
            opened = true;
            openBrowserUrl(m[0]);
          }
          clearTimeout(urlTimer);
          resolveUrl(m[0]);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    });

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        const st = new GdriveCliBackend({ binary, home: this.home }).checkAuthStatus();
        this._status.status = 'success';
        this._status.accountEmail = st.account || 'Google 账号';
        this._status.error = '';
      } else {
        const msg = collected.trim().slice(-300) || `退出码 ${code}`;
        this._status.status = 'error';
        this._status.error = `登录失败: ${msg}`;
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      this._status.status = 'error';
      this._status.error = err.message;
    });

    await urlPromise;
    return this.getStatus();
  }
}

/** Manages interactive loopback OAuth 2.0 PKCE sign-in for Google Drive API. */
export class OAuthFlowManager {
  constructor(
    configStore,
    { authUrl = GOOGLE_AUTH_URL, tokenUrl = GOOGLE_TOKEN_URL, apiBase = GOOGLE_DRIVE_API_BASE } = {},
  ) {
    this.configStore = configStore;
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this._server = null;
    this._timeout = null;
    this._status = { status: 'idle', authUrl: '', redirectUri: '', accountEmail: '', error: '' };
  }

  getStatus() {
    return { ...this._status };
  }

  #stopServer() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    if (this._server) {
      try {
        this._server.close();
      } catch {}
      this._server = null;
    }
  }

  async exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret = '' }) {
    const form = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    if (clientSecret) form.set('client_secret', clientSecret);

    const resp = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new BackendError(`OAuth token exchange failed (${resp.status}): ${detail}`);
    }
    const tokenData = await resp.json();
    const accessToken = tokenData.access_token || '';
    if (!accessToken) throw new BackendError('OAuth response missing access_token');

    const expiresIn = Number.parseInt(tokenData.expires_in ?? 3600, 10);
    const existing = this.configStore.getTokens() || {};
    const tokens = {
      access_token: accessToken,
      refresh_token: tokenData.refresh_token || existing.refresh_token || '',
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || GOOGLE_DRIVE_SCOPE,
      account_email: existing.account_email || '',
      account_name: existing.account_name || '',
    };

    try {
      const aboutResp = await fetch(`${this.apiBase}/about?fields=user(displayName,emailAddress)`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (aboutResp.ok) {
        const about = await aboutResp.json();
        tokens.account_email = about?.user?.emailAddress || '';
        tokens.account_name = about?.user?.displayName || '';
      }
    } catch {}

    this.configStore.saveTokens(tokens);
    return tokens;
  }

  async startFlow({ openBrowser = true, timeoutMs = 300000 } = {}) {
    const settings = this.configStore.getSettings();
    const clientId = String(settings.oauth?.clientId || '').trim();
    const clientSecret = String(settings.oauth?.clientSecret || '').trim();
    if (!clientId) throw new BackendError('请先填写 Google OAuth Client ID');

    this.#stopServer();
    const { verifier, challenge } = generatePkcePair();
    const state = randomBytes(18).toString('base64url');
    let redirectUri = '';

    const server = createServer(async (req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      if (parsed.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const recvState = parsed.searchParams.get('state') || '';
      const code = parsed.searchParams.get('code') || '';
      const err = parsed.searchParams.get('error') || '';

      if (err) {
        this._status.status = 'error';
        this._status.error = `Google 授权被拒绝或失败: ${err}`;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset='utf-8'><h3>Google 授权失败</h3><p>${escapeHtml(err)}</p>`);
        this.#stopServer();
        return;
      }

      if (!code || recvState !== state) {
        this._status.status = 'error';
        this._status.error = 'OAuth state 校验失败或缺少授权码';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end("<!doctype html><meta charset='utf-8'><h3>授权校验失败</h3><p>请返回 Antigravity 重试。</p>");
        this.#stopServer();
        return;
      }

      try {
        const tokens = await this.exchangeCode({
          code,
          redirectUri,
          codeVerifier: verifier,
          clientId,
          clientSecret,
        });
        this._status.status = 'success';
        this._status.accountEmail = tokens.account_email || '';
        this._status.error = '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:32px'><h2>授权成功</h2><p>已连接 ${escapeHtml(tokens.account_email || 'Google 账号')}。你可以关闭此页面并返回 Antigravity。</p></body>`,
        );
      } catch (e) {
        this._status.status = 'error';
        this._status.error = e.message;
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset='utf-8'><h3>获取令牌失败</h3><p>${escapeHtml(e.message)}</p>`);
      } finally {
        this.#stopServer();
      }
    });

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });

    const port = server.address().port;
    redirectUri = `http://127.0.0.1:${port}/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    const fullAuthUrl = `${this.authUrl}?${params.toString()}`;
    this._server = server;
    this._status = {
      status: 'waiting',
      authUrl: fullAuthUrl,
      redirectUri,
      accountEmail: '',
      error: '',
    };

    this._timeout = setTimeout(() => {
      if (this._status.status === 'waiting') {
        this._status.status = 'error';
        this._status.error = 'OAuth 登录等待超时，请重试';
      }
      this.#stopServer();
    }, timeoutMs);

    if (openBrowser) openBrowserUrl(fullAuthUrl);
    return { status: 'waiting', authUrl: fullAuthUrl, redirectUri, state };
  }
}

/** Google Drive v3 REST backend using native Node.js fetch and OAuth 2.0. */
export class GoogleDriveOAuthBackend {
  constructor({
    configStore,
    folderName = 'AntigravityPluginSync',
    tokenUrl = GOOGLE_TOKEN_URL,
    apiBase = GOOGLE_DRIVE_API_BASE,
    uploadBase = GOOGLE_DRIVE_UPLOAD_BASE,
  }) {
    this.configStore = configStore;
    this.folderName = folderName;
    this.tokenUrl = tokenUrl;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.uploadBase = uploadBase.replace(/\/+$/, '');
    this._rootFolderId = null;
    this._archivesFolderId = null;
  }

  async #getValidAccessToken() {
    const tokens = this.configStore.getTokens();
    if (!tokens?.access_token) {
      throw new BackendError('尚未登录 Google 账号，请先完成 OAuth 授权');
    }
    const expiresAt = Number(tokens.expires_at || 0);
    if (expiresAt - 60 > Date.now() / 1000) {
      return String(tokens.access_token);
    }
    const refreshToken = String(tokens.refresh_token || '');
    if (!refreshToken) {
      throw new BackendError('Google OAuth 令牌已过期且缺少 refresh_token，请重新登录');
    }

    const settings = this.configStore.getSettings();
    const clientId = String(settings.oauth?.clientId || '').trim();
    const clientSecret = String(settings.oauth?.clientSecret || '').trim();
    if (!clientId) throw new BackendError('缺少 Google OAuth Client ID，无法刷新令牌');

    const form = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (clientSecret) form.set('client_secret', clientSecret);

    const resp = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!resp.ok) {
      throw new BackendError(`刷新 Google 令牌失败 (${resp.status}): ${await resp.text()}`);
    }
    const refreshed = await resp.json();
    if (!refreshed.access_token) throw new BackendError('刷新令牌响应中缺少 access_token');

    tokens.access_token = refreshed.access_token;
    tokens.expires_at = Math.floor(Date.now() / 1000) + Number.parseInt(refreshed.expires_in ?? 3600, 10);
    if (refreshed.refresh_token) tokens.refresh_token = refreshed.refresh_token;
    this.configStore.saveTokens(tokens);
    return String(tokens.access_token);
  }

  async #request(url, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
    const token = await this.#getValidAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new BackendError(`Google Drive API 错误 (${resp.status}): ${await resp.text()}`);
      }
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
    }
  }

  async #requestJson(url, { method = 'GET', bodyObj } = {}) {
    const headers = {};
    let body;
    if (bodyObj !== undefined) {
      body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    const raw = await this.#request(url, { method, body, headers });
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  }

  async #findChild(name, parentId = null, mimeType = null) {
    const clauses = [
      `name = '${escapeDriveQuery(name)}'`,
      'trashed = false',
      parentId ? `'${escapeDriveQuery(parentId)}' in parents` : "'root' in parents",
    ];
    if (mimeType) clauses.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
    const q = encodeURIComponent(clauses.join(' and '));
    const data = await this.#requestJson(`${this.apiBase}/files?q=${q}&fields=files(id,name)&pageSize=10`);
    return data.files?.[0]?.id ? String(data.files[0].id) : null;
  }

  async #ensureFolder(name, parentId = null) {
    const folderMime = 'application/vnd.google-apps.folder';
    const found = await this.#findChild(name, parentId, folderMime);
    if (found) return found;
    const meta = { name, mimeType: folderMime };
    if (parentId) meta.parents = [parentId];
    const created = await this.#requestJson(`${this.apiBase}/files?fields=id`, { method: 'POST', bodyObj: meta });
    return String(created.id);
  }

  async #ensureFolders() {
    if (!this._rootFolderId) {
      this._rootFolderId = await this.#ensureFolder(this.folderName, null);
    }
    if (!this._archivesFolderId) {
      this._archivesFolderId = await this.#ensureFolder('archives', this._rootFolderId);
    }
    return { rootId: this._rootFolderId, archivesId: this._archivesFolderId };
  }

  async #uploadMultipart(name, parentId, contentType, payloadBuf) {
    const boundary = `----antigravity-sync-${randomBytes(8).toString('hex')}`;
    const metaBuf = Buffer.from(JSON.stringify({ name, parents: [parentId] }), 'utf8');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, 'utf8'),
      metaBuf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
      payloadBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const raw = await this.#request(`${this.uploadBase}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      timeoutMs: 120000,
    });
    return String(JSON.parse(raw.toString('utf8')).id);
  }

  async #updateMedia(fileId, contentType, payloadBuf) {
    await this.#request(`${this.uploadBase}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
      method: 'PATCH',
      body: payloadBuf,
      headers: { 'Content-Type': contentType },
      timeoutMs: 120000,
    });
  }

  async testConnection() {
    const about = await this.#requestJson(`${this.apiBase}/about?fields=user(displayName,emailAddress)`);
    const email = String(about?.user?.emailAddress || '');
    const tokens = this.configStore.getTokens() || {};
    if (email && email !== tokens.account_email) {
      tokens.account_email = email;
      tokens.account_name = about?.user?.displayName || '';
      this.configStore.saveTokens(tokens);
    }
    const { rootId } = await this.#ensureFolders();
    return {
      ok: true,
      account: email || String(about?.user?.displayName || 'Google Drive'),
      detail: `已连接 Google Drive 文件夹 ${this.folderName} (ID: ${rootId.slice(0, 8)}…)`,
    };
  }

  async readManifest() {
    const { rootId } = await this.#ensureFolders();
    const fileId = await this.#findChild('manifest.json', rootId);
    if (!fileId) return null;
    const raw = await this.#request(`${this.apiBase}/files/${encodeURIComponent(fileId)}?alt=media`);
    return JSON.parse(raw.toString('utf8'));
  }

  async writeManifest(manifest) {
    const { rootId } = await this.#ensureFolders();
    const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const fileId = await this.#findChild('manifest.json', rootId);
    if (fileId) {
      await this.#updateMedia(fileId, 'application/json; charset=utf-8', payload);
    } else {
      await this.#uploadMultipart('manifest.json', rootId, 'application/json; charset=utf-8', payload);
    }
  }

  async uploadArchive(archiveName, data) {
    const { archivesId } = await this.#ensureFolders();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const existingId = await this.#findChild(archiveName, archivesId);
    if (existingId) {
      await this.#updateMedia(existingId, 'application/zip', buf);
    } else {
      await this.#uploadMultipart(archiveName, archivesId, 'application/zip', buf);
    }
  }

  async downloadArchive(archiveName) {
    const { archivesId } = await this.#ensureFolders();
    const fileId = await this.#findChild(archiveName, archivesId);
    if (!fileId) throw new BackendError(`Google Drive 上未找到插件压缩包: ${archiveName}`);
    return this.#request(`${this.apiBase}/files/${encodeURIComponent(fileId)}?alt=media`, { timeoutMs: 120000 });
  }

  async deleteArchive(archiveName) {
    const { archivesId } = await this.#ensureFolders();
    const fileId = await this.#findChild(archiveName, archivesId);
    if (fileId) {
      await this.#request(`${this.apiBase}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    }
  }

  async listArchives() {
    const { archivesId } = await this.#ensureFolders();
    const q = encodeURIComponent(`'${escapeDriveQuery(archivesId)}' in parents and trashed = false`);
    const data = await this.#requestJson(`${this.apiBase}/files?q=${q}&fields=files(name)&pageSize=1000`);
    return (data.files || []).filter((x) => x.name).map((x) => String(x.name));
  }
}

export function detectRclone(binary = 'rclone') {
  if (binary && existsSync(binary)) return binary;
  return whichSync(binary || 'rclone');
}

export function listRcloneRemotes(binary = 'rclone', execFn = execFileSync) {
  const exe = detectRclone(binary);
  if (!exe) return [];
  try {
    const out = execFn(exe, ['listremotes', '--long'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const remotes = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      remotes.push({ name: trimmed.slice(0, idx).trim(), type: trimmed.slice(idx + 1).trim() });
    }
    return remotes;
  } catch {
    return [];
  }
}

/** Google Drive backend powered by an existing local `rclone` remote. */
export class RcloneDriveBackend {
  constructor({ remote, folderName = 'AntigravityPluginSync', binary = 'rclone', detectFn, execFn } = {}) {
    const clean = String(remote || '').trim().replace(/:+$/, '');
    if (!clean) throw new BackendError('未配置 rclone remote 名称');
    this.remote = clean;
    this.folderName = folderName;
    this.binary = binary || 'rclone';
    this._detectFn = detectFn || detectRclone;
    this._execFn = execFn || execFileSync;
  }

  #exe() {
    const exe = this._detectFn(this.binary);
    if (!exe) throw new BackendError(`未找到 rclone 可执行文件 (${this.binary})，请先安装并配置 rclone`);
    return exe;
  }

  #run(args, timeout = 120000) {
    const exe = this.#exe();
    try {
      const out = this._execFn(exe, args, {
        encoding: null,
        timeout,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return Buffer.isBuffer(out) ? out : Buffer.from(String(out || ''), 'utf8');
    } catch (err) {
      const stderr = err.stderr ? Buffer.from(err.stderr).toString('utf8').trim() : err.message;
      throw new BackendError(`rclone 执行失败: ${stderr}`);
    }
  }

  #remoteRoot() {
    return `${this.remote}:${this.folderName}`;
  }

  #remoteArchives() {
    return `${this.remote}:${this.folderName}/archives`;
  }

  #ensureDirs() {
    this.#run(['mkdir', this.#remoteArchives()], 30000);
  }

  async testConnection() {
    this.#ensureDirs();
    this.#run(['lsjson', this.#remoteRoot(), '--max-depth', '1'], 30000);
    return {
      ok: true,
      account: `rclone (${this.remote}:)`,
      detail: `已连接 ${this.#remoteRoot()}`,
    };
  }

  async readManifest() {
    this.#ensureDirs();
    const lsRaw = this.#run(['lsjson', this.#remoteRoot(), '--files-only'], 30000).toString('utf8');
    const entries = JSON.parse(lsRaw || '[]');
    if (!entries.some((item) => item.Name === 'manifest.json')) return null;
    const catRaw = this.#run(['cat', `${this.#remoteRoot()}/manifest.json`], 60000).toString('utf8');
    return JSON.parse(catRaw);
  }

  async writeManifest(manifest) {
    this.#ensureDirs();
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-rc-'));
    try {
      const tmpPath = join(tmp, 'manifest.json');
      writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      this.#run(['copyto', tmpPath, `${this.#remoteRoot()}/manifest.json`], 60000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async uploadArchive(archiveName, data) {
    this.#ensureDirs();
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-rc-'));
    try {
      const tmpPath = join(tmp, archiveName);
      writeFileSync(tmpPath, data);
      this.#run(['copyto', tmpPath, `${this.#remoteArchives()}/${archiveName}`], 120000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async downloadArchive(archiveName) {
    const tmp = mkdtempSync(join(tmpdir(), 'agysync-rc-'));
    try {
      const tmpPath = join(tmp, archiveName);
      this.#run(['copyto', `${this.#remoteArchives()}/${archiveName}`, tmpPath], 120000);
      return readFileSync(tmpPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async deleteArchive(archiveName) {
    try {
      this.#run(['deletefile', `${this.#remoteArchives()}/${archiveName}`], 60000);
    } catch {}
  }

  async listArchives() {
    this.#ensureDirs();
    try {
      const raw = this.#run(['lsjson', this.#remoteArchives(), '--files-only'], 30000).toString('utf8');
      return JSON.parse(raw || '[]').filter((x) => x.Name).map((x) => String(x.Name));
    } catch {
      return [];
    }
  }
}

/** Instantiate the configured DriveBackend, or null if not configured yet. */
export function buildBackend(configStore) {
  const settings = configStore.getSettings();
  const kind = settings.backend || 'none';
  const folderName = String(settings.folderName || 'AntigravityPluginSync');

  if (kind === 'gdrive') {
    const binary = String(settings.gdrive?.binary || '').trim();
    if (!detectGdriveCli(binary)) return null;
    return new GdriveCliBackend({ configStore, folderName, binary });
  }
  if (kind === 'oauth') {
    const tokens = configStore.getTokens();
    if (!tokens?.access_token) return null;
    return new GoogleDriveOAuthBackend({ configStore, folderName });
  }
  if (kind === 'rclone') {
    const remote = String(settings.rclone?.remote || '').trim();
    const binary = String(settings.rclone?.binary || 'rclone').trim();
    if (!remote) return null;
    return new RcloneDriveBackend({ remote, folderName, binary });
  }
  return null;
}
