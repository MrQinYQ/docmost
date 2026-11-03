import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fixture, eventually, pageId, hash } from './git-fixture.mjs';

const branch = 'refs/heads/feature';
const idle = async f => {
  assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'leases')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
  try { assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'operations')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};

test('Git work leaves no locks while the MCP manager stays connected', async t => {
  const f = await fixture(t), b = await f.bind(); await idle(f);
  await f.save('# Scoped publication\n'); const commit = f.commit();
  const result = await f.manager.publishGitDocuments({ commit, branch });
  assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.body, '# Scoped publication\n'); await idle(f);
  await assert.rejects(f.manager.setGitDocumentSync({ bindingId: b.bindingId, action: 'rebind', filePath: '../bad.md' }), { code: 'INVALID_REQUEST' }); await idle(f);
});

test('two connected managers reload the last completed publication without duplicate writes', async t => {
  const f = await fixture(t), b = await f.bind(), other = f.create(); await other.start();
  await f.save('# First process update\n'); const first = f.commit();
  await f.manager.publishGitDocuments({ commit: first, branch });
  let result = await other.publishGitDocuments({ commit: first, branch });
  assert.equal(result.documents[0].state, 'synced'); assert.equal(result.documents[0].bindingId, b.bindingId); assert.equal(f.state.writes, 1);
  await f.save('# Second process update\n'); const second = f.commit();
  result = await other.publishGitDocuments({ commit: second, branch }); assert.equal(result.documents[0].state, 'synced');
  result = await f.manager.publishGitDocuments({ commit: second, branch }); assert.equal(result.documents[0].git.published.commit, second); assert.equal(f.state.writes, 2); await idle(f);
});

test('another connected manager reconciles a unknown write without replay', async t => {
  const f = await fixture(t), bound = await f.bind(); await f.save('# Unknown acknowledged result\n'); const commit = f.commit(); f.state.loseAck = true;
  const result = await f.manager.publishGitDocuments({ commit, branch }); assert.ok(result.documents[0].pending); await idle(f);
  f.state.loseAck = false; f.state.failReads = false;
  const peer = f.create(); await peer.start(); const status = await peer.getGitDocumentStatus({ bindingId: bound.bindingId });
  assert.equal(status.git.published.commit, commit); assert.equal(status.pending, undefined); assert.equal(f.state.writes, 1); await idle(f);
});

test('two enabled MD watchers upload one save once and create no lease', async t => {
  const f = await fixture(t, { markdown: true }); await f.manager.bind({ pageId, filePath: 'document.md' }); const other = f.create(); await other.start();
  await f.save('# Single observed save\n');
  await eventually(() => f.state.body, x => x === '# Single observed save\n');
  await eventually(async () => (await readdir(join(f.config.knowledgeStateDir, 'leases')).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length, n => n === 0);
  await eventually(async () => [(await other.status()).bindings[0].localHash, (await f.manager.status()).bindings[0].localHash], values => values.every(value => value === hash('# Single observed save\n')));
  assert.equal(f.state.writes, 1);
});

test('a queued watcher cannot resurrect a binding another manager unbound while it waited', async t => {
  const f = await fixture(t, { markdown: true }), bound = await f.manager.bind({ pageId, filePath: 'document.md' }); const peer = f.create(); await peer.start();
  let enter, release; const entered = new Promise(r => { enter = r; }), waiting = new Promise(r => { release = r; });
  const removing = peer.runOperation(async () => { await peer.control({ bindingId: bound.bindingId, action: 'unbind' }); enter(); await waiting; });
  try { await entered; await f.save('# Must stay unbound\n'); await delay(80); } finally { release(); }
  await removing; await f.manager.runOperation(() => {});
  assert.equal(f.state.writes, 0); assert.deepEqual((await f.manager.status()).bindings, []);
  assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'bindings')), []); await idle(f);
});
