import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ApiError } from './errors.mjs';
import { absoluteDirectory, contained, readMarkdown, validRelativeFile } from './sync-files.mjs';
import { createSyncStore } from './sync-store.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const revision = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const messages = {
  INVALID_STATE: 'Sync storage is invalid. Use owned private directories and files; inspect the state before restarting.',
  INVALID_SOURCE: 'The bound source must be an owned regular UTF-8 Markdown file within the source root, nonblank and at most 1,000,000 bytes.',
  INVALID_RESPONSE: 'The deployment returned an invalid sync protocol response. Update the server before resuming.',
  INVALID_REQUEST: 'The requested sync control or identifier is invalid.',
  READ_ONLY: 'Markdown uploads and controls are unavailable in read-only mode.',
  CLOSED: 'The Markdown sync manager has stopped.',
  NOT_FOUND: 'The binding, page or endpoint could not be found.',
  FORBIDDEN: 'Docmost denied access to the bound page. Restore permission before resuming.',
  UNAUTHENTICATED: 'The personal credential expired or was revoked. Sign in before resuming.',
  UNSUPPORTED_DEPLOYMENT: 'This deployment does not expose the conditional sync endpoints. Deploy a compatible server before resuming.',
  IDENTITY_CHANGED: 'The authenticated user or workspace changed. This binding will not be retargeted.',
  TARGET_CHANGED: 'The bound page, space, workspace, origin or source root changed. This binding will not be retargeted.',
  CONFLICT: 'The live page changed. Read its current revision and explicitly resolve with that revision.',
  UNCONFIRMED: 'An earlier write has an unknown result. Inspect the live page and explicitly resolve; no automatic retry was made.',
  LEASE_BUSY: 'Another process owns the page lease. Confirm that a stale process has stopped before manually removing its lease file.',
  BINDING_EXISTS: 'This source file or page is already bound. Unbind its existing binding before choosing another target.',
  BINDING_LIMIT: 'At most 50 Markdown bindings are allowed in one state directory.',
  NETWORK_ERROR: 'The sync service could not be reached. Check connectivity before resuming.',
  TIMEOUT: 'The sync request timed out. Inspect pending state before resuming.',
  CANCELLED: 'The sync request was cancelled. A dispatched write may have completed.',
  REQUEST_FAILED: 'The sync service returned an unsuccessful response. Inspect pending state before resuming.',
  RATE_LIMITED: 'The sync service rate-limited the request. No automatic retry was made.',
};
const errorCode = error => Object.hasOwn(messages, error?.code) ? error.code : 'REQUEST_FAILED';
const errorFor = code => new ApiError(code, messages[code] ?? messages.REQUEST_FAILED);
const safeError = error => errorFor(errorCode(error));
const active = binding => binding.enabled && ['watching', 'synced', 'syncing'].includes(binding.state) && !binding.pending;

function identityOf(data) {
  if (!uuid(data?.user?.id) || !uuid(data?.workspace?.id)) throw errorFor('INVALID_RESPONSE');
  return { userId: data.user.id.toLowerCase(), workspaceId: data.workspace.id.toLowerCase() };
}
function validateRemote(data, pageId, preview = false) {
  if (!uuid(data?.pageId) || !uuid(data?.spaceId) || !uuid(data?.workspaceId)
    || !revision(data?.revision) || !revision(data?.persistedRevision)
    || (preview && !revision(data?.proposedRevision))) throw errorFor('INVALID_RESPONSE');
  if (data.pageId.toLowerCase() !== pageId) throw errorFor('TARGET_CHANGED');
  return { ...data, pageId: data.pageId.toLowerCase(), spaceId: data.spaceId.toLowerCase(), workspaceId: data.workspaceId.toLowerCase() };
}
const storedFields = ['version', 'bindingId', 'filePath', 'pageId', 'spaceId', 'workspaceId', 'userId', 'origin', 'root', 'enabled', 'state', 'localHash', 'remoteRevision', 'pending', 'errorCode'];
const bindingStates = ['watching', 'synced', 'syncing', 'paused', 'blocked', 'conflict', 'unconfirmed'];
function validateStored({ filename, value }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !storedFields.includes(key))
    || value.version !== 1 || !uuid(value.bindingId) || filename !== `${value.bindingId}.json`
    || !validRelativeFile(value.filePath) || !['pageId', 'spaceId', 'workspaceId', 'userId'].every(key => uuid(value[key]))
    || typeof value.origin !== 'string' || typeof value.root !== 'string' || typeof value.enabled !== 'boolean'
    || !bindingStates.includes(value.state) || !revision(value.localHash) || !revision(value.remoteRevision)
    || (value.errorCode !== undefined && !Object.hasOwn(messages, value.errorCode))) throw errorFor('INVALID_STATE');
  if (value.pending !== undefined && (!value.pending || typeof value.pending !== 'object' || Array.isArray(value.pending)
    || Object.keys(value.pending).sort().join(',') !== 'expectedRevision,localHash,proposedRevision'
    || !Object.values(value.pending).every(revision))) throw errorFor('INVALID_STATE');
  return { ...value, _tail: Promise.resolve(), _timer: undefined, _observed: undefined, _lease: undefined };
}

export function createMarkdownSync(config, { api, debounceMs = 1000, scanMs = 1000 } = {}) {
  const records = new Map();
  const watchers = new Map();
  const cancellation = new AbortController();
  let store, rootInfo, identity, startPromise, closePromise, interval;
  let controls = Promise.resolve();
  let state = 'running';
  let startupError;
  let closed = false;
  const snapshot = binding => ({
    bindingId: binding.bindingId, filePath: binding.filePath, pageId: binding.pageId,
    spaceId: binding.spaceId, workspaceId: binding.workspaceId, enabled: binding.enabled,
    state: binding.state, localHash: binding.localHash, remoteRevision: binding.remoteRevision,
    ...(binding.pending ? { pending: { ...binding.pending } } : {}),
    ...(binding.errorCode ? { error: { code: binding.errorCode, message: messages[binding.errorCode] } } : {}),
  });
  const summary = () => ({ state, readOnly: Boolean(config.readOnly), bindings: [...records.values()].map(snapshot),
    ...(startupError ? { error: { code: startupError.code, message: startupError.message } } : {}) });
  const serialize = binding => Object.fromEntries(storedFields.filter(key => binding[key] !== undefined).map(key => [key, binding[key]]));
  const canRun = binding => !closed && !startupError && state === 'running' && active(binding) && binding._lease;
  const persist = binding => store.save(serialize(binding));
  const requireRunning = () => { if (closed) throw errorFor('CLOSED'); if (startupError) throw startupError; };
  const requireWritable = () => { requireRunning(); if (config.readOnly) throw errorFor('READ_ONLY'); };
  const lookup = bindingId => { if (!uuid(bindingId)) throw errorFor('INVALID_REQUEST'); const binding = records.get(bindingId); if (!binding) throw errorFor('NOT_FOUND'); return binding; };
  const enqueue = (binding, operation) => {
    const result = binding._tail.then(operation);
    binding._tail = result.catch(() => {});
    return result;
  };
  const controlQueue = operation => { const result = controls.then(operation); controls = result.catch(() => {}); return result; };
  async function post(path, body, mutation = false) {
    if (cancellation.signal.aborted) throw errorFor('CANCELLED');
    try { return await api.post(path, body, cancellation.signal, mutation); }
    catch (error) { throw safeError(error); }
  }
  async function checkIdentity(binding) {
    const current = identityOf(await post('users/me', {}));
    if (current.userId !== binding.userId || current.workspaceId !== binding.workspaceId
      || binding.origin !== config.origin || binding.root !== config.syncRoot) throw errorFor('IDENTITY_CHANGED');
  }
  async function ensureLease(binding) {
    try { await store.assertLease(binding._lease); }
    catch (error) {
      if (error.code === 'LEASE_BUSY') { binding._lease = undefined; binding.state = 'blocked'; binding.errorCode = 'LEASE_BUSY'; }
      throw error;
    }
  }
  async function remoteFor(binding, content) {
    const remote = validateRemote(await post('pages/sync-state', { pageId: binding.pageId, ...(content === undefined ? {} : { content }) }), binding.pageId, content !== undefined);
    if (remote.spaceId !== binding.spaceId || remote.workspaceId !== binding.workspaceId) throw errorFor('TARGET_CHANGED');
    return remote;
  }
  async function setFailure(binding, error, pending = Boolean(binding.pending)) {
    const code = errorCode(error);
    if (closed && code === 'CANCELLED' && !pending) return;
    const blocked = ['IDENTITY_CHANGED', 'TARGET_CHANGED', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'UNSUPPORTED_DEPLOYMENT', 'INVALID_STATE', 'LEASE_BUSY'].includes(code);
    binding.state = code === 'CONFLICT' ? 'conflict' : pending && !blocked ? 'unconfirmed' : 'blocked';
    binding.errorCode = pending && code !== 'CONFLICT' && !blocked ? 'UNCONFIRMED' : code;
    if (binding._lease && !config.readOnly) await persist(binding);
  }
  async function commit(binding) {
    const pending = binding.pending;
    const next = { ...binding, localHash: pending.localHash, remoteRevision: pending.proposedRevision,
      state: binding.enabled ? 'synced' : 'paused' };
    delete next.pending;
    delete next.errorCode;
    await persist(next);
    binding.localHash = next.localHash;
    binding.remoteRevision = next.remoteRevision;
    binding.state = next.state;
    delete binding.pending;
    delete binding.errorCode;
  }
  async function reconcile(binding) {
    const remote = await remoteFor(binding);
    if (remote.revision === binding.pending.proposedRevision && remote.persistedRevision === binding.pending.proposedRevision) {
      await commit(binding);
      return true;
    }
    await setFailure(binding, errorFor(remote.revision !== binding.pending.expectedRevision && remote.revision !== binding.pending.proposedRevision ? 'CONFLICT' : 'UNCONFIRMED'));
    return false;
  }
  async function upload(binding, source, expectedRevision, resolving = false) {
    await ensureLease(binding);
    await checkIdentity(binding);
    const remote = await remoteFor(binding, source.content);
    if (remote.revision !== expectedRevision) throw errorFor('CONFLICT');
    if (closed) throw errorFor('CANCELLED');
    binding.pending = { localHash: source.hash, expectedRevision, proposedRevision: remote.proposedRevision };
    binding.state = 'syncing';
    delete binding.errorCode;
    await persist(binding);
    if (closed) { await setFailure(binding, errorFor('CANCELLED')); return false; }
    await ensureLease(binding);
    try {
      const updated = validateRemote(await post('pages/sync-update', {
        pageId: binding.pageId, content: source.content, expectedRevision,
        expectedSpaceId: binding.spaceId, expectedWorkspaceId: binding.workspaceId,
      }, true), binding.pageId);
      if (updated.spaceId !== binding.spaceId || updated.workspaceId !== binding.workspaceId) throw errorFor('TARGET_CHANGED');
    } catch (error) {
      if (['CONFLICT', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'UNSUPPORTED_DEPLOYMENT'].includes(errorCode(error))) {
        delete binding.pending;
        await setFailure(binding, error, false);
        if (resolving) throw safeError(error);
        return false;
      }
      if (closed || errorCode(error) === 'TARGET_CHANGED') {
        await setFailure(binding, error);
        return false;
      }
      // A dispatched mutation is never resent. Only a read can confirm its target.
    }
    try { return await reconcile(binding); }
    catch (error) { await setFailure(binding, error); return false; }
  }
  async function processBinding(binding) {
    if (!canRun(binding)) return;
    try {
      const source = await readMarkdown(config.syncRoot, rootInfo, binding.filePath);
      binding._observed = source.hash;
      if (source.hash === binding.localHash) return;
      await upload(binding, source, binding.remoteRevision);
    } catch (error) { await setFailure(binding, error); }
  }
  function schedule(binding) {
    if (!canRun(binding)) return;
    clearTimeout(binding._timer);
    binding._timer = setTimeout(() => {
      binding._timer = undefined;
      enqueue(binding, () => processBinding(binding)).catch(error => { startupError = safeError(error); state = 'blocked'; });
    }, debounceMs);
    binding._timer.unref();
  }
  async function scanBinding(binding) {
    if (!canRun(binding) || binding._scanning) return;
    binding._scanning = true;
    try {
      let observed;
      try { observed = (await readMarkdown(config.syncRoot, rootInfo, binding.filePath)).hash; }
      catch { observed = 'invalid'; }
      if (!canRun(binding)) return;
      if (observed !== binding._observed) {
        binding._observed = observed;
        if (observed !== binding.localHash) schedule(binding);
      }
    } finally { binding._scanning = false; }
  }
  function addWatcher(binding) {
    if (closed || config.readOnly) return;
    const parent = dirname(join(config.syncRoot, binding.filePath));
    if (watchers.has(parent)) return;
    try {
      const watcher = watch(parent, { persistent: false }, (event, filename) => {
        for (const record of records.values()) {
          if (dirname(join(config.syncRoot, record.filePath)) === parent && (!filename || basename(record.filePath) === String(filename))) scanBinding(record).catch(() => {});
        }
      });
      watcher.on('error', () => { watcher.close(); watchers.delete(parent); });
      watchers.set(parent, watcher);
    } catch { /* Periodic bounded scans still detect saves when native watches fail. */ }
  }
  async function initializeBinding(binding) {
    try {
      if (binding.origin !== config.origin || binding.root !== config.syncRoot) throw errorFor('TARGET_CHANGED');
      if (binding.userId !== identity.userId || binding.workspaceId !== identity.workspaceId) throw errorFor('IDENTITY_CHANGED');
      binding._lease = await store.acquire(binding, cancellation.signal);
      if (closed) return;
      if (binding.pending) { await reconcile(binding); }
      else {
        const remote = await remoteFor(binding);
        if (remote.revision !== binding.remoteRevision) throw errorFor('CONFLICT');
        // Preserve conflict/unconfirmed state across restarts; only explicit resolution rebases it.
        if (!binding.errorCode) binding.state = binding.enabled ? (binding.state === 'synced' ? 'synced' : 'watching') : 'paused';
      }
      if (!closed && active(binding)) {
        const source = await readMarkdown(config.syncRoot, rootInfo, binding.filePath);
        binding._observed = source.hash;
        if (source.hash !== binding.localHash) schedule(binding);
      }
      if (!closed) addWatcher(binding);
    } catch (error) { await setFailure(binding, error); }
  }
  async function initialize() {
    try {
      rootInfo = await absoluteDirectory(config.syncRoot, 'INVALID_SOURCE');
      if (contained(config.syncRoot, config.syncStateDir) || contained(config.syncStateDir, config.syncRoot)) throw errorFor('INVALID_STATE');
      store = await createSyncStore(config.syncStateDir, { readOnly: config.readOnly });
      const loaded = await store.load();
      for (const item of loaded) {
        const binding = validateStored(item);
        if (records.has(binding.bindingId) || [...records.values()].some(record => record.pageId === binding.pageId || record.filePath === binding.filePath)) throw errorFor('INVALID_STATE');
        records.set(binding.bindingId, binding);
      }
      if (closed || config.readOnly) return summary();
      identity = identityOf(await post('users/me', {}));
      if (closed) return summary();
      for (const binding of records.values()) { if (closed) break; await initializeBinding(binding); }
      if (!closed) {
        interval = setInterval(() => { for (const binding of records.values()) scanBinding(binding).catch(() => {}); }, scanMs);
        interval.unref();
      }
    } catch (error) { if (!closed) { startupError = safeError(error); state = 'blocked'; } }
    return summary();
  }
  function start() { return startPromise ??= initialize(); }
  async function status({ bindingId } = {}) {
    await start();
    if (bindingId === undefined) return summary();
    requireRunning();
    const binding = lookup(bindingId);
    const remote = await remoteFor(binding);
    return { ...snapshot(binding), currentRevision: remote.revision, currentPersistedRevision: remote.persistedRevision };
  }
  async function bind({ filePath, pageId, enabled = true }) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      if (!uuid(pageId) || typeof enabled !== 'boolean') throw errorFor('INVALID_REQUEST');
      pageId = pageId.toLowerCase();
      if (records.size >= 50) throw errorFor('BINDING_LIMIT');
      if ([...records.values()].some(binding => binding.pageId === pageId || binding.filePath === filePath)) throw errorFor('BINDING_EXISTS');
      const source = await readMarkdown(config.syncRoot, rootInfo, filePath);
      const current = identityOf(await post('users/me', {}));
      if (current.userId !== identity.userId || current.workspaceId !== identity.workspaceId) throw errorFor('IDENTITY_CHANGED');
      const remote = validateRemote(await post('pages/sync-state', { pageId }), pageId);
      if (remote.workspaceId !== current.workspaceId) throw errorFor('TARGET_CHANGED');
      const binding = { version: 1, bindingId: randomUUID(), filePath, pageId, spaceId: remote.spaceId,
        workspaceId: current.workspaceId, userId: current.userId, origin: config.origin, root: config.syncRoot,
        enabled, state: enabled ? 'watching' : 'paused', localHash: source.hash, remoteRevision: remote.revision,
        _tail: Promise.resolve(), _observed: source.hash };
      binding._lease = await store.acquire(binding, cancellation.signal);
      try {
        requireWritable();
        await persist(binding);
        records.set(binding.bindingId, binding);
        addWatcher(binding);
        return snapshot(binding);
      } catch (error) { await store.release(binding._lease); throw safeError(error); }
    });
  }
  async function control({ bindingId, action }) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      const binding = lookup(bindingId);
      if (!['pause', 'resume', 'unbind'].includes(action)) throw errorFor('INVALID_REQUEST');
      clearTimeout(binding._timer);
      if (action !== 'resume') binding.enabled = false;
      return enqueue(binding, async () => {
        requireWritable();
        if (action === 'unbind') {
          // Explicit metadata removal can clean up a pinned old identity/root.
          // It only needs exclusive ownership of that old local target lease.
          if (!binding._lease) binding._lease = await store.acquire(binding, cancellation.signal);
          await ensureLease(binding);
          await store.remove(binding.bindingId);
          await store.release(binding._lease);
          binding._lease = undefined;
          records.delete(binding.bindingId);
          return { ...snapshot(binding), state: 'unbound' };
        }
        if (!binding._lease) throw errorFor('LEASE_BUSY');
        await ensureLease(binding);
        if (action === 'pause') { if (!binding.errorCode) binding.state = 'paused'; await persist(binding); return snapshot(binding); }
        if (binding.pending || ['CONFLICT', 'UNCONFIRMED', 'IDENTITY_CHANGED', 'TARGET_CHANGED'].includes(binding.errorCode)) return snapshot(binding);
        binding.enabled = true;
        delete binding.errorCode;
        binding.state = 'watching';
        binding._observed = undefined;
        await persist(binding);
        addWatcher(binding);
        await scanBinding(binding);
        return snapshot(binding);
      });
    });
  }
  async function resolve({ bindingId, expectedRevision }) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      if (!revision(expectedRevision)) throw errorFor('INVALID_REQUEST');
      const binding = lookup(bindingId);
      clearTimeout(binding._timer);
      return enqueue(binding, async () => {
        requireWritable();
        if (!binding._lease) throw errorFor('LEASE_BUSY');
        await ensureLease(binding);
        try {
          const source = await readMarkdown(config.syncRoot, rootInfo, binding.filePath);
          const remote = await remoteFor(binding);
          if (remote.revision !== expectedRevision) throw errorFor('CONFLICT');
          binding.enabled = true;
          const confirmed = await upload(binding, source, expectedRevision, true);
          if (!confirmed) throw errorFor(binding.errorCode ?? 'UNCONFIRMED');
          binding._observed = undefined;
          addWatcher(binding);
          await scanBinding(binding);
          return snapshot(binding);
        } catch (error) { await setFailure(binding, error); throw safeError(error); }
      });
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    state = 'closed';
    cancellation.abort();
    clearInterval(interval);
    for (const binding of records.values()) clearTimeout(binding._timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    closePromise = (async () => {
      await startPromise;
      await controls;
      await Promise.all([...records.values()].map(binding => binding._tail));
      for (const binding of records.values()) {
        if (binding._lease) {
          const lease = binding._lease;
          try { await ensureLease(binding); await persist(binding); }
          catch (error) { startupError = safeError(error); }
          finally {
            try { await store.release(lease); }
            catch (error) { startupError = safeError(error); }
          }
          binding._lease = undefined;
        }
      }
      return summary();
    })();
    return closePromise;
  }
  return { start, close, bind, status, control, resolve };
}
