import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadConnectionConfig } from '../src/config.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const base = { DOCMOST_URL: 'https://wiki.example.test', DOCMOST_AUTH_MODE: 'session' };
function record(origin = base.DOCMOST_URL, expiry = Math.floor(Date.now() / 1000) + 600) {
  const payload = { type: 'access', sub: userId, workspaceId, sessionId, exp: expiry };
  return { version: 1, origin, token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-signature`, userId, workspaceId, sessionId, expiresAt: expiry * 1000 };
}

test('connection bootstrap can log in without reading a credential or requiring default space', () => {
  const config = loadConnectionConfig({ ...base, DOCMOST_SESSION_FILE: '/not-created-yet/session.json' }, { requireDefaultSpace: false });
  assert.equal(config.origin, base.DOCMOST_URL);
  assert.equal(config.authMode, 'session');
  assert.equal(config.sessionFile, '/not-created-yet/session.json');
  assert.equal(config.token, undefined);
  assert.equal(config.defaultSpaceId, undefined);
});

test('authentication modes are explicit and credential sources cannot mix', () => {
  for (const env of [
    { ...base, DOCMOST_AUTH_MODE: 'automatic' },
    { ...base },
    { ...base, DOCMOST_SESSION_FILE: 'relative.json' },
    { ...base, DOCMOST_SESSION_FILE: '/tmp/session.json', DOCMOST_API_TOKEN: 'synthetic' },
    { ...base, DOCMOST_SESSION_FILE: '/tmp/session.json', DOCMOST_API_TOKEN_FILE: '/tmp/key' },
    { ...base, DOCMOST_AUTH_MODE: 'api_key', DOCMOST_SESSION_FILE: '/tmp/session.json' },
    { ...base, DOCMOST_SESSION_FILE: '/tmp/session.json', DOCMOST_PASSWORD: 'never-print-this' },
  ]) assert.throws(() => loadConnectionConfig(env, { requireDefaultSpace: false }), { code: 'CONFIG_ERROR' });
  const legacy = loadConnectionConfig({ DOCMOST_URL: base.DOCMOST_URL, DOCMOST_API_TOKEN: 'synthetic' }, { requireDefaultSpace: false });
  assert.equal(legacy.authMode, 'api_key');
});

test('session configuration loads only a private origin-bound personal session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docmost-session-config-'));
  const file = join(dir, 'session.json');
  try {
    const session = record();
    await writeFile(file, JSON.stringify(session), { mode: 0o600 });
    const env = { ...base, DOCMOST_SESSION_FILE: file, DOCMOST_DEFAULT_SPACE_ID: workspaceId };
    const config = await loadConfig(env);
    assert.equal(config.authMode, 'session');
    assert.equal(config.token, session.token);
    assert.deepEqual(config.session, session);
    await assert.rejects(loadConfig({ ...env, DOCMOST_URL: 'https://another.example.test' }));
    await writeFile(file, JSON.stringify(record(base.DOCMOST_URL, Math.floor(Date.now()/1000)-60)));
    await assert.rejects(loadConfig(env), { code: 'SESSION_EXPIRED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
