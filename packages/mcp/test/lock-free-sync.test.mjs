import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSyncStore } from '../src/sync-store.mjs';
import { fixture, pageId, hash } from './git-fixture.mjs';
import { createMirrorTree } from '../src/mirror-tree.mjs';

const branch = 'refs/heads/feature';
const entries = async path => readdir(path).catch(error => { if (error.code === 'ENOENT') return []; throw error; });

test('Git publication ignores a live legacy page lease and never creates an operation ticket', async t => {
  const f = await fixture(t), bound = await f.bind();
  const leases = join(f.config.knowledgeStateDir, 'leases'); await mkdir(leases, { recursive: true, mode: 0o700 });
  const path = join(leases, hash(`${f.config.origin}|${bound.workspaceId}|${pageId}`) + '.json');
  const legacy = JSON.stringify({ pid: process.pid, nonce: 'old-live-process' });
  await writeFile(path, legacy, { mode: 0o600 });
  await f.save('# No local ownership\n'); const commit = f.commit();
  const post = f.api.post;
  f.api.post = async (...args) => {
    if (args[0] === 'pages/sync-update') {
      assert.deepEqual(await entries(join(f.config.knowledgeStateDir, 'operations')), []);
      assert.deepEqual(await entries(leases), [path.slice(path.lastIndexOf('/') + 1)]);
    }
    return post(...args);
  };
  const result = await f.manager.publishGitDocuments({ commit, branch });
  assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.body, '# No local ownership\n');
  assert.equal(await readFile(path, 'utf8'), legacy);
});

test('a conditional remote conflict is reported without a local lock or overwritten content', async t => {
  const f = await fixture(t); await f.bind();
  await f.save('# Local proposal\n'); const commit = f.commit();
  f.state.body = f.state.persisted = '# Changed in browser\n';
  const result = await f.manager.publishGitDocuments({ commit, branch });
  assert.equal(result.documents[0].error.code, 'CONFLICT'); assert.equal(result.documents[0].state, 'conflict');
  assert.equal(f.state.writes, 0); assert.equal(f.state.body, '# Changed in browser\n');
  assert.ok(!(await readdir(f.config.knowledgeStateDir)).some(name => ['leases', 'operations'].includes(name)));
});

test('a stale ledger writer reports conflict and preserves the newer durable record', async t => {
  const f = await fixture(t), binding = await f.bind();
  const first = await createSyncStore(f.config.knowledgeStateDir), second = await createSyncStore(f.config.knowledgeStateDir);
  const [{ value: stale }] = await first.load({ track: true }), [{ value: current }] = await second.load({ track: true });
  current.enabled = false; current.state = 'paused'; await second.save(current);
  stale.enabled = true; stale.state = 'watching';
  await assert.rejects(first.save(stale), { code: 'CONFLICT' });
  const [{ value }] = await second.load(); assert.equal(value.bindingId, binding.bindingId); assert.equal(value.enabled, false);
});

test('a read of other knowledge owners cannot adopt a new ledger baseline for stale memory', async t => {
  const f = await fixture(t); await f.bind();
  const a = await createSyncStore(f.config.knowledgeStateDir), b = await createSyncStore(f.config.knowledgeStateDir);
  const [{ value: stale }] = await a.load({ track: true }), [{ value: newer }] = await b.load({ track: true });
  newer.enabled = false; newer.state = 'paused'; await b.save(newer);
  await a.load();
  await assert.rejects(a.save(stale), { code: 'CONFLICT' });
  await a.load({ track: true }); await b.remove(newer.bindingId); await a.load();
  await assert.rejects(a.save(stale), { code: 'CONFLICT' });
});

test('publishing cannot prune a snapshot staged by another connection', async t => {
  const f = await fixture(t); const binding = await f.bind();
  const peer = await createSyncStore(f.config.knowledgeStateDir), content = '# Another in-flight snapshot\n';
  await peer.saveSnapshot(binding.bindingId, { hash: hash(content), content });
  await f.manager.publishGitDocuments({ commit: f.first, branch });
  assert.equal(await peer.readSnapshot(binding.bindingId, hash(content)), content);
});

test('simultaneous page enrollment reports a recoverable conflict rather than blocking the manager', async t => {
  const f = await fixture(t), a = f.manager, b = f.create(); await b.start();
  let release, entered;
  const wait = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const first = a.runOperation(async () => { entered(); await wait; return a.bindGitDocument({ filePath: 'document.md', pageId, commit: f.first, branch }); });
  await started; const second = await b.bindGitDocument({ filePath: 'document.md', pageId, commit: f.first, branch });
  release();
  await first;
  const status = await a.getGitDocumentStatus();
  assert.equal(status.error, undefined);
  assert.ok(status.bindings.every(binding => !binding.error || binding.error.code === 'CONFLICT'));
  if (status.bindings.length > 1) {
    await a.setGitDocumentSync({ bindingId: status.bindings.find(binding => binding.bindingId !== second.bindingId).bindingId, action: 'unbind' });
    assert.equal((await b.getGitDocumentStatus()).bindings.length, 1);
  }
});

test('a running knowledge callback does not reserve the root against another page', async t => {
  const f = await fixture(t), store = await createSyncStore(join(f.temp, 'mirror-state'));
  const rootUri = 'viking://user/test/resources/docmost-mcp';
  const origin = 'http://127.0.0.1:1933';
  const binding = id => ({ bindingId: id, state: 'synced', mirror: { version: 1, state: 'pending',
    target: { origin, accountId: 'personal', userId: 'test', rootUri },
    pending: { kind: 'body', phase: 'ready', hash: hash('body'), revision: hash('revision') } } });
  const a = binding('00000000-0000-4000-8000-000000000011'), b = binding('00000000-0000-4000-8000-000000000012');
  const tree = createMirrorTree({ config: { origin, rootUri },
    client: { async identity() { return { accountId: 'personal', userId: 'test', rootUri }; } },
    store, persist: value => store.save(value), signal: new AbortController().signal });
  let release, entered; const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const first = tree.run(a, async () => { entered(); await held; });
  await started; let called = false;
  try { await tree.run(b, async () => { called = true; }); assert.equal(called, true); assert.equal(b.mirror.errorCode, undefined); }
  finally { release(); await first; await tree.close(); }
});
