import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const credential = 'synthetic-knowledge-probe-credential';
const privateDetail = 'synthetic-private-upstream-detail';
const health = {
  status: 'ok', healthy: true, version: '0.4.19', account_id: 'personal', user_id: 'fixture-user', role: 'user',
};

function environment(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DOCMOST_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(name))),
    ...overrides,
  };
}

function run(env, args = ['--check-knowledge'], nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Knowledge CLI did not exit.')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
}

function output(result, expectedCode) {
  assert.equal(result.code, expectedCode, result.stderr);
  assert.ok(!result.stdout.includes(credential));
  assert.ok(!result.stderr.includes(credential));
  assert.ok(!result.stdout.includes(privateDetail));
  assert.ok(!result.stderr.includes(privateDetail));
  assert.ok(result.stdout.trim(), 'The diagnostic must print its JSON result.');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'The diagnostic result must be one JSON record.');
  return JSON.parse(result.stdout);
}

function blocked(result, code) {
  const info = output(result, 1);
  assert.equal(info.success, false);
  assert.equal(info.state, 'blocked');
  assert.equal(info.error.code, code);
  assert.equal(typeof info.error.message, 'string');
  assert.match(info.provider, /^[a-z][a-z0-9_-]{0,63}$/);
  return info;
}

async function harness(t) {
  const calls = [];
  const behavior = { status: 200, body: health };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, key: req.headers['x-api-key'], authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
    res.end(typeof behavior.body === 'string' ? behavior.body : JSON.stringify(behavior.body));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'docmost-knowledge-cli-')));
  const keyFile = join(dir, 'api-key');
  await writeFile(keyFile, `${credential}\n`, { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return {
    calls, behavior, origin, dir, keyFile,
    env: environment({
      DOCMOST_KNOWLEDGE_PROVIDER: 'openviking',
      DOCMOST_OPENVIKING_URL: origin,
      DOCMOST_OPENVIKING_API_KEY_FILE: keyFile,
      DOCMOST_OPENVIKING_ACCOUNT: 'personal',
      DOCMOST_OPENVIKING_USER: 'fixture-user',
      DOCMOST_OPENVIKING_TIMEOUT_MS: '1000',
    }),
  };
}

test('knowledge diagnostic defaults to disabled without Docmost configuration', async () => {
  assert.deepEqual(output(await run(environment()), 0), { success: true, provider: 'none', state: 'disabled' });
});

test('explicit none ignores stale provider and Docmost credentials without file reads or HTTP', async t => {
  const h = await harness(t);
  const forbidden = [h.keyFile, join(h.dir, 'session.json'), join(h.dir, 'docmost-token')];
  const preload = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const forbidden = ${JSON.stringify(forbidden)};
    const guard = fn => function(path, ...args) {
      if (forbidden.includes(String(path))) { process.stderr.write('UNEXPECTED_CREDENTIAL_READ\\n'); throw new Error('Credential read forbidden.'); }
      return fn.call(this, path, ...args);
    };
    for (const name of ['open', 'readFile', 'lstat', 'stat']) fsp[name] = guard(fsp[name]);
    for (const name of ['openSync', 'readFileSync', 'lstatSync', 'statSync']) fs[name] = guard(fs[name]);
    syncBuiltinESMExports();
  `;
  const result = await run({
    ...h.env,
    DOCMOST_KNOWLEDGE_PROVIDER: 'none',
    DOCMOST_URL: 'invalid-docmost-url', DOCMOST_AUTH_MODE: 'invalid-auth-mode',
    DOCMOST_SESSION_FILE: forbidden[1], DOCMOST_API_TOKEN_FILE: forbidden[2],
  }, undefined, [`--import=data:text/javascript,${encodeURIComponent(preload)}`]);
  assert.deepEqual(output(result, 0), { success: true, provider: 'none', state: 'disabled' });
  assert.ok(!result.stderr.includes('UNEXPECTED_CREDENTIAL_READ'));
  assert.equal(h.calls.length, 0);
});

test('OpenViking diagnostic authenticates one readonly identity request independently of Docmost', async t => {
  const h = await harness(t);
  const result = await run({ ...h.env, DOCMOST_URL: 'not-a-docmost-url', DOCMOST_AUTH_MODE: 'not-an-auth-mode', DOCMOST_SESSION_FILE: '/not-read/session' });
  assert.deepEqual(output(result, 0), {
    success: true, provider: 'openviking', state: 'ready', origin: h.origin,
    accountId: 'personal', userId: 'fixture-user', rootUri: 'viking://user/fixture-user/resources/docmost-mcp',
  });
  assert.deepEqual(h.calls, [{ path: '/health', method: 'GET', key: credential, authorization: undefined, body: '' }]);
  assert.ok(!result.stdout.includes(h.keyFile));
});

test('legacy OpenViking environment remains diagnosable without the provider selector', async t => {
  const h = await harness(t);
  delete h.env.DOCMOST_KNOWLEDGE_PROVIDER;
  const info = output(await run(h.env), 0);
  assert.equal(info.provider, 'openviking');
  assert.equal(info.state, 'ready');
  assert.equal(h.calls.length, 1);
});

test('configured private root is reported only after matching authenticated identity', async t => {
  const h = await harness(t);
  const rootUri = 'viking://user/fixture-user/resources/team-mirror';
  assert.equal(output(await run({ ...h.env, DOCMOST_OPENVIKING_ROOT_URI: rootUri }), 0).rootUri, rootUri);
  blocked(await run({ ...h.env, DOCMOST_OPENVIKING_ACCOUNT: 'another-account' }), 'OV_IDENTITY_CHANGED');
  assert.equal(h.calls.length, 2);
});

test('explicit OpenViking without URL returns a structured blocked diagnostic', async () => {
  const info = blocked(await run(environment({ DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' })), 'OV_CONFIG_ERROR');
  assert.equal(info.provider, 'openviking');
});

test('invalid URL or key path blocks before contacting a service and does not expose URL credentials', async t => {
  const h = await harness(t);
  for (const overrides of [
    { DOCMOST_OPENVIKING_URL: 'https://private-login:private-password@knowledge.example.invalid' },
    { DOCMOST_OPENVIKING_URL: 'http://outside.example.invalid' },
    { DOCMOST_OPENVIKING_URL: `${h.origin}/api/v1` },
    { DOCMOST_OPENVIKING_URL: `${h.origin}/?token=private-password` },
    { DOCMOST_OPENVIKING_API_KEY_FILE: 'relative-key' },
    { DOCMOST_OPENVIKING_API_KEY_FILE: '' },
  ]) {
    const result = await run({ ...h.env, ...overrides });
    blocked(result, 'OV_CONFIG_ERROR');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('private-password'));
  }
  assert.equal(h.calls.length, 0);
});

test('missing, public, or symlinked key files fail before the authenticated request', async t => {
  const h = await harness(t);
  const link = join(h.dir, 'key-link');
  await symlink(h.keyFile, link);
  blocked(await run({ ...h.env, DOCMOST_OPENVIKING_API_KEY_FILE: link }), 'OV_CONFIG_ERROR');
  blocked(await run({ ...h.env, DOCMOST_OPENVIKING_API_KEY_FILE: join(h.dir, 'absent-key') }), 'OV_CONFIG_ERROR');
  if (process.platform !== 'win32') {
    await chmod(h.keyFile, 0o644);
    blocked(await run(h.env), 'OV_CONFIG_ERROR');
  }
  assert.equal(h.calls.length, 0);
});

test('unsupported provider is safely blocked even when legacy OpenViking credentials exist', async t => {
  const h = await harness(t);
  const provider = 'private-provider-secret\nhttps://secret-login:secret-password@outside.invalid';
  const result = await run({ ...h.env, DOCMOST_KNOWLEDGE_PROVIDER: provider });
  blocked(result, 'KB_UNSUPPORTED_PROVIDER');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('private-provider-secret'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-password'));
  assert.equal(h.calls.length, 0);
});

test('remote errors use known diagnostic codes without printing upstream bodies or credentials', async t => {
  const h = await harness(t);
  for (const [status, code] of [[401, 'OV_UNAUTHENTICATED'], [403, 'OV_FORBIDDEN'], [500, 'OV_REQUEST_FAILED']]) {
    h.behavior.status = status;
    h.behavior.body = { status: 'error', error: { code: privateDetail, message: `${privateDetail} ${credential}` } };
    blocked(await run(h.env), code);
  }
  assert.equal(h.calls.length, 3, 'Readonly diagnostics must not retry failed requests.');
});

test('malformed or unhealthy identity responses never become a ready diagnostic', async t => {
  const h = await harness(t);
  for (const body of [privateDetail, { ...health, healthy: false }, { ...health, user_id: privateDetail + '\nunsafe' }, { status: 'ok', result: health }]) {
    h.behavior.body = body;
    blocked(await run(h.env), 'OV_INVALID_RESPONSE');
  }
});

test('help explains provider selection and the independent knowledge diagnostic', async () => {
  const result = await run(environment(), ['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DOCMOST_KNOWLEDGE_PROVIDER/);
  assert.match(result.stdout, /none/);
  assert.match(result.stdout, /openviking/i);
  assert.match(result.stdout, /--check-knowledge/);
});
