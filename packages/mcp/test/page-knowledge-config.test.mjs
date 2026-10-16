import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConnectionConfig } from '../src/config.mjs';

const env = { DOCMOST_URL: 'https://wiki.example.invalid',
  DOCMOST_DEFAULT_SPACE_ID: '00000000-0000-4000-8000-000000000001',
  DOCMOST_KNOWLEDGE_PROVIDER: 'openviking', DOCMOST_OPENVIKING_URL: 'https://knowledge.example.invalid' };

test('page knowledge storage works without enabling local Markdown synchronization', () => {
  const config = loadConnectionConfig({ ...env, DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/page-knowledge' });
  assert.equal(config.syncRoot, undefined);
  assert.equal(config.knowledgeStateDir, '/private/tmp/page-knowledge');
  assert.equal(config.syncStateDir, '/private/tmp/page-knowledge');
});

test('page and Markdown mirrors share one ledger and reject ambiguous storage', () => {
  const config = loadConnectionConfig({ ...env, DOCMOST_SYNC_ROOT: '/private/tmp/markdown', DOCMOST_SYNC_STATE_DIR: '/private/tmp/ledger' });
  assert.equal(config.knowledgeStateDir, '/private/tmp/ledger');
  assert.throws(() => loadConnectionConfig({ ...env, DOCMOST_KNOWLEDGE_STATE_DIR: 'relative' }), { code: 'CONFIG_ERROR' });
  assert.throws(() => loadConnectionConfig({ ...env, DOCMOST_SYNC_ROOT: '/private/tmp/markdown',
    DOCMOST_SYNC_STATE_DIR: '/private/tmp/ledger', DOCMOST_KNOWLEDGE_STATE_DIR: '/private/tmp/other' }), { code: 'CONFIG_ERROR' });
});
