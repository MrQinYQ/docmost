import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ConfigError } from './errors.mjs';
import { loadSession } from './session.mjs';

export { ConfigError } from './errors.mjs';

function flag(env, name) {
  const value = env[name];
  if (value !== undefined && value !== '0' && value !== '1')
    throw new ConfigError(`${name} must be 0 or 1.`);
  return value === '1';
}

export function loadConnectionConfig(env = process.env, { requireDefaultSpace = true } = {}) {
  let base;
  try { base = new URL(env.DOCMOST_URL); }
  catch { throw new ConfigError('Set DOCMOST_URL to the Docmost deployment root URL.'); }
  if (base.username || base.password || base.search || base.hash || !['/', ''].includes(base.pathname))
    throw new ConfigError('DOCMOST_URL must be a deployment root without credentials, /api, query or fragment.');
  const localHttp = flag(env, 'DOCMOST_ALLOW_LOCAL_HTTP');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && localHttp && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    throw new ConfigError('Use HTTPS. Loopback HTTP additionally requires DOCMOST_ALLOW_LOCAL_HTTP=1.');
  const readOnly = flag(env, 'DOCMOST_READ_ONLY');
  const timeoutMs = Number(env.DOCMOST_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw new ConfigError('DOCMOST_TIMEOUT_MS must be an integer from 100 to 120000.');
  let syncRoot = env.DOCMOST_SYNC_ROOT?.trim() || undefined;
  let syncStateDir = env.DOCMOST_SYNC_STATE_DIR?.trim() || undefined;
  if (Boolean(syncRoot) !== Boolean(syncStateDir))
    throw new ConfigError('Set both DOCMOST_SYNC_ROOT and DOCMOST_SYNC_STATE_DIR to enable Markdown synchronization.');
  if (syncRoot) {
    if (!isAbsolute(syncRoot) || !isAbsolute(syncStateDir))
      throw new ConfigError('Markdown sync source and state directories must be absolute paths.');
    syncRoot = resolve(syncRoot);
    syncStateDir = resolve(syncStateDir);
    const contains = (parent, child) => {
      const path = relative(parent, child);
      return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    };
    if (contains(syncRoot, syncStateDir) || contains(syncStateDir, syncRoot))
      throw new ConfigError('Markdown sync source and private state directories must be separate, with neither containing the other.');
  }

  function configuredUuid(name) {
    const value = env[name]?.trim();
    if (!value) return undefined;
    if (!z.uuid().safeParse(value).success)
      throw new ConfigError(`${name} must be a canonical UUID returned by Docmost.`);
    return value.toLowerCase();
  }
  const defaultSpaceId = configuredUuid('DOCMOST_DEFAULT_SPACE_ID');
  const defaultParentPageId = configuredUuid('DOCMOST_DEFAULT_PARENT_PAGE_ID');
  if (!defaultSpaceId && (requireDefaultSpace || defaultParentPageId))
    throw new ConfigError('Set DOCMOST_DEFAULT_SPACE_ID. Use --list-spaces first to choose an accessible space; the default parent page is optional.');

  const authMode = env.DOCMOST_AUTH_MODE ?? 'api_key';
  if (!['api_key', 'session'].includes(authMode))
    throw new ConfigError('DOCMOST_AUTH_MODE must be session or api_key; automatic fallback is not supported.');
  if (env.DOCMOST_PASSWORD || env.DOCMOST_LOGIN_PASSWORD)
    throw new ConfigError('Passwords are not accepted through environment variables. Run --login in your own terminal and enter the password privately.');
  const sessionFile = env.DOCMOST_SESSION_FILE?.trim();
  if (authMode === 'session') {
    if (!sessionFile || !isAbsolute(sessionFile))
      throw new ConfigError('Session mode requires DOCMOST_SESSION_FILE as an absolute private file path.');
    if (env.DOCMOST_API_TOKEN || env.DOCMOST_API_TOKEN_FILE)
      throw new ConfigError('Session mode cannot use DOCMOST_API_TOKEN or DOCMOST_API_TOKEN_FILE.');
  } else if (sessionFile) {
    throw new ConfigError('API Key mode cannot use DOCMOST_SESSION_FILE. Select exactly one authentication mode.');
  }
  return { origin: base.origin, apiBase: `${base.origin}/api/`, timeoutMs, readOnly, defaultSpaceId, defaultParentPageId, authMode, sessionFile, allowLocalHttp: localHttp, syncRoot, syncStateDir };
}

export async function loadConfig(env = process.env, options = {}) {
  const config = loadConnectionConfig(env, options);
  if (config.authMode === 'session') {
    const session = await loadSession(config.sessionFile, config.origin);
    return { ...config, token: session.token, session };
  }

  const direct = env.DOCMOST_API_TOKEN;
  const file = env.DOCMOST_API_TOKEN_FILE;
  if (Boolean(direct) === Boolean(file))
    throw new ConfigError('Set exactly one of DOCMOST_API_TOKEN or DOCMOST_API_TOKEN_FILE.');
  let token = direct;
  if (file) {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())))
        throw new ConfigError('Token file must be a private, owner-owned regular file (mode 0600), at most 64 KiB.');
      token = await handle.readFile('utf8');
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError('Cannot read the private Token file. Check the path, owner and permissions; symlinks are not supported.');
    } finally { await handle?.close(); }
  }
  token = token.trim();
  if (!token || token.length > 65536 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw new ConfigError('API Token must use valid Bearer-token characters without internal whitespace.');
  // This is only a local credential-kind check, not authentication. The server
  // alone validates signatures, expiry, license, identity and permissions.
  const parts = token.split('.');
  if (parts.length === 3) {
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
    catch { throw new ConfigError('The configured API Token has an invalid JWT payload.'); }
    if (payload.type !== 'api_key')
      throw new ConfigError('Configure an API Key, not a browser session or OAuth credential.');
  }
  return { ...config, token };
}
