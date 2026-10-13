import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// These are transport tests against a synthetic, local Docmost API. They never
// require a deployed Docmost instance or a real API token.
const ENTRY = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const TOKEN = 'synthetic-stdio-fixture-token-do-not-log';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const PAGE_ID = '00000000-0000-4000-8000-000000000003';
const PARENT_ID = '00000000-0000-4000-8000-000000000004';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-000000000005';
const OTHER_PARENT_ID = '00000000-0000-4000-8000-000000000006';
const READ_TOOLS = [
  'get_current_user', 'list_spaces', 'get_space', 'search_pages',
  'list_pages', 'get_page',
];
const WRITE_TOOLS = ['create_page', 'update_page', 'delete_page', 'restore_page'];
const PRIVATE_VALUES = [
  'fixture-password-hash', 'fixture-reset-secret', 'fixture-mfa-secret',
  'fixture-api-key-secret', 'fixture-license-secret',
];

function pagePayload(content = '# Fixture page') {
  return {
    id: PAGE_ID,
    slugId: 'fixture-page',
    title: 'Fixture page',
    spaceId: SPACE_ID,
    content,
    permissions: { read: true, write: true },
    space: { id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space' },
  };
}

function defaultPayload(path, body) {
  switch (path) {
    case '/api/users/me':
      return {
        user: {
          id: USER_ID,
          name: 'Fixture user',
          email: 'fixture@example.invalid',
          avatarUrl: null,
          role: 'admin',
          password: PRIVATE_VALUES[0],
          passwordHash: PRIVATE_VALUES[0],
          resetPasswordToken: PRIVATE_VALUES[1],
          mfaSecret: PRIVATE_VALUES[2],
          apiKey: PRIVATE_VALUES[3],
        },
        workspace: {
          id: SPACE_ID,
          name: 'Fixture workspace',
          hostname: 'fixture.example.invalid',
          licenseKey: PRIVATE_VALUES[4],
        },
      };
    case '/api/spaces':
      return { items: [{ id: SPACE_ID, name: 'Fixture space' }], meta: { hasNextPage: false } };
    case '/api/spaces/info':
      return { id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space' };
    case '/api/search':
      return { items: [pagePayload()], total: 1 };
    case '/api/pages/recent':
      return { items: [pagePayload()], meta: { hasNextPage: false } };
    case '/api/pages/info':
      return pagePayload(body.format === 'json' ? { type: 'doc', content: [] } : '# Fixture page');
    case '/api/pages/create':
    case '/api/pages/update':
    case '/api/pages/restore':
      return pagePayload();
    case '/api/pages/delete':
      return undefined;
    default:
      throw new Error(`Unexpected fixture route: ${path}`);
  }
}

async function startFixture() {
  const calls = [];
  const fixture = { calls, respond: null };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Invalid fixture JSON' }));
      return;
    }
    const call = { method: request.method, path: request.url, headers: request.headers, body };
    calls.push(call);
    if (fixture.respond) {
      const handled = await fixture.respond(call, response);
      if (handled) return;
    }
    try {
      const payload = defaultPayload(call.path, body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: payload, success: true, status: 200 }));
    } catch (error) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  fixture.url = `http://127.0.0.1:${server.address().port}`;
  fixture.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return fixture;
}

function startMcp(url, overrides = {}, args = []) {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: {
      ...process.env,
      DOCMOST_URL: url,
      DOCMOST_AUTH_MODE: 'api_key',
      DOCMOST_SESSION_FILE: undefined,
      DOCMOST_API_TOKEN: TOKEN,
      DOCMOST_API_TOKEN_FILE: undefined,
      DOCMOST_DEFAULT_SPACE_ID: SPACE_ID,
      DOCMOST_DEFAULT_PARENT_PAGE_ID: undefined,
      DOCMOST_ALLOW_LOCAL_HTTP: '1',
      DOCMOST_READ_ONLY: '0',
      DOCMOST_TIMEOUT_MS: '500',
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rpc = { child, stdout: '', stderr: '', invalidLines: [], messages: [] };
  let id = 0;
  let buffer = '';
  let closed = false;
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    if (buffer.trim()) rpc.invalidLines.push(buffer);
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP exited before responding (code ${code}, signal ${signal}): ${rpc.stderr}`));
    }
    pending.clear();
    resolve({ code, signal });
  }));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    rpc.stdout += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rpc.invalidLines.push(line);
        continue;
      }
      rpc.messages.push(message);
      if (message.jsonrpc !== '2.0') rpc.invalidLines.push(line);
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(message.id);
        request.resolve(message);
      }
    }
  });
  child.stderr.on('data', chunk => { rpc.stderr += chunk; });
  // A fixture process can exit during a negative startup test.
  child.stdin.on('error', () => {});
  rpc.request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error(`MCP already exited: ${rpc.stderr}`));
      return;
    }
    const requestId = ++id;
    rpc.lastRequestId = requestId;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out waiting for JSON-RPC ${method}: ${rpc.stderr}`));
    }, 3000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  rpc.notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  rpc.initialize = async () => {
    const reply = await rpc.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'docmost-stdio-fixture', version: '1.0.0' },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.protocolVersion, '2025-11-25');
    assert.ok(reply.result.capabilities.tools);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  rpc.call = (name, args = {}) => rpc.request('tools/call', { name, arguments: args });
  rpc.end = async (timeoutMs = 2000) => {
    child.stdin.end();
    let timer;
    try {
      return await Promise.race([
        exit,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP did not exit after stdin EOF')), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  rpc.cleanup = async () => {
    if (!closed) {
      try { await rpc.end(500); } catch { child.kill('SIGKILL'); await exit; }
    }
  };
  return rpc;
}

async function runCli(url, args, overrides = {}) {
  const rpc = startMcp(url, overrides, args);
  try {
    const outcome = await rpc.end();
    assert.ok(!rpc.stdout.includes(TOKEN), 'CLI stdout must not expose the API token');
    assert.ok(!rpc.stderr.includes(TOKEN), 'CLI stderr must not expose the API token');
    return { ...outcome, stdout: rpc.stdout, stderr: rpc.stderr };
  } finally { await rpc.cleanup(); }
}

function toolData(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
  if (reply.result.structuredContent) return reply.result.structuredContent;
  const text = reply.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(text);
}

function assertToolError(reply, pattern) {
  assert.ok(reply.error || reply.result?.isError === true, `Expected tool failure: ${JSON.stringify(reply)}`);
  if (pattern) assert.match(JSON.stringify(reply), pattern);
}

function assertCleanOutput(rpc) {
  assert.deepEqual(rpc.invalidLines, [], 'stdout must contain only complete JSON-RPC messages');
  assert.ok(rpc.messages.length > 0, 'the server emitted JSON-RPC responses');
  assert.ok(!rpc.stdout.includes(TOKEN), 'stdout must not expose the API token');
  assert.ok(!rpc.stderr.includes(TOKEN), 'stderr must not expose the API token');
}

async function harness(t, overrides = {}) {
  const fixture = await startFixture();
  const rpc = startMcp(fixture.url, overrides);
  t.after(async () => {
    await rpc.cleanup();
    await fixture.close();
    assertCleanOutput(rpc);
  });
  await rpc.initialize();
  return { fixture, rpc };
}

test('stdio initializes and advertises exactly ten strict tools', { timeout: 10000 }, async t => {
  const { rpc } = await harness(t);
  const reply = await rpc.request('tools/list');
  assert.equal(reply.error, undefined);
  const tools = reply.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects additional properties`);
    assert.equal(tool.inputSchema.properties.userId, undefined, `${tool.name} must not accept caller identity`);
  }
});

test('all tool calls use the authenticated Docmost API and delegate page content operations', { timeout: 15000 }, async t => {
  const { fixture, rpc } = await harness(t);
  const currentUser = toolData(await rpc.call('get_current_user'));
  assert.equal(currentUser.user.id, USER_ID);
  assert.equal(currentUser.workspace.hostname, 'fixture.example.invalid');
  assert.deepEqual(currentUser.defaults, { spaceId: SPACE_ID, parentPageId: null });
  for (const secret of PRIVATE_VALUES) assert.ok(!JSON.stringify(currentUser).includes(secret));

  toolData(await rpc.call('list_spaces', { query: 'Fixture', limit: 5, cursor: 'spaces-cursor' }));
  assert.equal(toolData(await rpc.call('get_space', { spaceId: SPACE_ID })).id, SPACE_ID);
  toolData(await rpc.call('search_pages', { query: 'needle', spaceId: SPACE_ID, titleOnly: true, limit: 7, offset: 2 }));
  toolData(await rpc.call('list_pages', { spaceId: SPACE_ID, limit: 8, cursor: 'pages-cursor' }));
  assert.equal(toolData(await rpc.call('get_page', { pageId: PAGE_ID, format: 'markdown' })).id, PAGE_ID);
  assert.equal(toolData(await rpc.call('get_page', { pageId: PAGE_ID, format: 'json' })).id, PAGE_ID);

  const markdown = '# New page\n\nMarkdown remains a string at the API boundary.';
  assert.equal(toolData(await rpc.call('create_page', {
    spaceId: SPACE_ID, parentPageId: PARENT_ID, title: 'Created', content: markdown,
  })).id, PAGE_ID);
  for (const operation of ['append', 'prepend', 'replace']) {
    assert.equal(toolData(await rpc.call('update_page', {
      pageId: PAGE_ID, content: '<p>HTML update</p>', format: 'html', operation,
    })).id, PAGE_ID);
  }
  assert.equal(toolData(await rpc.call('update_page', { pageId: PAGE_ID, title: 'Renamed' })).id, PAGE_ID);
  const deleted = toolData(await rpc.call('delete_page', { pageId: PAGE_ID }));
  assert.equal(deleted.success, true);
  assert.equal(deleted.pageId, PAGE_ID);
  assert.equal(toolData(await rpc.call('restore_page', { pageId: PAGE_ID })).id, PAGE_ID);

  for (const call of fixture.calls) {
    assert.equal(call.method, 'POST', call.path);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(call.headers['content-type'], /application\/json/);
    assert.equal(call.body.userId, undefined);
  }
  assert.deepEqual(fixture.calls.map(call => call.path), [
    '/api/users/me', '/api/spaces', '/api/spaces/info', '/api/search',
    '/api/pages/recent', '/api/pages/info', '/api/pages/info', '/api/pages/create',
    '/api/pages/update', '/api/pages/update', '/api/pages/update',
    '/api/pages/update', '/api/pages/delete', '/api/pages/restore',
  ]);
  assert.deepEqual(fixture.calls[0].body, {});
  assert.deepEqual(fixture.calls[1].body, { query: 'Fixture', limit: 5, cursor: 'spaces-cursor' });
  assert.deepEqual(fixture.calls[2].body, { spaceId: SPACE_ID });
  assert.deepEqual(fixture.calls[3].body, { query: 'needle', spaceId: SPACE_ID, titleOnly: true, limit: 7, offset: 2 });
  assert.deepEqual(fixture.calls[4].body, { spaceId: SPACE_ID, limit: 8, cursor: 'pages-cursor' });
  assert.deepEqual(fixture.calls[5].body, { pageId: PAGE_ID, format: 'markdown' });
  assert.deepEqual(fixture.calls[6].body, { pageId: PAGE_ID, format: 'json' });
  assert.deepEqual(fixture.calls[7].body, {
    spaceId: SPACE_ID, parentPageId: PARENT_ID, title: 'Created', content: markdown, format: 'markdown',
  });
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(fixture.calls[8 + index].body, {
      pageId: PAGE_ID, content: '<p>HTML update</p>', format: 'html',
      operation: ['append', 'prepend', 'replace'][index],
    });
  }
  assert.deepEqual(fixture.calls[11].body, { pageId: PAGE_ID, title: 'Renamed' });
  assert.deepEqual(fixture.calls[12].body, { pageId: PAGE_ID, permanentlyDelete: false });
  assert.deepEqual(fixture.calls[13].body, { pageId: PAGE_ID });
});

test('create page can omit its space and writes to the configured space root', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  assert.equal(toolData(await rpc.call('create_page', { title: 'Default destination', content: '# Default' })).id, PAGE_ID);
  assert.deepEqual(fixture.calls.map(call => call.body), [
    { spaceId: SPACE_ID, title: 'Default destination', content: '# Default', format: 'markdown' },
  ]);
});

test('equivalent UUID casing keeps the configured default parent in the same space', { timeout: 10000 }, async t => {
  const mixedCase = 'AAAAAAAA-0000-4000-8000-ABCDEF123456';
  const { fixture, rpc } = await harness(t, {
    DOCMOST_DEFAULT_SPACE_ID: mixedCase,
    DOCMOST_DEFAULT_PARENT_PAGE_ID: PARENT_ID,
  });
  toolData(await rpc.call('create_page', { spaceId: mixedCase.toLowerCase(), title: 'Same space' }));
  assert.deepEqual(fixture.calls.at(-1).body, {
    spaceId: mixedCase.toLowerCase(), parentPageId: PARENT_ID, title: 'Same space',
  });
  toolData(await rpc.call('create_page', { spaceId: mixedCase, title: 'Case alias' }));
  assert.deepEqual(fixture.calls.at(-1).body, {
    spaceId: mixedCase.toLowerCase(), parentPageId: PARENT_ID, title: 'Case alias',
  });
});

test('create page inherits default parent only in the default space and accepts explicit root or parent', { timeout: 15000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_DEFAULT_PARENT_PAGE_ID: PARENT_ID });
  const currentUser = toolData(await rpc.call('get_current_user'));
  assert.deepEqual(currentUser.defaults, { spaceId: SPACE_ID, parentPageId: PARENT_ID });
  const cases = [
    [{ title: 'Inherited parent' }, { spaceId: SPACE_ID, parentPageId: PARENT_ID, title: 'Inherited parent' }],
    [{ spaceId: SPACE_ID, title: 'Explicit default space' }, { spaceId: SPACE_ID, parentPageId: PARENT_ID, title: 'Explicit default space' }],
    [{ title: 'Root override', parentPageId: null }, { spaceId: SPACE_ID, title: 'Root override' }],
    [{ title: 'Parent override', parentPageId: OTHER_PARENT_ID }, { spaceId: SPACE_ID, parentPageId: OTHER_PARENT_ID, title: 'Parent override' }],
    [{ title: 'Parent slug override', parentPageId: 'chosen-parent-slug' }, { spaceId: SPACE_ID, parentPageId: 'chosen-parent-slug', title: 'Parent slug override' }],
    [{ spaceId: OTHER_SPACE_ID, title: 'Other space root' }, { spaceId: OTHER_SPACE_ID, title: 'Other space root' }],
    [{ spaceId: OTHER_SPACE_ID, parentPageId: null, title: 'Other space explicit root' }, { spaceId: OTHER_SPACE_ID, title: 'Other space explicit root' }],
    [{ spaceId: OTHER_SPACE_ID, parentPageId: OTHER_PARENT_ID, title: 'Other space parent' }, { spaceId: OTHER_SPACE_ID, parentPageId: OTHER_PARENT_ID, title: 'Other space parent' }],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toolData(await rpc.call('create_page', input)).id, PAGE_ID);
    assert.deepEqual(fixture.calls.at(-1).body, expected);
  }
  assert.equal(fixture.calls.length, cases.length + 1);
});

test('stdio refuses a missing default space before contacting Docmost', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const result = await runCli(fixture.url, [], { DOCMOST_DEFAULT_SPACE_ID: undefined });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CONFIG_ERROR.*DOCMOST_DEFAULT_SPACE_ID/);
  assert.deepEqual(fixture.calls, []);
});

test('CLI lists projected accessible spaces without a default space and forwards a discovery cursor', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.respond = (_call, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: {
      items: [{ id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space', apiKey: PRIVATE_VALUES[3] }],
      meta: { hasNextPage: true, nextCursor: 'next-spaces-cursor', apiKey: PRIVATE_VALUES[3] },
    }, success: true }));
    return true;
  };
  for (const args of [['--list-spaces'], ['--list-spaces', '--cursor', 'spaces-cursor']]) {
    const result = await runCli(fixture.url, args, { DOCMOST_DEFAULT_SPACE_ID: undefined });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const info = JSON.parse(result.stdout);
    assert.deepEqual(info.items, [{ id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space' }]);
    assert.deepEqual(info.meta, { hasNextPage: true, nextCursor: 'next-spaces-cursor' });
    for (const secret of PRIVATE_VALUES) assert.ok(!result.stdout.includes(secret));
  }
  assert.deepEqual(fixture.calls.map(call => ({ method: call.method, path: call.path, body: call.body })), [
    { method: 'POST', path: '/api/spaces', body: { limit: 100 } },
    { method: 'POST', path: '/api/spaces', body: { limit: 100, cursor: 'spaces-cursor' } },
  ]);
});

test('CLI check validates the default space and optional parent while returning safe identity metadata', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (const parent of [undefined, PAGE_ID]) {
    const before = fixture.calls.length;
    const result = await runCli(fixture.url, ['--check'], {
      DOCMOST_DEFAULT_PARENT_PAGE_ID: parent, DOCMOST_READ_ONLY: '1',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      success: true,
      user: { id: USER_ID, name: 'Fixture user', email: 'fixture@example.invalid', role: 'admin' },
      workspace: { id: SPACE_ID, name: 'Fixture workspace', hostname: 'fixture.example.invalid' },
      defaultSpace: { id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space' },
      defaultParentPage: parent ? { id: PAGE_ID, title: 'Fixture page', spaceId: SPACE_ID } : null,
      readOnly: true,
    });
    for (const secret of PRIVATE_VALUES) assert.ok(!result.stdout.includes(secret));
    assert.deepEqual(fixture.calls.slice(before).map(call => ({ path: call.path, body: call.body })), [
      { path: '/api/users/me', body: {} },
      { path: '/api/spaces/info', body: { spaceId: SPACE_ID } },
      ...(parent ? [{ path: '/api/pages/info', body: { pageId: PAGE_ID, format: 'json' } }] : []),
    ]);
  }
});

test('CLI rejects invalid discovery cursor arguments before contacting Docmost', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (const args of [
    ['--list-spaces', '--cursor'],
    ['--list-spaces', '--cursor', ''],
    ['--list-spaces', '--cursor', 'x'.repeat(4097)],
    ['--check', '--cursor', 'spaces-cursor'],
  ]) {
    const result = await runCli(fixture.url, args, { DOCMOST_DEFAULT_SPACE_ID: undefined });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CONFIG_ERROR/);
  }
  assert.deepEqual(fixture.calls, []);
});

test('CLI check rejects a missing default space and a parent from another space', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const missing = await runCli(fixture.url, ['--check'], { DOCMOST_DEFAULT_SPACE_ID: undefined });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /CONFIG_ERROR.*DOCMOST_DEFAULT_SPACE_ID/);
  assert.deepEqual(fixture.calls, []);
  fixture.respond = (call, response) => {
    if (call.path !== '/api/pages/info') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { ...pagePayload(), spaceId: OTHER_SPACE_ID }, success: true }));
    return true;
  };
  const mismatch = await runCli(fixture.url, ['--check'], { DOCMOST_DEFAULT_PARENT_PAGE_ID: PAGE_ID });
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.stdout, '');
  assert.match(mismatch.stderr, /parent.*space|space.*parent/i);
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/users/me', '/api/spaces/info', '/api/pages/info']);
});

test('CLI reports upstream failures without echoing tokens or account secrets', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.respond = (_call, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: `Forbidden fixture ${TOKEN} ${PRIVATE_VALUES[3]}` }));
    return true;
  };
  const result = await runCli(fixture.url, ['--list-spaces'], { DOCMOST_DEFAULT_SPACE_ID: undefined });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /FORBIDDEN|403/);
  assert.ok(!result.stderr.includes(PRIVATE_VALUES[3]));
  assert.equal(fixture.calls.length, 1, 'CLI authorization failures are not retried');
});

test('CLI check rejects a deleted default parent instead of reporting a usable destination', { timeout: 10000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  fixture.respond = (call, response) => {
    if (call.path !== '/api/pages/info') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { ...pagePayload(), deletedAt: '2026-10-12T00:00:00.000Z' }, success: true }));
    return true;
  };
  const result = await runCli(fixture.url, ['--check'], { DOCMOST_DEFAULT_PARENT_PAGE_ID: PAGE_ID });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /parent.*(deleted|trash)|(deleted|trash).*parent/i);
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/users/me', '/api/spaces/info', '/api/pages/info']);
});

test('tool defaults stay explicit at the upstream boundary', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  toolData(await rpc.call('list_spaces'));
  toolData(await rpc.call('search_pages', { query: 'needle' }));
  toolData(await rpc.call('list_pages'));
  toolData(await rpc.call('get_page', { pageId: PAGE_ID }));
  toolData(await rpc.call('update_page', { pageId: PAGE_ID, content: 'more', operation: 'append' }));
  assert.deepEqual(fixture.calls.map(call => call.body), [
    { limit: 20 }, { query: 'needle', limit: 20, offset: 0 }, { limit: 20 },
    { pageId: PAGE_ID, format: 'markdown' },
    { pageId: PAGE_ID, content: 'more', operation: 'append', format: 'markdown' },
  ]);
});

test('delete and restore require canonical UUID rather than URL slugId', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  for (const name of ['delete_page', 'restore_page']) {
    assertToolError(await rpc.call(name, { pageId: 'URLslugOnly' }));
  }
  assert.equal(fixture.calls.length, 0, 'invalid destructive IDs must never reach Docmost');
});

test('discovered restore tool discloses restoring every descendant including earlier deletions', { timeout: 10000 }, async t => {
  const { rpc } = await harness(t);
  const tools = (await rpc.request('tools/list')).result.tools;
  const restore = tools.find(tool => tool.name === 'restore_page');
  assert.match(restore.description, /ALL descendants/);
  assert.match(restore.description, /deleted before this document/);
  assert.match(restore.description, /authorization for the entire subtree/);
  assert.match(restore.description, /Does not restore previous shares/);
});

test('unknown tools and invalid arguments fail without making an HTTP request', { timeout: 15000 }, async t => {
  const { fixture, rpc } = await harness(t);
  const invalid = [
    ['not_a_docmost_tool', {}],
    ['get_current_user', { userId: USER_ID }],
    ['list_spaces', { userId: USER_ID }],
    ['get_space', { spaceId: SPACE_ID, userId: USER_ID }],
    ['search_pages', { query: 'needle', userId: USER_ID }],
    ['list_pages', { userId: USER_ID }],
    ['get_page', { pageId: PAGE_ID, userId: USER_ID }],
    ['get_page', { pageId: PAGE_ID, extra: true }],
    ['create_page', { spaceId: SPACE_ID, content: 'hello', userId: USER_ID }],
    ['create_page', { spaceId: SPACE_ID, content: '' }],
    ['create_page', { spaceId: SPACE_ID, content: { type: 'doc' } }],
    ['create_page', { spaceId: 'space-url-slug', title: 'Invalid space' }],
    ['create_page', { spaceId: null, title: 'Invalid space' }],
    ['create_page', { title: 'Invalid parent', parentPageId: '' }],
    ['update_page', { pageId: PAGE_ID, content: 'must not silently replace' }],
    ['update_page', { pageId: PAGE_ID }],
    ['update_page', { pageId: PAGE_ID, title: 'rename', operation: 'replace' }],
    ['update_page', { pageId: PAGE_ID, title: 'rename', format: 'html' }],
    ['update_page', { pageId: PAGE_ID, content: 'x', operation: 'delete' }],
    ['update_page', { pageId: PAGE_ID, content: 'x', operation: 'replace', format: 'json' }],
    ['delete_page', { pageId: PAGE_ID, permanentlyDelete: true }],
    ['delete_page', { pageId: PAGE_ID, permanentlyDelete: false }],
    ['delete_page', { pageId: PAGE_ID, userId: USER_ID }],
    ['restore_page', { pageId: PAGE_ID, userId: USER_ID }],
    ['list_spaces', { limit: 101 }],
    ['list_pages', { limit: 0 }],
    ['search_pages', { query: 'needle', offset: -1 }],
  ];
  for (const [name, args] of invalid) assertToolError(await rpc.call(name, args));
  assert.deepEqual(fixture.calls, []);
});

test('401 and 403 are surfaced as failures without retrying or exposing credentials', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  for (const status of [401, 403]) {
    fixture.respond = (_, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: `${status === 401 ? 'Unauthorized fixture' : 'Forbidden fixture'} ${TOKEN}` }));
      return true;
    };
    const before = fixture.calls.length;
    assertToolError(await rpc.call('get_current_user'), status === 401 ? /401|unauthorized/i : /403|forbidden/i);
    assert.equal(fixture.calls.length, before + 1, 'authorization failures are not retried');
  }
});

test('read-only mode advertises only six readers and rejects every write without HTTP', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_READ_ONLY: '1' });
  const tools = await rpc.request('tools/list');
  assert.equal(tools.error, undefined);
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), READ_TOOLS.toSorted());
  const writes = [
    ['create_page', { spaceId: SPACE_ID, title: 'Denied' }],
    ['update_page', { pageId: PAGE_ID, title: 'Denied' }],
    ['delete_page', { pageId: PAGE_ID }],
    ['restore_page', { pageId: PAGE_ID }],
  ];
  for (const [name, args] of writes) assertToolError(await rpc.call(name, args));
  assert.deepEqual(fixture.calls, []);
  assert.equal(toolData(await rpc.call('get_current_user')).user.id, USER_ID);
  assert.equal(fixture.calls.length, 1);
});

test('soft deletion also accepts a successful empty response body', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  fixture.respond = (_, response) => { response.writeHead(200); response.end(); return true; };
  const result = toolData(await rpc.call('delete_page', { pageId: PAGE_ID }));
  assert.equal(result.success, true);
  assert.equal(result.pageId, PAGE_ID);
  assert.deepEqual(fixture.calls[0].body, { pageId: PAGE_ID, permanentlyDelete: false });
});

test('redirects never forward credentials and are not followed or retried', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  fixture.respond = (_, response) => {
    response.writeHead(302, { location: `${fixture.url}/credential-trap` });
    response.end();
    return true;
  };
  assertToolError(await rpc.call('get_current_user'));
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].path, '/api/users/me');
});

test('upstream timeouts are bounded and writes are never retried', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_TIMEOUT_MS: '100' });
  fixture.respond = () => true; // Intentionally leave this request unanswered.
  const started = performance.now();
  assertToolError(await rpc.call('update_page', {
    pageId: PAGE_ID, content: 'timeout fixture', operation: 'append',
  }), /timeout|timed.out/i);
  assert.ok(performance.now() - started < 2000, 'the configured timeout bounds the tool call');
  assert.equal(fixture.calls.length, 1);
});

test('MCP request cancellation aborts the outstanding HTTP request before its timeout', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_TIMEOUT_MS: '2000' });
  let resolveSeen;
  let resolveAborted;
  const seen = new Promise(resolve => { resolveSeen = resolve; });
  const aborted = new Promise(resolve => { resolveAborted = resolve; });
  fixture.respond = (call, response) => {
    response.once('close', () => resolveAborted(!response.writableEnded));
    resolveSeen(call);
    return true;
  };
  // Cancellation can suppress the RPC response. Consume any eventual rejection
  // while separately checking the observable upstream cancellation.
  rpc.call('get_page', { pageId: PAGE_ID }).catch(() => {});
  const requestId = rpc.lastRequestId;
  let seenTimer;
  try {
    const call = await Promise.race([
      seen,
      new Promise((_, reject) => { seenTimer = setTimeout(() => reject(new Error('The cancellation fixture received no HTTP request')), 1000); }),
    ]);
    assert.equal(call.path, '/api/pages/info');
  } finally {
    clearTimeout(seenTimer);
  }
  rpc.notify('notifications/cancelled', { requestId, reason: 'Synthetic fixture cancellation' });
  let abortTimer;
  try {
    const wasAborted = await Promise.race([
      aborted,
      new Promise((_, reject) => { abortTimer = setTimeout(() => reject(new Error('MCP cancellation did not abort HTTP before the configured timeout')), 1000); }),
    ]);
    assert.equal(wasAborted, true);
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(fixture.calls.length, 1);
});

test('stdin EOF closes the stdio server within two seconds', { timeout: 10000 }, async t => {
  const { rpc } = await harness(t);
  const started = performance.now();
  const outcome = await rpc.end(2000);
  assert.ok(performance.now() - started < 2000);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.signal, null);
});
