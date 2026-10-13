import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createApiClient } from '../src/api.mjs';

const credential = 'synthetic-contract-credential';
const defaultSpaceId = '00000000-0000-4000-8000-000000000002';
const defaultParentPageId = '00000000-0000-4000-8000-000000000004';
const env = {
  DOCMOST_URL: 'https://wiki.example.test', DOCMOST_API_TOKEN: credential,
  DOCMOST_DEFAULT_SPACE_ID: defaultSpaceId,
};
const config = await loadConfig(env);

test('default space is a required UUID except during space discovery', async () => {
  assert.equal(config.defaultSpaceId, defaultSpaceId);
  const mixedCase = 'AAAAAAAA-0000-4000-8000-ABCDEF123456';
  assert.equal((await loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: mixedCase })).defaultSpaceId, mixedCase.toLowerCase());
  assert.equal((await loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: ` ${defaultSpaceId} ` })).defaultSpaceId, defaultSpaceId);
  for (const value of [undefined, '']) {
    await assert.rejects(loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: value }), { code: 'CONFIG_ERROR' });
    const discovery = await loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: value }, { requireDefaultSpace: false });
    assert.equal(discovery.defaultSpaceId, undefined);
  }
  for (const value of ['space-url-slug', '00000000-0000-4000-8000-00000000000x']) {
    for (const requireDefaultSpace of [true, false]) {
      await assert.rejects(loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: value }, { requireDefaultSpace }), { code: 'CONFIG_ERROR' });
    }
  }
});

test('default parent is an optional UUID and cannot exist without a default space', async () => {
  assert.equal(config.defaultParentPageId, undefined);
  assert.equal((await loadConfig({ ...env, DOCMOST_DEFAULT_PARENT_PAGE_ID: '' })).defaultParentPageId, undefined);
  assert.equal((await loadConfig({ ...env, DOCMOST_DEFAULT_PARENT_PAGE_ID: defaultParentPageId })).defaultParentPageId, defaultParentPageId);
  for (const requireDefaultSpace of [true, false]) {
    await assert.rejects(loadConfig({ ...env, DOCMOST_DEFAULT_PARENT_PAGE_ID: 'page-url-slug' }, { requireDefaultSpace }), { code: 'CONFIG_ERROR' });
  }
  await assert.rejects(loadConfig({ ...env, DOCMOST_DEFAULT_SPACE_ID: undefined, DOCMOST_DEFAULT_PARENT_PAGE_ID: defaultParentPageId }, { requireDefaultSpace: false }), { code: 'CONFIG_ERROR' });
});

test('configuration requires one credential and HTTPS deployment root', async () => {
  for (const overrides of [
    { DOCMOST_URL: '' }, { DOCMOST_API_TOKEN: '' },
    { DOCMOST_URL: 'http://wiki.example.test', DOCMOST_ALLOW_LOCAL_HTTP: '1' },
    { DOCMOST_URL: 'https://user:pass@wiki.example.test' },
    { DOCMOST_URL: 'https://wiki.example.test/api' },
    { DOCMOST_URL: 'https://wiki.example.test/?token=x' },
    { DOCMOST_URL: 'https://wiki.example.test/#secret' },
    { DOCMOST_API_TOKEN: 'header\r\ninjection' },
    { DOCMOST_API_TOKEN: 'quoted"token' },
    { DOCMOST_TIMEOUT_MS: 'NaN' }, { DOCMOST_TIMEOUT_MS: '99' },
    { DOCMOST_READ_ONLY: 'yes' },
  ]) await assert.rejects(loadConfig({ ...env, ...overrides }));
  await assert.rejects(loadConfig({ ...env, DOCMOST_API_TOKEN_FILE: '/not-read' }));
  const local = await loadConfig({ ...env, DOCMOST_URL: 'http://127.0.0.1:3000', DOCMOST_ALLOW_LOCAL_HTTP: '1' });
  assert.equal(local.apiBase, 'http://127.0.0.1:3000/api/');
  assert.equal(config.apiBase, 'https://wiki.example.test/api/');
});

test('JWT credential-kind check rejects session credentials without pretending to verify signatures', async () => {
  const jwt = type => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ type })).toString('base64url')}.synthetic-signature`;
  await assert.rejects(loadConfig({ ...env, DOCMOST_API_TOKEN: jwt('access') }));
  assert.equal((await loadConfig({ ...env, DOCMOST_API_TOKEN: jwt('api_key') })).token, jwt('api_key'));
});

test('private token file is read without accepting symlinks or permissive mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docmost-mcp-token-'));
  const file = join(dir, 'token');
  const fileEnv = { DOCMOST_URL: env.DOCMOST_URL, DOCMOST_API_TOKEN_FILE: file, DOCMOST_DEFAULT_SPACE_ID: defaultSpaceId };
  try {
    await writeFile(file, `${credential}\n`, { mode: 0o600 });
    assert.equal((await loadConfig(fileEnv)).token, credential);
    await symlink(file, join(dir, 'link'));
    await assert.rejects(loadConfig({ ...fileEnv, DOCMOST_API_TOKEN_FILE: join(dir, 'link') }));
    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      await assert.rejects(loadConfig(fileEnv));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('POST pins URL and Bearer, unwraps data and accepts empty delete success', async () => {
  const requests = [];
  const api = createApiClient(config, async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? Response.json({ data: { id: 'page-id' }, success: true, status: 200 })
      : new Response(null, { status: 204 });
  });
  assert.deepEqual(await api.post('pages/info', { pageId: 'page-id' }), { id: 'page-id' });
  assert.equal(await api.post('pages/delete', { pageId: 'page-id', permanentlyDelete: false }, undefined, true), undefined);
  assert.equal(requests[0].url, 'https://wiki.example.test/api/pages/info');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${credential}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { pageId: 'page-id' });
  await assert.rejects(api.post('https://evil.test', {}), { code: 'INVALID_PATH' });
});

test('401/403/429 and server failures return safe codes without upstream echo', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'REQUEST_FAILED']]) {
    const api = createApiClient(config, async () => new Response(`credential ${credential}`, { status }));
    await assert.rejects(api.post('pages/update', { pageId: 'p' }, undefined, true), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.mayHaveSucceeded, true);
      assert.ok(!error.message.includes(credential));
      return true;
    });
  }
});

test('attachment 404 classification requires a bounded JSON routing marker and never echoes error bodies', async () => {
  const marker = 'Cannot POST /api/search-attachments';
  const upstreamSecret = 'synthetic-upstream-error-secret';
  const cases = [
    new Response(`<html>${marker} ${credential} ${upstreamSecret}</html>`, { status: 404 }),
    Response.json({ message: `Resource missing ${credential} ${upstreamSecret}` }, { status: 404 }),
    Response.json([{ message: marker, secretKey: upstreamSecret }], { status: 404 }),
    new Response(JSON.stringify({ message: marker }), { status: 404, headers: { 'content-length': '16385' } }),
    Response.json({ message: marker, padding: 'x'.repeat(16384), secretKey: upstreamSecret }, { status: 404 }),
    Response.json({ message: marker, padding: '汉'.repeat(6000), secretKey: upstreamSecret }, { status: 404 }),
  ];
  for (const response of cases) {
    let requests = 0;
    const api = createApiClient(config, async () => { requests++; return response; });
    await assert.rejects(api.post('search-attachments', { query: 'fixture' }), error => {
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      assert.equal(error.mayHaveSucceeded, false);
      assert.ok(!error.message.includes(credential));
      assert.ok(!error.message.includes(upstreamSecret));
      assert.ok(!error.message.includes(marker));
      return true;
    });
    assert.equal(requests, 1, 'attachment errors are not retried');
  }
});

test('attachment 404 routing inspection stops and cancels the body when streaming bytes exceed its bound', async () => {
  const encode = value => new TextEncoder().encode(value);
  const chunks = [
    encode('{"message":"Cannot POST /api/search-attachments","padding":"' + 'x'.repeat(9000)),
    encode('x'.repeat(9000)),
    encode('","secretKey":"' + credential + '"}'),
  ];
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const api = createApiClient(config, async () => new Response(body, { status: 404 }));
  await assert.rejects(api.post('search-attachments', { query: 'fixture' }), error => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.status, 404);
    assert.ok(!error.message.includes(credential));
    return true;
  });
  assert.equal(cancelled, true, 'the API client cancels the excessive upstream body');
  assert.equal(pulls, 2, 'the API client stops before requesting more error content');
});

test('failed 404 response streams retain the known HTTP failure without echoing or retrying', async () => {
  for (const path of ['search-attachments', 'pages/info']) {
    let requests = 0;
    const api = createApiClient(config, async () => {
      requests++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(`Synthetic broken error body ${credential}`)); },
      }), { status: 404 });
    });
    await assert.rejects(api.post(path, path === 'search-attachments' ? { query: 'fixture' } : { pageId: 'missing-page-fixture' }), error => {
      assert.equal(error.code, 'NOT_FOUND', path);
      assert.equal(error.status, 404, path);
      assert.equal(error.mayHaveSucceeded, false, path);
      assert.ok(!error.message.includes(credential), path);
      assert.ok(!error.message.includes('Synthetic broken error body'), path);
      return true;
    });
    assert.equal(requests, 1, `${path} does not retry a failed response body`);
  }
});

test('attachment 404 routing inspection preserves timeout and client cancellation semantics', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (const code of ['TIMEOUT', 'CANCELLED']) {
      let requests = 0;
      let aborted = 0;
      const api = createApiClient({ ...config, timeoutMs: 100 }, async (_url, options) => {
        requests++;
        return new Response(new ReadableStream({
          start(controller) {
            options.signal.addEventListener('abort', () => {
              aborted++;
              controller.error(new Error(`Synthetic aborted error body ${credential}`));
            }, { once: true });
          },
        }), { status: 404 });
      });
      const controller = new AbortController();
      const request = api.post('search-attachments', { query: 'fixture' }, code === 'CANCELLED' ? controller.signal : undefined);
      if (code === 'CANCELLED') controller.abort(new Error(credential));
      await assert.rejects(request, error => {
        assert.equal(error.code, code);
        assert.equal(error.mayHaveSucceeded, false);
        assert.ok(!error.message.includes(credential));
        assert.ok(!error.message.includes('Synthetic aborted error body'));
        return true;
      });
      assert.equal(aborted, 1, `${code} aborts the response stream`);
      assert.equal(requests, 1, `${code} does not retry attachment search`);
    }
  } finally { clearTimeout(keepAlive); }
});

test('network errors are sanitized, mark uncertain writes, and never retry', async () => {
  let calls = 0;
  const api = createApiClient(config, async () => { calls++; throw new Error(`network ${credential}`); });
  await assert.rejects(api.post('pages/create', {}, undefined, true), error => error.code === 'NETWORK_ERROR' && error.mayHaveSucceeded && !error.message.includes(credential));
  assert.equal(calls, 1);
});

test('an expired personal session stops a running MCP before dispatching another request', async () => {
  let calls = 0;
  const api = createApiClient({ ...config, authMode: 'session', session: { expiresAt: Date.now() - 1 } }, async () => { calls++; return Response.json({ success: true, data: {} }); });
  await assert.rejects(api.post('pages/create', {}, undefined, true), { code: 'UNAUTHENTICATED', mayHaveSucceeded: false });
  assert.equal(calls, 0);
});

test('response bounds, malformed JSON, false success and credential echo are controlled', async () => {
  const tooLarge = createApiClient(config, async () => new Response('x', { headers: { 'content-length': '4194305' } }));
  await assert.rejects(tooLarge.post('pages/info', {}), { code: 'RESPONSE_TOO_LARGE' });
  const malformed = createApiClient(config, async () => new Response('<html>oops</html>'));
  await assert.rejects(malformed.post('pages/info', {}), { code: 'INVALID_RESPONSE' });
  const failed = createApiClient(config, async () => Response.json({ success: false, data: {} }));
  await assert.rejects(failed.post('pages/info', {}), { code: 'INVALID_RESPONSE' });
  const echoed = createApiClient(config, async () => Response.json({ data: { content: credential }, success: true }));
  assert.equal((await echoed.post('pages/info', {})).content, '[REDACTED]');
});

test('timeout and client cancellation abort the request without leaking error detail', async () => {
  const api = createApiClient({ ...config, timeoutMs: 100 }, async (_url, options) => {
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api.post('pages/update', {}, undefined, true), { code: 'TIMEOUT', mayHaveSucceeded: true });
    const controller = new AbortController();
    const request = api.post('pages/info', {}, controller.signal);
    controller.abort(new Error(credential));
    await assert.rejects(request, { code: 'CANCELLED' });
  } finally { clearTimeout(keepAlive); }
});
