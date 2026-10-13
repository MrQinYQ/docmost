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
const COMMENT_ID = '00000000-0000-4000-8000-000000000007';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000008';
const CHILD_ID = '00000000-0000-4000-8000-000000000009';
const COPY_ID = '00000000-0000-4000-8000-00000000000a';
const READ_TOOLS = [
  'get_current_user', 'list_spaces', 'get_space', 'search_pages',
  'list_pages', 'get_page', 'list_child_pages', 'get_comments',
  'search_attachments', 'list_workspace_members',
];
const WRITE_TOOLS = [
  'create_page', 'update_page', 'delete_page', 'restore_page',
  'duplicate_page', 'copy_page_to_space', 'move_page', 'move_page_to_space',
  'create_space', 'update_space', 'create_comment', 'update_comment',
];
const PRIVATE_VALUES = [
  'fixture-password-hash', 'fixture-reset-secret', 'fixture-mfa-secret',
  'fixture-api-key-secret', 'fixture-license-secret',
  'fixture-secret-key',
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
      return { id: body.spaceId === OTHER_SPACE_ID ? OTHER_SPACE_ID : SPACE_ID, name: 'Fixture space', slug: 'fixture-space' };
    case '/api/spaces/create':
    case '/api/spaces/update':
      return { id: SPACE_ID, name: body.name ?? 'Fixture space', slug: body.slug ?? 'fixture-space', description: body.description };
    case '/api/search':
      return { items: [pagePayload()], total: 1 };
    case '/api/pages/recent':
      return { items: [pagePayload()], meta: { hasNextPage: false } };
    case '/api/pages/sidebar-pages':
      return { items: [{ ...pagePayload(), id: CHILD_ID, parentPageId: PAGE_ID }], meta: { hasNextPage: false } };
    case '/api/pages/info':
      return {
        ...pagePayload(body.format === 'json' ? { type: 'doc', content: [] } : '# Fixture page'),
        ...([PARENT_ID, 'chosen-parent-slug'].includes(body.pageId) ? { id: PARENT_ID } : {}),
        ...(body.pageId === OTHER_PARENT_ID ? { id: OTHER_PARENT_ID, spaceId: OTHER_SPACE_ID, space: { id: OTHER_SPACE_ID, name: 'Other fixture space', slug: 'other-fixture-space' } } : {}),
      };
    case '/api/pages/create':
    case '/api/pages/update':
    case '/api/pages/restore':
      return pagePayload();
    case '/api/pages/duplicate':
      return { ...pagePayload(), id: COPY_ID, childPageIds: [CHILD_ID] };
    case '/api/pages/delete':
    case '/api/pages/move':
    case '/api/pages/move-to-space':
      return undefined;
    case '/api/comments':
      return { items: [{ id: COMMENT_ID, pageId: PAGE_ID, content: { type: 'doc', content: [] }, creator: { id: USER_ID, name: 'Fixture user' } }], meta: { hasNextPage: false } };
    case '/api/comments/create':
    case '/api/comments/update':
      return { id: COMMENT_ID, pageId: body.pageId ?? PAGE_ID, content: JSON.parse(body.content), parentCommentId: body.parentCommentId, creator: { id: USER_ID, name: 'Fixture user' } };
    case '/api/search-attachments':
      return { items: [{ id: ATTACHMENT_ID, fileName: 'fixture.txt', pageId: PAGE_ID, creatorId: USER_ID }], total: 1 };
    case '/api/workspace/members':
      return { items: [{ id: USER_ID, name: 'Fixture user', email: 'fixture@example.invalid', role: 'member', avatarUrl: null }], meta: { hasNextPage: false } };
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

test('stdio initializes and advertises twenty official tools plus recoverable delete and restore', { timeout: 10000 }, async t => {
  const { rpc } = await harness(t);
  const reply = await rpc.request('tools/list');
  assert.equal(reply.error, undefined);
  const tools = reply.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects additional properties`);
    assert.equal(tool.inputSchema.properties.userId, undefined, `${tool.name} must not accept caller identity`);
    assert.equal(tool.annotations.readOnlyHint, READ_TOOLS.includes(tool.name), tool.name);
    if (['move_page', 'move_page_to_space'].includes(tool.name)) assert.equal(tool.annotations.destructiveHint, true, tool.name);
    if (['duplicate_page', 'copy_page_to_space'].includes(tool.name)) assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});

test('new official tools use authenticated routes and explicit move and copy destinations', { timeout: 15000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_DEFAULT_PARENT_PAGE_ID: OTHER_PARENT_ID });
  const cases = [
    ['duplicate_page', { pageId: 'fixture-page-slug' }, '/api/pages/duplicate', { pageId: 'fixture-page-slug' }],
    ['copy_page_to_space', { pageId: 'fixture-page-slug', spaceId: OTHER_SPACE_ID }, '/api/pages/duplicate', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['move_page', { pageId: 'fixture-page-slug', parentPageId: null, position: 'a0000' }, '/api/pages/move', { pageId: PAGE_ID, parentPageId: null, position: 'a0000' }],
    ['move_page', { pageId: PAGE_ID, parentPageId: 'chosen-parent-slug', position: 'a00000000000' }, '/api/pages/move', { pageId: PAGE_ID, parentPageId: PARENT_ID, position: 'a00000000000' }],
    ['move_page_to_space', { pageId: 'fixture-page-slug', spaceId: OTHER_SPACE_ID }, '/api/pages/move-to-space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['create_space', { name: '  Created space  ', slug: 'created_space-2', description: 'A fixture space' }, '/api/spaces/create', { name: 'Created space', slug: 'created_space-2', description: 'A fixture space' }],
    ['update_space', { spaceId: SPACE_ID, name: '  Renamed space  ' }, '/api/spaces/update', { spaceId: SPACE_ID, name: 'Renamed space' }],
    ['update_space', { spaceId: SPACE_ID, description: '' }, '/api/spaces/update', { spaceId: SPACE_ID, description: '' }],
    ['get_comments', { pageId: PAGE_ID, limit: 5, cursor: 'comment-cursor' }, '/api/comments', { pageId: PAGE_ID, limit: 5, cursor: 'comment-cursor' }],
    ['search_attachments', { query: '  needle  ', spaceId: SPACE_ID, creatorId: USER_ID, limit: 7, offset: 2 }, '/api/search-attachments', { query: 'needle', spaceId: SPACE_ID, creatorId: USER_ID, limit: 7, offset: 2 }],
    ['list_workspace_members', { query: 'Fixture', limit: 8, cursor: 'member-cursor' }, '/api/workspace/members', { query: 'Fixture', limit: 8, cursor: 'member-cursor' }],
  ];
  for (const [name, input, path, expected] of cases) {
    const before = fixture.calls.length;
    const result = toolData(await rpc.call(name, input));
    const preflight = name === 'move_page' ? [
      { path: '/api/pages/info', body: { pageId: input.pageId } },
      ...(input.parentPageId ? [{ path: '/api/pages/info', body: { pageId: input.parentPageId } }] : []),
    ] : ['copy_page_to_space', 'move_page_to_space'].includes(name) ? [
      { path: '/api/pages/info', body: { pageId: input.pageId } },
      { path: '/api/spaces/info', body: { spaceId: OTHER_SPACE_ID } },
    ] : [];
    assert.deepEqual(fixture.calls.slice(before).map(call => ({ path: call.path, body: call.body })), [...preflight, { path, body: expected }], name);
    const call = fixture.calls.at(-1);
    assert.equal(call.method, 'POST', name);
    assert.equal(call.path, path, name);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`, name);
    assert.match(call.headers['content-type'], /application\/json/, name);
    assert.deepEqual(call.body, expected, name);
    if (name.startsWith('move_page')) {
      assert.equal(result.success, true, name);
      assert.equal(result.pageId, PAGE_ID, name);
    }
    if (['duplicate_page', 'copy_page_to_space'].includes(name)) {
      assert.equal(result.id, COPY_ID, name);
      assert.deepEqual(result.childPageIds, [CHILD_ID], name);
    }
  }
  for (const call of fixture.calls) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`, call.path);
});

test('child page listing resolves a parent slug to its canonical page and space and preserves pagination', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  fixture.respond = (call, response) => {
    if (call.path !== '/api/pages/sidebar-pages') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: {
      items: [{ ...pagePayload(), id: CHILD_ID, parentPageId: PAGE_ID, hasChildren: true, isBase: false, secretKey: PRIVATE_VALUES[5] }],
      meta: { limit: 3, hasNextPage: true, hasPrevPage: false, nextCursor: 'next-child-cursor', secretKey: PRIVATE_VALUES[5] },
    }, success: true }));
    return true;
  };
  const result = toolData(await rpc.call('list_child_pages', { pageId: 'parent-page-slug', limit: 3, cursor: 'child-cursor' }));
  assert.deepEqual(fixture.calls.map(call => ({ path: call.path, body: call.body })), [
    { path: '/api/pages/info', body: { pageId: 'parent-page-slug' } },
    { path: '/api/pages/sidebar-pages', body: { pageId: PAGE_ID, spaceId: SPACE_ID, limit: 3, cursor: 'child-cursor' } },
  ]);
  assert.deepEqual(result.items, [{ ...pagePayload(), id: CHILD_ID, parentPageId: PAGE_ID, hasChildren: true, isBase: false }]);
  assert.deepEqual(result.meta, { limit: 3, hasNextPage: true, hasPrevPage: false, nextCursor: 'next-child-cursor' });
  assert.ok(!JSON.stringify(result).includes(PRIVATE_VALUES[5]));
});

test('plain-text comments preserve every newline and literal HTML when serialized for Docmost', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  const text = '<b>literal</b>\r\nsecond\n\nlast\r';
  const expectedDocument = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '<b>literal</b>' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: 'last' }] },
    { type: 'paragraph' },
  ] };
  const created = toolData(await rpc.call('create_comment', { pageId: 'fixture-page-slug', parentCommentId: COMMENT_ID, text }));
  assert.equal(created.id, COMMENT_ID);
  assert.deepEqual(created.content, expectedDocument);
  const updated = toolData(await rpc.call('update_comment', { commentId: COMMENT_ID, text: 'Revised comment' }));
  assert.equal(updated.id, COMMENT_ID);
  assert.deepEqual(fixture.calls.map(call => ({ path: call.path, body: call.body })), [
    { path: '/api/comments/create', body: { pageId: 'fixture-page-slug', parentCommentId: COMMENT_ID, content: JSON.stringify(expectedDocument) } },
    { path: '/api/comments/update', body: { commentId: COMMENT_ID, content: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Revised comment"}]}]}' } },
  ]);
  for (const call of fixture.calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.body.text, undefined, 'only serialized editor content reaches Docmost');
  }
});

test('official readers send pagination and search defaults to the server', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  toolData(await rpc.call('list_child_pages', { pageId: PAGE_ID }));
  toolData(await rpc.call('get_comments', { pageId: PAGE_ID }));
  const attachments = toolData(await rpc.call('search_attachments', { query: 'needle' }));
  toolData(await rpc.call('list_workspace_members'));
  assert.deepEqual(fixture.calls.map(call => ({ path: call.path, body: call.body })), [
    { path: '/api/pages/info', body: { pageId: PAGE_ID } },
    { path: '/api/pages/sidebar-pages', body: { pageId: PAGE_ID, spaceId: SPACE_ID, limit: 20 } },
    { path: '/api/comments', body: { pageId: PAGE_ID, limit: 20 } },
    { path: '/api/search-attachments', body: { query: 'needle', limit: 20, offset: 0 } },
    { path: '/api/workspace/members', body: { limit: 20 } },
  ]);
  assert.equal(attachments.limit, 20);
  assert.equal(attachments.offset, 0);
});

test('member, comment and attachment projections retain useful results while omitting private fields', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  const privateFields = { password: PRIVATE_VALUES[0], resetPasswordToken: PRIVATE_VALUES[1], mfaSecret: PRIVATE_VALUES[2], apiKey: PRIVATE_VALUES[3], licenseKey: PRIVATE_VALUES[4], secretKey: PRIVATE_VALUES[5] };
  fixture.respond = (call, response) => {
    let payload;
    const meta = { limit: 2, hasNextPage: true, hasPrevPage: false, nextCursor: 'next-fixture-cursor', ...privateFields };
    if (call.path === '/api/workspace/members') payload = {
      items: [{ id: USER_ID, name: 'Fixture user', email: 'fixture@example.invalid', role: 'member', avatarUrl: null, ...privateFields }], meta,
    };
    else if (call.path === '/api/comments') payload = {
      items: [{ id: COMMENT_ID, pageId: PAGE_ID, content: { type: 'doc', content: [] }, parentCommentId: null, type: 'page', createdAt: '2026-10-12T00:00:00.000Z', editedAt: null, resolvedAt: null, creator: { id: USER_ID, name: 'Fixture user', email: 'private@example.invalid', ...privateFields }, ...privateFields }], meta,
    };
    else if (call.path === '/api/search-attachments') payload = {
      items: [{ id: ATTACHMENT_ID, fileName: 'fixture.txt', pageId: PAGE_ID, creatorId: USER_ID, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', highlight: 'fixture', rank: 0.5, path: '/private/blob', downloadUrl: 'https://untrusted.example.invalid/blob', space: { id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space', ...privateFields }, page: { id: PAGE_ID, title: 'Fixture page', slugId: 'fixture-page', ...privateFields }, ...privateFields }], total: 100, ...privateFields,
    };
    else return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: payload, success: true }));
    return true;
  };
  const members = toolData(await rpc.call('list_workspace_members', { limit: 2, cursor: 'member-cursor', query: 'Fixture' }));
  assert.deepEqual(members, {
    items: [{ id: USER_ID, name: 'Fixture user', email: 'fixture@example.invalid', role: 'member', avatarUrl: null }],
    meta: { limit: 2, hasNextPage: true, hasPrevPage: false, nextCursor: 'next-fixture-cursor' },
  });
  const comments = toolData(await rpc.call('get_comments', { pageId: PAGE_ID, limit: 2, cursor: 'comment-cursor' }));
  assert.deepEqual(comments, {
    items: [{ id: COMMENT_ID, pageId: PAGE_ID, content: { type: 'doc', content: [] }, parentCommentId: null, type: 'page', createdAt: '2026-10-12T00:00:00.000Z', editedAt: null, resolvedAt: null, creator: { id: USER_ID, name: 'Fixture user' } }],
    meta: { limit: 2, hasNextPage: true, hasPrevPage: false, nextCursor: 'next-fixture-cursor' },
  });
  const attachments = toolData(await rpc.call('search_attachments', { query: 'fixture', limit: 2, offset: 4 }));
  assert.deepEqual(attachments, { items: [{ id: ATTACHMENT_ID, fileName: 'fixture.txt', pageId: PAGE_ID, creatorId: USER_ID, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', space: { id: SPACE_ID, name: 'Fixture space', slug: 'fixture-space' }, page: { id: PAGE_ID, title: 'Fixture page', slugId: 'fixture-page' } }], limit: 2, offset: 4 });
  for (const secret of PRIVATE_VALUES) assert.ok(!JSON.stringify([members, comments, attachments]).includes(secret));
});

test('new tools reject malformed IDs, unsafe move omissions and invalid input without HTTP', { timeout: 15000 }, async t => {
  const { fixture, rpc } = await harness(t);
  const valid = [
    ['list_child_pages', { pageId: PAGE_ID }],
    ['duplicate_page', { pageId: PAGE_ID }],
    ['copy_page_to_space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['move_page', { pageId: PAGE_ID, parentPageId: null, position: 'a0000' }],
    ['move_page_to_space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['create_space', { name: 'Fixture', slug: 'fixture' }],
    ['update_space', { spaceId: SPACE_ID, name: 'Fixture' }],
    ['get_comments', { pageId: PAGE_ID }],
    ['create_comment', { pageId: PAGE_ID, text: 'Fixture' }],
    ['update_comment', { commentId: COMMENT_ID, text: 'Fixture' }],
    ['search_attachments', { query: 'Fixture' }],
    ['list_workspace_members', {}],
  ];
  for (const [name, input] of valid) {
    assertToolError(await rpc.call(name, { ...input, userId: USER_ID }), undefined);
    assertToolError(await rpc.call(name, { ...input, baseUrl: 'https://untrusted.example.invalid' }), undefined);
  }
  const invalid = [
    ['list_child_pages', { pageId: '', limit: 2 }],
    ['list_child_pages', { pageId: PAGE_ID, limit: 0 }],
    ['duplicate_page', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['copy_page_to_space', { pageId: PAGE_ID }],
    ['copy_page_to_space', { pageId: PAGE_ID, spaceId: 'destination-slug' }],
    ['move_page', { pageId: PAGE_ID, position: 'a0000' }],
    ['move_page', { pageId: PAGE_ID, parentPageId: null, position: 0 }],
    ['move_page', { pageId: PAGE_ID, parentPageId: null, position: 'abcd' }],
    ['move_page', { pageId: PAGE_ID, parentPageId: null, position: 'a'.repeat(13) }],
    ['move_page', { pageId: PAGE_ID, parentPageId: '', position: 'a0000' }],
    ['move_page_to_space', { pageId: PAGE_ID, spaceId: 'destination-slug' }],
    ['create_space', { name: ' ', slug: 'ok' }],
    ['create_space', { name: 'x', slug: 'ok' }],
    ['create_space', { name: 'x'.repeat(101), slug: 'ok' }],
    ['create_space', { name: 'Fixture', slug: '-unsafe' }],
    ['create_space', { name: 'Fixture', slug: 'a' }],
    ['create_space', { name: 'Fixture', slug: 'a'.repeat(101) }],
    ['create_space', { name: 'Fixture', slug: 'bad/slug' }],
    ['update_space', { spaceId: SPACE_ID }],
    ['update_space', { spaceId: SPACE_ID, name: ' ' }],
    ['update_space', { spaceId: SPACE_ID, slug: 'renamed-slug' }],
    ['get_comments', { pageId: PAGE_ID, cursor: '' }],
    ['create_comment', { pageId: PAGE_ID }],
    ['create_comment', { pageId: PAGE_ID, text: '' }],
    ['create_comment', { pageId: PAGE_ID, text: ' \n\t' }],
    ['create_comment', { pageId: PAGE_ID, text: 'Fixture', parentCommentId: 'comment-slug' }],
    ['create_comment', { pageId: PAGE_ID, text: 'Fixture', content: { type: 'doc', content: [] } }],
    ['create_comment', { pageId: PAGE_ID, content: { type: 'doc', content: [] } }],
    ['update_comment', { commentId: COMMENT_ID }],
    ['update_comment', { commentId: 'comment-slug', text: 'Fixture' }],
    ['update_comment', { commentId: COMMENT_ID, text: ' \n\t' }],
    ['update_comment', { commentId: COMMENT_ID, text: 'Fixture', content: { type: 'doc', content: [] } }],
    ['update_comment', { commentId: COMMENT_ID, content: { type: 'doc', content: [] } }],
    ['search_attachments', { query: ' ' }],
    ['search_attachments', { query: 'Fixture', creatorId: 'creator-name' }],
    ['search_attachments', { query: 'Fixture', limit: 101 }],
    ['search_attachments', { query: 'Fixture', offset: -1 }],
    ['list_workspace_members', { limit: 0 }],
    ['list_workspace_members', { cursor: '' }],
    ['list_workspace_members', { query: 'x'.repeat(201) }],
  ];
  for (const [name, input] of invalid) assertToolError(await rpc.call(name, input));
  assert.deepEqual(fixture.calls, [], 'invalid inputs never reach the configured deployment');
});

test('attachment capability absence is an explicit deployment error and generic permission failures stay forbidden', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  for (const [message, expectedCode] of [
    ['Cannot POST /api/search-attachments', /UNSUPPORTED_DEPLOYMENT/],
    ['Route POST:/api/search-attachments not found', /UNSUPPORTED_DEPLOYMENT/],
    [`Fixture attachment was not found ${PRIVATE_VALUES[5]}`, /NOT_FOUND/],
  ]) {
    fixture.respond = (call, response) => {
      assert.equal(call.path, '/api/search-attachments');
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message, secretKey: PRIVATE_VALUES[5] }));
      return true;
    };
    const before = fixture.calls.length;
    const reply = await rpc.call('search_attachments', { query: 'fixture' });
    assertToolError(reply, expectedCode);
    assert.equal(fixture.calls.length, before + 1, 'missing routes and resources are not retried');
    assert.ok(!JSON.stringify(reply).includes(PRIVATE_VALUES[5]));
  }
  fixture.respond = (_call, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: `Forbidden fixture ${TOKEN} ${PRIVATE_VALUES[5]}` }));
    return true;
  };
  for (const [name, input] of [
    ['search_attachments', { query: 'fixture' }],
    ['list_workspace_members', {}],
    ['move_page_to_space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['create_comment', { pageId: PAGE_ID, text: 'Fixture' }],
  ]) {
    const before = fixture.calls.length;
    const reply = await rpc.call(name, input);
    assertToolError(reply, /FORBIDDEN/);
    assert.ok(!JSON.stringify(reply).includes(PRIVATE_VALUES[5]));
    assert.equal(fixture.calls.length, before + 1, `${name} does not retry a forbidden request`);
  }
});

test('page destination preflights reject self, other-space parents and same-space transfers before a mutation', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t);
  for (const [name, input] of [
    ['move_page', { pageId: PAGE_ID, parentPageId: PAGE_ID, position: 'a0000' }],
    ['move_page', { pageId: PAGE_ID, parentPageId: OTHER_PARENT_ID, position: 'a0000' }],
    ['copy_page_to_space', { pageId: PAGE_ID, spaceId: SPACE_ID }],
    ['move_page_to_space', { pageId: PAGE_ID, spaceId: SPACE_ID }],
  ]) {
    const before = fixture.calls.length;
    assertToolError(await rpc.call(name, input), /INVALID_REQUEST/);
    assert.ok(fixture.calls.length > before, `${name} reads its source before validating the destination`);
    assert.ok(fixture.calls.slice(before).every(call => ['/api/pages/info', '/api/spaces/info'].includes(call.path)), `${name} must not mutate a rejected destination`);
  }
  fixture.respond = (call, response) => {
    if (call.path !== '/api/spaces/info') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: SPACE_ID, name: 'Mismatched target', slug: 'mismatched-target' }, success: true }));
    return true;
  };
  for (const name of ['copy_page_to_space', 'move_page_to_space']) {
    const before = fixture.calls.length;
    assertToolError(await rpc.call(name, { pageId: 'fixture-page-slug', spaceId: OTHER_SPACE_ID }), /INVALID_(REQUEST|RESPONSE)/);
    assert.deepEqual(fixture.calls.slice(before).map(call => ({ path: call.path, body: call.body })), [
      { path: '/api/pages/info', body: { pageId: 'fixture-page-slug' } },
      { path: '/api/spaces/info', body: { spaceId: OTHER_SPACE_ID } },
    ]);
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

test('read-only mode advertises ten readers and rejects every write without HTTP', { timeout: 10000 }, async t => {
  const { fixture, rpc } = await harness(t, { DOCMOST_READ_ONLY: '1' });
  const tools = await rpc.request('tools/list');
  assert.equal(tools.error, undefined);
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), READ_TOOLS.toSorted());
  const writes = [
    ['create_page', { spaceId: SPACE_ID, title: 'Denied' }],
    ['update_page', { pageId: PAGE_ID, title: 'Denied' }],
    ['delete_page', { pageId: PAGE_ID }],
    ['restore_page', { pageId: PAGE_ID }],
    ['duplicate_page', { pageId: PAGE_ID }],
    ['copy_page_to_space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['move_page', { pageId: PAGE_ID, parentPageId: null, position: 'a0000' }],
    ['move_page_to_space', { pageId: PAGE_ID, spaceId: OTHER_SPACE_ID }],
    ['create_space', { name: 'Denied', slug: 'denied' }],
    ['update_space', { spaceId: SPACE_ID, name: 'Denied' }],
    ['create_comment', { pageId: PAGE_ID, text: 'Denied' }],
    ['update_comment', { commentId: PAGE_ID, text: 'Denied' }],
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
