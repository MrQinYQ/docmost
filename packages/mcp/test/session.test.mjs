import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, stat, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSessionToken, loadSession, saveSession, removeSession, loginSession, logoutSession } from '../src/session.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const otherId = '00000000-0000-4000-8000-000000000004';
const origin = 'https://wiki.example.test';
const config = { origin, apiBase: `${origin}/api/`, timeoutMs: 1000, authMode: 'session' };
const password = 'synthetic-password-for-test';
const email = 'synthetic@example.test';
const exp = Math.floor(Date.now() / 1000) + 3600;
function jwt(overrides = {}) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'access', sub: userId, workspaceId, sessionId, exp, ...overrides })).toString('base64url')}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}
function record(overrides = {}) {
  return { version: 1, origin, token: jwt(), userId, workspaceId, sessionId, expiresAt: exp * 1000, ...overrides };
}
async function privateFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'docmost-session-test-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'session.json');
}
function response(data, headers = {}, status = 200) {
  return Response.json({ success: true, data }, { status, headers });
}
function loginFetch({ cookie = `authToken=${jwt()}; Path=/; HttpOnly; Expires=${new Date(exp * 1000).toUTCString()}`, loginData, me = { user: { id: userId, workspaceId }, workspace: { id: workspaceId, enforceSso: false } }, sessions = [{ id: sessionId, isCurrentDevice: true }], onRequest = () => {} } = {}) {
  return async (url, options) => {
    onRequest(String(url), options);
    const path = new URL(url).pathname;
    if (path === '/api/auth/login') return response(loginData, { 'set-cookie': cookie });
    if (path === '/api/users/me') return response(me);
    if (path === '/api/sessions') return response({ sessions });
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    throw new Error('Unexpected request.');
  };
}
function safeError(error) {
  assert.ok(!error.message.includes(password));
  assert.ok(!error.message.includes(jwt()));
  assert.ok(!error.message.includes(email));
  return true;
}

test('JWT decode accepts only future revocable access claims without verifying signature', () => {
  assert.deepEqual(decodeSessionToken(jwt()), { userId, workspaceId, sessionId, expiresAt: exp * 1000 });
  for (const token of ['not-a-jwt', jwt({ type: 'api_key' }), jwt({ sub: 'not-uuid' }), jwt({ workspaceId: null }), jwt({ sessionId: undefined }), jwt({ exp: 'future' }), jwt({ exp: 1 }), jwt({ exp: Infinity })]) {
    assert.throws(() => decodeSessionToken(token), error => error.code?.startsWith('SESSION_') && safeError(error));
  }
  assert.equal(decodeSessionToken(jwt({ exp: 1 }), { allowExpired: true }).expiresAt, 1000);
});

test('old deployments without revocable session IDs report incompatibility rather than repeated-login advice', () => {
  assert.throws(() => decodeSessionToken(jwt({ sessionId: undefined })), error => {
    assert.equal(error.code, 'SESSION_NOT_REVOCABLE');
    assert.match(error.message, /sessionId|revocable/);
    assert.ok(!error.message.includes(jwt()));
    return true;
  });
});

test('private session save/load binds origin, JWT claims and expiry, and remove clears it', async t => {
  const file = await privateFile(t);
  await saveSession(file, record());
  assert.deepEqual(await loadSession(file, origin), record());
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(loadSession(file, 'https://other.example.test'), { code: 'SESSION_ORIGIN_MISMATCH' });
  await removeSession(file, origin);
  await assert.rejects(loadSession(file, origin), { code: 'SESSION_NOT_FOUND' });
});

test('store rejects active overwrite and preserves the original record', async t => {
  const file = await privateFile(t);
  await saveSession(file, record());
  await assert.rejects(saveSession(file, record({ token: jwt({ sessionId: otherId }), sessionId: otherId })), { code: 'SESSION_EXISTS' });
  assert.equal((await loadSession(file, origin)).sessionId, sessionId);
});

test('stale logout never deletes a replacement session published during its network request', async t => {
  const file = await privateFile(t);
  await saveSession(file, record());
  const outgoing = await loadSession(file, origin);
  await removeSession(file, origin);
  const replacement = record({ token: jwt({ sessionId: otherId }), sessionId: otherId });
  await saveSession(file, replacement);
  await assert.rejects(removeSession(file, origin, { expectedSessionId: outgoing.sessionId }), { code: 'SESSION_CHANGED' });
  assert.equal((await loadSession(file, origin)).sessionId, otherId);
});

test('save creates a private parent and only replaces expired records for the same origin', async t => {
  const file = await privateFile(t);
  const nested = join(file, '..', 'private', 'session.json');
  await saveSession(nested, record());
  if (process.platform !== 'win32') assert.equal((await stat(join(nested, '..'))).mode & 0o777, 0o700);
  await writeFile(file, JSON.stringify(record({ token: jwt({ exp: 1 }), expiresAt: 1000 })), { mode: 0o600 });
  await assert.rejects(loadSession(file, origin), { code: 'SESSION_EXPIRED' });
  await saveSession(file, record());
  assert.equal((await loadSession(file, origin)).expiresAt, exp * 1000);
  await removeSession(file, origin);
  await writeFile(file, JSON.stringify(record({ origin: 'https://other.example.test', token: jwt({ exp: 1 }), expiresAt: 1000 })), { mode: 0o600 });
  await assert.rejects(saveSession(file, record()), { code: 'SESSION_ORIGIN_MISMATCH' });
});

test('store rejects malformed records, metadata forgery, large files and non-private files', async t => {
  const file = await privateFile(t);
  for (const contents of ['invalid json', JSON.stringify(record({ userId: otherId })), JSON.stringify(record({ expiresAt: (exp + 1) * 1000 })), JSON.stringify(record({ version: 2 })), 'x'.repeat(65537)]) {
    await writeFile(file, contents, { mode: 0o600 });
    await assert.rejects(loadSession(file, origin), safeError);
    await assert.rejects(saveSession(file, record()), safeError);
  }
  await writeFile(file, JSON.stringify(record()), { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(loadSession(file, origin), { code: 'SESSION_FILE_UNSAFE' });
    await assert.rejects(saveSession(file, record()), { code: 'SESSION_FILE_UNSAFE' });
    await chmod(file, 0o600);
    await chmod(join(file, '..'), 0o755);
    await assert.rejects(saveSession(file, record()), { code: 'SESSION_FILE_UNSAFE' });
  }
});

test('store never follows a symlink leaf or a symlink parent', async t => {
  const file = await privateFile(t);
  await writeFile(file, JSON.stringify(record()), { mode: 0o600 });
  const link = join(file, '..', 'link');
  await symlink(file, link);
  for (const operation of [() => loadSession(link, origin), () => saveSession(link, record()), () => removeSession(link, origin)]) await assert.rejects(operation(), { code: 'SESSION_FILE_UNSAFE' });
  const parentLink = join(file, '..', 'parent-link');
  await symlink(join(file, '..'), parentLink);
  await assert.rejects(saveSession(join(parentLink, 'new.json'), record()), { code: 'SESSION_FILE_UNSAFE' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record());
});

test('parallel saves publish only one session and do not overwrite an active winner', async t => {
  const file = await privateFile(t);
  const second = record({ token: jwt({ sessionId: otherId }), sessionId: otherId });
  const results = await Promise.allSettled([saveSession(file, record()), saveSession(file, second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['SESSION_BUSY', 'SESSION_EXISTS'].includes(results.find(result => result.status === 'rejected').reason.code));
  assert.ok([sessionId, otherId].includes((await loadSession(file, origin)).sessionId));
  await writeFile(`${file}.lock`, 'other-process', { flag: 'wx', mode: 0o600 });
  await assert.rejects(saveSession(file, record()), { code: 'SESSION_BUSY' });
  assert.equal(await readFile(`${file}.lock`, 'utf8'), 'other-process');
});

test('remove accepts expired own record but preserves malformed and wrong-origin files', async t => {
  const file = await privateFile(t);
  await writeFile(file, JSON.stringify(record({ token: jwt({ exp: 1 }), expiresAt: 1000 })), { mode: 0o600 });
  await removeSession(file, origin);
  for (const contents of ['bad json', JSON.stringify(record({ origin: 'https://other.example.test' }))]) {
    await writeFile(file, contents, { mode: 0o600 });
    await assert.rejects(removeSession(file, origin));
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('login sends only credentials to fixed origin, verifies server identity/current session and bounds cookie expiry', async () => {
  const requests = [];
  const cookieExpiry = (exp - 100) * 1000;
  const result = await loginSession(config, { email, password }, loginFetch({ cookie: `authToken=${jwt()}; Expires=${new Date(cookieExpiry).toUTCString()}; HttpOnly`, onRequest: (url, options) => requests.push({ url, options }) }));
  assert.deepEqual(result, record({ expiresAt: cookieExpiry }));
  assert.deepEqual(requests.map(request => request.url), [`${origin}/api/auth/login`, `${origin}/api/users/me`, `${origin}/api/sessions`]);
  assert.deepEqual(JSON.parse(requests[0].options.body), { email, password });
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  for (const request of requests.slice(1)) {
    assert.equal(request.options.headers.Authorization, `Bearer ${jwt()}`);
    assert.deepEqual(JSON.parse(request.options.body), {});
    assert.ok(!request.options.body.includes(password));
  }
  assert.ok(!JSON.stringify(result).includes(password));
});

test('login uses separate Set-Cookie headers, never a comma-split or another cookie', async () => {
  const fetchImpl = loginFetch({ cookie: `authToken=${jwt()}; Expires=${new Date(exp * 1000).toUTCString()}` });
  const result = await loginSession(config, { email, password }, async (url, options) => {
    const output = await fetchImpl(url, options);
    if (new URL(url).pathname === '/api/auth/login') {
      output.headers.append('set-cookie', 'otherCookie=unrelated; Path=/');
    }
    return output;
  });
  assert.equal(result.token, jwt());
  for (const cookie of ['otherCookie=unrelated', `authToken=${jwt({ type: 'api_key' })}`, `authToken=${jwt()}; Expires=invalid`, `authToken=${jwt()}; Expires=${new Date(1000).toUTCString()}`, `authToken=${jwt()}; Max-Age=0`]) await assert.rejects(loginSession(config, { email, password }, loginFetch({ cookie })), safeError);
  await assert.rejects(loginSession(config, { email, password }, async () => {
    const output = response(undefined);
    output.headers.append('set-cookie', `authToken=${jwt()}`);
    output.headers.append('set-cookie', `authToken=${jwt()}`);
    return output;
  }), safeError);
});

test('login stops on MFA or enforced SSO without an auth downgrade', async () => {
  for (const loginData of [{ userHasMfa: true }, { requiresMfaSetup: true }, { isMfaEnforced: true }, { enforceSso: true }, { mfaRequired: true }]) {
    let calls = 0;
    await assert.rejects(loginSession(config, { email, password }, loginFetch({ loginData, onRequest: () => calls++ })), error => error.code === 'LOGIN_UNSUPPORTED' && safeError(error));
    assert.equal(calls, 1);
  }
  await assert.rejects(loginSession(config, { email, password }, loginFetch({ me: { user: { id: userId, workspaceId }, workspace: { id: workspaceId, enforceSso: true } } })), { code: 'LOGIN_UNSUPPORTED' });
});

test('login rejects unverified JWT, user/workspace mismatches and non-current sessions', async () => {
  for (const me of [{ user: { id: otherId, workspaceId }, workspace: { id: workspaceId } }, { user: { id: userId, workspaceId: otherId }, workspace: { id: workspaceId } }, { user: { id: userId, workspaceId }, workspace: { id: otherId } }, {}]) await assert.rejects(loginSession(config, { email, password }, loginFetch({ me })), { code: 'SESSION_IDENTITY_MISMATCH' });
  for (const sessions of [[], [{ id: otherId, isCurrentDevice: true }], [{ id: sessionId, isCurrentDevice: false }]]) await assert.rejects(loginSession(config, { email, password }, loginFetch({ sessions })), { code: 'SESSION_IDENTITY_MISMATCH' });
  await assert.rejects(loginSession(config, { email, password }, async (url, options) => new URL(url).pathname === '/api/auth/login' ? response(undefined, { 'set-cookie': `authToken=${jwt()}` }) : new Response(`${password} ${jwt()}`, { status: 401 })), safeError);
});

test('login bounds streamed response, rejects redirects and sanitizes network/server failures without retrying', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response(`${password} ${jwt()}`, { status: 401 }), 'LOGIN_FAILED'],
    [async () => new Response(`${password} ${jwt()}`, { status: 302, headers: { location: 'https://other.example.test' } }), 'LOGIN_FAILED'],
    [async () => { throw new Error(`${password} ${email} ${jwt()}`); }, 'NETWORK_ERROR'],
    [async () => new Response('x'.repeat(65537)), 'LOGIN_RESPONSE_TOO_LARGE'],
    [async () => new Response('x', { headers: { 'content-length': '65537' } }), 'LOGIN_RESPONSE_TOO_LARGE'],
    [async () => new Response(`${password} malformed`), 'LOGIN_INVALID_RESPONSE'],
  ]) {
    let calls = 0;
    await assert.rejects(loginSession(config, { email, password }, async (...args) => { calls++; return fetchImpl(...args); }), error => error.code === code && safeError(error));
    assert.equal(calls, 1);
  }
});

test('login timeout aborts the request and never leaks the abort reason', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(loginSession({ ...config, timeoutMs: 20 }, { email, password }, async (_url, options) => {
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(password)), { once: true }));
    }), error => error.code === 'TIMEOUT' && safeError(error));
  } finally { clearTimeout(keepAlive); }
});

test('logout revokes exactly the dedicated Bearer session and rejects expired/mismatched records', async () => {
  const requests = [];
  await logoutSession(config, record(), async (url, options) => { requests.push({ url: String(url), options }); return new Response(null, { status: 204 }); });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${origin}/api/auth/logout`);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${jwt()}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  await assert.rejects(logoutSession(config, record({ token: jwt({ exp: 1 }), expiresAt: 1000 })), { code: 'SESSION_EXPIRED' });
  await assert.rejects(logoutSession(config, record({ origin: 'https://other.example.test' })), { code: 'SESSION_ORIGIN_MISMATCH' });
  await assert.rejects(logoutSession(config, record(), async () => new Response(`${password} ${jwt()}`, { status: 500 })), safeError);
});

test('session publication rejects accidental credential fields and leaves no temporary files', async t => {
  const file = await privateFile(t);
  await assert.rejects(saveSession(file, record({ password })), { code: 'SESSION_INVALID' });
  await assert.rejects(loadSession(file, origin), { code: 'SESSION_NOT_FOUND' });
  await saveSession(file, record());
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(file, '..')), ['session.json']);
});

test('login refuses unpinned transport and invalid credentials before making any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected request.'); };
  for (const badConfig of [{ ...config, apiBase: 'https://other.example.test/api/' }, { ...config, origin: 'http://wiki.example.test', apiBase: 'http://wiki.example.test/api/' }, { ...config, origin: 'http://127.0.0.1:3000', apiBase: 'http://127.0.0.1:3000/api/' }, { ...config, origin: `${origin}/path` }]) await assert.rejects(loginSession(badConfig, { email, password }, fetchImpl), { code: 'CONFIG_ERROR' });
  for (const credentials of [{ email: '', password }, { email, password: '' }, { email, password: password.repeat(65536) }, { email: email.repeat(100), password }]) await assert.rejects(loginSession(config, credentials, fetchImpl), { code: 'LOGIN_INVALID_CREDENTIALS' });
  assert.equal(calls, 0);
  const localOrigin = 'http://127.0.0.1:3000';
  assert.equal((await loginSession({ ...config, origin: localOrigin, apiBase: `${localOrigin}/api/`, allowLocalHttp: true }, { email, password }, loginFetch())).origin, localOrigin);
});

test('a JWT with a malformed header is rejected before any identity request', async () => {
  const broken = `not-a-json-header.${jwt().split('.')[1]}.c3ludGhldGlj`;
  assert.throws(() => decodeSessionToken(broken), { code: 'SESSION_INVALID' });
});

test('session-check failure revokes the newly authenticated session only after identity was verified', async () => {
  let active = true;
  let failure;
  const requests = [];
  const fetchImpl = loginFetch({ sessions: [{ id: otherId, isCurrentDevice: true }] });
  await assert.rejects(loginSession(config, { email, password }, async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === '/api/auth/logout') {
      assert.equal(options.headers.Authorization, `Bearer ${jwt()}`);
      assert.deepEqual(JSON.parse(options.body), {});
      active = false;
    }
    return fetchImpl(url, options);
  }), error => { failure = error; return error.code === 'SESSION_IDENTITY_MISMATCH' && safeError(error); });
  assert.equal(active, false);
  assert.deepEqual(requests, ['/api/auth/login', '/api/users/me', '/api/sessions', '/api/auth/logout']);
  assert.match(failure.message, /was revoked/i);
  assert.match(failure.message, /not saved/i);
});

test('failed verification cleanup reports uncertainty and an unknown identity is never revoked', async () => {
  for (const verifiedIdentity of [true, false]) {
    let revocations = 0;
    let failure;
    const fetchImpl = loginFetch({ me: { user: { id: verifiedIdentity ? userId : otherId, workspaceId }, workspace: { id: workspaceId } }, sessions: [] });
    await assert.rejects(loginSession(config, { email, password }, async (url, options) => {
      if (new URL(url).pathname === '/api/auth/logout') {
        revocations++;
        return new Response(`${password} ${jwt()}`, { status: 500 });
      }
      return fetchImpl(url, options);
    }), error => { failure = error; return error.code === 'SESSION_IDENTITY_MISMATCH' && safeError(error); });
    assert.equal(revocations, verifiedIdentity ? 1 : 0);
    assert.match(failure.message, /not saved/i);
    assert.match(failure.message, /may remain/i);
    assert.match(failure.message, /Sessions/);
    assert.doesNotMatch(failure.message, /was revoked/i);
  }
});
