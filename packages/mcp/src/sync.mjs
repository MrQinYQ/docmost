import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ApiError } from './errors.mjs';
import { absoluteDirectory, contained, readMarkdown, validRelativeFile } from './sync-files.mjs';
import { createSyncStore } from './sync-store.mjs';
import { createKnowledgeRuntime, knowledgeConnectionStatus, knowledgeStatus, legacyKnowledgeStatus, validateKnowledgeState } from './knowledge.mjs';
import { resolveDocumentLayout, isDescendantLayout } from './document-layout.mjs';
import { readPageSource } from './page-source.mjs';
import { openGitSource } from './git-source.mjs';
import { validateGitBinding, confirmedGitBinding } from './git-binding.mjs';
import { createGitPublication } from './git-publication.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const revision = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const messages = {
  INVALID_STATE: 'Sync storage is invalid. Use owned private directories and files; inspect the state before restarting.',
  INVALID_SOURCE: 'The bound source must be an owned regular UTF-8 Markdown file within the source root, nonblank and at most 1,000,000 bytes.',
  INVALID_RESPONSE: 'The deployment returned an invalid sync protocol response. Update the server before resuming.',
  INVALID_REQUEST: 'The requested sync control or identifier is invalid.',
  READ_ONLY: 'Knowledge-base writes, Markdown uploads and sync controls are unavailable in read-only mode.',
  CLOSED: 'The synchronization manager has stopped.',
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
  BINDING_LIMIT: 'At most 50 page enrollments and Markdown bindings are allowed in one state directory.',
  SAVE_PENDING: 'The preceding page body update has not been confirmed as saved. Wait for its knowledge-base status or explicitly sync the current saved page before making another body update.',
  GIT_BRANCH_CONFLICT: 'This document was published from a divergent commit. Merge the published commit before publishing again.',
  GIT_HISTORY_MISSING: 'The required Git history is unavailable. Restore it before publishing.',
  GIT_REF_CHANGED: 'The branch no longer points to the requested commit. Inspect its current HEAD before publishing.',
  GIT_SOURCE_DELETED: 'The associated Markdown is absent from this commit. The remote page was preserved.',
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
const pageSource = binding => binding.source === 'docmost';
const gitSource = binding => binding.source === 'git';
const markdownSource = binding => !binding.source || binding.source === 'markdown';
const sourceFileKey = (root, filePath) => JSON.stringify([root, filePath]);
const deletingPage = binding => binding.errorCode === 'NOT_FOUND' || binding.mirror?.state === 'deleted'
  || [binding.mirror?.operation, binding.mirror?.pending, binding.mirror?.next].some(job => job?.kind === 'delete');

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
const storedFields = ['version', 'source', 'bindingId', 'filePath', 'pageId', 'spaceId', 'workspaceId', 'userId', 'origin', 'root', 'enabled', 'state', 'localHash', 'remoteRevision', 'pending', 'errorCode', 'mirror', 'pageRefresh', 'parentIds', 'git'];
const bindingStates = ['watching', 'synced', 'syncing', 'paused', 'blocked', 'conflict', 'unconfirmed'];
function validateStored({ filename, value }, knowledgeAdapters) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !storedFields.includes(key))
    || value.version !== 1 || !uuid(value.bindingId) || filename !== `${value.bindingId}.json`
    || (value.source !== undefined && !['markdown', 'docmost', 'git'].includes(value.source))
    || (pageSource(value) ? value.filePath !== undefined || value.root !== undefined || value.pending !== undefined
      : !validRelativeFile(value.filePath) || typeof value.root !== 'string')
    || !['pageId', 'spaceId', 'workspaceId', 'userId'].every(key => uuid(value[key]))
    || typeof value.origin !== 'string' || typeof value.enabled !== 'boolean'
    || !bindingStates.includes(value.state) || !revision(value.localHash) || !revision(value.remoteRevision)
    || (value.errorCode !== undefined && !Object.hasOwn(messages, value.errorCode))) throw errorFor('INVALID_STATE');
  if (value.pending !== undefined && (!value.pending || typeof value.pending !== 'object' || Array.isArray(value.pending)
    || Object.keys(value.pending).sort().join(',') !== 'expectedRevision,localHash,proposedRevision'
    || !Object.values(value.pending).every(revision))) throw errorFor('INVALID_STATE');
  if (value.pageRefresh !== undefined && (!pageSource(value) || !value.pageRefresh || typeof value.pageRefresh !== 'object'
    || Array.isArray(value.pageRefresh) || Object.keys(value.pageRefresh).some(key => !['id', 'previousHash'].includes(key))
    || !uuid(value.pageRefresh.id) || (value.pageRefresh.previousHash !== undefined && !revision(value.pageRefresh.previousHash)))) throw errorFor('INVALID_STATE');
  if (gitSource(value)) validateGitBinding(value);
  else if (value.git !== undefined) throw errorFor('INVALID_STATE');
  if (value.parentIds !== undefined && ((!pageSource(value) && !gitSource(value))
    || !isDescendantLayout({ pageId: value.pageId, parentIds: value.parentIds }, value.pageId))) throw errorFor('INVALID_STATE');
  try { validateKnowledgeState(value.mirror, knowledgeAdapters); } catch { throw errorFor('INVALID_STATE'); }
  return { ...value, _tail: Promise.resolve(), _timer: undefined, _observed: undefined, _lease: undefined };
}

export function createMarkdownSync(config, { api, mirrorClient, knowledgeAdapters, debounceMs = 1000, scanMs = 1000 } = {}) {
  const records = new Map();
  const dormantPages = new Set();
  const dormantFiles = new Set();
  const sourceTaken = (root, filePath, except) => dormantFiles.has(sourceFileKey(root, filePath))
    || [...records.values()].some(binding => binding !== except && binding.root === root && binding.filePath === filePath);
  const watchers = new Map();
  const cancellation = new AbortController();
  let store, rootInfo, identity, startPromise, closePromise, interval, mirror, mirrorTree, knowledgeRuntime, gitReader, gitPublication;
  let controls = Promise.resolve();
  let state = 'running';
  let startupError;
  let closed = false;
  const stateDir = config.knowledgeStateDir ?? config.syncStateDir;
  const providerStatus = binding => {
    const result = knowledgeStatus(binding, config, knowledgeAdapters);
    return binding.pageRefresh && result?.enabled && result.state !== 'blocked'
      ? { ...result, state: 'waiting_docmost' } : result;
  };
  const legacyStatus = binding => {
    const result = legacyKnowledgeStatus(binding, knowledgeAdapters);
    return binding.pageRefresh && result && result.state !== 'blocked' ? { ...result, state: 'waiting_docmost' } : result;
  };
  const snapshot = binding => ({
    bindingId: binding.bindingId, source: binding.source ?? 'markdown', ...(binding.filePath ? { filePath: binding.filePath } : {}), pageId: binding.pageId,
    spaceId: binding.spaceId, workspaceId: binding.workspaceId, enabled: binding.enabled,
    state: binding.state, localHash: binding.localHash, remoteRevision: binding.remoteRevision,
    ...(gitSource(binding) ? { git: { published: { ...binding.git.published }, ...(binding.git.lastChecked ? { lastChecked: { ...binding.git.lastChecked } } : {}),
      ...(binding.git.pushReceipt ? { pushReceipt: { ...binding.git.pushReceipt } } : {}), ...(binding.git.intent ? { intent: { ...binding.git.intent } } : {}) } } : {}),
    ...(binding.pending ? { pending: { ...binding.pending } } : {}),
    ...(binding.errorCode ? { error: { code: binding.errorCode, message: messages[binding.errorCode] } } : {}),
    ...(providerStatus(binding) ? { knowledgeBase: providerStatus(binding) } : {}),
    ...(legacyStatus(binding) ? { openViking: legacyStatus(binding) } : {}),
  });
  const summary = () => ({ state, readOnly: Boolean(config.readOnly), knowledgeBase: knowledgeConnectionStatus(config, knowledgeAdapters), bindings: [...records.values()].map(snapshot),
    ...(startupError ? { error: { code: startupError.code, message: startupError.message } } : {}) });
  const serialize = binding => Object.fromEntries(storedFields.filter(key => binding[key] !== undefined).map(key => [key, binding[key]]));
  const canRun = binding => markdownSource(binding) && !closed && !startupError && state === 'running' && active(binding) && binding._lease && !(knowledgeRuntime?.accepts(binding) && binding.mirror?.operation);
  const persist = async binding => {
    const value = serialize(binding);
    await store.save(value);
    if (value.mirror || gitSource(value)) {
      const retained = [value.mirror?.pending?.hash, value.mirror?.next?.hash, value.pending?.localHash, value.git?.intent?.hash].filter(Boolean);
      await store.pruneSnapshots(value.bindingId, retained);
    }
  };
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
      || binding.origin !== config.origin || (!pageSource(binding) && binding.root !== (gitSource(binding) ? config.gitRoot : config.syncRoot))) throw errorFor('IDENTITY_CHANGED');
  }
  async function ensureLease(binding) {
    try {
      if (!binding._lease) throw errorFor('LEASE_BUSY');
      await store.assertLease(binding._lease);
    }
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
  async function readConfirmedSource(binding) {
    if (!gitSource(binding)) return readMarkdown(config.syncRoot, rootInfo, binding.filePath);
    const source = await gitReader.readSnapshot({ commit: binding.git.published.commit, filePath: binding.git.published.filePath ?? binding.filePath });
    if (source.kind !== 'body' || source.hash !== binding.localHash || source.blob !== binding.git.published.blob) throw errorFor('INVALID_SOURCE');
    return source;
  }
  async function setFailure(binding, error, pending = Boolean(binding.pending)) {
    const code = errorCode(error);
    if (closed && code === 'CANCELLED' && !pending) return;
    const blocked = ['IDENTITY_CHANGED', 'TARGET_CHANGED', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'UNSUPPORTED_DEPLOYMENT', 'INVALID_STATE', 'LEASE_BUSY'].includes(code);
    binding.state = ['CONFLICT', 'GIT_BRANCH_CONFLICT'].includes(code) ? 'conflict' : pending && !blocked ? 'unconfirmed' : 'blocked';
    binding.errorCode = pending && !['CONFLICT', 'GIT_BRANCH_CONFLICT'].includes(code) && !blocked ? 'UNCONFIRMED' : code;
    if (binding._lease && !config.readOnly) await persist(binding);
  }
  async function commit(binding) {
    const pending = binding.pending;
    mirror?.confirm(binding, pending);
    let next = { ...binding, localHash: pending.localHash, remoteRevision: pending.proposedRevision,
      state: binding.enabled ? 'synced' : 'paused' };
    delete next.pending;
    delete next.errorCode;
    if (gitSource(binding)) next = confirmedGitBinding(next);
    await persist(next);
    binding.localHash = next.localHash;
    binding.remoteRevision = next.remoteRevision;
    binding.state = next.state;
    if (gitSource(binding)) binding.git = next.git;
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
    await mirror?.prepare(binding, source);
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
        await mirror?.discard(binding, source.hash);
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
      const source = await readConfirmedSource(binding);
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
      try { observed = (await readConfirmedSource(binding)).hash; }
      catch { observed = 'invalid'; }
      if (!canRun(binding)) return;
      if (observed !== binding._observed) {
        binding._observed = observed;
        if (observed !== binding.localHash) schedule(binding);
      }
    } finally { binding._scanning = false; }
  }
  function addWatcher(binding) {
    if (closed || config.readOnly || !markdownSource(binding)) return;
    const parent = dirname(join(config.syncRoot, binding.filePath));
    if (watchers.has(parent)) return;
    try {
      const watcher = watch(parent, { persistent: false }, (event, filename) => {
        for (const record of records.values()) {
          if (!markdownSource(record)) continue;
          if (dirname(join(config.syncRoot, record.filePath)) === parent && (!filename || basename(record.filePath) === String(filename))) scanBinding(record).catch(() => {});
        }
      });
      watcher.on('error', () => { watcher.close(); watchers.delete(parent); });
      watchers.set(parent, watcher);
    } catch { /* Periodic bounded scans still detect saves when native watches fail. */ }
  }
  async function initializeBinding(binding) {
    try {
      if (binding.origin !== config.origin || (!pageSource(binding) && binding.root !== (gitSource(binding) ? config.gitRoot : config.syncRoot))) throw errorFor('TARGET_CHANGED');
      if (binding.userId !== identity.userId || binding.workspaceId !== identity.workspaceId) throw errorFor('IDENTITY_CHANGED');
      binding._lease = await store.acquire(binding, cancellation.signal);
      if (closed) return;
      if (pageSource(binding)) return;
      if (gitSource(binding)) {
        const repo = await gitReader.identity();
        if (repo.commonDir !== binding.git.commonDir || repo.objectFormat !== binding.git.objectFormat) throw errorFor('TARGET_CHANGED');
        if (binding.pending) await reconcile(binding);
        else {
          const remote = await remoteFor(binding);
          if (remote.revision !== binding.remoteRevision || remote.persistedRevision !== remote.revision) throw errorFor('CONFLICT');
        }
        return;
      }
      if (binding.pending) { await reconcile(binding); }
      else {
        const remote = await remoteFor(binding);
        if (remote.revision !== binding.remoteRevision) throw errorFor('CONFLICT');
        // Preserve conflict/unconfirmed state across restarts; only explicit resolution rebases it.
        if (!binding.errorCode) binding.state = binding.enabled ? (binding.state === 'synced' ? 'synced' : 'watching') : 'paused';
      }
      if (!closed && active(binding)) {
        const source = await readConfirmedSource(binding);
        binding._observed = source.hash;
        if (source.hash !== binding.localHash) schedule(binding);
      }
      if (!closed) addWatcher(binding);
    } catch (error) { await setFailure(binding, error); }
  }
  async function initialize() {
    try {
      if (config.syncRoot) {
        rootInfo = await absoluteDirectory(config.syncRoot, 'INVALID_SOURCE');
        if (contained(config.syncRoot, stateDir) || contained(stateDir, config.syncRoot)) throw errorFor('INVALID_STATE');
      }
      if (config.gitRoot) {
        if (contained(config.gitRoot, stateDir) || contained(stateDir, config.gitRoot)) throw errorFor('INVALID_STATE');
        gitReader = await openGitSource(config.gitRoot, { signal: cancellation.signal });
      }
      store = await createSyncStore(stateDir, { readOnly: config.readOnly });
      knowledgeRuntime = createKnowledgeRuntime(config, { adapters: knowledgeAdapters, client: mirrorClient, post, store, persist, signal: cancellation.signal,
        deletionReady: (binding, job) => !job.waitFor?.some(id => {
          const child = records.get(id);
          return child && id !== binding.bindingId && (child.mirror?.operation?.kind === 'delete'
            || child.mirror?.pending?.kind === 'delete' || child.mirror?.next?.kind === 'delete');
        }) });
      mirror = knowledgeRuntime?.mirror; mirrorTree = knowledgeRuntime?.tree;
      const loaded = await store.load();
      const seenPages = new Set(), seenFiles = new Set();
      for (const item of loaded) {
        const binding = validateStored(item, knowledgeAdapters);
        const fileKey = binding.filePath && sourceFileKey(binding.root, binding.filePath);
        if (seenPages.has(binding.pageId) || (fileKey && seenFiles.has(fileKey))) throw errorFor('INVALID_STATE');
        seenPages.add(binding.pageId); if (fileKey) seenFiles.add(fileKey);
        if ((!config.syncRoot && markdownSource(binding)) || (!config.gitRoot && gitSource(binding))) { dormantPages.add(binding.pageId); if (fileKey) dormantFiles.add(fileKey); continue; }
        if (records.has(binding.bindingId)) throw errorFor('INVALID_STATE');
        records.set(binding.bindingId, binding);
      }
      if (closed || config.readOnly) return summary();
      identity = identityOf(await post('users/me', {}));
      if (closed) return summary();
      for (const binding of records.values()) { if (closed) break; await initializeBinding(binding); }
      if (!closed) {
        interval = setInterval(() => { for (const binding of records.values()) {
          scanBinding(binding).catch(() => {});
          if (mirror && knowledgeRuntime.accepts(binding) && binding._lease && !binding._mirrorQueued && !closed) {
            binding._mirrorQueued = true;
            enqueue(binding, async () => {
              await ensureLease(binding);
              if (binding.mirror?.operation) await reconcilePageOperation(binding);
              if (pageSource(binding) && binding.pageRefresh) {
                try { await updatePageSource(binding); } catch (error) { await setFailure(binding, error); }
              }
              if (!binding.pageRefresh && mirror.canProcess(binding)) await mirrorTree.run(binding, () => mirror.process(binding));
            })
              .catch(error => { startupError = safeError(error); state = 'blocked'; })
              .finally(() => { binding._mirrorQueued = false; });
          }
        } }, scanMs);
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
    if (pageSource(binding)) return snapshot(binding);
    const remote = await remoteFor(binding);
    return { ...snapshot(binding), currentRevision: remote.revision, currentPersistedRevision: remote.persistedRevision };
  }
  async function bind({ filePath, pageId, enabled = true }) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      if (!config.syncRoot || !rootInfo) throw errorFor('INVALID_REQUEST');
      if (!uuid(pageId) || typeof enabled !== 'boolean') throw errorFor('INVALID_REQUEST');
      pageId = pageId.toLowerCase();
      if (records.size + dormantPages.size >= 50) throw errorFor('BINDING_LIMIT');
      if (dormantPages.has(pageId) || sourceTaken(config.syncRoot, filePath)
        || [...records.values()].some(binding => binding.pageId === pageId)) throw errorFor('BINDING_EXISTS');
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
        if (mirror) {
          mirror.initial(binding);
          if (knowledgeConnectionStatus(config, knowledgeAdapters).state === 'blocked') knowledgeRuntime.block(binding, 'configuration');
          const preview = await remoteFor(binding, source.content);
          if (enabled && preview.proposedRevision === preview.revision && preview.persistedRevision === preview.revision) {
            await mirror.prepare(binding, source);
            mirror.confirm(binding, { localHash: source.hash, proposedRevision: preview.revision });
          }
        }
        await persist(binding);
        records.set(binding.bindingId, binding);
        addWatcher(binding);
        return snapshot(binding);
      } catch (error) { await store.release(binding._lease); throw safeError(error); }
    });
  }
  async function control({ bindingId, action }, { allowGit = false } = {}) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      const binding = lookup(bindingId);
      if (gitSource(binding) && !allowGit) throw errorFor('INVALID_REQUEST');
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
          await store.archiveMirror(binding);
          await store.remove(binding.bindingId);
          for (const job of [binding.mirror?.pending, binding.mirror?.next].filter(Boolean)) {
            if (job.kind === 'body') await store.removeSnapshot(binding.bindingId, job.hash);
          }
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
      if (!markdownSource(binding)) throw errorFor('INVALID_REQUEST');
      clearTimeout(binding._timer);
      return enqueue(binding, async () => {
        requireWritable();
        if (!binding._lease) throw errorFor('LEASE_BUSY');
        await ensureLease(binding);
        try {
          const source = await readConfirmedSource(binding);
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
      try { await mirrorTree?.close(); } catch (error) { startupError = safeError(error); }
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
  async function retryMirror({ bindingId }) {
    await start(); requireWritable();
    const binding = lookup(bindingId);
    if (!binding._lease) throw errorFor('INVALID_REQUEST');
    if (!mirror || !knowledgeRuntime.accepts(binding)) {
      const status = providerStatus(binding);
      if (status) return status;
      throw errorFor('INVALID_REQUEST');
    }
    return enqueue(binding, async () => {
      await ensureLease(binding);
      if (gitSource(binding) && binding.pending && !await reconcile(binding)) return providerStatus(binding);
      if (binding.mirror?.operation) await reconcilePageOperation(binding);
      if (knowledgeConnectionStatus(config, knowledgeAdapters).state === 'blocked') { knowledgeRuntime.block(binding, 'configuration'); await persist(binding); return providerStatus(binding); }
      if (pageSource(binding)) {
        if (![binding.mirror?.pending, binding.mirror?.next].some(job => job?.kind === 'delete')) {
          try { await updatePageSource(binding); }
          catch (error) { await setFailure(binding, error); return providerStatus(binding); }
        }
        if (binding.pageRefresh) return providerStatus(binding);
        await mirrorTree.run(binding, () => mirror.retry(binding));
        return providerStatus(binding);
      }
      if (!binding.mirror?.pending) {
        try {
          const source = await readConfirmedSource(binding);
          const remote = await remoteFor(binding, source.content);
          if (source.hash !== binding.localHash || remote.revision !== binding.remoteRevision || remote.persistedRevision !== remote.revision || remote.proposedRevision !== remote.revision) throw errorFor('CONFLICT');
          await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: remote.revision }); await persist(binding);
        } catch { knowledgeRuntime.block(binding, 'docmost_changed'); await persist(binding); return providerStatus(binding); }
      }
      await mirrorTree.run(binding, () => mirror.retry(binding));
      return providerStatus(binding);
    });
  }
  async function currentLayout(binding, allowDeleted = false) {
    return resolveDocumentLayout({ origin: binding.origin, workspaceId: binding.workspaceId, pageId: binding.pageId, allowDeleted }, post);
  }
  async function beforePageOperation({ kind, pageId }) {
    await start(); if (!mirror || config.readOnly || closed || !['delete', 'restore'].includes(kind) || !uuid(pageId)) return;
    const ticket = { id: randomUUID(), kind, pageId: pageId.toLowerCase(), candidates: [] };
    return controlQueue(async () => {
      const captured = [];
      for (const binding of records.values()) {
        if (!binding._lease || !knowledgeRuntime?.accepts(binding)) continue;
        await enqueue(binding, async () => {
          try {
            await ensureLease(binding); await checkIdentity(binding);
            const layout = await currentLayout(binding, true);
            if (!isDescendantLayout(layout, ticket.pageId)) return;
            const page = await post('pages/info', { pageId: binding.pageId });
            if (Boolean(page.deletedAt) !== (kind === 'restore')) return;
            captured.push({ binding, parentIds: layout.parentIds, beforeDeletedAt: page.deletedAt ?? null });
          } catch { /* Optional mirror cannot prevent an authorized Docmost operation. */ }
        });
      }
      // Persist the managed descendants before the Docmost mutation. A parent
      // must not finish its directory cleanup while a child can still refresh
      // that directory's summaries and vectors. The dependency survives EOF.
      for (const candidate of captured) {
        await enqueue(candidate.binding, async () => {
          try {
            await ensureLease(candidate.binding);
            const waitFor = kind === 'delete' ? captured.filter(other => other.parentIds.includes(candidate.binding.pageId))
              .map(other => other.binding.bindingId) : [];
            mirror.initial(candidate.binding).operation = { id: ticket.id, kind, rootId: ticket.pageId,
              beforeDeletedAt: candidate.beforeDeletedAt, ...(waitFor.length ? { waitFor } : {}) };
            await persist(candidate.binding); ticket.candidates.push(candidate.binding.bindingId);
          } catch { /* Keep the successful primary operation independent. */ }
        });
      }
      return ticket;
    });
  }
  async function reconcilePageOperation(binding, cancelled = false) {
    const operation = binding.mirror?.operation;
    if (!operation || !knowledgeRuntime?.accepts(binding)) return;
    if (cancelled) { delete binding.mirror.operation; await persist(binding); return; }
    try {
      await checkIdentity(binding);
      const layout = await currentLayout(binding, true);
      if (!isDescendantLayout(layout, operation.rootId)) throw errorFor('TARGET_CHANGED');
      const page = await post('pages/info', { pageId: binding.pageId });
      if (operation.kind === 'delete') {
        if (!page.deletedAt || operation.beforeDeletedAt) return;
        // Defer only the new parent's filesystem deletion. Its earlier
        // dispatched body/task must remain able to reconcile and release a
        // namespace fence while descendants complete their deletions.
        await mirror.deleteConfirmed(binding, { waitFor: operation.waitFor });
        if (pageSource(binding)) delete binding.pageRefresh;
        binding.state = 'blocked'; binding.errorCode = 'NOT_FOUND';
      } else {
        if (page.deletedAt || !operation.beforeDeletedAt) return;
        if (pageSource(binding)) {
          await updatePageSource(binding, { restoring: true });
        } else {
          const source = await readConfirmedSource(binding);
          const remote = await remoteFor(binding, source.content);
          if (source.hash !== binding.localHash || remote.proposedRevision !== remote.revision || remote.persistedRevision !== remote.revision || remote.revision !== binding.remoteRevision) throw errorFor('CONFLICT');
          await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: remote.revision });
        }
        delete binding.mirror.operation;
        if (binding.errorCode === 'NOT_FOUND') { delete binding.errorCode; binding.state = binding.enabled ? 'synced' : 'paused'; }
      }
      await persist(binding);
    } catch (error) {
      knowledgeRuntime.block(binding, 'docmost_changed');
      delete binding.mirror.operation; await persist(binding);
    }
  }
  async function afterPageOperation(ticket, { cancelled = false } = {}) {
    if (!ticket || !Array.isArray(ticket.candidates) || !mirror || closed) return;
    const results = [];
    for (const id of ticket.candidates) {
      const binding = records.get(id);
      if (!binding || binding.mirror?.operation?.id !== ticket.id) continue;
      await enqueue(binding, async () => { await ensureLease(binding); await reconcilePageOperation(binding, cancelled); results.push({ bindingId: id, ...providerStatus(binding) }); });
    }
    return { targets: results };
  }
  async function refreshMirrorLayouts() {
    await start(); if (!mirror || config.readOnly || closed) return;
    const results = [];
    for (const binding of records.values()) {
      if (pageSource(binding) || !binding._lease || !knowledgeRuntime?.accepts(binding)) continue;
      await enqueue(binding, async () => {
        try {
          await ensureLease(binding);
          // Read inside the binding queue: an earlier write can acquire its
          // first URI or finish a move while this refresh is waiting.
          const currentUri = binding.mirror?.pending?.uri ?? binding.mirror?.uri;
          if (!currentUri) return;
          await checkIdentity(binding);
          const source = await readConfirmedSource(binding);
          const remote = validateRemote(await post('pages/sync-state', { pageId: binding.pageId, content: source.content }), binding.pageId, true);
          if (source.hash !== binding.localHash || remote.workspaceId !== binding.workspaceId || remote.revision !== binding.remoteRevision || remote.persistedRevision !== remote.revision || remote.proposedRevision !== remote.revision) return;
          const layout = await knowledgeRuntime.resolveLayout(binding);
          if (layout.uri === currentUri) return;
          await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: remote.revision });
          const job = binding.mirror.next ?? binding.mirror.pending;
          if (job) { job.allowSpaceChange = true; job.purpose = 'layout'; }
          await persist(binding); results.push({ bindingId: binding.bindingId, ...providerStatus(binding) });
        } catch { /* Keep successful Docmost metadata operations independent. */ }
      });
    }
    return { targets: results };
  }
  async function updatePageSource(binding, { restoring = false, acknowledgeCurrent = false } = {}) {
    await ensureLease(binding); await checkIdentity(binding);
    const source = await readPageSource(binding, post, { allowSpaceChange: true });
    if (!restoring && !acknowledgeCurrent && binding.pageRefresh?.previousHash === source.hash) return false;
    const layout = await knowledgeRuntime.resolveLayout(binding);
    const pending = binding.mirror?.next ?? binding.mirror?.pending;
    const currentUri = pending?.uri ?? binding.mirror?.uri;
    const samePending = pending?.kind === 'body' && pending.hash === source.hash
      && (!pending.uri || pending.uri === layout.uri);
    const sameSettled = !pending && binding.mirror?.hash === source.hash && currentUri === layout.uri && !mirror.needsRefresh?.(binding);
    if (!samePending && !sameSettled) {
      await mirror.prepare(binding, source);
      mirror.confirm(binding, { localHash: source.hash, proposedRevision: source.hash });
    }
    binding.spaceId = source.spaceId;
    binding.parentIds = layout.parentIds;
    binding.localHash = source.hash; binding.remoteRevision = source.hash;
    binding.state = binding.enabled ? 'synced' : 'paused';
    delete binding.pageRefresh; delete binding.errorCode;
    await persist(binding);
    return true;
  }
  async function syncPage({ pageId }) {
    await start();
    return controlQueue(async () => {
      requireWritable();
      if (!uuid(pageId) || !mirror) throw errorFor('INVALID_REQUEST');
      pageId = pageId.toLowerCase();
      const existing = [...records.values()].find(binding => binding.pageId === pageId);
      if (dormantPages.has(pageId)) throw errorFor('BINDING_EXISTS');
      if (existing) {
        if (!pageSource(existing)) throw errorFor('BINDING_EXISTS');
        return enqueue(existing, async () => { await updatePageSource(existing, { acknowledgeCurrent: true }); return snapshot(existing); });
      }
      if (records.size + dormantPages.size >= 50) throw errorFor('BINDING_LIMIT');
      const current = identityOf(await post('users/me', {}));
      if (current.userId !== identity.userId || current.workspaceId !== identity.workspaceId) throw errorFor('IDENTITY_CHANGED');
      const binding = { version: 1, source: 'docmost', bindingId: randomUUID(), pageId,
        workspaceId: current.workspaceId, userId: current.userId, origin: config.origin,
        enabled: true, state: 'watching', _tail: Promise.resolve() };
      const source = await readPageSource(binding, post, { allowSpaceChange: true });
      binding.spaceId = source.spaceId; binding.localHash = source.hash; binding.remoteRevision = source.hash;
      binding._lease = await store.acquire(binding, cancellation.signal);
      try {
        requireWritable();
        await updatePageSource(binding);
        records.set(binding.bindingId, binding);
        return snapshot(binding);
      } catch (error) { await store.release(binding._lease); throw safeError(error); }
    });
  }
  async function pageStatus({ pageId } = {}) {
    await start();
    if (pageId !== undefined) {
      requireRunning();
      if (!uuid(pageId)) throw errorFor('INVALID_REQUEST');
      const binding = [...records.values()].find(value => pageSource(value) && value.pageId === pageId.toLowerCase());
      return binding ? snapshot(binding) : { pageId: pageId.toLowerCase(), source: 'docmost', state: 'not_enrolled', knowledgeBase: knowledgeConnectionStatus(config, knowledgeAdapters) };
    }
    return { ...summary(), bindings: [...records.values()].filter(pageSource).map(snapshot) };
  }
  async function capturePageUpdate({ pageId }) {
    await start(); requireWritable();
    if (!uuid(pageId)) throw errorFor('INVALID_REQUEST');
    const binding = [...records.values()].find(value => pageSource(value) && value.pageId === pageId.toLowerCase());
    if (!binding || !binding.enabled || !mirror || !knowledgeRuntime.accepts(binding)) return;
    return enqueue(binding, async () => {
      await ensureLease(binding); await checkIdentity(binding);
      if (binding.pageRefresh?.previousHash !== undefined) {
        await updatePageSource(binding);
        if (binding.pageRefresh) throw errorFor('SAVE_PENDING');
      }
      const source = await readPageSource(binding, post, { allowSpaceChange: true });
      const ticket = { id: randomUUID(), pageId: binding.pageId, previousHash: source.hash };
      binding.pageRefresh = { id: ticket.id, previousHash: ticket.previousHash };
      await persist(binding);
      return ticket;
    });
  }
  async function cancelPageUpdate(ticket) {
    if (!ticket || !uuid(ticket.id) || !uuid(ticket.pageId)) return;
    await start(); requireWritable();
    const binding = [...records.values()].find(value => pageSource(value) && value.pageId === ticket.pageId);
    if (!binding) return;
    return enqueue(binding, async () => {
      if (binding.pageRefresh?.id !== ticket.id) return;
      await ensureLease(binding); delete binding.pageRefresh; await persist(binding);
      return snapshot(binding);
    });
  }
  async function refreshPageMirrors({ pageId, includeDescendants = false, expectedPreviousHash, refreshTicketId } = {}) {
    await start();
    if (!mirror || config.readOnly || closed) return { targets: [] };
    requireRunning();
    if ((pageId !== undefined && !uuid(pageId)) || typeof includeDescendants !== 'boolean'
      || (expectedPreviousHash !== undefined && (!pageId || !revision(expectedPreviousHash)))
      || (refreshTicketId !== undefined && (!pageId || !uuid(refreshTicketId)))) throw errorFor('INVALID_REQUEST');
    pageId = pageId?.toLowerCase();
    const results = [];
    for (const binding of records.values()) {
      if (!pageSource(binding) || !binding.enabled || deletingPage(binding) || !binding._lease || !knowledgeRuntime.accepts(binding)) continue;
      if (pageId && binding.pageId !== pageId && !includeDescendants) continue;
      await enqueue(binding, async () => {
        if (binding.pageId === pageId && refreshTicketId !== undefined && binding.pageRefresh?.id !== refreshTicketId) return;
        try {
          await ensureLease(binding);
          if (pageId && binding.pageId !== pageId && !binding.parentIds?.includes(pageId)
            && !isDescendantLayout(await currentLayout(binding), pageId)) return;
          if (!binding.pageRefresh) {
            binding.pageRefresh = { id: randomUUID(),
              ...(binding.pageId === pageId && expectedPreviousHash !== undefined ? { previousHash: expectedPreviousHash } : {}) };
            await persist(binding);
          }
          await updatePageSource(binding);
        } catch (error) { await setFailure(binding, error); }
        results.push(snapshot(binding));
      });
    }
    return { targets: results };
  }
  const gitMethod = name => async input => {
    await start();
    gitPublication ??= createGitPublication({ config, records, store, reader: gitReader, enqueue, controlQueue, requireWritable, requireRunning,
      ensureLease, checkIdentity, persist, snapshot, remoteFor, upload, reconcile, setFailure, errorFor, post, identity: () => identity,
      initialRemote: async (pageId, content) => validateRemote(await post('pages/sync-state', { pageId, content }), pageId, true),
      mirror, retryKnowledgeInline: binding => mirrorTree?.run(binding, () => mirror.retry(binding)),
      unbind: input => control(input, { allowGit: true }), dormantCount: () => dormantPages.size,
      sourceTaken, dormantPage: id => dormantPages.has(id), signal: cancellation.signal });
    return gitPublication[name](input ?? {});
  };
  return { start, close, bind, status, control, resolve, retryMirror, retryKnowledge: retryMirror,
    bindGitDocument: gitMethod('bindGitDocument'), publishGitDocuments: gitMethod('publishGitDocuments'), getGitDocumentStatus: gitMethod('getGitDocumentStatus'),
    setGitDocumentSync: gitMethod('setGitDocumentSync'), resolveGitDocumentConflict: gitMethod('resolveGitDocumentConflict'),
    beforePageOperation, afterPageOperation, refreshMirrorLayouts,
    syncPage, pageStatus, refreshPageMirrors, capturePageUpdate, cancelPageUpdate };
}
