import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, parse, join, relative } from 'node:path';
import { ApiError } from './errors.mjs';
import { validOpenVikingIdentifier, validOpenVikingUri, openVikingUriMatchesUser } from './openviking-config.mjs';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1_000_000;
const taskIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const taskStatuses = new Set(['pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled']);
const processingModes = new Set(['vectors_only', 'semantic_and_vectors', 'prune_orphans']);
const httpCodes = { 400: 'OV_INVALID_REQUEST', 401: 'OV_UNAUTHENTICATED', 403: 'OV_FORBIDDEN', 404: 'OV_NOT_FOUND', 409: 'OV_CONFLICT', 429: 'OV_RATE_LIMITED' };
export const OPENVIKING_ERROR_CODES = new Set([
  ...Object.values(httpCodes), 'OV_CONFIG_ERROR', 'OV_INVALID_RESPONSE', 'OV_IDENTITY_CHANGED',
  'OV_REQUEST_FAILED', 'OV_REDIRECT', 'OV_RESPONSE_TOO_LARGE', 'OV_CANCELLED', 'OV_TIMEOUT',
  'OV_NETWORK_ERROR', 'OV_PROCESSING_FAILED', 'OV_PROCESSING_PENDING', 'OV_TREE_BUSY',
]);

async function boundedErrorBody(response) {
  const limit = 16 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return undefined; }
  return body;
}
async function confirmsMissingResource(response, uri, allowDirectory = false) {
  const body = await boundedErrorBody(response);
  return body?.status === 'error' && body.error?.code === 'NOT_FOUND'
    && body.error.details?.resource === uri
    && (body.error.details?.type === 'file' || (allowDirectory && body.error.details?.type === 'directory'));
}

async function readPrivateKey(file) {
  const failure = () => new ApiError('OV_CONFIG_ERROR', 'Cannot read the private OpenViking API Key file. Use an owner-owned regular file with private permissions; symlinks are not supported.');
  let handle;
  try {
    if (!isAbsolute(file)) throw failure();
    let current = parse(file).root;
    for (const part of relative(current, file).split(/[\\/]/)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw failure();
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw failure();
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw failure();
    const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
    if (!key || key.length > 65536 || !/^[A-Za-z0-9._~+/-]+=*$/.test(key)) throw failure();
    return key;
  } catch { throw failure(); }
  finally { await handle?.close(); }
}

export function createOpenVikingClient(config, { fetchImpl = globalThis.fetch } = {}) {
  let keyPromise;
  let key;
  let confirmedIdentity;
  const invalid = (mutation = false) => new ApiError('OV_INVALID_RESPONSE', 'OpenViking returned an invalid response. Check the deployment version.', { mayHaveSucceeded: mutation });
  const redact = value => typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
  const clean = value => value === undefined ? undefined : JSON.parse(redact(JSON.stringify(value)));
  const failRequest = message => new ApiError('OV_INVALID_REQUEST', message);
  function checkUri(uri) {
    if (!validOpenVikingUri(uri)) throw failRequest('OpenViking operations require a safe resource URI.');
    const expectedRoot = confirmedIdentity?.rootUri ?? config?.rootUri;
    const expectedUser = confirmedIdentity?.userId ?? config?.userId;
    if (expectedUser && !openVikingUriMatchesUser(uri, expectedUser)) throw failRequest('OpenViking resource URI is outside the configured user.');
    if (expectedRoot && uri !== expectedRoot && !uri.startsWith(`${expectedRoot}/`)) throw failRequest('OpenViking resource URI is outside the configured mirror root.');
  }
  function checkTaskId(id) {
    if (typeof id !== 'string' || !taskIdentifier.test(id)) throw failRequest('Invalid OpenViking task identifier.');
  }
  async function getKey() {
    if (config?.error) throw new ApiError('OV_CONFIG_ERROR', config.error.message);
    if (!config?.origin || !config.apiBase || !config.apiKeyFile || !Number.isInteger(config.timeoutMs))
      throw new ApiError('OV_CONFIG_ERROR', 'Configure the optional OpenViking URL and private API Key file first.');
    keyPromise ??= readPrivateKey(config.apiKeyFile);
    key = await keyPromise;
    return key;
  }
  async function request(path, { method = 'GET', body, query, cancellation, mutation = false, missing = false, health = false, processingWait = false } = {}) {
    const timeout = AbortSignal.timeout(config?.timeoutMs ?? 30000);
    const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
    let sent = false;
    const failure = (code, message, status, uncertain = sent && mutation) => new ApiError(code, message, { status, mayHaveSucceeded: uncertain });
    try {
      signal.throwIfAborted();
      await getKey();
      signal.throwIfAborted();
      const url = health ? new URL('/health', config.origin) : new URL(path, config.apiBase);
      if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
      sent = true;
      const response = await fetchImpl(url, {
        method, headers: { 'X-API-Key': key, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', credentials: 'omit', signal,
      });
      if (!response.ok) {
        if (response.status === 404 && missing && await confirmsMissingResource(response, query.uri, missing === 'directory')) return undefined;
        if (response.status === 504 && processingWait) {
          const envelope = await boundedErrorBody(response);
          if (envelope?.status === 'error' && envelope.error?.code === 'DEADLINE_EXCEEDED')
            throw failure('OV_PROCESSING_PENDING', 'OpenViking queue work is still pending. Wait again without replaying a confirmed mutation.', response.status, false);
        }
        await response.body?.cancel().catch(() => {});
        if (response.status >= 300 && response.status < 400) throw failure('OV_REDIRECT', 'OpenViking redirects are not allowed.', response.status, false);
        throw failure(httpCodes[response.status] ?? 'OV_REQUEST_FAILED', 'OpenViking rejected the request. Check authentication, permissions, target and deployment status.', response.status, mutation && response.status >= 500);
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw failure('OV_RESPONSE_TOO_LARGE', 'OpenViking response exceeds the 4 MiB bound.');
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw failure('OV_RESPONSE_TOO_LARGE', 'OpenViking response exceeds the 4 MiB bound.');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw invalid(sent && mutation); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw invalid(sent && mutation);
      if (health) return clean(envelope);
      if (envelope.status === 'error') throw failure('OV_REQUEST_FAILED', 'OpenViking reported an unsuccessful operation. Read the target before retrying a write.');
      if (envelope.status !== 'ok' || !Object.hasOwn(envelope, 'result')) throw invalid(sent && mutation);
      return clean(envelope.result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (cancellation?.aborted) throw failure('OV_CANCELLED', 'OpenViking request was cancelled; a dispatched mutation may have completed.');
      if (timeout.aborted) throw failure('OV_TIMEOUT', 'OpenViking request timed out; a dispatched mutation may have completed.');
      throw failure('OV_NETWORK_ERROR', 'Cannot reach OpenViking. Check URL, TLS, network and redirects; a dispatched mutation may have completed.');
    }
  }
  function hasQueueFailure(queue) {
    if (queue === undefined || queue === null) return false;
    if (typeof queue !== 'object' || Array.isArray(queue)) throw invalid(true);
    return ['Semantic', 'Embedding'].some(name => {
      const state = queue[name];
      if (!state) return false;
      if (typeof state !== 'object' || Array.isArray(state)) throw invalid(true);
      if (state.error_count !== undefined && (!Number.isInteger(state.error_count) || state.error_count < 0)) throw invalid(true);
      if (state.errors !== undefined && !Array.isArray(state.errors)) throw invalid(true);
      return (state.error_count ?? 0) > 0 || (state.errors?.length ?? 0) > 0;
    });
  }
  function normalizeTask(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !taskIdentifier.test(data.task_id ?? '') || !taskStatuses.has(data.status)) throw invalid();
    const result = data.result;
    if (result !== undefined && result !== null && (typeof result !== 'object' || Array.isArray(result))) throw invalid();
    const count = name => {
      const value = result?.[name];
      if (value === undefined || value === null) return undefined;
      if (!Number.isInteger(value) || value < 0) throw invalid();
      return value;
    };
    const warnings = result?.warnings ?? [];
    if (!Array.isArray(warnings) || warnings.some(item => typeof item !== 'string')) throw invalid();
    if (data.status === 'completed' && count('failed_records') === undefined) throw invalid();
    return {
      taskId: data.task_id, status: data.status, uri: result?.uri ?? data.resource_id,
      failedRecords: count('failed_records'), unsupportedRecords: count('unsupported_records'),
      warnings: warnings.map(warning => warning.slice(0, 512)),
      ...(data.status === 'failed' && typeof data.error === 'string' && /^lock acquire timed out after \d+ms$/.test(data.error)
        ? { failureCode: 'OV_TREE_BUSY' } : {}),
      ...(typeof data.error === 'string' && data.error ? { error: 'OpenViking task failed. Inspect its status through the configured deployment.' } : {}),
    };
  }
  async function identity(signal) {
    const data = await request('', { cancellation: signal, health: true });
    if (data.status !== 'ok' || data.healthy !== true || !validOpenVikingIdentifier(data.account_id) || !validOpenVikingIdentifier(data.user_id) || !['admin', 'user'].includes(data.role)) throw invalid();
    const rootUri = config.rootUri ?? `viking://user/${data.user_id}/resources/docmost-mcp`;
    if ((config.accountId && config.accountId !== data.account_id) || (config.userId && config.userId !== data.user_id) || !openVikingUriMatchesUser(rootUri, data.user_id))
      throw new ApiError('OV_IDENTITY_CHANGED', 'The authenticated OpenViking identity does not match the configured account, user or selected resource root.');
    const result = { accountId: data.account_id, userId: data.user_id, role: data.role, rootUri };
    if (confirmedIdentity && (confirmedIdentity.accountId !== result.accountId || confirmedIdentity.userId !== result.userId))
      throw new ApiError('OV_IDENTITY_CHANGED', 'The authenticated OpenViking identity changed. Existing mirror tasks cannot be retargeted.');
    confirmedIdentity = result;
    return result;
  }
  async function read(uri, signal) {
    checkUri(uri);
    const result = await request('content/read', { query: { uri, raw: true }, cancellation: signal, missing: true });
    if (result !== undefined && typeof result !== 'string') throw invalid();
    return result;
  }
  async function write(uri, content, signal) {
    checkUri(uri);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) throw failRequest('OpenViking mirrored content must be text no larger than 1,000,000 bytes.');
    const result = await request('content/write', { method: 'POST', body: { uri, content, mode: 'replace', processing_mode: 'vectors_only', wait: true, timeout: config.timeoutMs / 1000 }, cancellation: signal, mutation: true });
    if (!result || result.uri !== uri || result.content_updated !== true || !Number.isInteger(result.written_bytes) || result.written_bytes < 0) throw invalid(true);
    if (['failed'].includes(result.semantic_status) || ['failed'].includes(result.vector_status) || hasQueueFailure(result.queue_status))
      throw new ApiError('OV_PROCESSING_FAILED', 'OpenViking saved content but processing reported errors. Read the target before repairing its index.', { mayHaveSucceeded: true });
    if (result.semantic_status !== 'skipped' || result.vector_status !== 'complete')
      throw new ApiError('OV_PROCESSING_PENDING', 'OpenViking content processing has not been confirmed complete. Reconcile before retrying.', { mayHaveSucceeded: true });
    return { uri, contentUpdated: true, writtenBytes: result.written_bytes, semanticStatus: result.semantic_status, vectorStatus: result.vector_status, queueStatus: result.queue_status };
  }
  async function reindex(uri, mode, signal) {
    checkUri(uri);
    if (!processingModes.has(mode)) throw failRequest('Unsupported OpenViking reindex mode.');
    const result = await request('content/reindex', { method: 'POST', body: { uri, mode, recursive: false, wait: false }, cancellation: signal, mutation: true });
    if (!result || !taskIdentifier.test(result.task_id ?? '') || result.status !== 'accepted' || result.uri !== uri) throw invalid(true);
    return { taskId: result.task_id };
  }
  async function task(id, signal) {
    checkTaskId(id);
    const result = normalizeTask(await request(`tasks/${id}`, { cancellation: signal }));
    if (result.taskId !== id) throw invalid();
    return result;
  }
  async function tasks(uri, signal) {
    checkUri(uri);
    const result = await request('tasks', { query: { task_type: 'admin_reindex', resource_id: uri, limit: 200 }, cancellation: signal });
    if (!Array.isArray(result)) throw invalid();
    return result.map(data => {
      const item = normalizeTask(data);
      if (item.uri !== uri || (data.task_type !== undefined && data.task_type !== 'admin_reindex')) throw invalid();
      return item;
    });
  }
  async function remove(uri, { recursive = false } = {}, signal) {
    checkUri(uri);
    if (typeof recursive !== 'boolean') throw failRequest('OpenViking recursive deletion must be explicit.');
    const result = await request('fs', { method: 'DELETE', query: { uri, recursive, wait: true, timeout: config.timeoutMs / 1000 }, cancellation: signal, mutation: true });
    if (!result || result.uri !== uri) throw invalid(true);
    if (result.semantic_status === 'failed' || hasQueueFailure(result.queue_status))
      throw new ApiError('OV_PROCESSING_FAILED', 'OpenViking deletion may have completed but parent-index refresh reported errors. Reconcile the target before retrying.', { mayHaveSucceeded: true });
    return { uri, semanticStatus: result.semantic_status, estimatedDeletedCount: result.estimated_deleted_count, queueStatus: result.queue_status };
  }
  async function waitProcessed(signal) {
    // Leave room for the server's polling interval and response delivery.
    const timeout = (config.timeoutMs - Math.min(1000, config.timeoutMs / 10)) / 1000;
    const result = await request('system/wait', { method: 'POST', body: { timeout }, cancellation: signal, processingWait: true });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
    return Object.fromEntries(Object.entries(result).map(([name, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name) || !value || typeof value !== 'object' || Array.isArray(value)
        || ['processed', 'requeue_count', 'error_count'].some(field => !Number.isSafeInteger(value[field]) || value[field] < 0)
        || (value.errors !== undefined && !Array.isArray(value.errors))) throw invalid();
      // Error counters are global history, not failures of this mirror. Never
      // expose their upstream message strings through the optional adapter.
      return [name, { processed: value.processed, requeueCount: value.requeue_count, errorCount: value.error_count }];
    }));
  }
  async function list(uri, signal) {
    checkUri(uri);
    const result = await request('fs/ls', { query: { uri, show_all_hidden: true, output: 'original', simple: false, recursive: false, node_limit: 1000 }, cancellation: signal, missing: 'directory' });
    if (result === undefined) return undefined;
    if (!Array.isArray(result) || result.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.name !== 'string' || !entry.name || /[\\/\u0000-\u001f\u007f]/.test(entry.name)
      || ['.', '..'].includes(entry.name) || entry.uri !== `${uri.replace(/\/$/, '')}/${entry.name}` || typeof entry.isDir !== 'boolean')) throw invalid();
    // The server does not return a next-page token. A full page is not proof of
    // a complete directory; refuse cleanup rather than hide unknown children.
    if (result.length >= 1000) throw new ApiError('OV_RESPONSE_TOO_LARGE', 'OpenViking directory listing reached its bound; complete ownership cannot be established.');
    return result;
  }
  return { identity, read, write, reindex, task, tasks, remove, list, waitProcessed };
}
