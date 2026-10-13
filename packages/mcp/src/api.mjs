import { ApiError } from './errors.mjs';
export { ApiError } from './errors.mjs';
const paths = new Set([
  'users/me', 'sessions', 'auth/logout', 'spaces', 'spaces/info', 'spaces/create', 'spaces/update',
  'search', 'search-attachments', 'workspace/members', 'comments', 'comments/create', 'comments/update',
  'pages/recent', 'pages/info', 'pages/sidebar-pages', 'pages/create', 'pages/update',
  'pages/duplicate', 'pages/move', 'pages/move-to-space', 'pages/delete', 'pages/restore',
]);
const MAX_BYTES = 4 * 1024 * 1024;

async function missingAttachmentRoute(response) {
  // Inspect only a bounded routing-error marker; never surface upstream error bodies.
  const maxBytes = 16 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return false;
  }
  const reader = response.body?.getReader();
  if (!reader) return false;
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let error;
  try { error = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return false; }
  return error?.message === 'Cannot POST /api/search-attachments'
    || error?.message === 'Route POST:/api/search-attachments not found';
}

export function createApiClient(config, fetchImpl = globalThis.fetch) {
  function redact(value) { return value.split(config.token).join('[REDACTED]'); }
  async function post(path, body, cancellation, mutation = false) {
    if (!paths.has(path)) throw new ApiError('INVALID_PATH', 'Unsupported Docmost API path.');
    if (config.authMode === 'session' && config.session?.expiresAt <= Date.now())
      throw new ApiError('UNAUTHENTICATED', 'The personal session expired. Run --login in your own terminal before making another request.');
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
    const failure = (code, message, status) => new ApiError(code, message, { status, mayHaveSucceeded: mutation });
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(new URL(path, config.apiBase), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
      if (!response.ok) {
        if (path === 'search-attachments' && response.status === 404) {
          let missing = false;
          try { missing = await missingAttachmentRoute(response); }
          catch { signal.throwIfAborted(); }
          if (missing)
            throw failure('UNSUPPORTED_DEPLOYMENT', 'This deployment does not expose /api/search-attachments. Attachment search requires a compatible endpoint, provided by this fork.', 404);
        }
        // Error-body cleanup must not replace an already known HTTP status.
        await response.body?.cancel().catch(() => {});
        const codes = { 400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' };
        const hints = {
          401: config.authMode === 'session'
            ? 'The personal session has expired or been revoked. Run --login in your own terminal; passwords must not be sent through MCP tools or chat.'
            : 'Docmost rejected the credential. Check Token expiry/revocation and native API Key support/license in the target deployment.',
          403: 'Docmost denied this operation for the Token user or endpoint.',
          404: 'Docmost could not find the resource or endpoint.',
          429: 'Docmost rate-limited the request. No automatic retry was made.',
        };
        throw failure(codes[response.status] ?? 'REQUEST_FAILED', hints[response.status] ?? 'Docmost returned an unsuccessful response.', response.status);
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel();
        throw failure('RESPONSE_TOO_LARGE', 'Docmost response exceeds 4 MiB; request less content.');
      }
      const reader = response.body?.getReader();
      let size = 0;
      const chunks = [];
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
              await reader.cancel();
              throw failure('RESPONSE_TOO_LARGE', 'Docmost response exceeds 4 MiB; request less content.');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return undefined;
      let envelope;
      try { envelope = JSON.parse(text); }
      catch { throw failure('INVALID_RESPONSE', 'Docmost returned invalid JSON. Check the deployment URL and version.'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.success !== true)
        throw failure('INVALID_RESPONSE', 'Expected the Docmost API success envelope. Check deployment version.');
      const data = envelope.data;
      return data === undefined ? undefined : JSON.parse(redact(JSON.stringify(data)));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (cancellation?.aborted) throw failure('CANCELLED', 'The client cancelled the request; an in-flight write may have completed.');
      if (timeout.aborted) throw failure('TIMEOUT', 'Docmost request timed out; an in-flight write may have completed.');
      throw failure('NETWORK_ERROR', 'Cannot reach Docmost. Check URL, TLS, network and redirects; an in-flight write may have completed.');
    }
  }
  return { post, redact };
}
