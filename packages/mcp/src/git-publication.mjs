import { randomUUID } from 'node:crypto';
import { validRelativeFile } from './sync-files.mjs';
import { readPageSource } from './page-source.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const gitBinding = binding => binding.source === 'git';

/** Reuses the manager's one ledger, page queue, CAS and knowledge coordinator. */
export function createGitPublication(context) {
  const { config, records, store, reader, enqueue, controlQueue, requireWritable, requireRunning,
    ensureLease, checkIdentity, persist, snapshot, remoteFor, upload, reconcile, setFailure,
    errorFor, identity, initialRemote, mirror, retryKnowledgeInline, unbind, dormantCount, sourceTaken, dormantPage } = context;
  const lookup = id => {
    if (!uuid(id)) throw errorFor('INVALID_REQUEST');
    const binding = records.get(id);
    if (!binding || !gitBinding(binding)) throw errorFor('NOT_FOUND');
    return binding;
  };
  async function check(binding) {
    await ensureLease(binding); await checkIdentity(binding);
    const current = await reader.identity();
    if (binding.root !== config.gitRoot || current.commonDir !== binding.git.commonDir || current.objectFormat !== binding.git.objectFormat) throw errorFor('TARGET_CHANGED');
  }
  const version = (source, commit, branch, filePath) => ({ commit, branch, blob: source.blob, hash: source.hash, filePath });
  async function bindGitDocument(input) {
    return controlQueue(async () => {
      requireWritable();
      if (!reader || !uuid(input.pageId) || !validRelativeFile(input.filePath)) throw errorFor('INVALID_REQUEST');
      const pageId = input.pageId.toLowerCase();
      const previous = [...records.values()].find(binding => binding.pageId === pageId);
      if (dormantPage(pageId) || (previous && previous.bindingId !== input.replaceBindingId) || (!previous && input.replaceBindingId)
        || sourceTaken(config.gitRoot, input.filePath, previous)) throw errorFor('BINDING_EXISTS');
      if (!previous && records.size + dormantCount() >= 50) throw errorFor('BINDING_LIMIT');
      const operation = async () => {
        requireWritable();
        if (previous) {
          await ensureLease(previous); await checkIdentity(previous);
          if (previous.pending || previous.pageRefresh || previous.git?.intent || previous.mirror?.pending || previous.mirror?.next || previous.mirror?.operation) throw errorFor('SAVE_PENDING');
        }
        await reader.resolveCommit(input);
        const source = await reader.readSnapshot(input);
        if (source.kind !== 'body') throw errorFor('GIT_SOURCE_DELETED');
        const repo = await reader.identity();
        const current = identity();
        const remote = await initialRemote(pageId, source.content);
        if (remote.workspaceId !== current.workspaceId) throw errorFor('TARGET_CHANGED');
        if (remote.revision !== remote.persistedRevision) throw errorFor('CONFLICT');
        if (remote.revision !== remote.proposedRevision) {
          // An existing page may use different editor block IDs. Exact saved
          // text plus stable live/persisted versions proves a no-write baseline.
          const observed = await readPageSource({ pageId, workspaceId: current.workspaceId, spaceId: remote.spaceId }, context.post);
          const after = await initialRemote(pageId, source.content);
          if (observed.hash !== source.hash || after.revision !== remote.revision || after.persistedRevision !== remote.revision) throw errorFor('CONFLICT');
        }
        const binding = { ...(previous ?? {}), version: 1, source: 'git', bindingId: previous?.bindingId ?? randomUUID(),
          origin: config.origin, userId: current.userId, workspaceId: current.workspaceId, pageId, spaceId: remote.spaceId,
          root: config.gitRoot, filePath: input.filePath, enabled: true, state: 'synced', localHash: source.hash, remoteRevision: remote.revision,
          git: { version: 1, commonDir: repo.commonDir, objectFormat: repo.objectFormat, published: version(source, input.commit, input.branch, input.filePath) },
          _tail: previous?._tail ?? Promise.resolve() };
        delete binding.errorCode; delete binding.pageRefresh; delete binding.pending;
        if (!previous) binding._lease = await store.acquire(binding, context.signal);
        try {
          if (mirror) { await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: remote.revision }); }
          await persist(binding);
          if (previous) {
            clearTimeout(previous._timer);
            for (const key of ['pageRefresh', 'pending', 'errorCode']) delete previous[key];
            Object.assign(previous, binding); records.set(binding.bindingId, previous);
          } else records.set(binding.bindingId, binding);
          return snapshot(records.get(binding.bindingId));
        } catch (error) { if (!previous) await store.release(binding._lease); throw error; }
      };
      return previous ? enqueue(previous, operation) : operation();
    });
  }
  async function publishOne(binding, input, expectedRevision) {
    requireWritable();
    if (!binding.enabled && expectedRevision === undefined) return snapshot(binding);
    try {
      await check(binding);
      let superseding = false;
      if (binding.pending && !await reconcile(binding)) {
        if (expectedRevision === undefined || binding.errorCode !== 'CONFLICT') return snapshot(binding);
        // A later observed web edit disproves the old expected/proposed state.
        // Explicit replacement must retain even the unacknowledged Git history.
        if (!await reader.isAncestor(binding.git.intent.commit, input.commit)) throw errorFor('GIT_BRANCH_CONFLICT');
        superseding = true;
      }
      const published = binding.git.published;
      let filePath = binding.filePath;
      let source = await reader.readSnapshot({ commit: input.commit, filePath });
      if (source.kind === 'deleted') {
        const renamed = await reader.findRename({ fromCommit: published.commit, toCommit: input.commit, filePath });
        if (!renamed) throw errorFor('GIT_SOURCE_DELETED');
        filePath = renamed; source = await reader.readSnapshot({ commit: input.commit, filePath });
      }
      const renamed = filePath !== (published.filePath ?? binding.filePath);
      if ((source.hash !== published.hash || renamed || expectedRevision !== undefined)
        && !await reader.isAncestor(published.commit, input.commit)) throw errorFor('GIT_BRANCH_CONFLICT');
      const remote = await remoteFor(binding, source.content);
      if (remote.revision !== (expectedRevision ?? binding.remoteRevision)
        || (expectedRevision === undefined && remote.persistedRevision !== remote.revision)) throw errorFor('CONFLICT');
      binding.git.lastChecked = { commit: input.commit, branch: input.branch };
      if (input.pushReceipt) binding.git.pushReceipt = input.pushReceipt;
      if (source.hash === published.hash && expectedRevision === undefined) {
        if (sourceTaken(config.gitRoot, filePath, binding)) throw errorFor('BINDING_EXISTS');
        binding.filePath = filePath;
        if (renamed) binding.git.published = version(source, input.commit, input.branch, filePath);
        if (binding.git.intent) { await mirror?.discard(binding, binding.git.intent.hash); delete binding.git.intent; }
        delete binding.errorCode; binding.state = 'synced';
        if (mirror && (!binding.mirror || binding.mirror.hash !== source.hash || mirror.needsRefresh?.(binding))) {
          await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: binding.remoteRevision });
        }
        await persist(binding);
        if (binding.mirror?.pending) await retryKnowledgeInline(binding);
        return snapshot(binding);
      }
      if (binding.git.intent && (!binding.pending || superseding)) await mirror?.discard(binding, binding.git.intent.hash);
      if (sourceTaken(config.gitRoot, filePath, binding)) throw errorFor('BINDING_EXISTS');
      binding.filePath = filePath;
      binding.git.intent = version(source, input.commit, input.branch, filePath);
      await store.saveSnapshot(binding.bindingId, source);
      if (superseding) delete binding.pending;
      await persist(binding);
      binding.enabled = true;
      await upload(binding, source, expectedRevision ?? binding.remoteRevision, expectedRevision !== undefined);
      return snapshot(binding);
    } catch (error) { await setFailure(binding, error); return snapshot(binding); }
  }
  async function publishGitDocuments(input) {
    requireWritable();
    if (!reader) throw errorFor('INVALID_REQUEST');
    await reader.resolveCommit(input);
    let bindings = [...records.values()].filter(gitBinding);
    if (input.bindingIds !== undefined) {
      if (!Array.isArray(input.bindingIds) || input.bindingIds.length < 1 || input.bindingIds.length > 50 || new Set(input.bindingIds).size !== input.bindingIds.length) throw errorFor('INVALID_REQUEST');
      bindings = input.bindingIds.map(lookup);
    }
    const pushReceipt = input.remote ? await reader.confirmPush(input) : undefined;
    const documents = [];
    for (const binding of bindings) documents.push(await enqueue(binding, () => publishOne(binding, { ...input, pushReceipt })));
    return { commit: input.commit, branch: input.branch, documents, ...(pushReceipt ? { pushReceipt } : {}) };
  }
  async function getGitDocumentStatus({ bindingId } = {}) {
    requireRunning();
    if (bindingId === undefined) return { bindings: [...records.values()].filter(gitBinding).map(snapshot), readOnly: Boolean(config.readOnly) };
    const binding = lookup(bindingId);
    const remote = await remoteFor(binding);
    return { ...snapshot(binding), currentRevision: remote.revision, currentPersistedRevision: remote.persistedRevision };
  }
  async function resolveGitDocumentConflict(input) {
    requireWritable();
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision ?? '')) throw errorFor('INVALID_REQUEST');
    const binding = lookup(input.bindingId); await reader.resolveCommit(input);
    return enqueue(binding, () => publishOne(binding, input, input.expectedRevision));
  }
  async function setGitDocumentSync({ bindingId, action, filePath }) {
    requireWritable(); const binding = lookup(bindingId);
    if (action === 'unbind') {
      if (binding.pending || binding.git.intent) throw errorFor('SAVE_PENDING');
      return unbind({ bindingId, action });
    }
    return enqueue(binding, async () => {
      await check(binding);
      if (action === 'rebind') {
        if (!validRelativeFile(filePath)) throw errorFor('INVALID_REQUEST');
        if (binding.pending || binding.git.intent) throw errorFor('SAVE_PENDING');
        if (sourceTaken(config.gitRoot, filePath, binding)) throw errorFor('BINDING_EXISTS');
        binding.filePath = filePath;
      } else if (action === 'pause') binding.enabled = false;
      else if (action === 'resume') {
        if (binding.pending || ['CONFLICT', 'UNCONFIRMED', 'GIT_BRANCH_CONFLICT'].includes(binding.errorCode)) return snapshot(binding);
        binding.enabled = true;
      } else throw errorFor('INVALID_REQUEST');
      if (!binding.errorCode) binding.state = binding.enabled ? 'synced' : 'paused';
      await persist(binding); return snapshot(binding);
    });
  }
  return { bindGitDocument, publishGitDocuments, getGitDocumentStatus, setGitDocumentSync, resolveGitDocumentConflict };
}
