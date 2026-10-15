import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModule = await import('../src/openviking-config.mjs').catch(() => undefined);
const clientModule = await import('../src/openviking-client.mjs').catch(() => undefined);

test('optional OpenViking configuration and HTTP client are available', () => {
  assert.equal(typeof configModule?.loadOpenVikingConfig, 'function');
  assert.equal(typeof clientModule?.createOpenVikingClient, 'function');
});

const credential = 'synthetic-openviking-test-credential';
const root = 'viking://user/qinyequan/resources/docmost-mcp';
const uri = `${root}/deployment/workspace/page/document.md`;
const taskId = '00000000-0000-4000-8000-000000000009';
const env = {
  DOCMOST_OPENVIKING_URL: 'https://ov.example.test',
  DOCMOST_OPENVIKING_API_KEY_FILE: '/private/tmp/not-yet-created-openviking-key',
};
const ok = result => new Response(JSON.stringify({ status: 'ok', result }), { status: 200 });
const health = { status: 'ok', healthy: true, version: '0.4.19', account_id: 'personal', user_id: 'qinyequan', role: 'admin' };
const writeResult = {
  uri, root_uri: uri.slice(0, -'/document.md'.length), context_type: 'resource', mode: 'replace',
  written_bytes: 13, content_updated: true, semantic_status: 'skipped', vector_status: 'complete',
  queue_status: { Semantic: { error_count: 0, errors: [] }, Embedding: { error_count: 0, errors: [] } },
};
const run = (name, fn) => test(name, { skip: !configModule || !clientModule }, fn);

async function fixture(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'docmost-openviking-client-')));
  const apiKeyFile = join(dir, 'key');
  await writeFile(apiKeyFile, `${credential}\n`, { mode: 0o600 });
  const config = configModule.loadOpenVikingConfig({ ...env, DOCMOST_OPENVIKING_API_KEY_FILE: apiKeyFile });
  try { return await fn({ dir, apiKeyFile, config }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

run('missing deployment URL leaves optional connection disabled without inspecting any key', () => {
  assert.equal(configModule.loadOpenVikingConfig({}), undefined);
  assert.equal(configModule.loadOpenVikingConfig({ DOCMOST_OPENVIKING_API_KEY_FILE: '/not-read' }), undefined);
  assert.equal(configModule.loadOpenVikingConfig({ DOCMOST_OPENVIKING_URL: ' ' }), undefined);
});

run('configuration accepts HTTPS and loopback HTTP roots without requiring a local executable', () => {
  const config = configModule.loadOpenVikingConfig(env);
  assert.equal(config.origin, 'https://ov.example.test');
  assert.equal(config.apiBase, 'https://ov.example.test/api/v1/');
  assert.equal(config.apiKeyFile, env.DOCMOST_OPENVIKING_API_KEY_FILE);
  for (const url of ['http://127.0.0.1:1933', 'http://localhost:1933', 'http://[::1]:1933'])
    assert.equal(configModule.loadOpenVikingConfig({ ...env, DOCMOST_OPENVIKING_URL: url }).error, undefined);
});

run('invalid or incomplete optional configuration returns a safe error instead of blocking Docmost', () => {
  for (const changes of [
    { DOCMOST_OPENVIKING_URL: 'http://remote.example.test' },
    { DOCMOST_OPENVIKING_URL: 'https://secret:password@ov.example.test' },
    { DOCMOST_OPENVIKING_URL: 'https://ov.example.test/api/v1' },
    { DOCMOST_OPENVIKING_URL: 'https://ov.example.test/?token=secret' },
    { DOCMOST_OPENVIKING_URL: 'https://ov.example.test/#secret' },
    { DOCMOST_OPENVIKING_API_KEY_FILE: '' }, { DOCMOST_OPENVIKING_API_KEY_FILE: 'relative' },
    { DOCMOST_OPENVIKING_USER: '../user' }, { DOCMOST_OPENVIKING_ACCOUNT: 'account\nsecret' },
    { DOCMOST_OPENVIKING_ROOT_URI: 'viking://resources/shared' },
    { DOCMOST_OPENVIKING_ROOT_URI: 'viking://user/qinyequan/resources' },
    { DOCMOST_OPENVIKING_ROOT_URI: `${root}/../unmanaged` },
    { DOCMOST_OPENVIKING_TIMEOUT_MS: 'NaN' }, { DOCMOST_OPENVIKING_TIMEOUT_MS: '99' },
  ]) {
    const result = configModule.loadOpenVikingConfig({ ...env, ...changes });
    assert.equal(result.error.code, 'OV_CONFIG_ERROR');
    assert.ok(!JSON.stringify(result).includes('password'));
    assert.ok(!JSON.stringify(result).includes('token=secret'));
  }
});

run('client factory is synchronous and defers missing private key failures until first request', async () => {
  let calls = 0;
  const client = clientModule.createOpenVikingClient(configModule.loadOpenVikingConfig(env), {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(health)); },
  });
  assert.equal(typeof client.identity, 'function');
  await assert.rejects(client.identity(), { code: 'OV_CONFIG_ERROR', mayHaveSucceeded: false });
  assert.equal(calls, 0);
});

run('private key must be an owner-only regular file with no symlink components or header injection', async () => fixture(async ({ dir, apiKeyFile, config }) => {
  let calls = 0;
  const make = apiKeyFile => clientModule.createOpenVikingClient({ ...config, apiKeyFile }, { fetchImpl: async () => { calls++; return new Response(JSON.stringify(health)); } });
  await symlink(apiKeyFile, join(dir, 'link'));
  await assert.rejects(make(join(dir, 'link')).identity(), { code: 'OV_CONFIG_ERROR' });
  await symlink(dir, join(dir, 'parent-link'));
  await assert.rejects(make(join(dir, 'parent-link', 'key')).identity(), { code: 'OV_CONFIG_ERROR' });
  await writeFile(apiKeyFile, 'injected\r\nheader');
  await assert.rejects(make(apiKeyFile).identity(), { code: 'OV_CONFIG_ERROR' });
  await writeFile(apiKeyFile, credential);
  if (process.platform !== 'win32') {
    await chmod(apiKeyFile, 0o644);
    await assert.rejects(make(apiKeyFile).identity(), { code: 'OV_CONFIG_ERROR' });
  }
  assert.equal(calls, 0);
}));

run('authenticated health metadata confirms identity and derives a private resource root', async () => fixture(async ({ config }) => {
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(health));
  } });
  assert.deepEqual(await client.identity(), { accountId: 'personal', userId: 'qinyequan', role: 'admin', rootUri: root });
  assert.equal(requests[0].url, 'https://ov.example.test/health');
  assert.equal(requests[0].options.headers['X-API-Key'], credential);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
}));

run('health HTTP 200 cannot authenticate missing, wrong or ROOT identity', async () => fixture(async ({ config }) => {
  for (const identity of [
    { status: 'ok', healthy: true }, { ...health, role: 'root' }, { ...health, role: 'invalid' },
    { ...health, user_id: 'other' }, { ...health, account_id: 'other' }, { ...health, user_id: '../other' },
  ]) {
    const client = clientModule.createOpenVikingClient({ ...config, userId: 'qinyequan', accountId: 'personal' }, {
      fetchImpl: async () => new Response(JSON.stringify(identity)),
    });
    await assert.rejects(client.identity(), error => ['OV_INVALID_RESPONSE', 'OV_IDENTITY_CHANGED'].includes(error.code));
  }
  const client = clientModule.createOpenVikingClient({ ...config, rootUri: 'viking://user/other/resources/docmost-mcp' }, {
    fetchImpl: async () => new Response(JSON.stringify(health)),
  });
  await assert.rejects(client.identity(), { code: 'OV_IDENTITY_CHANGED' });
}));

run('raw reads preserve exact Markdown bytes and distinguish confirmed 404 from denied access', async () => fixture(async ({ config }) => {
  const source = '# 标题\r\n正文\n\n';
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok(source);
  } });
  assert.equal(await client.read(uri), source);
  assert.equal(requests[0].url.pathname, '/api/v1/content/read');
  assert.equal(requests[0].url.searchParams.get('uri'), uri);
  assert.equal(requests[0].url.searchParams.get('raw'), 'true');
  const missing = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: 'File not found', details: { resource: uri, type: 'file' } } }), { status: 404 }) });
  assert.equal(await missing.read(uri), undefined);
  const forbidden = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response('forbidden', { status: 403 }) });
  await assert.rejects(forbidden.read(uri), { code: 'OV_FORBIDDEN', mayHaveSucceeded: false });
}));

run('human-readable resource names retain spaces and Unicode instead of renaming into escaped folders', async () => fixture(async ({ config }) => {
  const namedUri = `${root}/文档空间/My Page--id/document.md`;
  const calls = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async url => {
    calls.push(new URL(url));
    return ok('source');
  } });
  assert.equal(await client.read(namedUri), 'source');
  assert.equal(calls[0].searchParams.get('uri'), namedUri);
  const namedRoot = configModule.loadOpenVikingConfig({ ...env, DOCMOST_OPENVIKING_ROOT_URI: `${root}/My Mirror` });
  assert.equal(namedRoot.error, undefined);
  assert.equal(namedRoot.rootUri, `${root}/My Mirror`);
}));

run('routing 404 and mismatched absence markers are not evidence that the resource is absent', async () => fixture(async ({ config }) => {
  for (const body of ['<h1>Not found</h1>', JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: 'Route not found' } }), JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', details: { resource: `${root}/other.md`, type: 'file' } } })]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(body, { status: 404 }) });
    await assert.rejects(client.read(uri), { code: 'OV_NOT_FOUND', mayHaveSucceeded: false });
  }
}));

run('content replacement stages exact source with waited vectors_only processing', async () => fixture(async ({ config }) => {
  const source = '第一行\r\n第二行\n';
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return ok({ ...writeResult, written_bytes: Buffer.byteLength(source) });
  } });
  const result = await client.write(uri, source);
  assert.equal(result.vectorStatus, 'complete');
  assert.equal(result.semanticStatus, 'skipped');
  assert.equal(result.writtenBytes, Buffer.byteLength(source));
  assert.equal(requests.length, 1, 'adapter does not start implicit semantic tasks');
  assert.equal(requests[0].url, 'https://ov.example.test/api/v1/content/write');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    uri, content: source, mode: 'replace', processing_mode: 'vectors_only', wait: true, timeout: 30,
  });
}));

run('HTTP success with failed or queued processing is not successful mirror completion', async () => fixture(async ({ config }) => {
  for (const [changes, code] of [
    [{ vector_status: 'failed' }, 'OV_PROCESSING_FAILED'],
    [{ semantic_status: 'failed' }, 'OV_PROCESSING_FAILED'],
    [{ vector_status: 'queued' }, 'OV_PROCESSING_PENDING'],
    [{ queue_status: { Embedding: { error_count: 1, errors: ['private error'] } } }, 'OV_PROCESSING_FAILED'],
    [{ content_updated: false }, 'OV_INVALID_RESPONSE'],
  ]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok({ ...writeResult, ...changes }) });
    await assert.rejects(client.write(uri, 'source'), { code, mayHaveSucceeded: true });
  }
}));

run('nonrecursive semantic reindex is explicitly trackable by task ID', async () => fixture(async ({ config }) => {
  const pageDirectory = uri.slice(0, -'/document.md'.length);
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return ok({ task_id: taskId, status: 'accepted', uri: pageDirectory, mode: 'semantic_and_vectors', object_type: 'resource' });
  } });
  assert.deepEqual(await client.reindex(pageDirectory, 'semantic_and_vectors'), { taskId });
  assert.equal(requests[0].url, 'https://ov.example.test/api/v1/content/reindex');
  assert.deepEqual(JSON.parse(requests[0].options.body), { uri: pageDirectory, mode: 'semantic_and_vectors', recursive: false, wait: false });
}));

run('completed task failures and warnings remain visible, and task lists are URI scoped', async () => fixture(async ({ config }) => {
  const pageDirectory = uri.slice(0, -'/document.md'.length);
  const snapshot = {
    task_id: taskId, task_type: 'admin_reindex', resource_id: pageDirectory, status: 'completed',
    result: { status: 'completed', uri: pageDirectory, failed_records: 2, unsupported_records: 1, warnings: ['Some entries failed.'] },
  };
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok(requests.length === 1 ? snapshot : [snapshot]);
  } });
  const task = await client.task(taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.failedRecords, 2);
  assert.equal(task.unsupportedRecords, 1);
  assert.deepEqual(task.warnings, ['Some entries failed.']);
  const tasks = await client.tasks(pageDirectory);
  assert.equal(tasks[0].failedRecords, 2);
  assert.equal(requests[1].url.searchParams.get('task_type'), 'admin_reindex');
  assert.equal(requests[1].url.searchParams.get('resource_id'), pageDirectory);
}));

run('delete is exact by default and directory recursion requires an explicit option', async () => fixture(async ({ config }) => {
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok({ uri: requests.at(-1).url.searchParams.get('uri'), estimated_deleted_count: 3, semantic_status: 'complete' });
  } });
  await client.remove(uri);
  await client.remove(uri.slice(0, -'/document.md'.length), { recursive: true });
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].url.pathname, '/api/v1/fs');
  assert.equal(requests[0].url.searchParams.get('uri'), uri);
  assert.equal(requests[0].url.searchParams.get('recursive'), 'false');
  assert.equal(requests[1].url.searchParams.get('recursive'), 'true');
  assert.equal(requests[0].url.searchParams.get('wait'), 'true');
}));

run('directory listing preserves hidden derived files needed for safe ownership checks', async () => fixture(async ({ config }) => {
  const entries = [{ name: '.abstract.md', uri: `${root}/.abstract.md`, isDir: false }, { name: 'child', uri: `${root}/child`, isDir: true }];
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url) => {
    requests.push(new URL(url));
    return ok(entries);
  } });
  assert.deepEqual(await client.list(root), entries);
  assert.equal(requests[0].pathname, '/api/v1/fs/ls');
  assert.equal(requests[0].searchParams.get('show_all_hidden'), 'true');
  assert.equal(requests[0].searchParams.get('output'), 'original');
  assert.equal(requests[0].searchParams.get('simple'), 'false');
}));

run('only an exact structured missing-directory marker makes listing return undefined', async () => fixture(async ({ config }) => {
  const marker = { status: 'error', error: { code: 'NOT_FOUND', details: { resource: root, type: 'file' } } };
  for (const type of ['file', 'directory']) {
    const payload = { ...marker, error: { ...marker.error, details: { resource: root, type } } };
    const missing = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(JSON.stringify(payload), { status: 404 }) });
    assert.equal(await missing.list(root), undefined);
    if (type === 'directory') await assert.rejects(missing.read(root), { code: 'OV_NOT_FOUND' });
  }
  for (const [status, body] of [[404, { detail: 'Not Found' }], [404, { ...marker, error: { ...marker.error, details: { resource: `${root}/other`, type: 'file' } } }], [400, marker], [403, marker]]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
    await assert.rejects(client.list(root));
  }
}));

run('truncated directory listings cannot be mistaken for complete ownership proof', async () => fixture(async ({ config }) => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `file-${i}`, uri: `${root}/file-${i}`, isDir: false }));
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok(entries) });
  await assert.rejects(client.list(root), { code: 'OV_RESPONSE_TOO_LARGE' });
}));

run('listing metadata must prove each direct child name, URI and directory type before cleanup', async () => fixture(async ({ config }) => {
  for (const entry of [{ name: '.abstract.md' }, { name: '.abstract.md', uri: `${root}/.abstract.md` }, { name: '.abstract.md', uri: `${root}/elsewhere/.abstract.md`, isDir: false }, { name: '../escape', uri: `${root}/../escape`, isDir: false }]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok([entry]) });
    await assert.rejects(client.list(root), { code: 'OV_INVALID_RESPONSE' });
  }
}));

run('completed reindex tasks require an explicit failure counter before completion can be trusted', async () => fixture(async ({ config }) => {
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok({ task_id: taskId, status: 'completed', resource_id: root, result: { status: 'completed', uri: root } }) });
  await assert.rejects(client.task(taskId), { code: 'OV_INVALID_RESPONSE' });
}));

run('only an exact terminal lock timeout error is classified as safe namespace contention', async () => fixture(async ({ config }) => {
  for (const [error, status, expected] of [
    ['lock acquire timed out after 0ms', 'failed', 'OV_TREE_BUSY'],
    ['lock acquire timed out after 1200ms', 'failed', 'OV_TREE_BUSY'],
    ['private-prefix lock acquire timed out after 0ms', 'failed', undefined],
    ['lock acquire timed out after 0ms; private suffix', 'failed', undefined],
    ['Model request failed', 'failed', undefined],
    ['lock acquire timed out after 0ms', 'running', undefined],
  ]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok({ task_id: taskId, status, error, resource_id: root, result: null }) });
    const result = await client.task(taskId);
    assert.equal(result.failureCode, expected);
    assert.ok(!JSON.stringify(result).includes(error));
  }
}));

run('upstream HTTP errors, redirects and network exceptions never reveal credentials or body errors', async () => fixture(async ({ config }) => {
  for (const [status, code] of [[401, 'OV_UNAUTHENTICATED'], [403, 'OV_FORBIDDEN'], [409, 'OV_CONFLICT'], [429, 'OV_RATE_LIMITED'], [500, 'OV_REQUEST_FAILED'], [302, 'OV_REDIRECT']]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(`private-upstream ${credential}`, { status }) });
    await assert.rejects(client.write(uri, 'source'), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(credential));
      assert.ok(!error.message.includes('private-upstream'));
      assert.equal(error.mayHaveSucceeded, status >= 500);
      return true;
    });
  }
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => { throw new Error(`private-upstream ${credential}`); } });
  await assert.rejects(client.write(uri, 'source'), { code: 'OV_NETWORK_ERROR', mayHaveSucceeded: true });
}));

run('API envelopes, task counters and resource content shapes are validated without exposing errors', async () => fixture(async ({ config }) => {
  for (const body of ['invalid-json', JSON.stringify({ status: 'error', error: { message: credential } }), JSON.stringify({ status: 'ok', result: { content: 'not a raw string' } })]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(body) });
    await assert.rejects(client.read(uri), error => {
      assert.ok(['OV_INVALID_RESPONSE', 'OV_REQUEST_FAILED'].includes(error.code));
      assert.ok(!error.message.includes(credential));
      return true;
    });
  }
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok({ task_id: taskId, status: 'completed', result: { failed_records: 'unknown' } }) });
  await assert.rejects(client.task(taskId), { code: 'OV_INVALID_RESPONSE' });
}));

run('response and source byte bounds prevent unbounded memory or oversized mirror operations', async () => fixture(async ({ config }) => {
  let calls = 0;
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => { calls++; return ok('x'.repeat(4 * 1024 * 1024)); } });
  await assert.rejects(client.read(uri), { code: 'OV_RESPONSE_TOO_LARGE' });
  await assert.rejects(client.write(uri, '汉'.repeat(400000)), { code: 'OV_INVALID_REQUEST', mayHaveSucceeded: false });
  assert.equal(calls, 1);
}));

run('cancellation and timeout preserve uncertain mutation state without hidden retries', async () => fixture(async ({ config }) => {
  let calls = 0;
  const controller = new AbortController();
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (_url, { signal }) => {
    calls++;
    controller.abort();
    signal.throwIfAborted();
  } });
  await assert.rejects(client.write(uri, 'source', controller.signal), { code: 'OV_CANCELLED', mayHaveSucceeded: true });
  assert.equal(calls, 1);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.write(uri, 'source', cancelled.signal), { code: 'OV_CANCELLED', mayHaveSucceeded: false });
  assert.equal(calls, 1);
  const timeoutClient = clientModule.createOpenVikingClient({ ...config, timeoutMs: 100 }, { fetchImpl: async (_url, { signal }) => {
    const keepAlive = setTimeout(() => {}, 1000);
    try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    finally { clearTimeout(keepAlive); }
  } });
  await assert.rejects(timeoutClient.write(uri, 'source'), { code: 'OV_TIMEOUT', mayHaveSucceeded: true });
}));

run('unsafe URI and task identifiers fail before sending any authenticated request', async () => fixture(async ({ config }) => {
  let calls = 0;
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => { calls++; return ok(''); } });
  for (const target of ['https://outside.test', `${root}/../other`, `${root}/%2e%2e/other`, `${root}/foo?key=x`, `${root}/foo\\bar`])
    await assert.rejects(client.read(target), { code: 'OV_INVALID_REQUEST', mayHaveSucceeded: false });
  await assert.rejects(client.task('../private'), { code: 'OV_INVALID_REQUEST' });
  assert.equal(calls, 0);
}));

run('waitProcessed is a bounded readonly all-queue barrier with safe historical counters', async () => fixture(async ({ config }) => {
  const requests = [];
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok({ Semantic: { processed: 8, requeue_count: 1, error_count: 2, errors: [{ message: 'synthetic private upstream detail' }] },
      Embedding: { processed: 6, requeue_count: 0, error_count: 0, errors: [] } });
  } });
  assert.equal(typeof client.waitProcessed, 'function');
  assert.deepEqual(await client.waitProcessed(), { Semantic: { processed: 8, requeueCount: 1, errorCount: 2 }, Embedding: { processed: 6, requeueCount: 0, errorCount: 0 } });
  assert.equal(requests[0].url.pathname, '/api/v1/system/wait'); assert.equal(requests[0].url.search, '');
  assert.equal(requests[0].options.method, 'POST');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(body), ['timeout']); assert.ok(body.timeout > 0 && body.timeout * 1000 < config.timeoutMs);
}));

run('only a structured server wait deadline becomes retryable processing pending without mutation uncertainty', async () => fixture(async ({ config }) => {
  for (const structured of [true, false]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => new Response(structured
      ? JSON.stringify({ status: 'error', error: { code: 'DEADLINE_EXCEEDED', message: 'synthetic private timeout detail', details: { operation: 'queue processing', timeout: 29 } } })
      : '<html>synthetic gateway timeout</html>', { status: 504 }) });
    assert.equal(typeof client.waitProcessed, 'function');
    await assert.rejects(client.waitProcessed(), error => {
      assert.equal(error.code, structured ? 'OV_PROCESSING_PENDING' : 'OV_REQUEST_FAILED');
      assert.equal(error.mayHaveSucceeded, false); assert.ok(!error.message.includes('private')); return true;
    });
  }
}));

run('waitProcessed validates queue counts and never reports a cancelled observation as an uncertain write', async () => fixture(async ({ config }) => {
  for (const result of [null, [], { Semantic: null }, { Semantic: { processed: -1, requeue_count: 0, error_count: 0, errors: [] } },
    { Semantic: { processed: 1, requeue_count: 0, error_count: '0', errors: [] } }]) {
    const client = clientModule.createOpenVikingClient(config, { fetchImpl: async () => ok(result) });
    assert.equal(typeof client.waitProcessed, 'function'); await assert.rejects(client.waitProcessed(), { code: 'OV_INVALID_RESPONSE', mayHaveSucceeded: false });
  }
  const controller = new AbortController();
  const client = clientModule.createOpenVikingClient(config, { fetchImpl: async (_url, options) => {
    controller.abort(); options.signal.throwIfAborted();
  } });
  await assert.rejects(client.waitProcessed(controller.signal), { code: 'OV_CANCELLED', mayHaveSucceeded: false });
}));
