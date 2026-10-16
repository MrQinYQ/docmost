import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMirror } from '../src/mirror.mjs';

const adapterModule = await import('../src/knowledge-adapters/openviking.mjs').catch(() => undefined);
const documentModule = await import('../src/document-layout.mjs').catch(() => undefined);
const adapter = adapterModule?.openVikingAdapter;
const workspaceId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const pageId = '00000000-0000-4000-8000-000000000003';
const parentId = '00000000-0000-4000-8000-000000000004';
const origin = 'https://wiki.example.test';
const rootUri = 'viking://user/fixture-user/resources/docmost-mcp';
const connection = { origin: 'https://ov.example.test', rootUri };
const target = { origin: connection.origin, accountId: 'personal', userId: 'fixture-user', rootUri };
const revision = 'a'.repeat(64);
function binding(mirror) {
  return { bindingId: pageId, origin, workspaceId, spaceId, pageId, userId: parentId,
    state: 'synced', enabled: true, ...(mirror ? { mirror } : {}) };
}
async function post(path, body) {
  if (path === 'pages/info') return { id: body.pageId, workspaceId, spaceId,
    title: body.pageId === pageId ? 'Child' : 'Parent', parentPageId: body.pageId === pageId ? parentId : null };
  if (path === 'spaces/info') return { id: spaceId, workspaceId, name: 'Product Team' };
  assert.fail(`Unexpected read ${path}`);
}

test('OpenViking state marker is accepted while foreign provider state is rejected', () => {
  const legacy = { version: 1, state: 'waiting_docmost' };
  assert.doesNotThrow(() => validateMirror(legacy));
  assert.deepEqual(legacy, { version: 1, state: 'waiting_docmost' });
  assert.doesNotThrow(() => validateMirror({ ...legacy, provider: 'openviking' }));
  assert.throws(() => validateMirror({ ...legacy, provider: 'other' }), { code: 'OV_INVALID_STATE' });
});

test('document hierarchy is canonical metadata without any provider path', async () => {
  assert.equal(typeof documentModule?.resolveDocumentLayout, 'function');
  const layout = await documentModule.resolveDocumentLayout({ origin: 'https://WIKI.example.test:443/', workspaceId, pageId }, post);
  assert.deepEqual(layout, { originHash: 'cd82f7f07c4099e9', workspaceId, spaceId, spaceName: 'Product Team',
    title: 'Child', pageId, ancestors: [{ pageId: parentId, title: 'Parent' }], parentIds: [parentId] });
  assert.equal(documentModule.isDescendantLayout(layout, parentId), true);
  assert.equal(documentModule.isDescendantLayout({ ...layout, parentIds: [pageId] }, pageId), false);
});

test('adapter preserves physical layout and creates provider state without changing Docmost result', async () => {
  assert.equal(typeof adapter?.createRuntime, 'function');
  const runtime = adapter.createRuntime(connection, { config: { origin }, post,
    client: { async identity() { return target; } }, store: {}, persist: async () => {} });
  const record = binding();
  const { nodes, ...layout } = await runtime.resolveLayout(record);
  assert.equal(nodes.length, 3);
  assert.deepEqual(layout, {
    uri: `${rootUri}/Product-Team/Parent/Child/document.md`,
    pageDirectory: `${rootUri}/Product-Team/Parent/Child`,
    spaceId, pageId, title: 'Child', ancestors: [{ pageId: parentId, title: 'Parent' }], parentIds: [parentId],
  });
  runtime.block(record, 'configuration');
  assert.equal(record.state, 'synced');
  assert.equal(record.mirror.provider, 'openviking');
  assert.deepEqual(adapter.stateStatus(record), { state: 'blocked', error: { code: 'OV_CONFIG_ERROR', message: 'OpenViking is pending or paused; Docmost results remain independent.' } });
  assert.doesNotThrow(() => adapter.validateState(record.mirror));
  runtime.block(record, 'docmost_changed');
  assert.equal(record.mirror.errorCode, 'OV_DOCMOST_CHANGED');
  await runtime.tree.close();
});

test('adapter connection check reads only identity and returns a safe owned target', async () => {
  assert.equal(typeof adapter?.checkConnection, 'function');
  const controller = new AbortController();
  const client = { async identity(signal) { assert.equal(signal, controller.signal); return { ...target, role: 'admin', apiKey: 'secret', body: 'private' }; } };
  assert.deepEqual(await adapter.checkConnection(connection, { signal: controller.signal, client }), target);
  for (const invalid of [
    { ...target, userId: 'foreign' }, { ...target, accountId: '../unsafe' },
    { ...target, rootUri: 'viking://resources' },
  ]) await assert.rejects(adapter.checkConnection({ origin: connection.origin }, { client: { async identity() { return invalid; } } }), { code: 'OV_INVALID_RESPONSE' });
  await assert.rejects(adapter.checkConnection({ ...connection, userId: 'foreign' }, { signal: controller.signal, client }), { code: 'OV_IDENTITY_CHANGED' });
});

test('connection failures are redacted and cancellation cannot start authentication', async () => {
  assert.equal(typeof adapter?.checkConnection, 'function');
  await assert.rejects(adapter.checkConnection(connection, { client: { async identity() {
    throw Object.assign(new Error('private token secret source body'), { code: 'OV_NETWORK_ERROR' });
  } } }), error => error.code === 'OV_NETWORK_ERROR' && !error.message.includes('secret') && !error.message.includes('source'));
  const controller = new AbortController(); controller.abort();
  let authenticated = false;
  await assert.rejects(adapter.checkConnection(connection, { signal: controller.signal, client: { async identity() { authenticated = true; return target; } } }), { code: 'OV_CANCELLED' });
  assert.equal(authenticated, false);
});

test('foreign provider state cannot be overwritten or dispatch OpenViking work', async () => {
  assert.equal(typeof adapter?.createRuntime, 'function');
  let authenticated = false;
  const runtime = adapter.createRuntime(connection, { config: { origin }, post,
    client: { async identity() { authenticated = true; return target; } }, store: {}, persist: async () => {} });
  const record = binding({ version: 1, provider: 'other', state: 'pending', pending: { kind: 'body', phase: 'ready', hash: revision, revision } });
  const before = structuredClone(record);
  assert.throws(() => runtime.block(record, 'configuration'), { code: 'OV_INVALID_STATE' });
  await assert.rejects(runtime.mirror.process(record), { code: 'OV_INVALID_STATE' });
  assert.deepEqual(record, before);
  assert.equal(authenticated, false);
  await runtime.tree.close();
});

test('a legacy state gains its provider only after safe target ownership is confirmed', async () => {
  assert.equal(typeof adapter?.createRuntime, 'function');
  for (const identity of [target, { ...target, accountId: '../unsafe' }, { ...target, userId: '../unsafe' }]) {
    let reads = 0;
    const runtime = adapter.createRuntime(connection, { config: { origin },
      post: async () => { reads++; return {}; }, client: { async identity() { return identity; } },
      store: {}, persist: async () => {} });
    const record = binding({ version: 1, connectionOrigin: connection.origin, state: 'pending',
      pending: { kind: 'body', phase: 'ready', hash: revision, revision } });
    const before = structuredClone(record);
    assert.equal(runtime.mirror.initial(record).provider, undefined);
    before.mirror.destination = { scope: 'personal', rootUri: null };
    assert.deepEqual(record, before);
    await runtime.mirror.process(record);
    if (identity === target) {
      assert.equal(record.mirror.provider, 'openviking');
      assert.equal(reads, 1);
    } else {
      assert.equal(record.mirror.provider, undefined);
      assert.equal(reads, 0, 'an invalid owner cannot authorize even Docmost verification');
      assert.equal(record.mirror.errorCode, 'OV_TARGET_CHANGED');
    }
    await runtime.tree.close();
  }
});

test('a readonly runtime leaves legacy state untouched without identity or persistence calls', async () => {
  assert.equal(typeof adapter?.createRuntime, 'function');
  const unexpected = async () => assert.fail('Readonly state must not start a connection or persist');
  const runtime = adapter.createRuntime(connection, { config: { origin, readOnly: true }, post: unexpected,
    client: { identity: unexpected }, store: {}, persist: unexpected });
  const record = binding({ version: 1, connectionOrigin: connection.origin, state: 'pending',
    pending: { kind: 'body', phase: 'ready', hash: revision, revision } });
  const before = structuredClone(record);
  assert.equal(adapter.stateStatus(record).state, 'pending');
  await runtime.tree.run(record, unexpected);
  await runtime.mirror.process(record);
  assert.deepEqual(record, before);
  await runtime.tree.close();
});
