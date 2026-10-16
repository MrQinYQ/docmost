import { digest } from '../../sync-files.mjs';
import { resolveMirrorLayout } from './mirror-layout.mjs';
import { ApiError } from '../../errors.mjs';
import { validOpenVikingIdentifier, validOpenVikingUri, openVikingUriMatchesUser } from '../../openviking-config.mjs';
import { readPageSource } from '../../page-source.mjs';

const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const fields = ['provider', 'version', 'connectionOrigin', 'target', 'state', 'uri', 'hash', 'revision', 'pending', 'next', 'errorCode', 'retryAt', 'operation', 'ancestorsReady', 'nodes', 'destination'];
const phases = ['await_docmost', 'ready', 'writing', 'submit', 'submit_submitting', 'indexing', 'cleanup', 'removing', 'prune_submit', 'prune_submitting', 'pruning', 'prune_cleanup', 'prune_removing', 'prune_verify'];
const jobFields = ['kind', 'hash', 'revision', 'phase', 'uri', 'oldUri', 'pruneUri', 'taskId', 'priorTaskIds', 'purpose', 'allowSpaceChange', 'waitFor', 'indexUris', 'indexCursor', 'layoutVersion'];
const states = ['waiting_docmost', 'pending', 'processing', 'retrying', 'blocked', 'synced', 'deleted'];
const taskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const dependencies = value => Array.isArray(value) && value.length <= 50
  && value.every(id => uuid(id) && id === id.toLowerCase()) && new Set(value).size === value.length;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const activeTask = task => ['pending', 'running', 'queued', 'cancelling'].includes(task.status);
const derivedFiles = new Set(['.abstract.md', '.overview.md', '.meta.json', '.relations.json', '.relations.jsonl']);
const fail = code => new ApiError(code, 'OpenViking mirror is paused or awaiting confirmation. Inspect its separate sync state; do not repeat Docmost writes.');
const safeCode = error => /^OV_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OV_REQUEST_FAILED';
const privateUri = validOpenVikingUri;
function ownUri(mirror, value) { return privateUri(value) && mirror.target && value.startsWith(`${mirror.target.rootUri}/`); }
const parentUri = value => value.slice(0, value.lastIndexOf('/'));
const sameTarget = (a, b) => a && b && ['origin', 'accountId', 'userId', 'rootUri'].every(key => a[key] === b[key]);
function validIndexChain(mirror, job) {
  if (job.indexUris === undefined && job.indexCursor === undefined) return true;
  if (job.kind !== 'body' || !ownUri(mirror, job.uri) || !job.uri.endsWith('/document.md')
    || !Array.isArray(job.indexUris) || job.indexUris.length < 2 || job.indexUris.length > 102
    || !Number.isInteger(job.indexCursor) || job.indexCursor < 0 || job.indexCursor >= job.indexUris.length) return false;
  const parts = parentUri(job.uri).slice(mirror.target.rootUri.length + 1).split('/');
  if (job.layoutVersion === 2) {
    if (parts.length < 2 || job.indexUris.length !== parts.length) return false;
  } else if (parts.length < 4 || !/^[0-9a-f]{16}$/.test(parts[0]) || !uuid(parts[1])
    || !uuid(parts[2].slice(-36)) || job.indexUris.length !== parts.length - 2) return false;
  let current = parentUri(job.uri);
  for (const uri of job.indexUris) {
    if (!ownUri(mirror, uri) || uri !== current) return false;
    current = parentUri(current);
  }
  return job.indexUris.at(-1) === `${mirror.target.rootUri}/${parts.slice(0, job.layoutVersion === 2 ? 1 : 3).join('/')}`;
}
export function validateMirror(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || (value.provider !== undefined && value.provider !== 'openviking')
    || Object.keys(value).some(k => !fields.includes(k)) || !states.includes(value.state)
    || (value.connectionOrigin !== undefined && typeof value.connectionOrigin !== 'string')
    || (value.errorCode !== undefined && !/^OV_[A-Z_]+$/.test(value.errorCode))
    || (value.hash !== undefined && !hash(value.hash)) || (value.revision !== undefined && !hash(value.revision))
    || (value.retryAt !== undefined && (!Number.isSafeInteger(value.retryAt) || value.retryAt < 0))) throw fail('OV_INVALID_STATE');
  if (value.target !== undefined && (!record(value.target) || Object.keys(value.target).sort().join(',') !== 'accountId,origin,rootUri,userId'
    || !['origin', 'accountId', 'userId'].every(k => typeof value.target[k] === 'string' && value.target[k]) || !privateUri(value.target.rootUri))) throw fail('OV_INVALID_STATE');
  if (value.destination !== undefined && (!record(value.destination) || Object.keys(value.destination).sort().join(',') !== 'rootUri,scope'
    || !['personal', 'shared'].includes(value.destination.scope)
    || (value.destination.rootUri !== null && (!validOpenVikingUri(value.destination.rootUri)
      || value.destination.rootUri.startsWith('viking://resources/') !== (value.destination.scope === 'shared'))))) throw fail('OV_INVALID_STATE');
  if (value.nodes !== undefined && (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 102
    || value.nodes.some((node, i) => !record(node) || Object.keys(node).sort().join(',') !== 'key,uri'
      || !hash(node.key) || !ownUri(value, node.uri)
      || parentUri(node.uri) !== (i ? value.nodes[i - 1].uri : value.target.rootUri)))) throw fail('OV_INVALID_STATE');
  if (value.uri !== undefined && !ownUri(value, value.uri)) throw fail('OV_INVALID_STATE');
  if (value.ancestorsReady !== undefined && (value.ancestorsReady !== true || !ownUri(value, value.uri)
    || !hash(value.hash) || !hash(value.revision))) throw fail('OV_INVALID_STATE');
  if (value.operation !== undefined && (!record(value.operation)
    || Object.keys(value.operation).some(key => !['beforeDeletedAt', 'id', 'kind', 'rootId', 'waitFor'].includes(key))
    || !uuid(value.operation.id) || !uuid(value.operation.rootId) || !['delete', 'restore'].includes(value.operation.kind)
    || (value.operation.waitFor !== undefined && !dependencies(value.operation.waitFor))
    || (value.operation.beforeDeletedAt !== null && (typeof value.operation.beforeDeletedAt !== 'string'
      || value.operation.beforeDeletedAt.length > 64 || !Number.isFinite(Date.parse(value.operation.beforeDeletedAt)))))) throw fail('OV_INVALID_STATE');
  for (const job of [value.pending, value.next].filter(job => job !== undefined)) {
    if (!record(job) || Object.keys(job).some(key => !jobFields.includes(key))
      || (job.layoutVersion !== undefined && (job.layoutVersion !== 2 || job.kind !== 'body'))
      || !['body', 'delete'].includes(job.kind) || !phases.includes(job.phase)
      || (job.kind === 'body' && !hash(job.hash)) || (job.revision !== undefined && !hash(job.revision))
      || (job.kind === 'body' && job.phase !== 'await_docmost' && !hash(job.revision))
      || (job.kind === 'delete' && (job.hash !== undefined || job.revision !== undefined || job.purpose !== undefined || job.allowSpaceChange !== undefined))
      || (job.waitFor !== undefined && (job.kind !== 'delete' || !dependencies(job.waitFor)))
      || [job.uri, job.oldUri, job.pruneUri].some(uri => uri !== undefined && !ownUri(value, uri))
      || (job.taskId !== undefined && !taskId(job.taskId))
      || (['indexing', 'pruning'].includes(job.phase) && !taskId(job.taskId))
      || (['prune_cleanup', 'prune_removing', 'prune_verify'].includes(job.phase) && (!ownUri(value, job.pruneUri) || job.taskId !== undefined))
      || (job.priorTaskIds !== undefined && (!Array.isArray(job.priorTaskIds) || job.priorTaskIds.length > 200
        || job.priorTaskIds.some(id => !taskId(id)) || new Set(job.priorTaskIds).size !== job.priorTaskIds.length))
      || (job.purpose !== undefined && job.purpose !== 'layout')
      || !validIndexChain(value, job)
      || (job.purpose === 'layout' ? job.allowSpaceChange !== true : job.allowSpaceChange !== undefined)) throw fail('OV_INVALID_STATE');
  }
}
export function mirrorStatus(binding) {
  const mirror = binding.mirror;
  if (!mirror) return undefined;
  return { state: mirror.state, ...(mirror.uri ? { uri: mirror.uri } : {}),
    ...(mirror.revision ? { confirmedRevision: mirror.revision } : {}),
    ...(mirror.pending ? { phase: mirror.pending.phase, operation: mirror.pending.kind, taskId: mirror.pending.taskId } : {}),
    ...(mirror.pending?.indexUris ? { indexUri: mirror.pending.indexUris[mirror.pending.indexCursor], indexStep: mirror.pending.indexCursor + 1,
      indexTotal: mirror.pending.indexUris.length } : {}),
    ...(mirror.errorCode ? { error: { code: mirror.errorCode, message: 'OpenViking is pending or paused; Docmost results remain independent.' } } : {}) };
}

/** Durable per-page protocol, called under the binding's serial queue.
 * Remote writes have no CAS or business idempotency key. Exclusive mirror
 * ownership and read/task reconciliation reduce races but cannot make the two
 * deployments atomic or prevent an external writer racing a successful read.
 */
export function createMirror(config, { client, post, store, persist, signal, deletionReady = () => true }) {
  const connection = config.openViking;
  const writable = () => { signal.throwIfAborted(); if (config.readOnly) throw fail('OV_READ_ONLY'); };
  const requestedDestination = () => ({ scope: connection?.rootUri?.startsWith('viking://resources/') ? 'shared' : connection?.scope ?? 'personal', rootUri: connection?.rootUri ?? null });
  function initial(binding) {
    validateMirror(binding.mirror);
    if (!binding.mirror) binding.mirror = { provider: 'openviking', version: 1, connectionOrigin: connection?.origin,
      destination: requestedDestination(), state: 'waiting_docmost' };
    // Before this field existed, unconfirmed tasks were exclusively personal.
    // Never infer permission to share an old snapshot from today's config.
    binding.mirror.destination ??= binding.mirror.target
      ? { scope: binding.mirror.target.rootUri.startsWith('viking://resources/') ? 'shared' : 'personal', rootUri: binding.mirror.target.rootUri }
      : { scope: 'personal', rootUri: null };
    return binding.mirror;
  }
  async function prepare(binding, source) {
    if (!connection) return;
    writable(); const mirror = initial(binding);
    if (connection.error) { mirror.state = 'blocked'; mirror.errorCode = connection.error.code; return; }
    if (mirror.connectionOrigin && mirror.connectionOrigin !== connection.origin) { mirror.state = 'blocked'; mirror.errorCode = 'OV_TARGET_CHANGED'; return; }
    await store.saveSnapshot(binding.bindingId, source);
    const job = { kind: 'body', hash: source.hash, phase: 'await_docmost' };
    const slot = mirror.pending && mirror.pending.phase !== 'await_docmost' ? 'next' : 'pending';
    mirror[slot] = job;
    delete mirror.ancestorsReady;
    // Snapshot garbage collection follows the caller's successful atomic save.
    // The last on-disk ledger can still reference the replaced in-memory job.
  }
  function confirm(binding, pending) {
    validateMirror(binding.mirror);
    const mirror = binding.mirror; if (!mirror) return;
    for (const job of [mirror.pending, mirror.next].filter(Boolean)) {
      if (job.kind === 'body' && job.hash === pending.localHash && job.phase === 'await_docmost') {
        job.revision = pending.proposedRevision; job.phase = 'ready'; mirror.state = 'pending'; delete mirror.errorCode;
      }
    }
  }
  async function discard(binding, sourceHash) {
    validateMirror(binding.mirror);
    const mirror = binding.mirror; if (!mirror) return;
    for (const slot of ['pending', 'next']) {
      if (mirror[slot]?.hash === sourceHash && mirror[slot].phase === 'await_docmost') {
        delete mirror[slot];
      }
    }
  }
  async function target(binding) {
    if (connection.error) throw fail(connection.error.code);
    if (!client) throw fail('OV_CONFIG_ERROR');
    const identity = await client.identity(signal);
    const rootUri = connection.rootUri ?? identity.rootUri ?? `viking://user/${identity.userId}/resources/docmost-mcp`;
    const next = { origin: connection.origin, accountId: identity.accountId, userId: identity.userId, rootUri };
    if (!validOpenVikingIdentifier(identity.accountId) || !validOpenVikingIdentifier(identity.userId)
      || !validOpenVikingUri(rootUri) || !openVikingUriMatchesUser(rootUri, identity.userId)) throw fail('OV_TARGET_CHANGED');
    const mirror = initial(binding);
    const expectedRoot = mirror.destination.rootUri ?? (mirror.destination.scope === 'shared'
      ? 'viking://resources/docmost-mcp' : `viking://user/${identity.userId}/resources/docmost-mcp`);
    if (expectedRoot !== rootUri || mirror.destination.scope !== (rootUri.startsWith('viking://resources/') ? 'shared' : 'personal')) throw fail('OV_TARGET_CHANGED');
    if (mirror.connectionOrigin && mirror.connectionOrigin !== connection.origin) throw fail('OV_TARGET_CHANGED');
    if (mirror.target && JSON.stringify(mirror.target) !== JSON.stringify(next)) throw fail('OV_TARGET_CHANGED');
    mirror.provider = 'openviking'; mirror.target = next; mirror.connectionOrigin = connection.origin;
    return next;
  }
  async function docmost(binding, job) {
    const me = await post('users/me', {});
    if (me?.user?.id !== binding.userId || me?.workspace?.id !== binding.workspaceId || config.origin !== binding.origin) throw fail('OV_DOCMOST_IDENTITY_CHANGED');
    if (job.kind === 'delete') {
      const page = await post('pages/info', { pageId: binding.pageId });
      if (page?.id !== binding.pageId || page?.workspaceId !== binding.workspaceId || !page.deletedAt) throw fail('OV_DOCMOST_CHANGED');
    } else if (binding.source === 'docmost') {
      const source = await readPageSource(binding, post, { allowSpaceChange: job.allowSpaceChange === true });
      if (source.hash !== job.revision) throw fail('OV_DOCMOST_CHANGED');
    } else {
      const remote = await post('pages/sync-state', { pageId: binding.pageId });
      if (remote?.pageId !== binding.pageId || remote?.workspaceId !== binding.workspaceId
        || remote.revision !== job.revision || remote.persistedRevision !== job.revision
        || (!job.allowSpaceChange && remote.spaceId !== binding.spaceId)) throw fail('OV_DOCMOST_CHANGED');
    }
  }
  function onlyDerived(entries, directory) {
    if (!Array.isArray(entries) || entries.some(entry => !record(entry) || typeof entry.name !== 'string'
      || !entry.name || /[\\/\x00-\x1f\x7f]/.test(entry.name) || ['.', '..'].includes(entry.name)
      || entry.uri !== `${directory}/${entry.name}` || typeof entry.isDir !== 'boolean')) throw fail('OV_INVALID_RESPONSE');
    return entries.every(entry => derivedFiles.has(entry.name) && !entry.isDir && !entry.isDirectory && !entry.is_dir && entry.type !== 'directory');
  }
  async function cleanDirectory(uri) {
    const directory = uri.slice(0, uri.lastIndexOf('/'));
    const entries = await client.list(directory, signal);
    if (entries === undefined) return directory;
    // A parent folder can contain a different bound child or an unknown asset.
    if (!onlyDerived(entries, directory)) return uri;
    const result = await client.remove(directory, { recursive: true }, signal);
    if (['failed', 'queued', 'pending', 'deferred'].includes(result.semanticStatus)) throw fail('OV_PROCESSING_PENDING');
    return directory;
  }
  async function finish(binding, job) {
    const mirror = binding.mirror;
    if (job.kind === 'body' && job.indexUris && job.indexCursor + 1 < job.indexUris.length) {
      // A move's old leaf and its cleanup queues must settle before the new
      // ancestors aggregate their final children. This keeps the original
      // durable cleanup protocol intact, then resumes the bounded index chain.
      job.indexCursor++; job.phase = 'submit';
      delete job.oldUri; delete job.pruneUri; delete job.taskId; delete job.priorTaskIds;
      await persist(binding); return;
    }
    if (job.kind === 'body') { mirror.uri = job.uri; mirror.hash = job.hash; mirror.revision = job.revision; }
    else { delete mirror.uri; delete mirror.hash; delete mirror.revision; }
    if (job.kind === 'body' && job.indexUris && job.indexCursor === job.indexUris.length - 1) mirror.ancestorsReady = true;
    else delete mirror.ancestorsReady;
    mirror.pending = mirror.next; delete mirror.next;
    if (!mirror.pending) delete mirror.pending;
    mirror.state = mirror.pending ? 'pending' : job.kind === 'delete' ? 'deleted' : 'synced';
    delete mirror.errorCode; delete mirror.retryAt; await persist(binding);
  }
  async function beginTask(binding, job, uri, mode, phase) {
    const recovering = job.phase === `${phase}_submitting`;
    if (!recovering) job.priorTaskIds = (await client.tasks(uri, signal)).map(task => task.taskId);
    job.phase = `${phase}_submitting`; await persist(binding);
    let submitted;
    if (recovering) {
      if (!Array.isArray(job.priorTaskIds)) throw fail('OV_UNCONFIRMED');
      const tasks = (await client.tasks(uri, signal)).filter(task => !job.priorTaskIds.includes(task.taskId));
      if (tasks.length !== 1) throw fail('OV_UNCONFIRMED');
      submitted = { taskId: tasks[0].taskId };
    } else {
      try { submitted = await client.reindex(uri, mode, signal); }
      catch (error) {
        if (error.mayHaveSucceeded === false) {
          job.phase = phase === 'prune' ? 'prune_submit' : 'submit';
          delete job.priorTaskIds; await persist(binding);
        }
        throw error;
      }
    }
    job.taskId = submitted.taskId; job.phase = phase === 'prune' ? 'pruning' : 'indexing'; await persist(binding);
  }
  async function checkAncestorInputs(binding, uri) {
    const entries = await client.list(uri, signal);
    if (!Array.isArray(entries) || entries.some(entry => !record(entry) || typeof entry.name !== 'string'
      || !entry.name || /[\\/\x00-\x1f\x7f]/.test(entry.name) || ['.', '..'].includes(entry.name)
      || entry.uri !== `${uri}/${entry.name}` || typeof entry.isDir !== 'boolean')) throw fail('OV_INVALID_RESPONSE');
    for (const entry of entries) {
      if (entry.isDir) { if (derivedFiles.has(entry.name)) throw fail('OV_CONFLICT'); continue; }
      if (derivedFiles.has(entry.name)) continue;
      if (entry.name !== 'document.md') throw fail('OV_CONFLICT');
      const owners = (await store.load()).map(item => item.value).filter(owner => owner.enabled
        && owner.origin === binding.origin && owner.workspaceId === binding.workspaceId && owner.userId === binding.userId
        && sameTarget(owner.mirror?.target, binding.mirror.target));
      let confirmed;
      for (const owner of owners) {
        validateMirror(owner.mirror);
        const candidates = [owner.mirror, owner.mirror.pending, owner.mirror.next].filter(candidate => candidate?.uri === entry.uri
          && hash(candidate.hash) && hash(candidate.revision) && candidate.phase !== 'await_docmost');
        if (!candidates.length) continue;
        const content = await client.read(entry.uri, signal);
        const candidate = candidates.find(value => typeof content === 'string' && digest(content) === value.hash);
        if (!candidate) continue;
        await docmost(owner, { kind: 'body', revision: candidate.revision }); confirmed = true; break;
      }
      if (!confirmed) throw fail('OV_CONFLICT');
    }
  }
  function dispatchBody(binding, job) {
    if (binding.pending || ['conflict', 'unconfirmed'].includes(binding.state)) return false;
    if (job.purpose === 'layout' && job.allowSpaceChange === true)
      return !binding.errorCode || binding.errorCode === 'TARGET_CHANGED';
    return binding.enabled && !['paused', 'blocked'].includes(binding.state);
  }
  function dispatchPruneCleanup(binding, job, successor) {
    if (binding.pending || ['paused', 'conflict', 'unconfirmed'].includes(binding.state)) return false;
    if (successor?.kind === 'body') return dispatchBody(binding, successor);
    if (job.kind === 'body' && successor?.kind !== 'delete') return dispatchBody(binding, job);
    // An explicit confirmed deletion puts its Docmost binding in NOT_FOUND.
    return !binding.errorCode || binding.errorCode === 'NOT_FOUND';
  }
  async function checkOwnedBody(job) {
    const content = await client.read(job.uri, signal);
    if (content === undefined) throw fail('OV_UNCONFIRMED');
    if (digest(content) !== job.hash) throw fail('OV_CONFLICT');
  }
  async function handoffDeletion(binding, job, deletion) {
    if (job.oldUri) {
      // Complete cleanup of the earlier owned location first. Finishing this
      // job records the proven leaf, then its queued deletion removes that leaf.
      job.phase = 'cleanup'; delete job.taskId; await persist(binding);
      return job;
    }
    Object.assign(binding.mirror, { uri: job.uri, hash: job.hash, revision: job.revision, pending: deletion, state: 'pending' });
    delete binding.mirror.next; delete binding.mirror.errorCode; delete binding.mirror.retryAt;
    await persist(binding);
    return deletion;
  }
  function canProcess(binding) {
    validateMirror(binding.mirror);
    if (!connection || config.readOnly || signal.aborted) return false;
    const mirror = binding.mirror, job = mirror?.pending;
    if (!job || job.phase === 'await_docmost' || mirror.operation || mirror.state === 'blocked' || (mirror.retryAt ?? 0) > Date.now()) return false;
    if (job.kind === 'delete' && ['ready', 'cleanup'].includes(job.phase) && !deletionReady(binding, job)) return false;
    const successor = mirror.next?.phase === 'ready' ? mirror.next : undefined;
    if (job.kind === 'body' && job.phase === 'cleanup' && successor?.kind === 'delete' && !deletionReady(binding, successor)) return false;
    const newerBody = job.kind === 'body' && successor?.kind === 'body' && dispatchBody(binding, successor);
    const deletingSuccessor = job.kind === 'body' && successor?.kind === 'delete';
    const restoringSuccessor = job.kind === 'delete' && successor?.kind === 'body';
    // A restoration is a body publication, so it retains the normal source
    // pause/conflict guard even while an earlier delete is being reconciled.
    if (restoringSuccessor && !dispatchBody(binding, successor)) return false;
    if (['prune_cleanup', 'prune_removing', 'prune_verify'].includes(job.phase) && !dispatchPruneCleanup(binding, job, successor)) return false;
    const paused = job.kind === 'body' && !dispatchBody(binding, job) && !newerBody && !deletingSuccessor;
    return !paused || ['indexing', 'pruning'].includes(job.phase);
  }
  async function process(binding) {
    if (!canProcess(binding)) return;
    const mirror = binding.mirror; let job = mirror.pending;
    const successor = mirror.next?.phase === 'ready' ? mirror.next : undefined;
    const newerBody = job.kind === 'body' && successor?.kind === 'body' && dispatchBody(binding, successor);
    const deletingSuccessor = job.kind === 'body' && successor?.kind === 'delete';
    const restoringSuccessor = job.kind === 'delete' && successor?.kind === 'body';
    let paused = job.kind === 'body' && !dispatchBody(binding, job) && !newerBody && !deletingSuccessor;
    try {
      writable(); await target(binding);
      // A newer version has already passed Docmost's live + persisted checks.
      // Verify that version again, then reconcile the old owned output before
      // advancing the queue. Without this successor, remote edits remain conflicts.
      let checkedSuccessor = false;
      if (restoringSuccessor) {
        await docmost(binding, successor); checkedSuccessor = true;
        if (['ready', 'cleanup'].includes(job.phase)) {
          // No DELETE request can have been dispatched before "removing" was
          // saved. Keep the known old resource and replace it with the restored
          // body under the normal ownership check below.
          mirror.pending = successor; delete mirror.next; job = successor;
          mirror.state = 'pending'; delete mirror.errorCode; delete mirror.retryAt;
          await persist(binding);
        } else if (job.phase === 'removing') {
          // Neither presence nor absence proves an interrupted DELETE has
          // ended. A late request could otherwise delete the restored body.
          const current = await client.read(job.uri, signal);
          if (current !== undefined && digest(current) !== mirror.hash) throw fail('OV_CONFLICT');
          throw fail('OV_UNCONFIRMED');
        } else if (job.phase === 'prune_removing') throw fail('OV_UNCONFIRMED');
        else if (!['prune_submit', 'prune_submitting', 'pruning', 'prune_cleanup', 'prune_verify'].includes(job.phase)) throw fail('OV_INVALID_STATE');
      }
      if ((newerBody || deletingSuccessor) && !['indexing', 'pruning'].includes(job.phase)) {
        await docmost(binding, successor); checkedSuccessor = true;
        if (job.phase === 'ready' && !job.uri) {
          mirror.pending = successor; delete mirror.next; job = successor;
          mirror.state = 'pending'; delete mirror.errorCode; delete mirror.retryAt;
          await persist(binding); paused = !dispatchBody(binding, job);
        } else if (['writing', 'submit'].includes(job.phase)) {
          await checkOwnedBody(job);
          if ((await client.tasks(job.uri.slice(0, job.uri.lastIndexOf('/')), signal)).some(activeTask)) throw fail('OV_UNCONFIRMED');
          if (deletingSuccessor) job = await handoffDeletion(binding, job, successor);
          else if (job.phase === 'writing') { job.phase = 'submit'; await persist(binding); }
        } else if (job.phase === 'submit_submitting') await checkOwnedBody(job);
      }
      // Already submitted index jobs may be observed while the source is paused.
      if (!['indexing', 'pruning'].includes(job.phase) && !checkedSuccessor) await docmost(binding, job);
      if (job.kind === 'body' && job.phase === 'ready') {
        const owners = [...(store.load ? await store.load() : []), ...(store.loadMirrorHistory ? await store.loadMirrorHistory() : [])];
        const claims = [binding, ...owners.map(item => item.value)].filter(owner => sameTarget(owner.mirror?.target, mirror.target))
          .flatMap(owner => { validateMirror(owner.mirror); return owner.mirror.nodes ?? []; });
        const layout = await resolveMirrorLayout({ rootUri: mirror.target.rootUri, origin: binding.origin, workspaceId: binding.workspaceId, pageId: binding.pageId,
          claims, isOccupied: async uri => await client.list(uri, signal) !== undefined }, post);
        mirror.nodes = layout.nodes; job.layoutVersion = 2;
        job.uri = layout.uri; job.oldUri = mirror.uri && mirror.uri !== job.uri ? mirror.uri : undefined;
        if (binding.source === 'docmost') {
          job.indexUris = [layout.pageDirectory]; job.indexCursor = 0;
          for (let depth = 0; depth <= layout.parentIds.length; depth++) job.indexUris.push(parentUri(job.indexUris.at(-1)));
        }
        job.phase = 'writing'; mirror.state = 'processing'; await persist(binding);
        const current = await client.read(job.uri, signal);
        if (current !== undefined && digest(current) !== job.hash && !(job.uri === mirror.uri && digest(current) === mirror.hash)) throw fail('OV_CONFLICT');
        if (current === undefined || digest(current) !== job.hash) {
          const content = await store.readSnapshot(binding.bindingId, job.hash);
          await client.write(job.uri, content, signal);
        }
        job.phase = 'submit'; await persist(binding);
      }
      if (job.kind === 'body' && job.phase === 'writing') {
        const current = await client.read(job.uri, signal);
        if (current === undefined || digest(current) !== job.hash) throw fail('OV_UNCONFIRMED');
        job.phase = 'submit'; await persist(binding);
      }
      if (['submit', 'submit_submitting'].includes(job.phase)) {
        await checkOwnedBody(job);
        const indexUri = job.indexUris?.[job.indexCursor] ?? parentUri(job.uri);
        if (job.indexCursor > 0 && job.phase === 'submit') await checkAncestorInputs(binding, indexUri);
        await beginTask(binding, job, indexUri, 'semantic_and_vectors', 'submit'); return;
      }
      if (job.phase === 'indexing' || job.phase === 'pruning') {
        const task = await client.task(job.taskId, signal);
        if (activeTask(task)) return;
        if (!deletingSuccessor && task.status === 'failed' && task.failureCode === 'OV_TREE_BUSY') {
          job.phase = job.phase === 'indexing' ? 'submit' : 'prune_submit';
          delete job.taskId; delete job.priorTaskIds;
          mirror.state = 'retrying'; mirror.errorCode = 'OV_TREE_BUSY'; mirror.retryAt = Date.now() + 1000;
          await persist(binding); return;
        }
        if (!(deletingSuccessor && job.phase === 'indexing' && ['completed', 'failed', 'cancelled'].includes(task.status))
          && (task.status !== 'completed' || task.failedRecords !== 0 || task.unsupportedRecords > 0)) throw fail('OV_PROCESSING_FAILED');
        if (job.phase === 'indexing') {
          const content = await client.read(job.uri, signal);
          if ((content === undefined && !deletingSuccessor) || (content !== undefined && digest(content) !== job.hash)) throw fail('OV_CONFLICT');
          if (deletingSuccessor) {
            await docmost(binding, successor);
            job = await handoffDeletion(binding, job, successor);
          } else {
            if (paused) return;
            if (job.indexUris && !job.oldUri && job.indexCursor + 1 < job.indexUris.length) {
              job.indexCursor++; job.phase = 'submit'; delete job.taskId; delete job.priorTaskIds;
              await persist(binding); return;
            }
            if (!job.oldUri) { await finish(binding, job); return; }
            job.phase = 'cleanup'; delete job.taskId; await persist(binding);
          }
        } else {
          // OpenViking's prune task acquires a tree lock that can create a
          // directory at an already-deleted file URI. Track its cleanup as a
          // separate mutation, never widening the exact prune scope.
          job.phase = 'prune_cleanup'; delete job.taskId; delete job.priorTaskIds;
          await persist(binding);
          if (!dispatchPruneCleanup(binding, job, successor)) return;
          await docmost(binding, successor ?? job);
        }
      }
      if (job.kind === 'delete' && job.phase === 'ready') {
        // Reconciliation can hand off an uncertain body into this new job in
        // the same invocation. Its children may still need the namespace.
        if (!deletionReady(binding, job)) return;
        if (!mirror.uri) { await finish(binding, job); return; }
        job.uri = mirror.uri; job.phase = 'cleanup'; await persist(binding);
      }
      if (job.phase === 'cleanup' || job.phase === 'removing') {
        const uri = job.kind === 'delete' ? job.uri : job.oldUri;
        if (!ownUri(mirror, uri)) throw fail('OV_INVALID_STATE');
        if (job.phase === 'cleanup') {
          const deletion = job.kind === 'delete' ? job : successor?.kind === 'delete' ? successor : undefined;
          if (deletion && !deletionReady(binding, deletion)) return;
          // Drain earlier detached refreshes before removing the original
          // leaf and choosing a directory cleanup scope. The first DELETE is
          // still undispatched if the barrier or fresh Docmost proof fails.
          await client.waitProcessed(signal);
          await docmost(binding, successor ?? job);
          if (deletion && !deletionReady(binding, deletion)) return;
        }
        job.phase = 'removing'; await persist(binding);
        const current = await client.read(uri, signal);
        if (current !== undefined && digest(current) !== mirror.hash) throw fail('OV_CONFLICT');
        if (current !== undefined) {
          const result = await client.remove(uri, {}, signal);
          if (['failed', 'queued', 'pending', 'deferred'].includes(result.semanticStatus)) throw fail('OV_PROCESSING_PENDING');
        }
        if (await client.read(uri, signal) !== undefined) throw fail('OV_UNCONFIRMED');
        job.pruneUri = await cleanDirectory(uri); job.phase = 'prune_submit'; await persist(binding);
      }
      if (['prune_submit', 'prune_submitting'].includes(job.phase)) await beginTask(binding, job, job.pruneUri, 'prune_orphans', 'prune');
      if (job.phase === 'prune_removing') throw fail('OV_UNCONFIRMED');
      if (job.phase === 'prune_cleanup') {
        if (!ownUri(mirror, job.pruneUri)) throw fail('OV_INVALID_STATE');
        await client.waitProcessed(signal);
        await docmost(binding, successor ?? job);
        const entries = await client.list(job.pruneUri, signal);
        if (entries === undefined) { await finish(binding, job); return; }
        if (!onlyDerived(entries, job.pruneUri)) throw fail('OV_CONFLICT');
        // Persist the uncertainty fence before DELETE. A resumed invocation
        // cannot infer that a lost response is terminal from mere FS absence.
        job.phase = 'prune_removing'; await persist(binding);
        let result;
        try { result = await client.remove(job.pruneUri, { recursive: true }, signal); }
        catch (error) {
          // A definite HTTP rejection did not dispatch a deletion. Keep the
          // safe listing/permission stage retryable after credentials change.
          // Processing results and later read failures remain uncertain.
          if (error.mayHaveSucceeded === false) { job.phase = 'prune_cleanup'; await persist(binding); }
          throw error;
        }
        if (result.semanticStatus !== 'complete') throw fail('OV_PROCESSING_PENDING');
        // The DELETE is now acknowledged. A later barrier timeout or read
        // failure only resumes verification, never an uncertain DELETE replay.
        job.phase = 'prune_verify'; await persist(binding);
      }
      if (job.phase === 'prune_verify') {
        if (!ownUri(mirror, job.pruneUri)) throw fail('OV_INVALID_STATE');
        await client.waitProcessed(signal);
        await docmost(binding, successor ?? job);
        const entries = await client.list(job.pruneUri, signal);
        if (entries === undefined) { await finish(binding, job); return; }
        if (!onlyDerived(entries, job.pruneUri)) throw fail('OV_CONFLICT');
        // Detached parent refreshes can recreate only sidecars after DELETE.
        // Their completed output is safe to clean in a new, separately checked
        // turn; unknown entries never authorize another recursive deletion.
        job.phase = 'prune_cleanup'; mirror.state = 'pending'; delete mirror.errorCode; delete mirror.retryAt;
        await persist(binding);
      }
    } catch (error) {
      if (signal.aborted) return;
      mirror.errorCode = safeCode(error);
      const transient = ['OV_NETWORK_ERROR', 'OV_TIMEOUT', 'OV_PROCESSING_PENDING', 'OV_RATE_LIMITED'].includes(mirror.errorCode);
      mirror.state = transient ? 'retrying' : 'blocked';
      if (transient) mirror.retryAt = Date.now() + 30000;
      await persist(binding);
    }
  }
  async function deleteConfirmed(binding, { waitFor } = {}) {
    const mirror = initial(binding);
    // Submitted work must finish before deleting its output.
    if (waitFor !== undefined && !dependencies(waitFor)) throw fail('OV_INVALID_STATE');
    const deletion = { kind: 'delete', phase: 'ready', ...(waitFor === undefined ? {} : { waitFor: [...waitFor] }) };
    if (mirror.pending?.taskId || (mirror.pending?.kind === 'body' && !['ready', 'await_docmost'].includes(mirror.pending.phase))
      || (mirror.pending?.kind === 'delete' && !['ready', 'cleanup', 'await_docmost'].includes(mirror.pending.phase))) mirror.next = deletion;
    else mirror.pending = deletion;
    mirror.state = 'pending'; delete mirror.errorCode; delete mirror.retryAt; delete mirror.operation;
  }
  async function retry(binding) {
    writable(); const mirror = initial(binding), job = mirror.pending;
    if (job?.taskId && ['indexing', 'pruning'].includes(job.phase)) {
      const task = await client.task(job.taskId, signal);
      if (['failed', 'cancelled'].includes(task.status) || (task.status === 'completed'
        && (task.failedRecords !== 0 || task.unsupportedRecords > 0))) {
        job.phase = job.phase === 'indexing' ? 'submit' : 'prune_submit';
        delete job.taskId; delete job.priorTaskIds;
      }
    }
    mirror.state = 'pending'; delete mirror.errorCode; delete mirror.retryAt;
    await persist(binding); await process(binding); return mirrorStatus(binding);
  }
  return { initial, prepare, confirm, discard, canProcess, process, retry, deleteConfirmed,
    needsRefresh: binding => binding.source === 'docmost' && !binding.mirror?.ancestorsReady };
}
