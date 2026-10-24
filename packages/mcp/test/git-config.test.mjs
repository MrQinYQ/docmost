import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConnectionConfig } from '../src/config.mjs';

const env = { DOCMOST_URL: 'https://wiki.example.invalid', DOCMOST_DEFAULT_SPACE_ID: '00000000-0000-4000-8000-000000000001' };
test('Git publishing is opt-in, works without MD watching or a knowledge provider and shares private state', () => {
  assert.equal(loadConnectionConfig(env).gitRoot, undefined);
  for (const state of [{ DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/state' }, { DOCMOST_SYNC_STATE_DIR: '/private/tmp/state' }]) {
    const config = loadConnectionConfig({ ...env, ...state, DOCMOST_GIT_ROOT: '/private/tmp/repo', DOCMOST_KNOWLEDGE_PROVIDER: 'none' });
    assert.equal(config.gitRoot, '/private/tmp/repo'); assert.equal(config.syncRoot, undefined);
    assert.equal(config.syncStateDir, '/private/tmp/state'); assert.equal(config.knowledgeStateDir, '/private/tmp/state');
  }
});
test('Git roots and all private state directories are validated without weakening legacy MD pairing', () => {
  for (const override of [
    { DOCMOST_GIT_ROOT: 'repo', DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/state' },
    { DOCMOST_GIT_ROOT: '/private/tmp/repo' },
    { DOCMOST_GIT_ROOT: '/private/tmp/repo', DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/repo/state' },
    { DOCMOST_GIT_ROOT: '/private/tmp/repo', DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp' },
    { DOCMOST_GIT_ROOT: '/private/tmp/repo', DOCMOST_SYNC_STATE_DIR: '/private/tmp/state1', DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/state2' },
    { DOCMOST_SYNC_ROOT: '/private/tmp/source' },
    { DOCMOST_GIT_ROOT: '/private/tmp/repo', DOCMOST_SYNC_STATE_DIR: 'state', DOCMOST_KNOWLEDGE_STATE_DIR: resolve('state') },
  ]) assert.throws(() => loadConnectionConfig({ ...env, ...override }), { code: 'CONFIG_ERROR' });
});

test('service state is usable for project-context publishing with neither a Git nor Markdown root', () => {
  for (const key of ['DOCMOST_KNOWLEDGE_STATE_DIR', 'DOCMOST_SYNC_STATE_DIR']) {
    const config = loadConnectionConfig({ ...env, [key]: '/private/tmp/state', DOCMOST_KNOWLEDGE_PROVIDER: 'none' });
    assert.equal(config.gitRoot, undefined); assert.equal(config.syncRoot, undefined); assert.equal(config.syncStateDir, '/private/tmp/state');
  }
});
