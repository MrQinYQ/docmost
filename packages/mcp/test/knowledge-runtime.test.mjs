import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeSelection, knowledgeStatus, legacyKnowledgeStatus, validateKnowledgeState,
  createKnowledgeRuntime, checkKnowledgeConnection } from '../src/knowledge.mjs';

function fixture() {
  const calls = [];
  const adapter = { id: 'fixture', validateState(value) { assert.equal(value.provider, 'fixture'); },
    stateStatus(binding) { return { state: binding.mirror.state, uri: binding.mirror.uri }; },
    createRuntime(connection, context) {
      calls.push(['create', connection, context.post]);
      return { mirror: { initial(binding) { binding.mirror ??= { version: 1, provider: 'fixture', state: 'pending' }; return binding.mirror; },
        prepare() { calls.push(['prepare']); }, confirm() { calls.push(['confirm']); }, discard() { calls.push(['discard']); },
        canProcess() { return true; }, process() { calls.push(['process']); }, retry() { calls.push(['retry']); },
        deleteConfirmed() { calls.push(['delete']); } },
        tree: { run(binding, work) { return work(); }, close() {} },
        resolveLayout() { return { uri: 'fixture:document/owned-id' }; }, block() { calls.push(['block']); } };
    }, async checkConnection(connection) { calls.push(['check', connection]); return { origin: 'https://fixture.example' }; } };
  return { calls, adapters: { fixture: adapter }, config: { knowledgeBase: { provider: 'fixture', config: { endpoint: 'fixture' } } } };
}

test('a provider without OpenViking URIs creates and operates through the generic registry', async () => {
  const f = fixture(), post = () => {}, binding = {};
  const runtime = createKnowledgeRuntime(f.config, { adapters: f.adapters, post });
  runtime.mirror.initial(binding);
  await runtime.mirror.prepare(binding, { content: 'confirmed source' });
  await runtime.tree.run(binding, () => runtime.mirror.process(binding));
  assert.equal(runtime.id, 'fixture');
  assert.equal(runtime.resolveLayout(binding).uri, 'fixture:document/owned-id');
  assert.deepEqual(f.calls.map(x => x[0]), ['create', 'prepare', 'process']);
  assert.deepEqual(knowledgeStatus(binding, f.config, f.adapters), {
    provider: 'fixture', enabled: true, state: 'pending', uri: undefined,
  });
  assert.equal(legacyKnowledgeStatus(binding, f.adapters), undefined);
  validateKnowledgeState(binding.mirror, f.adapters);
});

test('switching a provider preserves old state and does not dispatch or mutate its pending work', async () => {
  const f = fixture();
  const binding = { mirror: { version: 1, provider: 'openviking', state: 'pending', pending: { phase: 'writing', hash: 'old' } } };
  const before = structuredClone(binding), runtime = createKnowledgeRuntime(f.config, { adapters: f.adapters });
  runtime.mirror.initial(binding);
  await runtime.mirror.prepare(binding, {}); runtime.mirror.confirm(binding, {});
  await runtime.mirror.discard(binding, 'old'); await runtime.mirror.process(binding);
  await runtime.mirror.deleteConfirmed(binding);
  assert.equal(runtime.mirror.canProcess(binding), false);
  assert.deepEqual(binding, before);
  assert.deepEqual(f.calls.map(x => x[0]), ['create']);
  const status = knowledgeStatus(binding, f.config, f.adapters);
  assert.equal(status.state, 'blocked'); assert.equal(status.error.code, 'KB_TARGET_CHANGED');
});

test('disabled and unsupported selections do not instantiate any adapter', async () => {
  const f = fixture();
  assert.equal(createKnowledgeRuntime({}, { adapters: f.adapters }), undefined);
  assert.equal(createKnowledgeRuntime({ knowledgeBase: { provider: 'unsupported', error: { code: 'KB_UNSUPPORTED_PROVIDER', message: 'Unavailable' } } }, { adapters: f.adapters }), undefined);
  assert.deepEqual(await checkKnowledgeConnection(undefined, { adapters: f.adapters }), { success: true, provider: 'none', state: 'disabled' });
  assert.deepEqual(f.calls, []);
});

test('legacy OpenViking config selects its adapter without changing its connection values', () => {
  const connection = { origin: 'https://existing.example' };
  assert.deepEqual(knowledgeSelection({ openViking: connection }), { provider: 'openviking', config: connection });
});

test('a standalone probe delegates to the chosen provider and contains no Docmost dependency', async () => {
  const f = fixture();
  assert.deepEqual(await checkKnowledgeConnection(f.config.knowledgeBase, { adapters: f.adapters }), {
    success: true, provider: 'fixture', state: 'ready', origin: 'https://fixture.example',
  });
  assert.deepEqual(f.calls.map(x => x[0]), ['check']);
});

test('stored states never silently fall back from an unknown provider', () => {
  assert.throws(() => validateKnowledgeState({ version: 1, provider: 'missing', state: 'pending' }), { code: 'KB_INVALID_STATE' });
});
