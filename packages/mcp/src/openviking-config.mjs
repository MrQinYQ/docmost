import { isAbsolute, resolve } from 'node:path';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validOpenVikingIdentifier(value) {
  return typeof value === 'string' && identifier.test(value) && value !== '.' && value !== '..';
}

export function validOpenVikingUri(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\?#\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.replace(/\/$/, '').split('/');
  if (parts[0] !== 'viking:' || parts[1] !== '') return false;
  const start = parts[2] === 'resources' ? 3 : 5;
  if (start === 5 && (parts[2] !== 'user' || !validOpenVikingIdentifier(parts[3]) || parts[4] !== 'resources')) return false;
  if (parts.length <= start) return false;
  try {
    return parts.slice(start).every(part => {
      const decoded = decodeURIComponent(part);
      return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(decoded);
    });
  } catch { return false; }
}

export function openVikingUriMatchesUser(uri, userId) {
  return validOpenVikingUri(uri) && (uri.startsWith('viking://resources/') || uri.split('/')[3] === userId);
}

// An optional integration must never prevent the independent Docmost connection.
export function loadOpenVikingConfig(env = process.env) {
  const url = env.DOCMOST_OPENVIKING_URL?.trim();
  if (!url) return undefined;
  const fail = message => ({ error: { code: 'OV_CONFIG_ERROR', message } });
  let base;
  try { base = new URL(url); }
  catch { return fail('DOCMOST_OPENVIKING_URL must be an OpenViking deployment root URL.'); }
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname))
    return fail('OpenViking URL must be a deployment root without credentials, API paths, query or fragment.');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    return fail('OpenViking requires HTTPS, or HTTP on a loopback host.');
  const apiKeyFile = env.DOCMOST_OPENVIKING_API_KEY_FILE?.trim();
  if (!apiKeyFile || !isAbsolute(apiKeyFile))
    return fail('Set DOCMOST_OPENVIKING_API_KEY_FILE to an absolute private file path.');
  const timeoutMs = Number(env.DOCMOST_OPENVIKING_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    return fail('DOCMOST_OPENVIKING_TIMEOUT_MS must be an integer from 100 to 120000.');
  const accountId = env.DOCMOST_OPENVIKING_ACCOUNT?.trim() || undefined;
  const userId = env.DOCMOST_OPENVIKING_USER?.trim() || undefined;
  if ((accountId && !validOpenVikingIdentifier(accountId)) || (userId && !validOpenVikingIdentifier(userId)))
    return fail('Expected OpenViking account and user must be safe identifiers.');
  const scope = env.DOCMOST_OPENVIKING_SCOPE?.trim() || 'personal';
  if (!['personal', 'shared'].includes(scope)) return fail('DOCMOST_OPENVIKING_SCOPE must be personal or shared.');
  const rootUri = env.DOCMOST_OPENVIKING_ROOT_URI?.trim().replace(/\/$/, '') || (scope === 'shared' ? 'viking://resources/docmost-mcp' : undefined);
  if (rootUri && !validOpenVikingUri(rootUri))
    return fail('OpenViking mirror root must be a concrete resources directory.');
  if (rootUri && rootUri.startsWith('viking://resources/') !== (scope === 'shared'))
    return fail('OpenViking root must match the explicitly selected personal or shared scope.');
  if (rootUri && userId && !openVikingUriMatchesUser(rootUri, userId))
    return fail('OpenViking mirror root must belong to the expected user.');
  return { origin: base.origin, apiBase: `${base.origin}/api/v1/`, timeoutMs, apiKeyFile: resolve(apiKeyFile), accountId, userId, rootUri, scope };
}
