import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownSync } from '../src/sync.mjs';
import { digest } from '../src/sync-files.mjs';

const pageId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';
const rev = content => digest(`document:${content}`);
async function fixture(t, { offline = false, readOnly = false } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'docmost-mirror-manager-')));
  const root = join(temp, 'source'); await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'note.md'), '# Initial\n');
  const remote = { pageId, spaceId, workspaceId, revision: rev('# Remote\n'), persistedRevision: rev('# Remote\n') };
  const writes = [], resources = new Map(), tasks = new Map(), directories = new Set();
  const mirrorRoot = 'viking://user/test/resources/docmost-mcp';
  function addDirectory(uri) {
    while (uri.startsWith(mirrorRoot)) { directories.add(uri); if (uri === mirrorRoot) break; uri = uri.slice(0, uri.lastIndexOf('/')); }
  }
  let title = 'My Page', deletedAt = null, docWrites = 0, taskCount = 0;
  const post = async (path, body) => {
    if (path === 'users/me') return { user: { id: userId }, workspace: { id: workspaceId } };
    if (path === 'pages/sync-state') return { ...remote, ...(body.content !== undefined ? { proposedRevision: rev(body.content) } : {}) };
    if (path === 'pages/sync-update') {
      docWrites++; assert.equal(body.expectedRevision, remote.revision);
      remote.revision = remote.persistedRevision = rev(body.content); return { ...remote };
    }
    if (path === 'pages/info') return { id: pageId, spaceId, workspaceId, title, parentPageId: null, deletedAt };
    if (path === 'spaces/info') return { id: spaceId, workspaceId, name: 'Shared' };
    throw new Error(`Unexpected ${path}`);
  };
  const client = {
    async identity() { if (offline) throw Object.assign(new Error('safe offline'), { code: 'OV_NETWORK_ERROR' }); return { accountId: 'personal', userId: 'test', role: 'user', rootUri: 'viking://user/test/resources/docmost-mcp' }; },
    async read(uri) {
      if (directories.has(uri)) throw Object.assign(new Error('synthetic directory read'), { code: 'OV_INVALID_REQUEST', status: 400 });
      return resources.get(uri);
    },
    async write(uri, content) {
      assert.equal(directories.has(uri), false, 'a directory placeholder cannot be replaced as a Markdown file');
      writes.push({ uri, content }); resources.set(uri, content); addDirectory(uri.slice(0, uri.lastIndexOf('/')));
      return { vectorStatus: 'complete', semanticStatus: 'skipped' };
    },
    async reindex(uri, mode) {
      // OpenViking's tree lock creates a placeholder for a missing prune target.
      if (mode === 'prune_orphans' && !resources.has(uri) && !directories.has(uri)) addDirectory(uri);
      const taskId = `reindex_${++taskCount}`; tasks.set(taskId, { taskId, status: 'completed', failedRecords: 0, warnings: [], uri, mode }); return { taskId };
    },
    async task(id) { return tasks.get(id); }, async tasks() { return []; },
    async waitProcessed() { return {}; },
    async remove(uri, { recursive = false } = {}) {
      resources.delete(uri);
      if (recursive) {
        for (const value of resources.keys()) if (value.startsWith(uri + '/')) resources.delete(value);
        for (const value of directories) if (value === uri || value.startsWith(uri + '/')) directories.delete(value);
      }
      return { semanticStatus: 'complete' };
    },
    async list(uri) {
      if (!directories.has(uri)) return undefined;
      const direct = value => value.startsWith(uri + '/') && !value.slice(uri.length + 1).includes('/');
      return [...[...resources.keys()].filter(direct).map(value => ({ name: value.slice(uri.length + 1), uri: value, isDir: false })),
        ...[...directories].filter(direct).map(value => ({ name: value.slice(uri.length + 1), uri: value, isDir: true }))];
    },
  };
  const config = { origin: 'https://docmost.test', syncRoot: root, syncStateDir: join(temp, 'state'), readOnly,
    openViking: { origin: 'http://127.0.0.1:1933', rootUri: 'viking://user/test/resources/docmost-mcp' } };
  const api = { post };
  const manager = createMarkdownSync(config, { api, mirrorClient: client, debounceMs: 10, scanMs: 15 });
  await manager.start(); t.after(async () => { await manager.close(); await rm(temp, { recursive: true, force: true }); });
  return { manager, root, remote, writes, resources, directories, tasks, config, client, post, api, get docWrites() { return docWrites; }, rename(value) { title = value; }, deleted(value) { deletedAt = value; } };
}
async function eventually(read, condition) {
  const deadline = Date.now() + 2500;
  let value;
  while (Date.now() < deadline) { value = await read(); if (condition(value)) return value; await new Promise(r => setTimeout(r, 15)); }
  assert.fail(`Timed out: ${JSON.stringify(value)}`);
}
const bindingState = async (f, id) => (await f.manager.status()).bindings.find(x => x.bindingId === id);

test('explicitly disabled knowledge integration preserves old operation intent while Docmost continues', async t => {
  const f = await fixture(t);
  f.remote.revision = f.remote.persistedRevision = rev('# Initial\n');
  const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  await f.manager.close();
  const filename = join(f.config.syncStateDir, 'bindings', binding.bindingId + '.json');
  const stored = JSON.parse(await readFile(filename, 'utf8'));
  stored.mirror.operation = { id: '00000000-0000-4000-8000-000000000099', kind: 'delete', rootId: pageId, beforeDeletedAt: null };
  await writeFile(filename, JSON.stringify(stored));
  const mirrorBefore = structuredClone(stored.mirror);
  let requests = 0;
  const forbidden = new Proxy({}, { get() { return () => { requests++; throw new Error('disabled adapter was invoked'); }; } });
  const manager = createMarkdownSync({ ...f.config, knowledgeBase: undefined }, { api: f.api, mirrorClient: forbidden, debounceMs: 10, scanMs: 15 });
  try {
    await manager.start();
    await writeFile(join(f.root, 'note.md'), '# Changed while knowledge is disabled\n');
    await eventually(() => manager.status(), x => x.bindings[0]?.state === 'synced' && f.docWrites === 1);
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).mirror, mirrorBefore);
    assert.equal((await manager.status()).knowledgeBase.state, 'disabled');
  } finally { await manager.close(); }
});

test('an unsupported knowledge provider is isolated from successful Docmost binding and saves', async t => {
  const f = await fixture(t); await f.manager.close();
  const manager = createMarkdownSync({ ...f.config, knowledgeBase: { provider: 'unsupported', error: {
    code: 'KB_UNSUPPORTED_PROVIDER', message: 'Choose an available provider.' } } }, {
    api: f.api, mirrorClient: new Proxy({}, { get() { throw new Error('unsupported provider accessed OpenViking'); } }), debounceMs: 10, scanMs: 15,
  });
  try {
    const binding = await manager.bind({ filePath: 'note.md', pageId });
    assert.equal(binding.knowledgeBase.error.code, 'KB_UNSUPPORTED_PROVIDER');
    await writeFile(join(f.root, 'note.md'), '# Saved with an unavailable provider\n');
    await eventually(() => manager.status(), x => x.bindings[0]?.state === 'synced' && f.docWrites === 1);
    assert.equal((await manager.retryMirror({ bindingId: binding.bindingId })).error.code, 'KB_UNSUPPORTED_PROVIDER');
    assert.equal(f.docWrites, 1);
  } finally { await manager.close(); }
});

test('the Markdown coordinator publishes a confirmed snapshot through a non-OpenViking adapter', async t => {
  const f = await fixture(t); await f.manager.close();
  const published = [];
  const adapter = {
    id: 'fixture',
    validateState(value) { assert.equal(value.provider, 'fixture'); },
    stateStatus(binding) { return { state: binding.mirror.state, uri: binding.mirror.uri }; },
    createRuntime(_connection, { store, persist, post }) {
      const mirror = {
        initial(binding) { return binding.mirror ??= { provider: 'fixture', version: 1, state: 'waiting_docmost' }; },
        async prepare(binding, source) {
          await store.saveSnapshot(binding.bindingId, source);
          mirror.initial(binding).pending = { kind: 'body', hash: source.hash, phase: 'await_docmost' };
        },
        confirm(binding, pending) {
          const job = binding.mirror.pending;
          if (job?.hash === pending.localHash) { job.revision = pending.proposedRevision; job.phase = 'ready'; }
        },
        canProcess(binding) { return binding.mirror?.pending?.phase === 'ready'; },
        async process(binding) {
          const job = binding.mirror.pending, remote = await post('pages/sync-state', { pageId: binding.pageId });
          assert.equal(remote.revision, job.revision); assert.equal(remote.persistedRevision, job.revision);
          published.push(await store.readSnapshot(binding.bindingId, job.hash));
          binding.mirror.uri = 'fixture:space/page'; binding.mirror.state = 'synced';
          delete binding.mirror.pending; await persist(binding);
        },
      };
      return { mirror, tree: { run: (_binding, work) => work(), close() {} } };
    },
  };
  const manager = createMarkdownSync({ ...f.config, knowledgeBase: { provider: 'fixture', config: {} } }, {
    api: f.api, knowledgeAdapters: { fixture: adapter }, debounceMs: 10, scanMs: 15,
    mirrorClient: new Proxy({}, { get() { throw new Error('a generic adapter must not access OpenViking'); } }),
  });
  try {
    const binding = await manager.bind({ filePath: 'note.md', pageId });
    assert.equal(binding.knowledgeBase.provider, 'fixture'); assert.equal(binding.openViking, undefined);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(published, [], 'an unconfirmed initial MD cannot be exported');
    await writeFile(join(f.root, 'note.md'), '# Confirmed backend-neutral body\n');
    const result = await eventually(() => manager.status(), x => x.bindings[0]?.knowledgeBase.state === 'synced');
    assert.equal(result.bindings[0].knowledgeBase.uri, 'fixture:space/page');
    assert.deepEqual(published, ['# Confirmed backend-neutral body\n']);
    assert.equal(f.docWrites, 1);
  } finally { await manager.close(); }
});

async function subtreeFixture(t, { unknownAsset = false } = {}) {
  const f = await fixture(t), childId = '00000000-0000-4000-8000-000000000005';
  const childContent = '# Child\n', childRemote = { pageId: childId, spaceId, workspaceId,
    revision: rev(childContent), persistedRevision: rev(childContent) };
  let childDeletedAt = null;
  f.remote.revision = f.remote.persistedRevision = rev('# Initial\n');
  await writeFile(join(f.root, 'child.md'), childContent);
  f.api.post = async (path, body, ...args) => {
    if (body?.pageId === childId) {
      if (path === 'pages/info') {
        // Parent confirmation reaches its queue first while the child still
        // verifies its own deleted state. Cleanup must wait for that child.
        if (childDeletedAt) await new Promise(resolve => setTimeout(resolve, 60));
        return { id: childId, spaceId, workspaceId, title: 'Child', parentPageId: pageId, deletedAt: childDeletedAt };
      }
      if (path === 'pages/sync-state') return { ...childRemote, ...(body.content !== undefined ? { proposedRevision: rev(body.content) } : {}) };
      if (path === 'pages/sync-update') {
        assert.equal(body.expectedRevision, childRemote.revision);
        childRemote.revision = childRemote.persistedRevision = rev(body.content); return { ...childRemote };
      }
    }
    return f.post(path, body, ...args);
  };
  const parent = await f.manager.bind({ filePath: 'note.md', pageId });
  const child = await f.manager.bind({ filePath: 'child.md', pageId: childId });
  const parentState = await eventually(() => bindingState(f, parent.bindingId), x => x.openViking?.state === 'synced');
  const childState = await eventually(() => bindingState(f, child.bindingId), x => x.openViking?.state === 'synced');
  const parentDir = parentState.openViking.uri.slice(0, -'/document.md'.length);
  const childDir = childState.openViking.uri.slice(0, -'/document.md'.length);
  if (unknownAsset) f.resources.set(parentDir + '/foreign.md', '# Retained unknown asset\n');
  const removals = [], remove = f.client.remove;
  f.client.remove = async (uri, options, signal) => {
    removals.push(uri); const result = await remove(uri, options, signal);
    // A child deletion refreshes its parent directory, including empty-parent
    // summaries. Deleting the ancestor first leaves this directory context.
    if (uri === childDir && options?.recursive) {
      f.directories.add(parentDir);
      f.resources.set(parentDir + '/.abstract.md', 'Synthetic empty-parent summary');
      f.resources.set(parentDir + '/.overview.md', 'Synthetic empty-parent overview');
    }
    return result;
  };
  return { ...f, parent, child, parentDir, childDir, removals, get docWrites() { return f.docWrites; }, trash() {
    f.deleted('2026-10-14T00:00:00Z'); childDeletedAt = '2026-10-14T00:00:00Z';
  } };
}

test('subtree deletion waits for managed descendants and removes the empty parent directory context', async t => {
  const f = await subtreeFixture(t);
  const ticket = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  const recorded = JSON.parse(await readFile(join(f.config.syncStateDir, 'bindings', f.parent.bindingId + '.json'), 'utf8'));
  f.trash(); await f.manager.afterPageOperation(ticket);
  await eventually(() => bindingState(f, f.parent.bindingId), x => x.openViking?.state === 'deleted');
  await eventually(() => bindingState(f, f.child.bindingId), x => x.openViking?.state === 'deleted');
  assert.equal(f.directories.has(f.parentDir), false, 'the deleted parent page must not retain a directory summary/context');
  assert.equal(f.directories.has(f.childDir), false);
  assert.equal([...f.resources.keys()].some(uri => uri.startsWith(f.parentDir + '/')), false);
  assert.ok(f.removals.indexOf(f.childDir) < f.removals.indexOf(f.parentDir + '/document.md'));
  assert.deepEqual(recorded.mirror.operation.waitFor, [f.child.bindingId]);
});

test('postorder subtree deletion retains unknown assets in the parent directory', async t => {
  const f = await subtreeFixture(t, { unknownAsset: true });
  const ticket = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.trash(); await f.manager.afterPageOperation(ticket);
  await eventually(() => bindingState(f, f.parent.bindingId), x => x.openViking?.state === 'deleted');
  await eventually(() => bindingState(f, f.child.bindingId), x => x.openViking?.state === 'deleted');
  assert.equal(f.resources.get(f.parentDir + '/foreign.md'), '# Retained unknown asset\n');
  assert.equal(f.directories.has(f.childDir), false);
  assert.equal(f.removals.includes(f.parentDir), false);
});

test('a parent deletion dependency survives shutdown while its child waits for semantic queues', { timeout: 8000 }, async t => {
  const f = await subtreeFixture(t);
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.client.waitProcessed = async signal => {
    entered();
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const ticket = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.trash(); const confirmation = f.manager.afterPageOperation(ticket).catch(() => {});
  await waiting; await f.manager.close(); await confirmation;
  assert.equal(f.removals.includes(f.parentDir + '/document.md'), false);
  const recorded = JSON.parse(await readFile(join(f.config.syncStateDir, 'bindings', f.parent.bindingId + '.json'), 'utf8'));
  assert.equal(recorded.mirror.operation, undefined, 'Docmost confirmation is already durable');
  assert.equal(recorded.mirror.pending.kind, 'delete');
  assert.deepEqual(recorded.mirror.pending.waitFor, [f.child.bindingId]);
  f.client.waitProcessed = async () => ({});
  const restarted = createMarkdownSync(f.config, { api: f.api, mirrorClient: f.client, debounceMs: 10, scanMs: 15 });
  try {
    await restarted.start();
    const current = { ...f, manager: restarted };
    await eventually(() => bindingState(current, f.parent.bindingId), x => x.openViking?.state === 'deleted');
    await eventually(() => bindingState(current, f.child.bindingId), x => x.openViking?.state === 'deleted');
    assert.equal(f.directories.has(f.parentDir), false);
    assert.ok(f.removals.indexOf(f.childDir) < f.removals.indexOf(f.parentDir + '/document.md'));
  } finally { await restarted.close(); }
});

test('subtree deletion reconciles an older unknown parent write before waiting for the child', async t => {
  const f = await subtreeFixture(t), write = f.client.write;
  f.client.write = async (...args) => {
    await write(...args);
    throw Object.assign(new Error('Synthetic lost write acknowledgement'), { code: 'OV_NETWORK_ERROR', mayHaveSucceeded: true });
  };
  await writeFile(join(f.root, 'note.md'), '# Confirmed parent with an unknown mirror acknowledgement\n');
  await eventually(() => bindingState(f, f.parent.bindingId), x => x.openViking?.phase === 'writing' && x.openViking?.state === 'retrying');
  f.client.write = write;
  const ticket = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.trash(); await f.manager.afterPageOperation(ticket);
  await eventually(() => bindingState(f, f.parent.bindingId), x => x.openViking?.state === 'deleted');
  await eventually(() => bindingState(f, f.child.bindingId), x => x.openViking?.state === 'deleted');
  assert.equal(f.directories.has(f.parentDir), false);
  assert.equal(f.directories.has(f.childDir), false);
  assert.ok(f.removals.indexOf(f.childDir) < f.removals.indexOf(f.parentDir + '/document.md'));
  assert.equal(f.docWrites, 1, 'reconciliation cannot replay the earlier Docmost body write');
});

test('MD only enters OpenViking after Docmost live and persisted confirmation with space hierarchy', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  assert.equal(binding.openViking?.state, 'waiting_docmost');
  assert.equal(f.writes.length, 0);
  await writeFile(join(f.root, 'note.md'), '# New\n');
  const synced = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  assert.equal(synced.state, 'synced'); assert.equal(f.docWrites, 1);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].content, '# New\n');
  assert.match(f.writes[0].uri, new RegExp(`Shared/My-Page/document.md$`));
  assert.equal(synced.openViking.confirmedRevision, f.remote.revision);
});
test('optional offline target preserves successful Docmost result and retry never replays Docmost', async t => {
  const f = await fixture(t, { offline: true }); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Saved offline\n');
  const saved = await eventually(() => bindingState(f, binding.bindingId), x => x.state === 'synced');
  assert.ok(saved.openViking); assert.notEqual(saved.openViking.state, 'synced'); assert.equal(f.docWrites, 1);
  f.client.identity = async () => ({ accountId: 'personal', userId: 'test', role: 'user', rootUri: 'viking://user/test/resources/docmost-mcp' });
  await f.manager.retryMirror({ bindingId: binding.bindingId });
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  assert.equal(f.docWrites, 1); assert.equal(f.writes[0].content, '# Saved offline\n');
});
test('retry returns the gate failure recorded by this call rather than its earlier pending snapshot', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Confirmed\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  f.client.identity = async () => { throw Object.assign(new Error('synthetic unavailable'), { code: 'OV_NETWORK_ERROR' }); };
  const result = await f.manager.retryMirror({ bindingId: binding.bindingId });
  assert.equal(result.state, 'retrying');
  assert.equal(result.error?.code, 'OV_NETWORK_ERROR');
  assert.equal(f.docWrites, 1);
});
test('Docmost conflict and paused source never publish a new local version', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  f.remote.revision = rev('# Web edit\n');
  await writeFile(join(f.root, 'note.md'), '# Local conflict\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.state === 'conflict');
  assert.equal(f.writes.length, 0);
  await f.manager.control({ bindingId: binding.bindingId, action: 'pause' });
  await writeFile(join(f.root, 'note.md'), '# Paused\n');
  await new Promise(r => setTimeout(r, 80)); assert.equal(f.writes.length, 0);
});
test('rename moves the confirmed source and removes only the old owned leaf', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# First\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  const old = f.writes[0].uri; f.rename('Renamed');
  await writeFile(join(f.root, 'note.md'), '# Second\n');
  const final = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced' && x.openViking.uri?.includes('/Renamed/'));
  assert.equal(f.resources.has(old), false); assert.equal(f.resources.get(final.openViking.uri), '# Second\n');
  assert.equal(f.directories.has(old.slice(0, old.lastIndexOf('/'))), false);
});
test('explicit deletion and restoration mirror only the confirmed managed state transition', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# To delete\n');
  const original = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  assert.equal(typeof f.manager.beforePageOperation, 'function');
  const deletion = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.deleted('2026-10-14T00:00:00Z'); await f.manager.afterPageOperation(deletion);
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'deleted');
  assert.equal(f.resources.has(original.openViking.uri), false);
  assert.equal(f.directories.has(original.openViking.uri.slice(0, original.openViking.uri.lastIndexOf('/'))), false);
  const restoration = await f.manager.beforePageOperation({ kind: 'restore', pageId });
  f.deleted(null); await f.manager.afterPageOperation(restoration);
  const restored = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  assert.equal(f.resources.get(restored.openViking.uri), '# To delete\n'); assert.equal(f.docWrites, 1);
});
test('explicit metadata rename relayouts without replaying the Docmost body mutation', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Same body\n');
  const original = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  f.rename('Changed metadata'); assert.equal(typeof f.manager.refreshMirrorLayouts, 'function');
  await f.manager.refreshMirrorLayouts();
  const next = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced' && x.openViking.uri !== original.openViking.uri);
  assert.equal(f.resources.get(next.openViking.uri), '# Same body\n'); assert.equal(f.docWrites, 1);
});
test('rename while the first mirror task is running retains a confirmed layout successor', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  const reindex = f.client.reindex;
  f.client.reindex = async (...args) => {
    const result = await reindex(...args); f.tasks.get(result.taskId).status = 'running'; return result;
  };
  await writeFile(join(f.root, 'note.md'), '# First confirmed body\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.phase === 'indexing');
  const oldUri = f.writes[0].uri;
  f.rename('Renamed before initial completion');
  const refreshed = await f.manager.refreshMirrorLayouts();
  assert.equal(refreshed.targets.length, 1);
  f.client.reindex = reindex;
  for (const task of f.tasks.values()) task.status = 'completed';
  const final = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced' && x.openViking.uri?.includes('/Renamed-before-initial-completion/'));
  assert.equal(f.resources.has(oldUri), false);
  assert.equal(f.resources.get(final.openViking.uri), '# First confirmed body\n');
  assert.equal(f.docWrites, 1);
});
test('metadata refresh compares the layout when its binding queue executes', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Original\n');
  const original = await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  let entered, release, blocked = false;
  const reachedLayout = new Promise(resolve => { entered = resolve; });
  const holdLayout = new Promise(resolve => { release = resolve; });
  f.api.post = async (path, ...args) => {
    if (path === 'spaces/info' && !blocked) { blocked = true; entered(); await holdLayout; }
    return f.post(path, ...args);
  };
  f.rename('Temporary layout');
  await writeFile(join(f.root, 'note.md'), '# Confirmed second version\n');
  await reachedLayout;
  f.rename('My Page');
  const refreshed = f.manager.refreshMirrorLayouts();
  release();
  assert.equal((await refreshed).targets.length, 1);
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced' && x.openViking.uri === original.openViking.uri && x.openViking.confirmedRevision === f.remote.revision);
  assert.equal(f.resources.get(original.openViking.uri), '# Confirmed second version\n');
  assert.ok([...f.resources.keys()].every(uri => !uri.includes('/Temporary-layout/')));
  assert.equal(f.docWrites, 2);
});
test('an unknown reindex submission cannot reuse the only completed task from an earlier version', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  const oldTask = { taskId: 'old_task', status: 'completed', failedRecords: 0, warnings: [] };
  f.client.tasks = async () => [oldTask]; f.client.task = async () => oldTask;
  f.client.reindex = async () => { throw Object.assign(new Error('lost submit'), { code: 'OV_TIMEOUT' }); };
  await writeFile(join(f.root, 'note.md'), '# Newly written but not indexed\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.error?.code === 'OV_TIMEOUT');
  await f.manager.retryMirror({ bindingId: binding.bindingId });
  const result = await bindingState(f, binding.bindingId);
  assert.notEqual(result.openViking.state, 'synced'); assert.equal(result.openViking.error?.code, 'OV_UNCONFIRMED');
  assert.equal(f.docWrites, 1);
});

test('paused cleanup stops automatic OpenViking authentication until the source is resumed', async t => {
  const f = await fixture(t); const binding = await f.manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Before pause\n');
  await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
  let identities = 0, held = false, release;
  const identity = f.client.identity;
  f.client.identity = async (...args) => { identities++; return identity(...args); };
  const task = f.client.task;
  const hold = new Promise(resolve => { release = resolve; });
  f.client.task = async id => {
    const value = await task(id);
    if (value.mode === 'prune_orphans' && !held) { held = true; await hold; }
    return value;
  };
  f.rename('New ordinary-save layout');
  await writeFile(join(f.root, 'note.md'), '# Confirmed before cleanup pause\n');
  try {
    await eventually(async () => held, Boolean);
    const paused = f.manager.control({ bindingId: binding.bindingId, action: 'pause' });
    release(); await paused;
    await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.phase === 'prune_cleanup');
    const before = identities;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(identities, before);
    await f.manager.control({ bindingId: binding.bindingId, action: 'resume' });
    await eventually(() => bindingState(f, binding.bindingId), x => x.openViking?.state === 'synced');
    assert.equal(f.docWrites, 2);
  } finally { release(); }
});
