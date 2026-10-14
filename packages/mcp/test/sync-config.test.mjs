import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConnectionConfig } from '../src/config.mjs';
import { createApiClient } from '../src/api.mjs';

const env = {
  DOCMOST_URL: 'https://wiki.example.invalid',
  DOCMOST_DEFAULT_SPACE_ID: '00000000-0000-4000-8000-000000000001',
};
const token = 'synthetic-sync-contract-token';

test('MD synchronization is opt-in with separate absolute source and state directories', () => {
  assert.equal(loadConnectionConfig(env).syncRoot, undefined);
  const config = loadConnectionConfig({ ...env, DOCMOST_SYNC_ROOT: '/private/tmp/source', DOCMOST_SYNC_STATE_DIR: '/private/tmp/state' });
  assert.equal(config.syncRoot, '/private/tmp/source');
  assert.equal(config.syncStateDir, '/private/tmp/state');
  assert.equal(loadConnectionConfig({ ...env, DOCMOST_SYNC_ROOT: ' ', DOCMOST_SYNC_STATE_DIR: '' }).syncRoot, undefined);
  for (const overrides of [
    { DOCMOST_SYNC_ROOT: '/private/tmp/source' },
    { DOCMOST_SYNC_STATE_DIR: '/private/tmp/state' },
    { DOCMOST_SYNC_ROOT: 'source', DOCMOST_SYNC_STATE_DIR: '/private/tmp/state' },
    { DOCMOST_SYNC_ROOT: '/private/tmp/source', DOCMOST_SYNC_STATE_DIR: 'state' },
    { DOCMOST_SYNC_ROOT: '/private/tmp/source', DOCMOST_SYNC_STATE_DIR: '/private/tmp/source' },
    { DOCMOST_SYNC_ROOT: '/private/tmp/source', DOCMOST_SYNC_STATE_DIR: '/private/tmp/source/.state' },
    { DOCMOST_SYNC_ROOT: '/private/tmp/source', DOCMOST_SYNC_STATE_DIR: '/private/tmp' },
  ]) assert.throws(() => loadConnectionConfig({ ...env, ...overrides }), { code: 'CONFIG_ERROR' });
});

test('sync endpoints are fixed and a conditional conflict has a safe explicit code', async () => {
  const config = { ...loadConnectionConfig(env), token };
  let requests = 0;
  const api = createApiClient(config, async (url, options) => {
    requests++;
    assert.equal(new URL(url).pathname, '/api/pages/sync-update');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({ message: `Private conflict ${token}` }, { status: 409 });
  });
  await assert.rejects(api.post('pages/sync-update', { pageId: env.DOCMOST_DEFAULT_SPACE_ID, content: 'Changed', expectedRevision: 'a'.repeat(64) }, undefined, true), error => {
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.status, 409);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(requests, 1);
});

test('known missing sync routes report unsupported without treating resource 404s as capability absence', async () => {
  const config = { ...loadConnectionConfig(env), token };
  for (const path of ['pages/sync-state', 'pages/sync-update']) {
    for (const message of [`Cannot POST /api/${path}`, `Route POST:/api/${path} not found`, 'Page not found']) {
      let requests = 0;
      const api = createApiClient(config, async () => {
        requests++;
        return Response.json({ message, secretKey: token }, { status: 404 });
      });
      await assert.rejects(api.post(path, { pageId: env.DOCMOST_DEFAULT_SPACE_ID }), error => {
        assert.equal(error.code, message === 'Page not found' ? 'NOT_FOUND' : 'UNSUPPORTED_DEPLOYMENT');
        assert.equal(error.status, 404);
        assert.ok(!error.message.includes(token));
        return true;
      });
      assert.equal(requests, 1);
    }
  }
});
