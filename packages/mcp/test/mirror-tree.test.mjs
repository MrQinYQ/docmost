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
  const leases = () => readdir(join(dir, 'leases'));
  return { store, config, client, taskData, calls, a, b, gate, leases };
}

run('parent and child bindings cannot overlap server-side index tasks in one mirror tree', async t => {
  const f = await fixture(t); const { result: gate } = f.gate();
  let aWork = 0, bWork = 0;
  await gate.run(f.a, async () => {
    aWork++; f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'parent-task', uri: `${rootUri}/parent/document.md` };
    f.taskData.set('parent-task', { status: 'running' }); await f.store.save(f.a);
  });
  await gate.run(f.b, async () => { bWork++; });
  assert.equal(aWork, 1); assert.equal(bWork, 0);
  assert.equal(f.b.mirror.state, 'retrying'); assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
  assert.equal(f.b.state, 'synced', 'Docmost result remains independent');
  assert.equal((await f.leases()).length, 1);
  f.taskData.get('parent-task').status = 'completed';
  await gate.run(f.b, async () => { bWork++; delete f.b.mirror.pending; await f.store.save(f.b); });
  assert.equal(bWork, 1);
  assert.equal((await f.leases()).length, 0);
});

run('two gate instances use one shared namespace lease rather than overlapping writes', async t => {
  const f = await fixture(t); const first = f.gate().result, second = f.gate().result;
  await first.run(f.a, async () => {
    f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'active-a' };
    f.taskData.set('active-a', { status: 'running' }); await f.store.save(f.a);
  });
  let called = false;
  await second.run(f.b, async () => { called = true; });
  assert.equal(called, false); assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
  assert.equal((await f.leases()).length, 1);
});

run('fresh disk metadata fences a still-running server task after its original process releases the lease', async t => {
  const f = await fixture(t); const first = f.gate().result, replacement = f.gate().result;
  const staleB = structuredClone(f.b);
  await first.run(f.a, async () => {
    f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'server-task' };
    f.taskData.set('server-task', { status: 'running' }); await f.store.save(f.a);
  });
  await first.close(); assert.equal((await f.leases()).length, 0);
  let work = 0;
  await replacement.run(staleB, async () => { work++; });
  assert.equal(work, 0); assert.equal(staleB.mirror.errorCode, 'OV_TREE_BUSY');
  assert.ok(f.calls.some(call => call.taskId === 'server-task'));
  f.taskData.get('server-task').status = 'failed';
  await replacement.run(staleB, async () => { work++; delete staleB.mirror.pending; await f.store.save(staleB); });
  assert.equal(work, 1); assert.equal((await f.leases()).length, 0);
});

run('unknown dispatched writes and submissions without task IDs fence other bindings until their owner reconciles', async t => {
    for (const phase of ['writing', 'submit_submitting', 'removing', 'prune_submitting', 'prune_removing']) {
    const f = await fixture(t); const gate = f.gate().result;
    f.a.mirror.pending.phase = phase;
    if (phase.startsWith('prune_')) f.a.mirror.pending.pruneUri = `${rootUri}/old/document.md`;
    await f.store.save(f.a);
    let bWork = 0;
    await gate.run(f.b, async () => { bWork++; });
    assert.equal(bWork, 0); assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
    await gate.run(f.a, async () => { delete f.a.mirror.pending; await f.store.save(f.a); });
    await gate.run(f.b, async () => { bWork++; delete f.b.mirror.pending; await f.store.save(f.b); });
    assert.equal(bWork, 1);
  }
});

run('paused or archived cleanup with no dispatched DELETE does not block another binding', async t => {
  for (const archived of [false, true]) {
    const f = await fixture(t); const gate = f.gate().result;
    f.a.enabled = false; f.a.state = 'paused';
    f.a.mirror.pending.phase = 'prune_cleanup';
    f.a.mirror.pending.pruneUri = `${rootUri}/old-page/document.md`;
    await f.store.save(f.a);
    if (archived) { await f.store.archiveMirror(f.a); await f.store.remove(f.a.bindingId); }
    let work = 0;
    await gate.run(f.b, async () => { work++; delete f.b.mirror.pending; await f.store.save(f.b); });
    assert.equal(work, 1);
    assert.equal((await f.leases()).length, 0);
  }
});

run('acknowledged deletion waits for detached ancestor queues before another binding can write', async t => {
  for (const archived of [false, true]) {
    const f = await fixture(t), gate = f.gate().result;
    f.a.mirror.pending.phase = 'prune_verify';
    f.a.mirror.pending.pruneUri = `${rootUri}/old-page/document.md`;
    await f.store.save(f.a);
    if (archived) { await f.store.archiveMirror(f.a); await f.store.remove(f.a.bindingId); }
    let busy = true, work = 0;
    f.client.waitProcessed = async () => {
      f.calls.push({ operation: 'wait' });
      if (busy) throw Object.assign(new Error('Synthetic queue still processing'), { code: 'OV_PROCESSING_PENDING' });
      return {};
    };
    await gate.run(f.b, async () => { work++; });
    assert.equal(work, 0, 'terminal admin tasks do not prove detached semantic queues are idle');
    assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
    busy = false;
    await gate.run(f.b, async () => { work++; delete f.b.mirror.pending; await f.store.save(f.b); });
    assert.equal(work, 1); assert.ok(f.calls.some(call => call.operation === 'wait'));
    assert.equal((await f.leases()).length, 0);
  }
});

run('expired or inaccessible task status is not terminal evidence that permits a new overlapping task', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'missing-task' }; await f.store.save(f.a);
  let work = 0;
  await gate.run(f.b, async () => { work++; });
  assert.equal(work, 0); assert.equal(f.b.mirror.state, 'retrying');
  assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
});

run('other authenticated accounts and private roots do not block this namespace', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  f.a.mirror.target.accountId = 'other'; f.a.mirror.pending.phase = 'writing'; await f.store.save(f.a);
  let work = 0;
  await gate.run(f.b, async () => { work++; delete f.b.mirror.pending; await f.store.save(f.b); });
  assert.equal(work, 1);
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

run('closing waits for its existing work before releasing the namespace lease', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const work = gate.run(f.a, async () => { entered(); await waiting; });
  await started;
  const closing = gate.close();
  assert.equal((await f.leases()).length, 1);
  release(); await work; await closing;
  assert.equal((await f.leases()).length, 0);
});

run('idle and unconfirmed Docmost jobs preserve their state without entering a busy tree', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  await gate.run(f.a, async () => {
    f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'active-parent' };
    f.taskData.set('active-parent', { status: 'running' }); await f.store.save(f.a);
  });
  const storeCalls = [];
  for (const method of ['load', 'loadMirrorHistory', 'save', 'acquire', 'assertLease', 'release']) {
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

run('archived unbound work fences a restarted process until its server task is terminal', async t => {
  const f = await fixture(t); const first = f.gate().result, replacement = f.gate().result;
  await first.run(f.a, async () => {
    f.a.mirror.pending = { ...f.a.mirror.pending, phase: 'indexing', taskId: 'unbound-task' };
    f.taskData.set('unbound-task', { status: 'running' }); await f.store.save(f.a);
  });
  await f.store.archiveMirror(f.a); await f.store.remove(aId); await first.close();
  let work = 0;
  await replacement.run(f.b, async () => { work++; });
  assert.equal(work, 0); assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
  f.taskData.get('unbound-task').status = 'completed';
  await replacement.run(f.b, async () => { work++; });
  assert.equal(work, 1);
  const history = await f.store.loadMirrorHistory();
  assert.equal(history.length, 1); assert.equal(history[0].value.active, false, 'fencing never schedules or deletes historical work');
});

run('unknown archived dispatches fence this root while other roots remain independent', async t => {
  for (const sameRoot of [true, false]) {
    const f = await fixture(t); const gate = f.gate().result;
    f.a.mirror.pending.phase = 'removing';
    if (!sameRoot) f.a.mirror.target.rootUri = `${rootUri}-other`;
    await f.store.archiveMirror(f.a); await f.store.remove(aId);
    let work = 0; await gate.run(f.b, async () => { work++; });
    assert.equal(work, sameRoot ? 0 : 1);
    if (sameRoot) assert.equal(f.b.mirror.errorCode, 'OV_TREE_BUSY');
  }
});

run('malformed mirror history cannot authorize dispatch into its namespace', async t => {
  const f = await fixture(t); const gate = f.gate().result;
  f.a.mirror.pending.privateBody = 'synthetic forbidden field';
  await f.store.archiveMirror(f.a); await f.store.remove(aId);
  let work = 0; await gate.run(f.b, async () => { work++; });
  assert.equal(work, 0); assert.equal(f.b.mirror.errorCode, 'OV_INVALID_STATE');
});
