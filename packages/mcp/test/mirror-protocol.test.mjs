import test from 'node:test';
import assert from 'node:assert/strict';
import { createMirror, validateMirror, mirrorStatus } from '../src/mirror.mjs';
import { digest } from '../src/sync-files.mjs';
import { resolveMirrorLayout } from '../src/mirror-layout.mjs';

const ids = {
  binding: '00000000-0000-4000-8000-000000000001',
  page: '00000000-0000-4000-8000-000000000002',
  space: '00000000-0000-4000-8000-000000000003',
  workspace: '00000000-0000-4000-8000-000000000004',
  user: '00000000-0000-4000-8000-000000000005',
  otherSpace: '00000000-0000-4000-8000-000000000006',
};
const rootUri = 'viking://user/test/resources/docmost-mcp';
const oldSource = '# Old synthetic version\n';
const newSource = '# New synthetic version\n';
const oldHash = digest(oldSource), newHash = digest(newSource);
const oldRevision = digest('old document revision'), newRevision = digest('new document revision');
const docOrigin = 'https://docmost.example.test';

async function fixture({ prune = true, deletionReady } = {}) {
  const config = { origin: docOrigin, openViking: { origin: 'https://ov.example.test', rootUri } };
  const target = { origin: config.openViking.origin, accountId: 'personal', userId: 'test', rootUri };
  const binding = { bindingId: ids.binding, origin: docOrigin, pageId: ids.page, spaceId: ids.space, workspaceId: ids.workspace, userId: ids.user,
    enabled: true, state: 'synced', mirror: { version: 1, connectionOrigin: target.origin, target, state: 'pending' } };
  const remote = { revision: oldRevision, persistedRevision: oldRevision, spaceId: ids.space, title: 'Page', deletedAt: null };
  const events = [], resources = new Map(), tasks = new Map(), snapshots = new Map([[oldHash, oldSource], [newHash, newSource]]);
  const persisted = [];
  let serial = 0, failPersist = false;
  const post = async path => {
    events.push({ type: 'docmost', path });
    if (path === 'users/me') return { user: { id: ids.user }, workspace: { id: ids.workspace } };
    if (path === 'pages/sync-state') return { pageId: ids.page, workspaceId: ids.workspace, ...remote };
    if (path === 'pages/info') return { id: ids.page, workspaceId: ids.workspace, spaceId: remote.spaceId, title: remote.title, parentPageId: null, deletedAt: remote.deletedAt };
    if (path === 'spaces/info') return { id: remote.spaceId, workspaceId: ids.workspace, name: remote.spaceId === ids.space ? 'Shared' : 'Other' };
    assert.fail(`Unexpected Docmost operation ${path}`);
  };
  const layout = await resolveMirrorLayout({ rootUri, origin: docOrigin, workspaceId: ids.workspace, pageId: ids.page }, post);
  events.length = 0;
  const client = {
    async identity() { return target; },
    async read(uri) { events.push({ type: 'read', uri }); return resources.get(uri); },
    async write(uri, content) { events.push({ type: 'write', uri, hash: digest(content) }); resources.set(uri, content); },
    async tasks(uri) { events.push({ type: 'tasks', uri }); return [...tasks.values()].filter(task => task.uri === uri); },
    async reindex(uri, mode) { const taskId = `task-${++serial}`; events.push({ type: 'reindex', uri, mode }); tasks.set(taskId, { taskId, uri, status: 'completed', failedRecords: 0, unsupportedRecords: 0, warnings: [] }); return { taskId }; },
    async task(taskId) { events.push({ type: 'task', taskId }); return tasks.get(taskId); },
    async waitProcessed() { events.push({ type: 'wait' }); return { Semantic: { processed: 1, requeueCount: 0, errorCount: 0 }, Embedding: { processed: 1, requeueCount: 0, errorCount: 0 } }; },
    async remove(uri, options) { events.push({ type: 'remove', uri, options }); resources.delete(uri); return { semanticStatus: 'complete' }; },
    async list() { return undefined; },
  };
  const store = {
    async saveSnapshot(_id, { hash, content }) { snapshots.set(hash, content); },
    async readSnapshot(_id, hash) { assert.ok(snapshots.has(hash), 'a still referenced snapshot must exist'); return snapshots.get(hash); },
    async removeSnapshot(_id, hash) { events.push({ type: 'removeSnapshot', hash }); snapshots.delete(hash); },
  };
  const persist = async value => {
    if (failPersist) throw new Error('synthetic durable write failure');
    persisted.push(structuredClone(value));
    events.push({ type: 'persist' });
    if (prune) {
      const retained = new Set([value.mirror?.pending?.hash, value.mirror?.next?.hash, value.pending?.localHash].filter(Boolean));
      for (const hash of snapshots.keys()) if (!retained.has(hash)) snapshots.delete(hash);
    }
  };
  const controller = new AbortController();
  const mirror = createMirror(config, { client, post, store, persist, signal: controller.signal, deletionReady });
  const body = (hash, revision, phase = 'ready', uri) => ({ kind: 'body', hash, revision, phase, ...(uri ? { uri } : {}) });
  return { config, binding, remote, resources, tasks, snapshots, events, persisted, client, mirror, persist, post, layout, controller, body,
    failPersistence() { failPersist = true; } };
}
async function settle(f, turns = 15) {
  for (let i = 0; i < turns; i++) {
    await f.mirror.process(f.binding);
    if (!f.binding.mirror.pending || f.binding.mirror.state === 'blocked') return;
  }
  assert.fail('mirror protocol did not settle in bounded turns');
}

test('preparing or discarding cannot delete snapshots still referenced by the last durable ledger', async () => {
  const f = await fixture({ prune: false });
  f.binding.mirror.pending = f.body(oldHash, oldRevision);
  await f.mirror.prepare(f.binding, { hash: newHash, content: newSource });
  assert.equal(f.snapshots.get(oldHash), oldSource);
  assert.equal(f.binding.mirror.pending.hash, oldHash, 'a confirmed job waits until its successor is confirmed');
  assert.equal(f.binding.mirror.next.hash, newHash);
  await f.mirror.discard(f.binding, newHash);
  assert.equal(f.snapshots.get(newHash), newSource, 'only the successful atomic ledger save may release a snapshot');
  assert.equal(f.events.some(event => event.type === 'removeSnapshot'), false);
});

test('finishing an indexed version preserves an identical-hash relayout successor snapshot', async () => {
  const f = await fixture();
  const oldUri = `${rootUri}/old/document.md`;
  f.resources.set(oldUri, oldSource);
  f.tasks.set('old-index', { taskId: 'old-index', uri: `${rootUri}/old`, status: 'completed', failedRecords: 0 });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', oldUri), taskId: 'old-index' };
  f.binding.mirror.next = { ...f.body(oldHash, oldRevision), purpose: 'layout', allowSpaceChange: true };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.hash, oldHash);
  assert.equal(f.snapshots.get(oldHash), oldSource);
  await settle(f);
  assert.equal(f.resources.get(f.binding.mirror.uri), oldSource);
  assert.equal(f.binding.mirror.state, 'synced');
});

test('durable-save failure while finishing leaves the body snapshot available for restart', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('old-index', { taskId: 'old-index', uri: f.layout.pageDirectory, status: 'completed', failedRecords: 0 });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', f.layout.uri), taskId: 'old-index' };
  f.failPersistence();
  await assert.rejects(f.mirror.process(f.binding));
  assert.equal(f.snapshots.get(oldHash), oldSource);
  assert.equal(f.events.some(event => event.type === 'removeSnapshot'), false);
});

test('a newer confirmed Docmost version advances after an old unknown write is read back and reconciled', async () => {
  const f = await fixture();
  f.remote.revision = f.remote.persistedRevision = newRevision;
  f.resources.set(f.layout.uri, oldSource);
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
  f.binding.mirror.next = f.body(newHash, newRevision);
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.equal(f.binding.mirror.hash, newHash);
  assert.equal(f.resources.get(f.layout.uri), newSource);
  assert.equal(f.events.filter(event => event.type === 'write').length, 1, 'the uncertain old Docmost or OpenViking body is not replayed');
  assert.equal(f.events.some(event => event.type === 'docmost' && event.path.includes('update')), false);
});

test('an ambiguous or foreign old write blocks supersession without overwriting its target', async () => {
  for (const content of [undefined, '# Foreign edit\n']) {
    const f = await fixture();
    f.remote.revision = f.remote.persistedRevision = newRevision;
    if (content !== undefined) f.resources.set(f.layout.uri, content);
    f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
    f.binding.mirror.next = f.body(newHash, newRevision);
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.state, 'blocked');
    assert.ok(['OV_UNCONFIRMED', 'OV_CONFLICT'].includes(f.binding.mirror.errorCode));
    assert.equal(f.events.some(event => event.type === 'write' || event.type === 'reindex'), false);
    assert.equal(f.binding.mirror.next.hash, newHash);
  }
});

test('supersession waits for any active task at the old URI instead of racing its output', async () => {
  const f = await fixture();
  f.remote.revision = f.remote.persistedRevision = newRevision;
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('active', { taskId: 'active', uri: f.layout.pageDirectory, status: 'running' });
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
  f.binding.mirror.next = f.body(newHash, newRevision);
  await f.mirror.process(f.binding);
  assert.equal(f.events.some(event => event.type === 'write' || event.type === 'reindex'), false);
  assert.equal(f.binding.mirror.next.hash, newHash);
  assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED');
});

test('a ready old version can be coalesced only after the newest Docmost revision is confirmed', async () => {
  const f = await fixture();
  f.remote.revision = f.remote.persistedRevision = newRevision;
  f.binding.mirror.pending = f.body(oldHash, oldRevision);
  f.binding.mirror.next = f.body(newHash, newRevision);
  await settle(f);
  assert.equal(f.binding.mirror.hash, newHash);
  assert.equal(f.events.filter(event => event.type === 'write').length, 1);
  assert.equal(f.events.find(event => event.type === 'write').hash, newHash);
});

test('an unknown reindex recovery rejects all task IDs recorded before submission', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('prior-index', { taskId: 'prior-index', uri: f.layout.pageDirectory, status: 'completed', failedRecords: 0 });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'submit_submitting', f.layout.uri), priorTaskIds: ['prior-index'] };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED');
  assert.equal(f.binding.mirror.state, 'blocked');
  assert.equal(f.events.some(event => event.type === 'reindex'), false);
});

test('explicit metadata relayout can cross a fixed space guard while the body remains verified', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.binding.state = 'blocked'; f.binding.errorCode = 'TARGET_CHANGED'; f.binding.enabled = false;
  f.remote.spaceId = ids.otherSpace;
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision), purpose: 'layout', allowSpaceChange: true };
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.ok(f.binding.mirror.uri.includes(`Other--${ids.otherSpace}`));
  assert.equal(f.resources.get(f.binding.mirror.uri), oldSource);
  assert.equal(f.binding.errorCode, 'TARGET_CHANGED', 'relocation does not quietly rebind local body uploads');
});

test('a confirmed layout successor can reconcile a paused old write before moving it', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.binding.state = 'blocked'; f.binding.errorCode = 'TARGET_CHANGED'; f.binding.enabled = false;
  f.remote.spaceId = ids.otherSpace;
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
  f.binding.mirror.next = { ...f.body(oldHash, oldRevision), purpose: 'layout', allowSpaceChange: true };
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.ok(f.binding.mirror.uri.includes(`Other--${ids.otherSpace}`));
  assert.equal(f.resources.get(f.binding.mirror.uri), oldSource);
});

test('layout authorization does not bypass a pending or conflicting Docmost body', async () => {
  for (const changes of [{ state: 'conflict' }, { state: 'unconfirmed' }, { pending: { localHash: newHash } }]) {
    const f = await fixture();
    Object.assign(f.binding, changes);
    f.binding.mirror.pending = { ...f.body(oldHash, oldRevision), purpose: 'layout', allowSpaceChange: true };
    await f.mirror.process(f.binding);
    assert.equal(f.events.some(event => ['write', 'reindex', 'remove'].includes(event.type)), false);
  }
});

test('retry of a failed terminal index repairs only the index and does not replay content writes', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('failed-index', { taskId: 'failed-index', uri: f.layout.pageDirectory, status: 'failed', failedRecords: undefined });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', f.layout.uri), taskId: 'failed-index' };
  f.binding.mirror.state = 'blocked'; f.binding.mirror.errorCode = 'OV_PROCESSING_FAILED';
  await f.mirror.retry(f.binding);
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.equal(f.events.filter(event => event.type === 'reindex').length, 1);
  assert.equal(f.events.some(event => event.type === 'write'), false);
});

test('retrying a failed index refuses a foreign source before semantic reprocessing', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, '# Foreign OpenViking edit\n');
  f.tasks.set('failed-index', { taskId: 'failed-index', uri: f.layout.pageDirectory, status: 'failed' });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', f.layout.uri), taskId: 'failed-index' };
  f.binding.mirror.state = 'blocked'; f.binding.mirror.errorCode = 'OV_PROCESSING_FAILED';
  await f.mirror.retry(f.binding);
  assert.equal(f.binding.mirror.errorCode, 'OV_CONFLICT');
  assert.equal(f.events.some(event => event.type === 'reindex' || event.type === 'write'), false);
});

test('a known rejected reindex can retry without pretending its request may have been accepted', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'submit', f.layout.uri);
  const original = f.client.reindex;
  f.client.reindex = async () => { throw Object.assign(new Error('synthetic rejection'), { code: 'OV_RATE_LIMITED', mayHaveSucceeded: false }); };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'submit');
  f.client.reindex = original;
  await f.mirror.retry(f.binding); await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
});

test('a cancelling index is observed until terminal and is never restarted by retry', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('cancelling-index', { taskId: 'cancelling-index', uri: f.layout.pageDirectory, status: 'cancelling' });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', f.layout.uri), taskId: 'cancelling-index' };
  await f.mirror.retry(f.binding);
  assert.equal(f.binding.mirror.pending?.phase, 'indexing');
  assert.equal(f.binding.mirror.state, 'pending');
  assert.equal(f.events.some(event => event.type === 'reindex'), false);
});

test('a recognised terminal namespace lock timeout retries only the index with bounded backoff', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('locked-index', { taskId: 'locked-index', uri: f.layout.pageDirectory, status: 'failed', failureCode: 'OV_TREE_BUSY' });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'indexing', f.layout.uri), taskId: 'locked-index' };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'submit');
  assert.equal(f.binding.mirror.state, 'retrying'); assert.equal(f.binding.mirror.errorCode, 'OV_TREE_BUSY');
  assert.ok(f.binding.mirror.retryAt > Date.now() && f.binding.mirror.retryAt <= Date.now() + 1500);
  f.binding.mirror.retryAt = 0;
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.equal(f.events.some(event => event.type === 'write'), false);
  assert.equal(f.events.filter(event => event.type === 'reindex').length, 1);
});

test('malformed cleanup listings cannot authorize recursive removal of an unknown directory', async () => {
  for (const entries of [[{ name: '.abstract.md' }], [{ name: '.abstract.md', uri: `${rootUri}/elsewhere/.abstract.md`, isDir: false }]]) {
    const f = await fixture();
    Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
    f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
    f.binding.mirror.pending = { kind: 'delete', phase: 'cleanup', uri: f.layout.uri };
    f.client.list = async () => entries;
    await f.mirror.process(f.binding);
    assert.equal(f.events.some(event => event.type === 'remove' && event.options?.recursive), false);
    assert.equal(f.binding.mirror.errorCode, 'OV_INVALID_RESPONSE');
  }
});
test('deferred empty-directory deletion remains pending instead of reporting completed cleanup', async () => {
  const f = await fixture();
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  f.binding.mirror.pending = { kind: 'delete', phase: 'cleanup', uri: f.layout.uri };
  f.client.list = async () => [];
  f.client.remove = async (uri, options) => {
    f.events.push({ type: 'remove', uri, options });
    return { semanticStatus: options?.recursive ? 'deferred' : 'complete' };
  };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.state, 'retrying');
  assert.equal(f.binding.mirror.errorCode, 'OV_PROCESSING_PENDING');
  assert.equal(f.binding.mirror.pending.phase, 'removing');
  assert.equal(f.events.some(event => event.type === 'reindex'), false);
});

test('explicit deletion reconciles an unknown first write instead of orphaning its published resource', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
  f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  f.binding.state = 'blocked'; f.binding.errorCode = 'NOT_FOUND';
  await f.mirror.deleteConfirmed(f.binding);
  await f.persist(f.binding);
  await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted');
  assert.equal(f.resources.has(f.layout.uri), false);
  assert.equal(f.events.some(event => event.type === 'write'), false);
  assert.equal(f.events.some(event => event.type === 'reindex' && event.mode === 'semantic_and_vectors'), false);
});

test('explicit deletion preserves unknown task submission until its owned task is found and settles', async () => {
  const f = await fixture();
  f.resources.set(f.layout.uri, oldSource);
  f.tasks.set('old-index', { taskId: 'old-index', uri: f.layout.pageDirectory, status: 'running' });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'submit_submitting', f.layout.uri), priorTaskIds: [] };
  f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  await f.mirror.deleteConfirmed(f.binding);
  await f.persist(f.binding);
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'indexing');
  await f.mirror.process(f.binding);
  assert.equal(f.resources.has(f.layout.uri), true, 'deletion waits until a submitted processor is terminal');
  f.tasks.get('old-index').status = 'failed';
  await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted');
  assert.equal(f.resources.has(f.layout.uri), false);
});

test('mirror state schema rejects extra payload fields and incomplete layout authorization', () => {
  const valid = { version: 1, state: 'pending', pending: { kind: 'body', phase: 'ready', hash: oldHash, revision: oldRevision } };
  validateMirror(valid);
  for (const change of [
    { ...valid, pending: { ...valid.pending, content: 'private body' } },
    { ...valid, pending: { ...valid.pending, apiKey: 'secret' } },
    { ...valid, pending: { ...valid.pending, allowSpaceChange: true } },
    { ...valid, pending: { ...valid.pending, priorTaskIds: ['../unsafe'] } },
    { ...valid, operation: { id: 'unsafe', kind: 'delete', rootId: ids.page, beforeDeletedAt: null } },
    { ...valid, operation: { id: ids.binding, kind: 'delete', rootId: ids.page, beforeDeletedAt: null, body: 'private' } },
  ]) assert.throws(() => validateMirror(change), { code: 'OV_INVALID_STATE' });
  assert.ok(!JSON.stringify(mirrorStatus({ mirror: valid })).includes(oldHash));
});

test('readonly or aborted protocol never dispatches OpenViking writes', async () => {
  for (const abort of [false, true]) {
    const f = await fixture();
    f.binding.mirror.pending = f.body(oldHash, oldRevision);
    if (abort) f.controller.abort(); else f.config.readOnly = true;
    await f.mirror.process(f.binding);
    assert.equal(f.events.some(event => ['write', 'reindex', 'remove'].includes(event.type)), false);
  }
});

function restoredSuccessor(f, phase, { absent = false } = {}) {
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.binding.mirror.pending = { kind: 'delete', phase, ...(phase === 'ready' ? {} : { uri: f.layout.uri }) };
  f.binding.mirror.next = f.body(newHash, newRevision);
  f.remote.deletedAt = null; f.remote.revision = f.remote.persistedRevision = newRevision;
  if (!absent) f.resources.set(f.layout.uri, oldSource);
}

test('a confirmed restored body cancels a delete that has not been dispatched', async () => {
  for (const phase of ['ready', 'cleanup']) {
    const f = await fixture(); restoredSuccessor(f, phase);
    await settle(f);
    assert.equal(f.binding.mirror.state, 'synced'); assert.equal(f.resources.get(f.layout.uri), newSource);
    assert.equal(f.events.some(event => event.type === 'remove'), false);
    assert.equal(f.events.some(event => event.type === 'docmost' && event.path.includes('update')), false);
  }
});

test('a restored successor cannot bypass pause, conflict or an unconfirmed Docmost write', async () => {
  for (const phase of ['ready', 'removing', 'pruning']) for (const changes of [
    { enabled: false, state: 'paused' }, { state: 'paused' }, { state: 'conflict' }, { state: 'unconfirmed' }, { pending: { localHash: newHash } },
  ]) {
    const f = await fixture(); restoredSuccessor(f, phase); Object.assign(f.binding, changes);
    if (phase === 'pruning') Object.assign(f.binding.mirror.pending, { taskId: 'delete-prune', pruneUri: f.layout.pageDirectory });
    const before = structuredClone(f.binding.mirror);
    await f.mirror.process(f.binding);
    assert.deepEqual(f.binding.mirror, before);
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
  }
});

test('restoration is proved against both live and persisted Docmost revisions before cancelling deletion', async () => {
  for (const changed of ['live', 'persisted', 'identity']) {
    const f = await fixture(); restoredSuccessor(f, 'ready');
    if (changed === 'live') f.remote.revision = oldRevision;
    if (changed === 'persisted') f.remote.persistedRevision = oldRevision;
    if (changed === 'identity') f.binding.userId = ids.otherSpace;
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.errorCode, changed === 'identity' ? 'OV_DOCMOST_IDENTITY_CHANGED' : 'OV_DOCMOST_CHANGED');
    assert.equal(f.binding.mirror.pending.kind, 'delete');
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
  }
});

test('an unknown in-flight delete cannot be cancelled from resource absence or replayed after restoration', async () => {
  for (const absent of [false, true]) {
    const f = await fixture(); restoredSuccessor(f, 'removing', { absent });
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.state, 'blocked'); assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED');
    assert.equal(f.binding.mirror.pending.phase, 'removing'); assert.equal(f.binding.mirror.next.hash, newHash);
    await f.mirror.retry(f.binding);
    assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED');
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
  }
});

test('restoration observes submitted deletion pruning before publishing the restored body', async () => {
  for (const phase of ['prune_submit', 'prune_submitting', 'pruning']) {
    const f = await fixture(); restoredSuccessor(f, phase, { absent: true });
    f.binding.mirror.pending.pruneUri = f.layout.pageDirectory;
    if (phase !== 'prune_submit') {
      f.tasks.set('delete-prune', { taskId: 'delete-prune', uri: f.layout.pageDirectory, status: 'running', failedRecords: 0 });
      if (phase === 'pruning') f.binding.mirror.pending.taskId = 'delete-prune';
      else f.binding.mirror.pending.priorTaskIds = [];
    }
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.state === 'blocked', false);
    assert.equal(f.events.some(event => event.type === 'write' || event.type === 'remove'), false);
    for (const task of f.tasks.values()) task.status = 'completed';
    await settle(f);
    assert.equal(f.binding.mirror.state, 'synced'); assert.equal(f.resources.get(f.layout.uri), newSource);
    assert.equal(f.events.some(event => event.type === 'remove'), false);
    assert.equal(f.events.filter(event => event.type === 'reindex' && event.mode === 'prune_orphans').length, phase === 'prune_submit' ? 1 : 0);
  }
});

async function ghostFixture() {
  const f = await fixture(), directories = new Set([f.layout.pageDirectory]);
  f.resources.set(f.layout.uri, oldSource);
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  f.binding.mirror.pending = { kind: 'delete', phase: 'cleanup', uri: f.layout.uri };
  const reindex = f.client.reindex;
  f.client.reindex = async (uri, mode) => {
    const result = await reindex(uri, mode);
    if (mode === 'prune_orphans') directories.add(uri); // The real tree lock creates a missing target directory.
    return result;
  };
  f.client.list = async uri => {
    f.events.push({ type: 'list', uri });
    if (!directories.has(uri)) return undefined;
    return [...new Set([...directories, ...f.resources.keys()])]
      .filter(child => child.startsWith(`${uri}/`) && !child.slice(uri.length + 1).includes('/'))
      .map(child => ({ name: child.slice(uri.length + 1), uri: child, isDir: directories.has(child) }));
  };
  f.client.remove = async (uri, options = {}) => {
    f.events.push({ type: 'remove', uri, options });
    f.resources.delete(uri);
    if (options.recursive) {
      for (const child of f.resources.keys()) if (child.startsWith(`${uri}/`)) f.resources.delete(child);
      for (const child of directories) if (child === uri || child.startsWith(`${uri}/`)) directories.delete(child);
    }
    return { semanticStatus: 'complete' };
  };
  function completedPrune(pruneUri) {
    f.resources.delete(f.layout.uri); directories.add(pruneUri);
    f.tasks.set('finished-prune', { taskId: 'finished-prune', uri: pruneUri, status: 'completed', failedRecords: 0, unsupportedRecords: 0 });
    f.binding.mirror.pending = { kind: 'delete', phase: 'pruning', uri: f.layout.uri, pruneUri, taskId: 'finished-prune' };
  }
  return { ...f, directories, completedPrune };
}

test('exact leaf pruning removes its ghost directory while preserving a bound child under the parent', async () => {
  const f = await ghostFixture(), child = `${f.layout.pageDirectory}/Child--${ids.otherSpace}`;
  f.directories.add(child); f.resources.set(`${child}/document.md`, '# Child remains\n');
  await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(f.directories.has(f.layout.uri), false);
  assert.equal(f.resources.get(`${child}/document.md`), '# Child remains\n'); assert.equal(f.directories.has(child), true);
  const prunes = f.events.filter(event => event.type === 'reindex' && event.mode === 'prune_orphans');
  assert.deepEqual(prunes.map(event => event.uri), [f.layout.uri]);
  assert.equal(f.events.some(event => event.type === 'remove' && event.uri === f.layout.pageDirectory && event.options.recursive), false);
  assert.ok(f.events.some(event => event.type === 'remove' && event.uri === f.layout.uri && event.options.recursive));
});

test('pruning a proved empty page directory removes the created ghost without another prune loop', async () => {
  const f = await ghostFixture();
  f.resources.set(`${f.layout.pageDirectory}/.abstract.md`, 'Synthetic old summary');
  await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(f.directories.has(f.layout.pageDirectory), false);
  assert.equal(f.events.filter(event => event.type === 'reindex' && event.mode === 'prune_orphans').length, 1);
  assert.equal(f.events.filter(event => event.type === 'remove' && event.uri === f.layout.pageDirectory && event.options.recursive).length, 2);
});

test('prune ghost ownership requires a complete valid listing containing only derived files', async () => {
  for (const entries of [
    [{ name: 'foreign.txt', uri: 'placeholder', isDir: false }],
    [{ name: '.abstract.md', uri: 'placeholder', isDir: true }],
    [{ name: '.abstract.md' }],
  ]) {
    const f = await ghostFixture(); f.completedPrune(f.layout.uri);
    const listing = entries.map(entry => entry.uri ? { ...entry, uri: `${f.layout.uri}/${entry.name}` } : entry);
    f.client.list = async () => listing;
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.state, 'blocked');
    assert.ok(['OV_CONFLICT', 'OV_INVALID_RESPONSE'].includes(f.binding.mirror.errorCode));
    assert.equal(f.events.some(event => event.type === 'remove'), false);
    assert.equal(f.directories.has(f.layout.uri), true);
  }
});

test('pruning can be observed while paused but ghost cleanup waits for current source and Docmost proof', async () => {
  for (const mode of ['paused', 'conflict', 'unconfirmed', 'docmost_changed']) {
    const f = await ghostFixture(); f.completedPrune(f.layout.uri);
    if (mode === 'paused') { f.binding.state = 'paused'; f.binding.enabled = false; }
    if (mode === 'conflict' || mode === 'unconfirmed') f.binding.state = mode;
    if (mode === 'docmost_changed') f.remote.deletedAt = null;
    await f.mirror.process(f.binding);
    assert.equal(f.events.some(event => event.type === 'remove'), false);
    assert.equal(f.directories.has(f.layout.uri), true);
    assert.equal(f.binding.mirror.pending.phase, 'prune_cleanup');
    assert.equal(f.binding.mirror.pending.taskId, undefined);
    if (mode === 'docmost_changed') assert.equal(f.binding.mirror.errorCode, 'OV_DOCMOST_CHANGED');
  }
});

test('unknown ghost deletion is durable and cannot be replayed or completed from absence after restart', async () => {
  const f = await ghostFixture(); f.completedPrune(f.layout.uri);
  let removals = 0;
  f.client.remove = async uri => {
    removals++;
    assert.equal(f.persisted.at(-1).mirror.pending.phase, 'prune_removing', 'dispatch is preceded by its durable uncertainty fence');
    assert.equal(f.persisted.at(-1).mirror.pending.taskId, undefined);
    f.directories.delete(uri);
    throw Object.assign(new Error('synthetic lost delete response'), { code: 'OV_NETWORK_ERROR', mayHaveSucceeded: true });
  };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'prune_removing'); assert.equal(removals, 1);
  f.binding.mirror.retryAt = 0;
  const restarted = createMirror(f.config, { client: f.client, post: f.post, store: {
    readSnapshot: async (_id, hash) => f.snapshots.get(hash),
  }, persist: f.persist, signal: f.controller.signal });
  await restarted.process(f.binding);
  assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED'); assert.equal(f.binding.mirror.state, 'blocked');
  await restarted.retry(f.binding);
  assert.equal(removals, 1); assert.equal(f.binding.mirror.pending.phase, 'prune_removing');
  await restarted.deleteConfirmed(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'prune_removing', 'a newer explicit delete cannot erase an unknown dispatched deletion');
  assert.equal(f.binding.mirror.next?.kind, 'delete');
  assert.equal(f.events.some(event => event.type === 'write' || event.type === 'reindex'), false);
});

test('another confirmed deletion cannot discard an unknown leaf DELETE or prune submission', async () => {
  for (const phase of ['removing', 'prune_submitting']) {
    const f = await fixture();
    Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
    const original = { kind: 'delete', phase, uri: f.layout.uri, ...(phase === 'prune_submitting' ? { pruneUri: f.layout.uri, priorTaskIds: [] } : {}) };
    f.binding.mirror.pending = original;
    await f.mirror.deleteConfirmed(f.binding);
    assert.equal(f.binding.mirror.pending, original);
    assert.equal(f.binding.mirror.next.kind, 'delete');
    await f.mirror.prepare(f.binding, { hash: oldHash, content: oldSource });
    f.mirror.confirm(f.binding, { localHash: oldHash, proposedRevision: oldRevision });
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.errorCode, 'OV_UNCONFIRMED');
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
  }
});

test('generic list errors are never interpreted as proof of an absent cleanup target', async () => {
  for (const phase of ['cleanup', 'pruning']) {
    const f = await ghostFixture();
    if (phase === 'pruning') f.completedPrune(f.layout.uri);
    f.resources.delete(f.layout.uri);
    f.client.list = async () => { throw Object.assign(new Error('synthetic route 404'), { code: 'OV_NOT_FOUND' }); };
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.state, 'blocked'); assert.equal(f.binding.mirror.errorCode, 'OV_NOT_FOUND');
    assert.equal(f.events.some(event => event.type === 'remove' || event.type === 'reindex'), false);
  }
});

test('a definitely rejected ghost DELETE can retry after authentication is repaired', async () => {
  const f = await ghostFixture(); f.completedPrune(f.layout.uri);
  const remove = f.client.remove; let attempts = 0;
  f.client.remove = async (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('synthetic denied request'), { code: 'OV_FORBIDDEN', mayHaveSucceeded: false });
    return remove(...args);
  };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'prune_cleanup'); assert.equal(f.binding.mirror.errorCode, 'OV_FORBIDDEN');
  assert.equal(f.directories.has(f.layout.uri), true);
  await f.mirror.retry(f.binding);
  assert.equal(attempts, 2); assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(f.directories.has(f.layout.uri), false);
  assert.equal(f.events.some(event => event.type === 'reindex'), false);
});

test('accepted ghost DELETE processing or subsequent absence-check failure never becomes a rejected DELETE', async () => {
  for (const failure of ['processing', 'absence_check']) {
    const f = await ghostFixture(); f.completedPrune(f.layout.uri);
    const remove = f.client.remove, list = f.client.list; let accepted = false, attempts = 0;
    f.client.remove = async (...args) => {
      attempts++; const result = await remove(...args); accepted = true;
      return failure === 'processing' ? { ...result, semanticStatus: 'deferred' } : result;
    };
    f.client.list = async (...args) => {
      if (accepted && failure === 'absence_check') throw Object.assign(new Error('synthetic denied verification'), { code: 'OV_FORBIDDEN', mayHaveSucceeded: false });
      return list(...args);
    };
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.pending.phase, failure === 'processing' ? 'prune_removing' : 'prune_verify');
    await f.mirror.retry(f.binding);
    assert.equal(f.binding.mirror.errorCode, failure === 'processing' ? 'OV_UNCONFIRMED' : 'OV_FORBIDDEN'); assert.equal(attempts, 1);
  }
});

test('canProcess is a pure shared guard for local pause, conflict, blocked state and cooldown', async () => {
  for (const mode of ['paused', 'disabled', 'conflict', 'unconfirmed', 'docmost_pending', 'blocked', 'cooldown', 'await_docmost', 'operation', 'no_job', 'readonly', 'aborted']) {
    const f = await fixture(); f.binding.mirror.pending = f.body(oldHash, oldRevision);
    if (['paused', 'conflict', 'unconfirmed'].includes(mode)) f.binding.state = mode;
    if (mode === 'disabled') f.binding.enabled = false;
    if (mode === 'docmost_pending') f.binding.pending = { localHash: oldHash };
    if (mode === 'blocked') { f.binding.mirror.state = 'blocked'; f.binding.mirror.errorCode = 'OV_CONFLICT'; }
    if (mode === 'cooldown') f.binding.mirror.retryAt = Date.now() + 30000;
    if (mode === 'await_docmost') f.binding.mirror.pending = { kind: 'body', hash: oldHash, phase: 'await_docmost' };
    if (mode === 'operation') f.binding.mirror.operation = { id: ids.binding, kind: 'delete', rootId: ids.page, beforeDeletedAt: null };
    if (mode === 'no_job') delete f.binding.mirror.pending;
    if (mode === 'readonly') f.config.readOnly = true;
    if (mode === 'aborted') f.controller.abort();
    const before = structuredClone(f.binding); let identities = 0;
    f.client.identity = async () => { identities++; assert.fail('a local early return must not authenticate'); };
    assert.equal(typeof f.mirror.canProcess, 'function'); assert.equal(f.mirror.canProcess(f.binding), false, mode);
    await f.mirror.process(f.binding);
    assert.deepEqual(f.binding, before); assert.deepEqual(f.events, []); assert.equal(identities, 0);
  }
});

test('canProcess permits readonly task observation but excludes restoration and ghost cleanup while paused', async () => {
  for (const phase of ['indexing', 'pruning']) for (const state of ['paused', 'conflict', 'unconfirmed']) {
    const f = await fixture(); f.binding.state = state; f.binding.enabled = false;
    f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, phase, f.layout.uri), taskId: 'active-task', ...(phase === 'pruning' ? { pruneUri: f.layout.uri } : {}) };
    f.tasks.set('active-task', { taskId: 'active-task', status: 'running', uri: f.layout.uri });
    assert.equal(typeof f.mirror.canProcess, 'function'); assert.equal(f.mirror.canProcess(f.binding), true);
    await f.mirror.process(f.binding);
    assert.ok(f.events.some(event => event.type === 'task'));
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
  }
  const restored = await fixture(); restoredSuccessor(restored, 'ready'); restored.binding.state = 'paused';
  assert.equal(restored.mirror.canProcess(restored.binding), false);
  const ghost = await ghostFixture(); ghost.completedPrune(ghost.layout.uri);
  ghost.binding.mirror.pending.phase = 'prune_cleanup'; delete ghost.binding.mirror.pending.taskId;
  ghost.binding.state = 'paused';
  assert.equal(ghost.mirror.canProcess(ghost.binding), false);
});

test('ghost deletion waits for detached queue work before dispatch and durably acknowledges deletion before its final barrier', async () => {
  const f = await ghostFixture(); f.completedPrune(f.layout.uri);
  await f.mirror.process(f.binding);
  const removeIndex = f.events.findIndex(event => event.type === 'remove');
  const waits = f.events.map((event, index) => event.type === 'wait' ? index : -1).filter(index => index >= 0);
  assert.equal(waits.length, 2); assert.ok(waits[0] < removeIndex && waits[1] > removeIndex);
  assert.ok(f.persisted.some(value => value.mirror.pending?.phase === 'prune_verify'));
  assert.equal(f.binding.mirror.state, 'deleted');
});

test('a final barrier timeout or cancellation retains acknowledged DELETE for readonly restart verification', async () => {
  for (const failure of ['timeout', 'cancelled']) {
    const f = await ghostFixture(); f.completedPrune(f.layout.uri);
    let waits = 0, removals = 0; const remove = f.client.remove;
    f.client.remove = async (...args) => { removals++; return remove(...args); };
    f.client.waitProcessed = async () => {
      if (++waits === 2) {
        if (failure === 'cancelled') f.controller.abort();
        throw Object.assign(new Error('synthetic wait interruption'), { code: failure === 'timeout' ? 'OV_PROCESSING_PENDING' : 'OV_CANCELLED', mayHaveSucceeded: false });
      }
      return {};
    };
    await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.pending?.phase, 'prune_verify'); assert.equal(removals, 1);
    assert.equal(f.persisted.at(-1).mirror.pending.phase, 'prune_verify');
    if (failure === 'timeout') assert.equal(f.binding.mirror.state, 'retrying');
    f.binding.mirror.retryAt = 0;
    const restarted = createMirror(f.config, { client: f.client, post: f.post, store: {}, persist: f.persist, signal: new AbortController().signal });
    await restarted.process(f.binding);
    assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(removals, 1);
  }
});

test('a barrier-proved derived-only resurrection retries cleanup in a new turn while a foreign resurrection stays protected', async () => {
  for (const foreign of [false, true]) {
    const f = await ghostFixture(); f.completedPrune(f.layout.uri);
    let waits = 0, removals = 0; const remove = f.client.remove;
    f.client.remove = async (...args) => { removals++; return remove(...args); };
    f.client.waitProcessed = async () => {
      if (++waits === 2) {
        f.directories.add(f.layout.uri);
        f.resources.set(`${f.layout.uri}/${foreign ? 'foreign.txt' : '.abstract.md'}`, 'Synthetic late sidecar');
      }
      return {};
    };
    await f.mirror.process(f.binding);
    assert.equal(removals, 1);
    if (foreign) {
      assert.equal(f.binding.mirror.state, 'blocked'); assert.equal(f.binding.mirror.errorCode, 'OV_CONFLICT');
      assert.equal(f.binding.mirror.pending.phase, 'prune_verify');
    } else {
      assert.equal(f.binding.mirror.pending.phase, 'prune_cleanup');
      await f.mirror.process(f.binding);
      assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(removals, 2);
    }
    assert.equal(f.events.some(event => event.type === 'reindex'), false);
  }
});

test('operation waitFor and acknowledged prune verification have strict compatible durable schemas', async () => {
  const f = await ghostFixture(); f.completedPrune(f.layout.uri);
  f.binding.mirror.pending.phase = 'prune_verify'; delete f.binding.mirror.pending.taskId;
  const operation = { id: ids.binding, kind: 'delete', rootId: ids.page, beforeDeletedAt: null };
  validateMirror({ ...f.binding.mirror, operation });
  validateMirror({ ...f.binding.mirror, operation: { ...operation, waitFor: [] } });
  validateMirror({ ...f.binding.mirror, operation: { ...operation, waitFor: [ids.otherSpace] } });
  for (const waitFor of ['wrong', ['wrong'], [ids.otherSpace, ids.otherSpace],
    Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)])
    assert.throws(() => validateMirror({ ...f.binding.mirror, operation: { ...operation, waitFor } }), { code: 'OV_INVALID_STATE' });
  validateMirror(f.binding.mirror);
  await f.mirror.deleteConfirmed(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'prune_verify'); assert.equal(f.binding.mirror.next.kind, 'delete');
  restoredSuccessor(f, 'prune_verify', { absent: true }); f.binding.mirror.pending.pruneUri = f.layout.uri;
  await settle(f);
  assert.equal(f.binding.mirror.state, 'synced'); assert.equal(f.resources.get(f.layout.uri), newSource);
});

test('the first cleanup DELETE waits for queue quiescence and a timeout preserves its undispatched phase', async () => {
  const f = await ghostFixture(); let waits = 0;
  f.client.waitProcessed = async () => {
    f.events.push({ type: 'wait' });
    if (++waits === 1) throw Object.assign(new Error('synthetic outstanding ancestor refresh'), { code: 'OV_PROCESSING_PENDING', mayHaveSucceeded: false });
    return {};
  };
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'cleanup'); assert.equal(f.binding.mirror.state, 'retrying');
  assert.equal(f.resources.get(f.layout.uri), oldSource);
  assert.equal(f.events.some(event => event.type === 'remove' || event.type === 'reindex'), false);
  await f.mirror.retry(f.binding); await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted');
  assert.equal(f.events.filter(event => event.type === 'remove' && !event.options.recursive).length, 1);
  const firstRemove = f.events.findIndex(event => event.type === 'remove');
  assert.ok(f.events.slice(0, firstRemove).filter(event => event.type === 'wait').length >= 2);
});

test('permissions and a confirmed body revision are rechecked after the initial cleanup barrier before any DELETE', async () => {
  for (const change of ['permissions', 'body']) {
    const f = await fixture(); let changed = false;
    Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
    f.resources.set(f.layout.uri, oldSource);
    if (change === 'body') {
      f.remote.revision = f.remote.persistedRevision = newRevision;
      f.binding.mirror.pending = { ...f.body(newHash, newRevision, 'cleanup', `${rootUri}/new/document.md`), oldUri: f.layout.uri };
    } else {
      f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
      f.binding.mirror.pending = { kind: 'delete', phase: 'cleanup', uri: f.layout.uri };
    }
    f.client.waitProcessed = async () => { changed = true; if (change === 'body') f.remote.revision = oldRevision; return {}; };
    const mirror = createMirror(f.config, { client: f.client, store: {}, persist: f.persist, signal: f.controller.signal,
      post: async (path, body) => {
        if (changed && change === 'permissions' && path === 'pages/info') throw Object.assign(new Error('synthetic permission revoked'), { code: 'FORBIDDEN' });
        return f.post(path, body);
      } });
    await mirror.process(f.binding);
    assert.equal(changed, true); assert.equal(f.binding.mirror.pending.phase, 'cleanup'); assert.equal(f.binding.mirror.state, 'blocked');
    assert.equal(f.events.some(event => ['remove', 'write', 'reindex'].includes(event.type)), false);
    assert.equal(f.resources.get(f.layout.uri), oldSource);
  }
});

test('a confirmed delete with dependent children reconciles an old write before waiting in an undispatched delete job', async () => {
  let childrenReady = false;
  const f = await fixture({ deletionReady: (_binding, job) => childrenReady || !job.waitFor?.length });
  f.resources.set(f.layout.uri, oldSource); f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  f.binding.mirror.pending = f.body(oldHash, oldRevision, 'writing', f.layout.uri);
  await f.mirror.deleteConfirmed(f.binding, { waitFor: [ids.otherSpace] });
  assert.equal(f.mirror.canProcess(f.binding), true, 'an old uncertain write must remain observable instead of fencing its children forever');
  await f.mirror.process(f.binding);
  assert.ok(f.events.some(event => event.type === 'read'));
  assert.equal(f.binding.mirror.pending.kind, 'delete'); assert.equal(f.binding.mirror.pending.phase, 'ready');
  assert.deepEqual(f.binding.mirror.pending.waitFor, [ids.otherSpace]); validateMirror(f.binding.mirror);
  assert.equal(f.mirror.canProcess(f.binding), false);
  assert.equal(f.events.some(event => ['remove', 'write', 'reindex'].includes(event.type)), false);
  childrenReady = true; await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(f.resources.has(f.layout.uri), false);
});

test('delete dependencies do not prevent observing already submitted index work and recovering its task ID', async () => {
  for (const phase of ['indexing', 'submit_submitting']) {
    let childrenReady = false;
    const f = await fixture({ deletionReady: (_binding, job) => childrenReady || !job.waitFor?.length });
    f.resources.set(f.layout.uri, oldSource); f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
    f.tasks.set('parent-index', { taskId: 'parent-index', uri: f.layout.pageDirectory, status: 'running', failedRecords: 0 });
    f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, phase, f.layout.uri),
      ...(phase === 'indexing' ? { taskId: 'parent-index' } : { priorTaskIds: [] }) };
    await f.mirror.deleteConfirmed(f.binding, { waitFor: [ids.otherSpace] });
    assert.equal(f.mirror.canProcess(f.binding), true); await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.pending.phase, 'indexing');
    await f.mirror.process(f.binding);
    assert.ok(f.events.some(event => event.type === 'task'));
    f.tasks.get('parent-index').status = 'completed'; await f.mirror.process(f.binding);
    assert.equal(f.binding.mirror.pending.phase, 'ready'); assert.equal(f.binding.mirror.pending.kind, 'delete');
    assert.equal(f.mirror.canProcess(f.binding), false);
    assert.equal(f.events.some(event => ['write', 'remove', 'reindex'].includes(event.type)), false);
    childrenReady = true; await settle(f); assert.equal(f.binding.mirror.state, 'deleted');
  }
});

test('an old layout body cleanup defers new filesystem deletion until dependent child deletes finish', async () => {
  let childrenReady = false;
  const f = await fixture({ deletionReady: (_binding, job) => childrenReady || !job.waitFor?.length });
  const newUri = `${rootUri}/new/document.md`;
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.resources.set(f.layout.uri, oldSource); f.resources.set(newUri, oldSource);
  f.remote.deletedAt = '2026-10-14T00:00:00.000Z';
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'cleanup', newUri), oldUri: f.layout.uri };
  await f.mirror.deleteConfirmed(f.binding, { waitFor: [ids.otherSpace] });
  await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'cleanup'); assert.equal(f.binding.mirror.pending.kind, 'body');
  assert.equal(f.events.some(event => ['remove', 'write', 'reindex'].includes(event.type)), false);
  const wait = f.client.waitProcessed; let changedWhileWaiting = false;
  f.client.waitProcessed = async (...args) => {
    const result = await wait(...args);
    if (!changedWhileWaiting) { changedWhileWaiting = true; childrenReady = false; }
    return result;
  };
  childrenReady = true; await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'cleanup');
  assert.equal(f.events.some(event => ['remove', 'write', 'reindex'].includes(event.type)), false, 'dependencies are rechecked after the barrier too');
  childrenReady = true; await settle(f);
  assert.equal(f.binding.mirror.state, 'deleted'); assert.equal(f.resources.has(f.layout.uri), false); assert.equal(f.resources.has(newUri), false);
});

test('delete-job dependencies are optional canonical UUIDs and cannot be attached to a body job', async () => {
  const f = await fixture();
  for (const waitFor of [undefined, [], [ids.otherSpace]]) {
    await f.mirror.deleteConfirmed(f.binding, { waitFor }); validateMirror(f.binding.mirror);
    assert.deepEqual(f.binding.mirror.pending.waitFor, waitFor);
  }
  for (const waitFor of [['invalid'], [ids.otherSpace, ids.otherSpace],
    Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)])
    assert.throws(() => validateMirror({ ...f.binding.mirror, pending: { kind: 'delete', phase: 'ready', waitFor } }), { code: 'OV_INVALID_STATE' });
  assert.throws(() => validateMirror({ ...f.binding.mirror, pending: { ...f.body(oldHash, oldRevision), waitFor: [] } }), { code: 'OV_INVALID_STATE' });
});

test('a nondispatched layout cleanup waiting for child deletes never authenticates or enters remote work', async () => {
  const f = await fixture({ deletionReady: () => false });
  Object.assign(f.binding.mirror, { uri: f.layout.uri, hash: oldHash, revision: oldRevision });
  f.binding.mirror.pending = { ...f.body(oldHash, oldRevision, 'cleanup', `${rootUri}/new/document.md`), oldUri: f.layout.uri };
  await f.mirror.deleteConfirmed(f.binding, { waitFor: [ids.otherSpace] });
  let identities = 0;
  f.client.identity = async () => { identities++; assert.fail('dependency-only waiting must not contend for remote work'); };
  const before = structuredClone(f.binding);
  assert.equal(f.mirror.canProcess(f.binding), false);
  await f.mirror.process(f.binding);
  assert.equal(identities, 0); assert.deepEqual(f.events, []); assert.deepEqual(f.binding, before);
});
