import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMirror, validateMirror } from '../src/mirror.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
const ids = { page: '00000000-0000-4000-8000-000000000001', ad: '00000000-0000-4000-8000-000000000002',
  business: '00000000-0000-4000-8000-000000000003', space: '00000000-0000-4000-8000-000000000004',
  workspace: '00000000-0000-4000-8000-000000000005', user: '00000000-0000-4000-8000-000000000006' };
const root = 'viking://user/test/resources/docmost-mcp', origin = 'https://docmost.test';
const spaceDir = `${root}/FE`;
const businessDir = `${spaceDir}/Business`, adDir = `${businessDir}/AD`;
const pageDir = `${adDir}/Plan`, uri = `${pageDir}/document.md`;
const body = '# Complete synthetic plan\n\nOriginal full body.\n';
const indexUris = [pageDir, adDir, businessDir, spaceDir];

function fixture() {
  const target = { origin: 'https://ov.test', accountId: 'personal', userId: 'test', rootUri: root };
  const binding = { bindingId: ids.page, source: 'docmost', pageId: ids.page, spaceId: ids.space,
    workspaceId: ids.workspace, userId: ids.user, origin, enabled: true, state: 'synced',
    mirror: { version: 1, target, connectionOrigin: target.origin, state: 'pending',
      nodes: [[spaceDir, 'space', ids.space], [businessDir, 'page', ids.business], [adDir, 'page', ids.ad], [pageDir, 'page', ids.page]]
        .map(([uri, kind, id]) => ({ uri, key: hash(JSON.stringify([origin, ids.workspace, kind, id])) })),
      pending: { kind: 'body', phase: 'ready', hash: hash(body), revision: hash(body) } } };
  const resources = new Map(), tasks = new Map(), submissions = [], persisted = [], records = [];
  const directories = new Set(indexUris);
  let serial = 0, loseAcknowledgement = false;
  const post = async (path, input) => {
    if (path === 'users/me') return { user: { id: ids.user }, workspace: { id: ids.workspace } };
    if (path === 'spaces/info') return { id: ids.space, workspaceId: ids.workspace, name: 'FE' };
    if (path === 'pages/info') {
      const parents = { [ids.page]: ids.ad, [ids.ad]: ids.business, [ids.business]: null };
      const titles = { [ids.page]: 'Plan', [ids.ad]: 'AD', [ids.business]: 'Business' };
      return { id: input.pageId, spaceId: ids.space, workspaceId: ids.workspace,
        parentPageId: parents[input.pageId], title: titles[input.pageId], content: body, deletedAt: null };
    }
    assert.fail(`No conditional endpoint is allowed: ${path}`);
  };
  const client = {
    async identity() { return target; }, async read(path) { return resources.get(path); },
    async write(path, content) { resources.set(path, content); },
    async reindex(path, mode) {
      const taskId = `ancestor_task_${++serial}`;
      submissions.push({ uri: path, mode, taskId });
      tasks.set(taskId, { taskId, uri: path, status: 'completed', failedRecords: 0, unsupportedRecords: 0 });
      if (loseAcknowledgement && path === adDir) { loseAcknowledgement = false;
        throw Object.assign(new Error('synthetic lost response'), { code: 'OV_NETWORK_ERROR', mayHaveSucceeded: true }); }
      return { taskId };
    },
    async task(id) { return tasks.get(id); },
    async tasks(path) { return [...tasks.values()].filter(value => value.uri === path); },
    async waitProcessed() { return {}; },
    async remove(path) { resources.delete(path); directories.delete(path); return { semanticStatus: 'complete' }; },
    async list(path) {
      if (!directories.has(path)) return undefined;
      const direct = value => value.startsWith(path + '/') && !value.slice(path.length + 1).includes('/');
      return [...[...resources.keys()].filter(direct).map(value => ({ uri: value, name: value.slice(path.length + 1), isDir: false })),
        ...[...directories].filter(direct).map(value => ({ uri: value, name: value.slice(path.length + 1), isDir: true }))];
    },
  };
  const store = { async readSnapshot() { return body; }, async load() { return records.map(value => ({ value })); } };
  const mirror = createMirror({ origin, openViking: { origin: target.origin, rootUri: root } }, {
    client, post, store, persist: async value => { persisted.push(structuredClone(value)); }, signal: new AbortController().signal,
  });
  return { binding, mirror, client, resources, tasks, submissions, persisted, records,
    loseNextParentResponse() { loseAcknowledgement = true; } };
}
async function settle(f) {
  for (let turn = 0; turn < 15 && f.binding.mirror.pending; turn++) await f.mirror.process(f.binding);
}

test('page-source indexing completes every canonical parent through its space before becoming synced', async () => {
  const f = fixture(); await f.mirror.process(f.binding); await f.mirror.process(f.binding);
  assert.notEqual(f.binding.mirror.state, 'synced', 'a completed page-only task cannot prove ancestor summaries');
  await settle(f);
  assert.deepEqual(f.submissions.map(value => value.uri), indexUris);
  assert.ok(f.submissions.every(value => value.mode === 'semantic_and_vectors'));
  assert.equal(f.binding.mirror.state, 'synced'); assert.equal(f.binding.mirror.ancestorsReady, true);
  assert.equal(f.resources.get(uri), body);
  assert.ok(f.persisted.some(value => value.mirror.pending?.indexCursor === 2));
});

test('an unknown ancestor submission is recovered at that exact cursor without replaying a completed page task', async () => {
  const f = fixture(); f.loseNextParentResponse();
  for (let turn = 0; turn < 5 && f.binding.mirror.pending?.phase !== 'submit_submitting'; turn++) await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.pending.phase, 'submit_submitting');
  assert.equal(f.binding.mirror.pending.indexCursor, 1);
  const resumed = structuredClone(f.binding); f.binding.mirror = resumed.mirror;
  await f.mirror.retry(f.binding); await settle(f);
  assert.deepEqual(f.submissions.map(value => value.uri), indexUris);
  assert.equal(f.binding.mirror.ancestorsReady, true);
});

test('ancestor tasks refuse unknown direct files while unrelated child directory originals are never read', async () => {
  const f = fixture(); f.resources.set(`${adDir}/unmanaged.md`, '# Not authorized for raw model processing\n');
  await settle(f);
  assert.equal(f.binding.mirror.state, 'blocked'); assert.equal(f.binding.mirror.errorCode, 'OV_CONFLICT');
  assert.deepEqual(f.submissions.map(value => value.uri), [pageDir]);
});

test('ancestor cursor validation rejects a chain escaping its space or jumping to another subtree', () => {
  const f = fixture(); f.binding.mirror.pending = { kind: 'body', phase: 'submit', uri, hash: hash(body), revision: hash(body), indexUris, indexCursor: 1, layoutVersion: 2 };
  assert.doesNotThrow(() => validateMirror(f.binding.mirror));
  for (const changes of [
    { indexCursor: -1 }, { indexCursor: 4 }, { indexUris: [...indexUris, `${root}/eefc352536dc2e9e/${ids.workspace}`] },
    { indexUris: [pageDir, businessDir, spaceDir] }, { indexUris: [pageDir, `${root}/foreign`, businessDir, spaceDir] },
  ]) assert.throws(() => validateMirror({ ...f.binding.mirror, pending: { ...f.binding.mirror.pending, ...changes } }), { code: 'OV_INVALID_STATE' });
});

test('a parent document participates only with a same-target managed ledger and matching confirmed body', async () => {
  for (const owned of [true, false]) {
    const f = fixture(), parentDocument = `${adDir}/document.md`;
    f.resources.set(parentDocument, body);
    if (owned) f.records.push({ ...f.binding, pageId: ids.ad, bindingId: ids.ad,
      mirror: { version: 1, state: 'synced', target: f.binding.mirror.target, uri: parentDocument, hash: hash(body), revision: hash(body) } });
    const originalRead = f.client.read; let parentReads = 0;
    f.client.read = async path => { if (path === parentDocument) parentReads++; return originalRead(path); };
    await settle(f);
    assert.equal(f.binding.mirror.state, owned ? 'synced' : 'blocked');
    assert.equal(parentReads > 0, owned, 'unknown parent originals must not even be read');
    assert.deepEqual(f.submissions.map(value => value.uri), owned ? indexUris : [pageDir]);
  }
});

test('a relayout removes its owned old leaf before aggregating the new parent chain', async () => {
  const f = fixture(), oldUri = `${adDir}/Old-title--${ids.page}/document.md`;
  Object.assign(f.binding.mirror, { uri: oldUri, hash: hash(body), revision: hash(body) });
  f.resources.set(oldUri, body);
  let ancestorSawOld = false;
  const reindex = f.client.reindex;
  f.client.reindex = async (path, mode) => {
    if (mode === 'semantic_and_vectors' && path !== pageDir && f.resources.has(oldUri)) ancestorSawOld = true;
    return reindex(path, mode);
  };
  for (let turn = 0; turn < 25 && f.binding.mirror.pending; turn++) await f.mirror.process(f.binding);
  assert.equal(f.binding.mirror.state, 'synced');
  assert.equal(ancestorSawOld, false, 'parent summaries must see the final physical layout');
  assert.equal(f.resources.has(oldUri), false);
  assert.equal(f.binding.mirror.ancestorsReady, true);
});
