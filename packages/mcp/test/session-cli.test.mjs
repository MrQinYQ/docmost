import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSession } from '../src/session.mjs';

const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';

async function harness(t, status = 200) {
  const calls = [];
  const behavior = {};
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, bearer: req.headers.authorization });
    if (behavior.respond && await behavior.respond(req, res)) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    const data = req.url === '/api/users/me'
      ? { user: { id: userId, email: 'fixture@example.invalid' }, workspace: { id: workspaceId } }
      : req.url === '/api/spaces' ? { items: [{ id: workspaceId, name: 'Fixture' }] }
        : req.url === '/api/spaces/info' ? { id: workspaceId, name: 'Fixture' } : undefined;
    res.end(JSON.stringify({ success: true, status, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'docmost-session-cli-'));
  const file = join(dir, 'session.json');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ type: 'access', sub: userId, workspaceId, sessionId, exp })).toString('base64url')}.synthetic-signature`;
  await writeFile(file, JSON.stringify({ version: 1, origin, token, userId, workspaceId, sessionId, expiresAt: exp * 1000 }), { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { file, token, calls, behavior, env: { ...process.env, DOCMOST_AUTH_MODE: 'session', DOCMOST_URL: origin, DOCMOST_SESSION_FILE: file, DOCMOST_DEFAULT_SPACE_ID: workspaceId, DOCMOST_ALLOW_LOCAL_HTTP: '1', DOCMOST_API_TOKEN: '', DOCMOST_API_TOKEN_FILE: '' } };
}
function run(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit.')); }, 4000);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
}

test('session CLI checks identity/defaults and lists spaces without exposing credential', async t => {
  const h = await harness(t);
  for (const args of [['--check'], ['--list-spaces']]) {
    const result = await run(h.env, args);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes(h.token));
    assert.ok(!result.stderr.includes(h.token));
  }
  assert.ok(h.calls.every(call => call.bearer === `Bearer ${h.token}`));
});

test('password login requires a real local terminal and never posts supplied CLI secrets', async t => {
  const h = await harness(t);
  await rm(h.file);
  const result = await run(h.env, ['--login']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /INTERACTIVE_LOGIN_REQUIRED|terminal|TTY/);
  assert.equal(h.calls.length, 0);
  const argv = await run(h.env, ['--login', '--password', 'must-not-be-echoed']);
  assert.equal(argv.code, 1);
  assert.ok(!argv.stderr.includes('must-not-be-echoed'));
  assert.equal(h.calls.length, 0);
});

test('logout revokes only the dedicated session and removes its local file', async t => {
  const h = await harness(t);
  const result = await run(h.env, ['--logout']);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.serverRevoked, true);
  assert.equal(info.localRemoved, true);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/auth/logout']);
  await assert.rejects(access(h.file));
  assert.ok(!result.stdout.includes(h.token));
});

test('failed remote logout clears local credential but reports revocation uncertainty', async t => {
  const h = await harness(t, 500);
  const result = await run(h.env, ['--logout']);
  assert.equal(result.code, 1);
  const info = JSON.parse(result.stdout);
  assert.equal(info.serverRevoked, false);
  assert.equal(info.localRemoved, true);
  await assert.rejects(access(h.file));
  assert.ok(!result.stdout.includes(h.token));
  assert.ok(!result.stderr.includes(h.token));
});

test('a delayed CLI logout preserves a newer login after another logout already finished', async t => {
  const h = await harness(t);
  let started, release;
  const pending = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let count = 0;
  h.behavior.respond = async (req, res) => {
    if (req.url !== '/api/auth/logout') return false;
    if (++count === 1) { started(); await released; }
    res.writeHead(204); res.end(); return true;
  };
  const old = JSON.parse(await readFile(h.file, 'utf8'));
  const late = run(h.env, ['--logout']);
  await pending;
  assert.equal((await run(h.env, ['--logout'])).code, 0);
  const newId = '00000000-0000-4000-8000-000000000004';
  const pieces = old.token.split('.');
  const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
  pieces[1] = Buffer.from(JSON.stringify({ ...claims, sessionId: newId })).toString('base64url');
  await saveSession(h.file, { ...old, token: pieces.join('.'), sessionId: newId });
  release();
  const result = await late;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SESSION_CHANGED/);
  assert.equal(JSON.parse(await readFile(h.file, 'utf8')).sessionId, newId);
  assert.ok(h.calls.every(call => call.bearer === `Bearer ${h.token}`));
});

test('revoked session 401 tells the user to log in without attempting automatic authentication', async t => {
  const h = await harness(t, 401);
  const result = await run(h.env, ['--list-spaces']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNAUTHENTICATED.*--login/);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/spaces']);
});
