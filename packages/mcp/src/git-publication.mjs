import { randomUUID } from 'node:crypto';
import { validRelativeFile } from './sync-files.mjs';
import { readPageSource } from './page-source.mjs';
import { gitRepositoryId, sameGitRepository } from './git-repositories.mjs';
import { ApiError } from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const gitBinding = binding => binding.source === 'git';

/** Reuses the manager's one ledger, page queue, CAS and knowledge coordinator. */
export function createGitPublication(context) {
  const { config, records, store, repositories, enqueue, controlQueue, requireWritable, requireRunning,
    ensureLease, checkIdentity, persist, snapshot, remoteFor, upload, reconcile, setFailure,
    errorFor, identity, initialRemote, mirror, retryKnowledgeInline, unbind, dormantCount, sourceTaken, dormantPage } = context;
  const lookup = id => {
    if (!uuid(id)) throw errorFor('INVALID_REQUEST');
    const binding = records.get(id);
    if (!binding || !gitBinding(binding)) throw errorFor('NOT_FOUND');
    return binding;
  };
  const projectRoot = input => {
    const root = input.repositoryRoot ?? config.gitRoot;
    if (root === undefined) throw new ApiError('INVALID_REQUEST', 'Pass repositoryRoot detected from the current project. A fixed Git root is not required in the MCP configuration.');
    return root;
  };
  async function check(binding, root) {
    await ensureLease(binding); await checkIdentity(binding);
    return repositories.forBinding(binding, root);
  }
  const version = (source, commit, branch, filePath) => ({ commit, branch, blob: source.blob, hash: source.hash, filePath });
  async function bindGitDocument(input) {
    return controlQueue(async () => {
      requireWritable();
      if (!uuid(input.pageId) || !validRelativeFile(input.filePath)) throw errorFor('INVALID_REQUEST');
      const root = projectRoot(input), reader = await repositories.open(root), repo = await reader.identity();
      const pageId = input.pageId.toLowerCase();
      const previous = [...records.values()].find(binding => binding.pageId === pageId);
      if (dormantPage(pageId) || (previous && previous.bindingId !== input.replaceBindingId) || (!previous && input.replaceBindingId)
        || sourceTaken(root, input.filePath, previous, repo.commonDir, repo.prefix)) throw errorFor('BINDING_EXISTS');
      if (!previous && records.size + dormantCount() >= 50) throw errorFor('BINDING_LIMIT');
      const operation = async () => {
        requireWritable();
        if (previous) {
          await ensureLease(previous); await checkIdentity(previous);
          if (gitBinding(previous)) await repositories.forBinding(previous, root);
          if (previous.pending || previous.pageRefresh || previous.git?.intent || previous.mirror?.pending || previous.mirror?.next || previous.mirror?.operation) throw errorFor('SAVE_PENDING');
        }
        await reader.resolveCommit(input);
        const source = await reader.readSnapshot(input);
        if (source.kind !== 'body') throw errorFor('GIT_SOURCE_DELETED');
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
          root, filePath: input.filePath, enabled: true, state: 'synced', localHash: source.hash, remoteRevision: remote.revision,
          git: { version: 1, commonDir: repo.commonDir, objectFormat: repo.objectFormat, instance: repo.instance, prefix: repo.prefix, published: version(source, input.commit, input.branch, input.filePath) },
          _tail: previous?._tail ?? Promise.resolve() };
        delete binding.errorCode; delete binding.pageRefresh; delete binding.pending;
        if (!previous) await ensureLease(binding);
        try {
          if (mirror) { await mirror.prepare(binding, source); mirror.confirm(binding, { localHash: source.hash, proposedRevision: remote.revision }); }
          await persist(binding);
          if (previous) {
            clearTimeout(previous._timer);
            for (const key of ['pageRefresh', 'pending', 'errorCode']) delete previous[key];
            Object.assign(previous, binding); records.set(binding.bindingId, previous);
          } else records.set(binding.bindingId, binding);
          return snapshot(records.get(binding.bindingId));
        } catch (error) { throw error; }
      };
      return previous ? enqueue(previous, operation) : operation();
    });
  }
  async function publishOne(binding, input, expectedRevision) {
    requireWritable();
    if (!binding.enabled && expectedRevision === undefined) return snapshot(binding);
    try {
      const reader = await check(binding, input.repositoryRoot);
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
        if (sourceTaken(binding.root, filePath, binding, binding.git.commonDir, binding.git.prefix)) throw errorFor('BINDING_EXISTS');
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
      if (sourceTaken(binding.root, filePath, binding, binding.git.commonDir, binding.git.prefix)) throw errorFor('BINDING_EXISTS');
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
    const root = projectRoot(input), reader = await repositories.open(root), repo = await reader.identity();
    await reader.resolveCommit(input);
    let bindings = [...records.values()].filter(binding => sameGitRepository(binding, repo));
    if (input.bindingIds !== undefined) {
      if (!Array.isArray(input.bindingIds) || input.bindingIds.length < 1 || input.bindingIds.length > 50 || new Set(input.bindingIds).size !== input.bindingIds.length) throw errorFor('INVALID_REQUEST');
      bindings = input.bindingIds.map(lookup);
      if (bindings.some(binding => !sameGitRepository(binding, repo))) throw errorFor('TARGET_CHANGED');
    }
    const pushReceipt = input.remote ? await reader.confirmPush(input) : undefined;
    const documents = [];
    for (const binding of bindings) {
      try { documents.push(await enqueue(binding, () => publishOne(binding, { ...input, repositoryRoot: root, pushReceipt }))); }
      catch (error) { await setFailure(binding, error); documents.push(snapshot(binding)); }
    }
    return { repository: { root, id: gitRepositoryId(repo) }, commit: input.commit, branch: input.branch, documents, ...(pushReceipt ? { pushReceipt } : {}) };
  }
  async function getGitDocumentStatus({ bindingId, repositoryRoot } = {}) {
    requireRunning();
    const repo = repositoryRoot === undefined ? undefined : await (await repositories.open(repositoryRoot)).identity();
    if (bindingId === undefined) return { bindings: [...records.values()].filter(b => gitBinding(b) && (!repo || sameGitRepository(b, repo))).map(snapshot), readOnly: Boolean(config.readOnly) };
    const binding = lookup(bindingId);
    if (repo && !sameGitRepository(binding, repo)) throw errorFor('TARGET_CHANGED');
    const remote = await remoteFor(binding);
    return { ...snapshot(binding), currentRevision: remote.revision, currentPersistedRevision: remote.persistedRevision };
  }
  async function resolveGitDocumentConflict(input) {
    requireWritable();
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision ?? '')) throw errorFor('INVALID_REQUEST');
    const binding = lookup(input.bindingId), reader = await repositories.forBinding(binding, input.repositoryRoot); await reader.resolveCommit(input);
    return enqueue(binding, () => publishOne(binding, input, input.expectedRevision));
  }
  async function setGitDocumentSync({ bindingId, action, filePath, repositoryRoot }) {
    requireWritable(); const binding = lookup(bindingId);
    if (action === 'unbind') {
      if (binding.pending || binding.git.intent) throw errorFor('SAVE_PENDING');
      return unbind({ bindingId, action });
    }
    return enqueue(binding, async () => {
      if (action === 'confirm-repository') {
        await ensureLease(binding); await checkIdentity(binding);
        const next = { ...binding, git: await repositories.confirm(binding, repositoryRoot) };
        await persist(next); binding.git = next.git;
        if (binding.errorCode === 'GIT_IDENTITY_UNCONFIRMED') delete binding.errorCode;
        if (binding.pending) await reconcile(binding);
        else {
          const remote = await remoteFor(binding);
          if (remote.revision !== binding.remoteRevision || remote.persistedRevision !== remote.revision) await setFailure(binding, errorFor('CONFLICT'));
          else if (!binding.errorCode) binding.state = binding.enabled ? 'synced' : 'paused';
        }
        await persist(binding); return snapshot(binding);
      }
      await check(binding);
      if (action === 'rebind') {
        if (!validRelativeFile(filePath)) throw errorFor('INVALID_REQUEST');
        if (binding.pending || binding.git.intent) throw errorFor('SAVE_PENDING');
        if (sourceTaken(binding.root, filePath, binding, binding.git.commonDir, binding.git.prefix)) throw errorFor('BINDING_EXISTS');
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
