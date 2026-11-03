import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncStore } from '../src/sync-store.mjs';
import { digest } from '../src/sync-files.mjs';

const module = await import('../src/mirror-tree.mjs').catch(() => undefined);
test('OpenViking mirror tree gate is available', () => assert.equal(typeof module?.createMirrorTree, 'function'));
const run = (name, fn) => test(name, { skip: !module }, fn);
const rootUri = 'viking://user/test/resources/docmost-mcp';
const origin = 'https://ov.example.test';
const aId = '00000000-0000-4000-8000-000000000001';
const bId = '00000000-0000-4000-8000-000000000002';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'docmost-mirror-tree-')));
  const store = await createSyncStore(dir);
  const taskData = new Map(), calls = [];
  const config = { origin, rootUri };
  const target = { origin, accountId: 'personal', userId: 'test', rootUri };
  const client = {
    async identity() { calls.push({ operation: 'identity' }); return { accountId: 'personal', userId: 'test', rootUri, role: 'user' }; },
    async task(taskId) { calls.push({ operation: 'task', taskId }); const task = taskData.get(taskId); if (!task) throw Object.assign(new Error('Synthetic missing task'), { code: 'OV_NOT_FOUND' }); return task; },
    async waitProcessed() { calls.push({ operation: 'wait' }); return {}; },
  };
  const binding = id => ({ bindingId: id, origin: 'https://docmost.example.test', workspaceId: aId, pageId: id,
    state: 'synced', enabled: true, localHash: digest('local confirmed source'),
    mirror: { version: 1, state: 'pending', target: { ...target }, connectionOrigin: origin, pending: { kind: 'body', phase: 'ready', hash: digest('body'), revision: digest('document revision') } } });
  const a = binding(aId), b = binding(bId);
  await store.save(a); await store.save(b);
  const controllers = [], gates = [];
  function gate(options = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const result = module.createMirrorTree({ config: { ...config, ...options }, client, store, persist: value => store.save(value), signal: controller.signal });
    gates.push(result); return { result, controller };
  }
  t.after(async () => { for (const controller of controllers) controller.abort(); for (const gate of gates) await gate.close(); await rm(dir, { recursive: true, force: true }); });
  const leases = () => readdir(join(dir, 'leases')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return { store, config, client, taskData, calls, a, b, gate, leases };
}

run('other page tasks never reserve a knowledge root, including archived unknown work', async t => {
  for (const phase of ['writing', 'submit_submitting', 'indexing', 'removing', 'prune_verify']) {
    for (const archived of [false, true]) {
      const f = await fixture(t), gate = f.gate().result;
      f.a.mirror.pending.phase = phase;
      if (phase === 'indexing') { f.a.mirror.pending.taskId = 'running-task'; f.taskData.set('running-task', { status: 'running' }); }
      if (phase === 'prune_verify') f.a.mirror.pending.pruneUri = `${rootUri}/old/document.md`;
      await f.store.save(f.a);
      if (archived) { await f.store.archiveMirror(f.a); await f.store.remove(aId); }
      let work = 0; await gate.run(f.b, async () => { work++; });
      assert.equal(work, 1); assert.equal(f.b.mirror.errorCode, undefined);
      assert.deepEqual(f.calls.map(call => call.operation), ['identity']);
      assert.deepEqual(await f.leases(), []);
    }
  }
});

run('namespace identity changes pause only the affected page without dispatch', async t => {
  const f = await fixture(t), gate = f.gate().result;
  f.b.mirror.target.accountId = 'another-account';
  let work = 0; await gate.run(f.b, async () => { work++; });
  assert.equal(work, 0); assert.equal(f.b.mirror.errorCode, 'OV_TARGET_CHANGED');
  assert.equal(f.b.state, 'synced');
});

run('close waits for its active callbacks without owning a namespace', async t => {
  const f = await fixture(t), gate = f.gate().result;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const work = gate.run(f.a, async () => { entered(); await waiting; });
  await started; const closing = gate.close();
  assert.deepEqual(await f.leases(), []);
  release(); await work; await closing;
});

run('optional service failure is isolated from successful Docmost state and never dispatches work', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  f.client.identity = async () => { throw Object.assign(new Error('Synthetic offline detail'), { code: 'OV_NETWORK_ERROR' }); };
  let work = 0;
  await gate.run(f.a, async () => { work++; });
  assert.equal(work, 0); assert.equal(f.a.state, 'synced'); assert.equal(f.a.mirror.errorCode, 'OV_NETWORK_ERROR');
  assert.equal((await f.leases()).length, 0);
});

run('readonly, cancellation and closed gates never authenticate or dispatch mutations', async t => {
  for (const mode of ['readonly', 'cancelled', 'closed']) {
    const f = await fixture(t); const { result: gate, controller } = f.gate(mode === 'readonly' ? { readOnly: true } : {});
    if (mode === 'cancelled') controller.abort();
    if (mode === 'closed') await gate.close();
    let work = 0; await gate.run(f.a, async () => { work++; });
    assert.equal(work, 0); assert.equal(f.calls.length, 0); assert.equal((await f.leases()).length, 0);
  }
});

run('idle and unconfirmed Docmost jobs preserve their state without entering a busy tree', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  await gate.run(f.a, async () => {
    f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'active-parent' };
    f.taskData.set('active-parent', { status: 'running' }); await f.store.save(f.a);
  });
  const storeCalls = [];
  for (const method of ['load', 'loadMirrorHistory', 'save']) {
    const original = f.store[method].bind(f.store);
    f.store[method] = async (...args) => { storeCalls.push(method); return original(...args); };
  }
  for (const state of ['synced', 'deleted', 'waiting_docmost']) {
    f.b.mirror = { version: 1, connectionOrigin: origin, state };
    const before = structuredClone(f.b);
    f.calls.length = 0; storeCalls.length = 0;
    let work = 0; await gate.run(f.b, async () => { work++; });
    assert.deepEqual(f.b, before); assert.equal(work, 0);
    assert.deepEqual(f.calls, []); assert.deepEqual(storeCalls, []);
  }
  f.b.mirror.pending = { kind: 'body', phase: 'await_docmost', hash: digest('unconfirmed') };
  const before = structuredClone(f.b);
  f.calls.length = 0; storeCalls.length = 0;
  let work = 0; await gate.run(f.b, async () => { work++; });
  assert.deepEqual(f.b, before); assert.equal(work, 0);
  assert.deepEqual(f.calls, []); assert.deepEqual(storeCalls, []);
});

run('an idle binding is untouched while another work callback is still in flight', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const active = gate.run(f.a, async () => { entered(); await waiting; });
  await started;
  delete f.b.mirror.pending; f.b.mirror.state = 'synced';
  const before = structuredClone(f.b), callsBefore = f.calls.length;
  try {
    await gate.run(f.b, async () => assert.fail('idle work must not run'));
    assert.deepEqual(f.b, before); assert.equal(f.calls.length, callsBefore);
  } finally { release(); await active; }
});
