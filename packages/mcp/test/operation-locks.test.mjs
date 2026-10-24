import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createSyncStore } from '../src/sync-store.mjs';
import { fixture, eventually, pageId, hash } from './git-fixture.mjs';

const branch = 'refs/heads/feature';
const idle = async f => {
  assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'leases')), []);
  try { assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'operations')), []); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};

test('finished Git work releases its locks while the MCP manager stays connected', async t => {
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

test('another connected manager reconciles a released unknown write without replay', async t => {
  const f = await fixture(t), bound = await f.bind(); await f.save('# Unknown acknowledged result\n'); const commit = f.commit(); f.state.loseAck = true;
  const result = await f.manager.publishGitDocuments({ commit, branch }); assert.ok(result.documents[0].pending); await idle(f);
  f.state.loseAck = false; f.state.failReads = false;
  const peer = f.create(); await peer.start(); const status = await peer.getGitDocumentStatus({ bindingId: bound.bindingId });
  assert.equal(status.git.published.commit, commit); assert.equal(status.pending, undefined); assert.equal(f.state.writes, 1); await idle(f);
});

test('two enabled MD watchers upload one save once and keep no idle lease', async t => {
  const f = await fixture(t, { markdown: true }); await f.manager.bind({ pageId, filePath: 'document.md' }); const other = f.create(); await other.start();
  await f.save('# Single observed save\n');
  await eventually(() => f.state.body, x => x === '# Single observed save\n');
  await eventually(async () => (await readdir(join(f.config.knowledgeStateDir, 'leases'))).length, n => n === 0);
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

test('temporary live-owner busy automatically retries the saved MD without poisoning the manager', async t => {
  const f = await fixture(t, { markdown: true }); await f.manager.bind({ pageId, filePath: 'document.md' });
  const key = createHash('sha256').update(f.config.origin + '|00000000-0000-4000-8000-000000000003|' + pageId).digest('hex');
  const filename = join(f.config.knowledgeStateDir, 'leases', key + '.json'); await writeFile(filename, JSON.stringify({ pid: process.pid, nonce: 'temporary-live-worker' }), { mode: 0o600 });
  await f.save('# Saved while temporarily busy\n');
  await eventually(() => f.manager.status(), s => s.bindings[0].error?.code === 'LEASE_BUSY');
  await rm(filename);
  await eventually(() => f.state.body, body => body === '# Saved while temporarily busy\n');
  assert.equal(f.state.writes, 1); assert.equal((await f.manager.status()).state, 'running');
  await f.manager.control({ bindingId: (await f.manager.status()).bindings[0].bindingId, action: 'resume' });
  await idle(f);
});

test('a killed worker leaves recoverable tickets and page locks, without losing its binding', async t => {
  const f = await fixture(t), b = await f.bind();
  const saved = JSON.parse(await readFile(join(f.config.knowledgeStateDir, 'bindings', b.bindingId + '.json'), 'utf8'));
  const entry = new URL('../src/sync-store.mjs', import.meta.url).href;
  const code = `import {createSyncStore} from ${JSON.stringify(entry)}; const s=await createSyncStore(process.env.TEST_STATE); if(typeof s.acquireOperation!=='function')process.exit(2); await s.acquireOperation(new AbortController().signal); await s.acquire(JSON.parse(process.env.TEST_BINDING),new AbortController().signal,{recoverDead:true}); console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_STATE: f.config.knowledgeStateDir, TEST_BINDING: JSON.stringify(saved) }, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const ready = await Promise.race([once(child.stdout, 'data').then(x => String(x[0]).trim()), closed.then(() => 'exited')]); assert.equal(ready, 'ready');
  child.kill('SIGKILL'); await closed;
  await f.save('# Recovered after crash\n'); const commit = f.commit(); const result = await f.manager.publishGitDocuments({ commit, branch });
  assert.equal(result.documents[0].bindingId, b.bindingId); assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.writes, 1); await idle(f);
});

test('a live legacy page owner remains protected and failed work releases only its own ticket', async t => {
  const f = await fixture(t), b = await f.bind();
  const { createHash, randomUUID } = await import('node:crypto');
  const saved = JSON.parse(await readFile(join(f.config.knowledgeStateDir, 'bindings', b.bindingId + '.json'), 'utf8'));
  const key = createHash('sha256').update(saved.origin + '|' + saved.workspaceId + '|' + saved.pageId).digest('hex');
  const filename = join(f.config.knowledgeStateDir, 'leases', key + '.json'), owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  await writeFile(filename, owner, { mode: 0o600 });
  await f.save('# Must not steal a live owner\n'); const commit = f.commit(); const result = await f.manager.publishGitDocuments({ commit, branch });
  assert.equal(result.documents[0].error.code, 'LEASE_BUSY'); assert.equal(f.state.writes, 0); assert.equal(await readFile(filename, 'utf8'), owner);
  assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'operations')), []);
});

test('cancelling a waiting operation removes its participant and preserves the active owner', async t => {
  const f = await fixture(t), store = await createSyncStore(f.config.knowledgeStateDir);
  assert.equal(typeof store.acquireOperation, 'function');
  const owner = await store.acquireOperation(new AbortController().signal), cancellation = new AbortController();
  try {
    const waiting = store.acquireOperation(cancellation.signal);
    await eventually(async () => (await readdir(join(f.config.knowledgeStateDir, 'operations'))).length, n => n === 2);
    cancellation.abort(); await assert.rejects(waiting);
    assert.equal((await readdir(join(f.config.knowledgeStateDir, 'operations'))).length, 1);
  } finally { await store.releaseOperation(owner); }
  await idle(f);
});

test('simultaneously starting processes serialize real critical sections and leave no tickets', { timeout: 10000 }, async t => {
  const f = await fixture(t), entry = new URL('../src/sync-store.mjs', import.meta.url).href;
  const code = `import {createSyncStore} from ${JSON.stringify(entry)}; import {open,unlink,access} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';const s=await createSyncStore(process.env.TEST_STATE);console.log('ready');while(true){try{await access(process.env.TEST_STATE+'/start');break;}catch{await delay(5);}}for(let i=0;i<4;i++){const owner=await s.acquireOperation(new AbortController().signal);try{const file=await open(process.env.TEST_STATE+'/critical','wx',0o600);await delay(5);await file.close();await unlink(process.env.TEST_STATE+'/critical');}finally{await s.releaseOperation(owner);}}`;
  const workers = Array.from({ length: 5 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_STATE: f.config.knowledgeStateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
    const done = once(child, 'close'); t.after(() => child.kill('SIGKILL'));
    return { child, done, error: () => stderr, ready: Promise.race([once(child.stdout, 'data'), done.then(() => { throw new Error('Ticket worker exited before becoming ready'); })]) };
  });
  await Promise.all(workers.map(w => w.ready)); await writeFile(join(f.config.knowledgeStateDir, 'start'), 'start', { mode: 0o600 });
  const results = await Promise.all(workers.map(worker => worker.done));
  for (let i = 0; i < workers.length; i++) assert.equal(results[i][0], 0, 'exclusive critical section failed: ' + workers[i].error());
  assert.deepEqual(await readdir(join(f.config.knowledgeStateDir, 'operations')), []);
});
