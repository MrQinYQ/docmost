import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConnectionConfig } from '../src/config.mjs';

const knowledge = await import('../src/knowledge-config.mjs').catch(() => undefined);
const base = {
  DOCMOST_OPENVIKING_URL: 'https://knowledge.example.invalid',
  DOCMOST_OPENVIKING_API_KEY_FILE: '/private/tmp/not-read-knowledge-api-key',
};
const docmost = {
  DOCMOST_URL: 'https://wiki.example.invalid',
  DOCMOST_DEFAULT_SPACE_ID: '00000000-0000-4000-8000-000000000001',
};
const run = (name, fn) => test(name, { skip: !knowledge }, fn);

test('optional knowledge configuration exposes a provider selection boundary', () => {
  assert.equal(typeof knowledge?.loadKnowledgeConfig, 'function');
});

run('omitted knowledge provider disables integration when there is no legacy deployment URL', () => {
  assert.equal(knowledge.loadKnowledgeConfig({}), undefined);
  assert.equal(knowledge.loadKnowledgeConfig({ DOCMOST_OPENVIKING_URL: ' ' }), undefined);
  assert.equal(knowledge.loadKnowledgeConfig({ DOCMOST_OPENVIKING_API_KEY_FILE: '/never-read-this-key' }), undefined);
});

run('explicit none exits before reading any OpenViking setting', () => {
  const env = { DOCMOST_KNOWLEDGE_PROVIDER: 'none' };
  for (const name of ['URL', 'API_KEY_FILE', 'ACCOUNT', 'USER', 'ROOT_URI', 'TIMEOUT_MS']) {
    Object.defineProperty(env, `DOCMOST_OPENVIKING_${name}`, {
      get() { assert.fail(`Disabled knowledge integration read ${name}.`); },
    });
  }
  assert.equal(knowledge.loadKnowledgeConfig(env), undefined);
});

run('explicit OpenViking and legacy URL inference preserve the established connection shape', () => {
  const expected = {
    provider: 'openviking',
    config: {
      origin: 'https://knowledge.example.invalid',
      apiBase: 'https://knowledge.example.invalid/api/v1/',
      timeoutMs: 30000,
      apiKeyFile: '/private/tmp/not-read-knowledge-api-key',
      accountId: 'personal',
      userId: 'fixture-user',
      rootUri: 'viking://user/fixture-user/resources/docmost-fixture',
    },
  };
  const env = {
    ...base,
    DOCMOST_OPENVIKING_ACCOUNT: 'personal',
    DOCMOST_OPENVIKING_USER: 'fixture-user',
    DOCMOST_OPENVIKING_ROOT_URI: 'viking://user/fixture-user/resources/docmost-fixture/',
  };
  assert.deepEqual(knowledge.loadKnowledgeConfig(env), expected);
  assert.deepEqual(knowledge.loadKnowledgeConfig({ ...env, DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' }), expected);
});

run('explicit OpenViking without a deployment URL remains configured but blocked', () => {
  const result = knowledge.loadKnowledgeConfig({ DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' });
  assert.equal(result.provider, 'openviking');
  assert.equal(result.config.error.code, 'OV_CONFIG_ERROR');
  assert.equal(typeof result.config.error.message, 'string');
});

run('invalid optional provider configuration stays isolated inside the descriptor', () => {
  for (const changes of [
    { DOCMOST_OPENVIKING_URL: 'https://private-user:private-password@knowledge.example.invalid' },
    { DOCMOST_OPENVIKING_URL: 'http://outside.example.invalid' },
    { DOCMOST_OPENVIKING_URL: 'https://knowledge.example.invalid/api/v1' },
    { DOCMOST_OPENVIKING_API_KEY_FILE: 'relative-key' },
    { DOCMOST_OPENVIKING_TIMEOUT_MS: '99' },
    { DOCMOST_OPENVIKING_USER: '../private-user' },
  ]) {
    const result = knowledge.loadKnowledgeConfig({ ...base, ...changes, DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' });
    assert.equal(result.provider, 'openviking');
    assert.equal(result.config.error.code, 'OV_CONFIG_ERROR');
    assert.ok(!JSON.stringify(result).includes('private-password'));
  }
});

run('unsupported providers never fall back to legacy OpenViking or echo arbitrary input', () => {
  for (const provider of ['vespa', 'private-credential\nhttps://secret-user:secret-password@outside.invalid']) {
    const result = knowledge.loadKnowledgeConfig({ ...base, DOCMOST_KNOWLEDGE_PROVIDER: provider });
    assert.equal(result.error.code, 'KB_UNSUPPORTED_PROVIDER');
    assert.equal(result.provider, 'unsupported');
    assert.equal(result.config, undefined);
    assert.ok(!JSON.stringify(result).includes('private-credential'));
    assert.ok(!JSON.stringify(result).includes('secret-password'));
  }
});

run('Docmost connection configuration exposes the selected optional descriptor without credential reads', () => {
  const config = loadConnectionConfig({ ...docmost, ...base, DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' });
  assert.equal(config.knowledgeBase.provider, 'openviking');
  assert.equal(config.knowledgeBase.config.origin, 'https://knowledge.example.invalid');
  assert.equal(config.knowledgeBase.config.apiKeyFile, base.DOCMOST_OPENVIKING_API_KEY_FILE);
  const disabled = loadConnectionConfig({ ...docmost, ...base, DOCMOST_KNOWLEDGE_PROVIDER: 'none' });
  assert.equal(disabled.knowledgeBase, undefined);
  assert.equal(disabled.openViking, undefined);
  const blocked = loadConnectionConfig({ ...docmost, DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' });
  assert.equal(blocked.knowledgeBase.config.error.code, 'OV_CONFIG_ERROR');
});
