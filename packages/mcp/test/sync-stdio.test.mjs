import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Real dist/stdio processes and files against a synthetic loopback API only.
// No personal session or deployed Docmost instance is read by this suite.
const ENTRY = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const TOKEN = 'synthetic-markdown-sync-token-do-not-log';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const PAGE_ID = '00000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000004';
const INITIAL_MARKDOWN = '# Existing local body\n\nInitial baseline.\n';
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
const SYNC_TOOLS = [
  'bind_markdown', 'get_markdown_sync_status', 'set_markdown_sync', 'resolve_markdown_sync',
];

function hashMarkdown(markdown) {
  return createHash('sha256').update(markdown).digest('hex');
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function startFixture() {
  const fixture = { calls: [], content: '# Remote initial body\n', respond: null };
  fixture.revision = hashMarkdown(fixture.content);
  fixture.persistedRevision = fixture.revision;
  fixture.replaceRemote = (content, { persist = true } = {}) => {
    fixture.content = content;
    fixture.revision = hashMarkdown(content);
    if (persist) fixture.persistedRevision = fixture.revision;
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { json(response, 400, { message: 'Invalid fixture JSON' }); return; }
    const call = { method: request.method, path: request.url, headers: request.headers, body };
    fixture.calls.push(call);
    if (fixture.respond && await fixture.respond(call, response)) return;
    let payload;
    switch (call.path) {
      case '/api/users/me':
        payload = {
          user: { id: USER_ID, name: 'Synthetic sync user', email: 'sync@example.invalid', role: 'admin' },
          workspace: { id: WORKSPACE_ID, name: 'Synthetic sync workspace', hostname: 'sync.example.invalid' },
        };
        break;
      case '/api/spaces/info':
        payload = { id: SPACE_ID, name: 'Synthetic sync space', slug: 'synthetic-sync-space' };
        break;
      case '/api/pages/info':
        payload = { id: PAGE_ID, title: 'Synthetic sync page', spaceId: SPACE_ID,
          workspaceId: WORKSPACE_ID, content: fixture.content, permissions: { read: true, write: true } };
        break;
      case '/api/pages/sync-state':
        payload = {
          pageId: PAGE_ID, spaceId: SPACE_ID, workspaceId: WORKSPACE_ID,
          revision: fixture.revision, persistedRevision: fixture.persistedRevision,
          ...(body.content === undefined ? {} : { proposedRevision: hashMarkdown(body.content) }),
        };
        break;
      case '/api/pages/sync-update':
        if (body.expectedRevision !== fixture.revision || body.expectedSpaceId !== SPACE_ID || body.expectedWorkspaceId !== WORKSPACE_ID) {
          json(response, 409, { message: 'Synthetic live revision conflict' });
          return;
        }
        fixture.replaceRemote(body.content);
        payload = { pageId: PAGE_ID, spaceId: SPACE_ID, workspaceId: WORKSPACE_ID,
          revision: fixture.revision, persistedRevision: fixture.persistedRevision };
        break;
      default:
        json(response, 404, { message: `Cannot POST ${call.path}` });
        return;
    }
    json(response, 200, { data: payload, success: true, status: 200 });
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
  fixture.updates = () => fixture.calls.filter(call => call.path === '/api/pages/sync-update');
  return fixture;
}

function startMcp(url, overrides = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      DOCMOST_URL: url, DOCMOST_AUTH_MODE: 'api_key', DOCMOST_API_TOKEN: TOKEN,
      DOCMOST_API_TOKEN_FILE: undefined, DOCMOST_SESSION_FILE: undefined,
      DOCMOST_DEFAULT_SPACE_ID: SPACE_ID, DOCMOST_DEFAULT_PARENT_PAGE_ID: undefined,
      DOCMOST_ALLOW_LOCAL_HTTP: '1', DOCMOST_READ_ONLY: '0', DOCMOST_TIMEOUT_MS: '500',
      DOCMOST_SYNC_ROOT: undefined, DOCMOST_SYNC_STATE_DIR: undefined,
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
      reject(new Error(`MCP exited before responding (${code}, ${signal}): ${rpc.stderr}`));
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
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { rpc.invalidLines.push(line); continue; }
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
  child.stdin.on('error', () => {});
  rpc.request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error(`MCP already exited: ${rpc.stderr}`)); return; }
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out waiting for JSON-RPC ${method}: ${rpc.stderr}`));
    }, 4000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  rpc.initialize = async () => {
    const reply = await rpc.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'docmost-markdown-sync-fixture', version: '1.0.0' },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.protocolVersion, '2025-11-25');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  rpc.call = (name, args = {}) => rpc.request('tools/call', { name, arguments: args });
  const awaitExit = async (timeoutMs, message) => {
    let timer;
    try {
      return await Promise.race([exit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  rpc.end = (timeoutMs = 3000) => {
    child.stdin.end();
    return awaitExit(timeoutMs, 'Configured MCP did not exit after stdin EOF');
  };
  rpc.signal = (signal, timeoutMs = 3000) => {
    child.kill(signal);
    return awaitExit(timeoutMs, `Configured MCP did not exit after ${signal}`);
  };
  rpc.cleanup = async () => {
    if (closed) return;
    try { await rpc.end(500); }
    catch { child.kill('SIGKILL'); await exit; }
  };
  return rpc;
}

function assertCleanOutput(rpc) {
  assert.deepEqual(rpc.invalidLines, [], 'stdout must contain JSON-RPC lines only');
  assert.ok(!rpc.stdout.includes(TOKEN), 'stdout must not expose credentials');
  assert.ok(!rpc.stderr.includes(TOKEN), 'stderr must not expose credentials');
}

function toolData(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
  if (reply.result.structuredContent) return reply.result.structuredContent;
  return JSON.parse(reply.result.content.find(item => item.type === 'text').text);
}

function assertToolError(reply, pattern) {
  assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply));
  if (pattern) assert.match(JSON.stringify(reply.error ?? reply.result), pattern);
  assert.ok(!JSON.stringify(reply).includes(TOKEN), 'tool errors must not expose credentials');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check, message, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (performance.now() < deadline);
  assert.fail(message);
}

async function bind(rpc, input = {}) {
  const binding = toolData(await rpc.call('bind_markdown', { filePath: 'document.md', pageId: PAGE_ID, ...input }));
  assert.match(binding.bindingId, /^[0-9a-f-]{36}$/i);
  assert.equal(binding.pageId, PAGE_ID);
  assert.equal(binding.filePath, 'document.md');
  return binding;
}

const status = async (rpc, bindingId) => toolData(await rpc.call('get_markdown_sync_status', { bindingId }));

async function harness(t, { configured = true, overrides = {} } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'docmost-sync-stdio-')));
  const sourceRoot = join(directory, 'source');
  const stateDir = join(directory, 'private-state');
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  const filePath = join(sourceRoot, 'document.md');
  await writeFile(filePath, INITIAL_MARKDOWN);
  const fixture = await startFixture();
  const processes = [];
  const env = { ...(configured ? { DOCMOST_SYNC_ROOT: sourceRoot, DOCMOST_SYNC_STATE_DIR: stateDir } : {}), ...overrides };
  const start = async (extraEnv = {}) => {
    const rpc = startMcp(fixture.url, { ...env, ...extraEnv });
    processes.push(rpc);
    await rpc.initialize();
    return rpc;
  };
  t.after(async () => {
    for (const rpc of processes) await rpc.cleanup();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
    for (const rpc of processes) assertCleanOutput(rpc);
  });
  return { fixture, rpc: await start(), start, sourceRoot, stateDir, filePath, directory };
}

test('configured stdio discovers four strict local Markdown controls', { timeout: 10000 }, async t => {
  const { rpc } = await harness(t);
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS, ...SYNC_TOOLS].sort());
  for (const name of SYNC_TOOLS) {
    const tool = tools.find(value => value.name === name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.equal(tool.inputSchema.properties.userId, undefined, name);
    assert.equal(tool.inputSchema.properties.origin, undefined, name);
    assert.equal(tool.annotations.readOnlyHint, name === 'get_markdown_sync_status', name);
  }
  const shapes = {
    bind_markdown: { keys: ['filePath', 'pageId', 'enabled'], required: ['filePath', 'pageId'] },
    get_markdown_sync_status: { keys: ['bindingId'], required: [] },
    set_markdown_sync: { keys: ['bindingId', 'action'], required: ['bindingId', 'action'] },
    resolve_markdown_sync: { keys: ['bindingId', 'expectedRevision'], required: ['bindingId', 'expectedRevision'] },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const schema = tools.find(value => value.name === name).inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), shape.keys.toSorted(), name);
    assert.deepEqual((schema.required ?? []).toSorted(), shape.required.toSorted(), name);
  }
  assert.equal(tools.find(tool => tool.name === 'resolve_markdown_sync').annotations.destructiveHint, true);
});

test('without sync configuration stdio keeps the 22/10 registries and never watches files', { timeout: 12000 }, async t => {
  for (const readOnly of [false, true]) {
    const { rpc, fixture, filePath } = await harness(t, {
      configured: false, overrides: { DOCMOST_READ_ONLY: readOnly ? '1' : '0' },
    });
    const tools = (await rpc.request('tools/list')).result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...(readOnly ? [] : WRITE_TOOLS)].sort());
    assertToolError(await rpc.call('bind_markdown', { filePath: 'document.md', pageId: PAGE_ID }));
    await writeFile(filePath, '# Unconfigured save\n');
    await delay(1300);
    assert.deepEqual(fixture.calls, [], 'unconfigured startup and local changes do not contact Docmost');
  }
});

test('sync controls reject extra identity fields and unsafe paths before remote access', { timeout: 10000 }, async t => {
  const { rpc, fixture, filePath } = await harness(t);
  toolData(await rpc.call('get_markdown_sync_status'));
  const before = fixture.calls.length;
  const invalid = [
    ['bind_markdown', { pageId: PAGE_ID }],
    ['bind_markdown', { filePath: 'document.md' }],
    ['bind_markdown', { filePath: 'document.md', pageId: PAGE_ID, origin: fixture.url }],
    ['bind_markdown', { filePath: 'document.md', pageId: PAGE_ID, userId: USER_ID }],
    ['bind_markdown', { filePath: filePath, pageId: PAGE_ID }],
    ['bind_markdown', { filePath: '../document.md', pageId: PAGE_ID }],
    ['bind_markdown', { filePath: 'document.md', pageId: 'page-url-slug' }],
    ['bind_markdown', { filePath: 'document.md', pageId: PAGE_ID, enabled: 'true' }],
    ['get_markdown_sync_status', { userId: USER_ID }],
    ['get_markdown_sync_status', { bindingId: 'not-a-uuid' }],
    ['set_markdown_sync', { bindingId: PAGE_ID, action: 'delete' }],
    ['set_markdown_sync', { bindingId: PAGE_ID, action: 'pause', origin: fixture.url }],
    ['resolve_markdown_sync', { bindingId: PAGE_ID, expectedRevision: 'stale' }],
    ['resolve_markdown_sync', { bindingId: PAGE_ID, expectedRevision: 'z'.repeat(64) }],
    ['resolve_markdown_sync', { bindingId: PAGE_ID, expectedRevision: 'a'.repeat(64), userId: USER_ID }],
  ];
  for (const [name, input] of invalid) assertToolError(await rpc.call(name, input));
  assert.equal(fixture.calls.length, before, 'invalid controls must not read or mutate the remote target');
  assert.deepEqual(fixture.updates(), []);
});

test('bind records baselines without uploading and atomic rapid saves upload the complete latest body', { timeout: 12000 }, async t => {
  const { rpc, fixture, filePath, sourceRoot } = await harness(t);
  const remoteBaseline = fixture.revision;
  const binding = await bind(rpc);
  assert.equal(binding.enabled, true, 'binding is enabled by default');
  await delay(1300);
  assert.equal(fixture.updates().length, 0, 'binding must never publish its initial file body');
  const markdown = '# Atomic final save\n\nEntire replacement body, including 中文.\n';
  await writeFile(filePath, '# First rapid save\n');
  const replacement = join(sourceRoot, '.editor-save.tmp');
  await writeFile(replacement, markdown);
  await rename(replacement, filePath);
  await eventually(() => fixture.content === markdown, 'atomic rename save was not uploaded');
  await eventually(async () => (await status(rpc, binding.bindingId)).remoteRevision === fixture.revision,
    'verified remote baseline did not advance');
  const updates = fixture.updates();
  assert.equal(updates.length, 1, 'rapid saves are debounced into one whole-body update');
  assert.deepEqual(updates[0].body, { pageId: PAGE_ID, content: markdown, expectedRevision: remoteBaseline, expectedSpaceId: SPACE_ID, expectedWorkspaceId: WORKSPACE_ID });
  assert.equal(updates[0].method, 'POST');
  assert.equal(updates[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!fixture.calls.some(call => call.path === '/api/pages/update'), 'sync never uses unconditional replacement');
  const state = await status(rpc, binding.bindingId);
  assert.equal(state.localHash, hashMarkdown(markdown));
  assert.equal(state.error, undefined);
  assert.ok(!JSON.stringify(state).includes(markdown), 'status excludes document bodies');
});

test('live CAS conflict pauses saves and only explicit resolution against the current revision replaces the page', { timeout: 17000 }, async t => {
  const { rpc, fixture, filePath } = await harness(t);
  const binding = await bind(rpc);
  const baseline = fixture.revision;
  const browserBody = '# Browser changed the live document\n';
  let injectConflict = true;
  fixture.respond = (call, response) => {
    if (call.path !== '/api/pages/sync-update' || !injectConflict) return false;
    injectConflict = false;
    fixture.replaceRemote(browserBody, { persist: false });
    json(response, 409, { message: 'Synthetic live CAS conflict' });
    return true;
  };
  await writeFile(filePath, '# Local conflicting save\n');
  await eventually(async () => (await status(rpc, binding.bindingId)).error?.code === 'CONFLICT',
    '409 must become an actionable conflict state');
  assert.equal(fixture.content, browserBody);
  assert.equal(fixture.updates()[0].body.expectedRevision, baseline);
  assert.equal(fixture.persistedRevision, baseline, 'fixture models browser changes ahead of DB persistence');
  const merged = '# User accepted merged local body\n';
  await writeFile(filePath, merged);
  const attempts = fixture.updates().length;
  const resume = await rpc.call('set_markdown_sync', { bindingId: binding.bindingId, action: 'resume' });
  if (resume.error || resume.result?.isError) assertToolError(resume, /CONFLICT/);
  await delay(1300);
  assert.equal(fixture.updates().length, attempts, 'resume cannot discard the conflicting baseline');
  assert.equal(fixture.content, browserBody);
  assertToolError(await rpc.call('resolve_markdown_sync', {
    bindingId: binding.bindingId, expectedRevision: baseline,
  }), /CONFLICT/);
  assert.equal(fixture.content, browserBody, 'stale explicit resolution must preserve the live page');
  const observed = await status(rpc, binding.bindingId);
  assert.equal(observed.currentRevision, hashMarkdown(browserBody), 'the MCP status tool exposes the revision required for resolution');
  assert.equal(observed.currentPersistedRevision, baseline, 'status distinguishes live content from the persisted snapshot');
  assert.equal(observed.remoteRevision, baseline, 'reading current state does not reset the saved sync baseline');
  const laterBrowserBody = '# Another browser edit after status was observed\n';
  fixture.replaceRemote(laterBrowserBody, { persist: false });
  assertToolError(await rpc.call('resolve_markdown_sync', {
    bindingId: binding.bindingId, expectedRevision: observed.currentRevision,
  }), /CONFLICT/);
  assert.equal(fixture.content, laterBrowserBody, 'a status revision becomes stale if the remote page changes again');
  const observedRevision = (await status(rpc, binding.bindingId)).currentRevision;
  assert.equal(observedRevision, hashMarkdown(laterBrowserBody));
  toolData(await rpc.call('resolve_markdown_sync', {
    bindingId: binding.bindingId, expectedRevision: observedRevision,
  }));
  assert.equal(fixture.content, merged);
  assert.deepEqual(fixture.updates().at(-1).body, {
    pageId: PAGE_ID, content: merged, expectedRevision: observedRevision, expectedSpaceId: SPACE_ID, expectedWorkspaceId: WORKSPACE_ID,
  });
  assert.equal((await status(rpc, binding.bindingId)).error, undefined);
  await writeFile(filePath, '# Save after explicit resolution\n');
  await eventually(() => fixture.content === '# Save after explicit resolution\n', 'resolution must resume automatic saves');
});

test('single-binding status reads current revisions without resetting baselines or scheduling uploads', { timeout: 10000 }, async t => {
  const { rpc, fixture } = await harness(t);
  const binding = await bind(rpc);
  const baseline = fixture.revision;
  const remoteBody = '# Remote change observed through the status control\n';
  fixture.replaceRemote(remoteBody, { persist: false });
  const before = fixture.calls.length;
  const current = await status(rpc, binding.bindingId);
  assert.equal(current.currentRevision, hashMarkdown(remoteBody));
  assert.equal(current.currentPersistedRevision, baseline);
  assert.equal(current.remoteRevision, baseline, 'a status read preserves the previous accepted baseline');
  assert.equal(current.localHash, hashMarkdown(INITIAL_MARKDOWN));
  assert.equal(current.enabled, true);
  const reads = fixture.calls.slice(before);
  assert.ok(reads.some(call => call.path === '/api/pages/sync-state'), 'status must obtain a fresh live revision');
  assert.ok(reads.every(call => ['/api/users/me', '/api/pages/sync-state'].includes(call.path)), 'status only uses read endpoints');
  for (const call of reads.filter(call => call.path === '/api/pages/sync-state')) {
    assert.deepEqual(call.body, { pageId: PAGE_ID }, 'status reads without proposing source content');
  }
  const beforeList = fixture.calls.length;
  const overview = toolData(await rpc.call('get_markdown_sync_status'));
  assert.ok(overview.bindings.some(value => value.bindingId === binding.bindingId));
  assert.equal(fixture.calls.length, beforeList, 'listing cached bindings does not refresh remote pages');
  await delay(1300);
  assert.equal(fixture.updates().length, 0, 'status never publishes unchanged local content or automatically resolves a remote change');
  assert.equal(fixture.content, remoteBody);
});

test('pause and unbind stop future saves while resume validates and uploads a local-only change', { timeout: 14000 }, async t => {
  const { rpc, fixture, filePath } = await harness(t);
  const binding = await bind(rpc, { enabled: false });
  assert.equal(binding.enabled, false);
  await writeFile(filePath, '# Paused file save\n');
  await delay(1300);
  assert.equal(fixture.updates().length, 0);
  toolData(await rpc.call('set_markdown_sync', { bindingId: binding.bindingId, action: 'resume' }));
  await eventually(() => fixture.content === '# Paused file save\n', 'resume did not reconcile a local-only save');
  toolData(await rpc.call('set_markdown_sync', { bindingId: binding.bindingId, action: 'pause' }));
  const before = fixture.updates().length;
  await writeFile(filePath, '# Another paused save\n');
  await delay(1300);
  assert.equal(fixture.updates().length, before);
  toolData(await rpc.call('set_markdown_sync', { bindingId: binding.bindingId, action: 'unbind' }));
  const overview = toolData(await rpc.call('get_markdown_sync_status'));
  assert.ok(!overview.bindings.some(value => value.bindingId === binding.bindingId));
  await writeFile(filePath, '# Unbound save\n');
  await delay(1300);
  assert.equal(fixture.updates().length, before, 'unbound files never upload');
});

test('denied and known-missing sync routes block uploads without falling back', { timeout: 12000 }, async t => {
  for (const [httpStatus, code] of [[403, 'FORBIDDEN'], [404, 'UNSUPPORTED_DEPLOYMENT']]) {
    await t.test(code, { timeout: 5000 }, async t => {
      const { rpc, fixture, filePath } = await harness(t);
      fixture.respond = (call, response) => {
        if (call.path !== '/api/pages/sync-state') return false;
        json(response, httpStatus, { message: httpStatus === 404 ? 'Cannot POST /api/pages/sync-state' : `Forbidden ${TOKEN}` });
        return true;
      };
      const result = await rpc.call('bind_markdown', { filePath: 'document.md', pageId: PAGE_ID });
      if (result.error || result.result?.isError) assertToolError(result, new RegExp(code));
      else assert.equal(toolData(result).error?.code, code);
      await writeFile(filePath, '# Save after blocked service\n');
      await delay(1300);
      assert.equal(fixture.updates().length, 0);
      assert.ok(!fixture.calls.some(call => call.path === '/api/pages/update'));
    });
  }
});

test('configured read-only stdio adds status only and cannot watch or upload saved bindings', { timeout: 12000 }, async t => {
  const { rpc, fixture, filePath, start } = await harness(t);
  const binding = await bind(rpc);
  await rpc.end();
  const reader = await start({ DOCMOST_READ_ONLY: '1' });
  const tools = (await reader.request('tools/list')).result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, 'get_markdown_sync_status'].sort());
  const overview = toolData(await reader.call('get_markdown_sync_status'));
  assert.equal(overview.readOnly, true);
  assert.ok(overview.bindings.some(value => value.bindingId === binding.bindingId), 'read-only status can inspect existing metadata');
  const beforeRead = fixture.calls.length;
  const remoteBody = '# Remote edit visible to a read-only status client\n';
  fixture.replaceRemote(remoteBody);
  const current = await status(reader, binding.bindingId);
  assert.equal(current.currentRevision, hashMarkdown(remoteBody));
  assert.equal(current.currentPersistedRevision, hashMarkdown(remoteBody));
  const statusReads = fixture.calls.slice(beforeRead);
  assert.ok(statusReads.some(call => call.path === '/api/pages/sync-state'), 'read-only single-binding status can read the live revision');
  assert.ok(statusReads.every(call => ['/api/users/me', '/api/pages/sync-state'].includes(call.path)), 'read-only status must never mutate');
  const before = fixture.calls.length;
  for (const [name, input] of [
    ['bind_markdown', { filePath: 'document.md', pageId: PAGE_ID }],
    ['set_markdown_sync', { bindingId: binding.bindingId, action: 'resume' }],
    ['resolve_markdown_sync', { bindingId: binding.bindingId, expectedRevision: fixture.revision }],
  ]) assertToolError(await reader.call(name, input));
  await writeFile(filePath, '# Read-only mode save\n');
  await delay(1500);
  assert.equal(fixture.calls.length, before, 'denied controls and read-only file saves never contact the sync API');
  assert.equal(fixture.updates().length, 0);
});

test('a second process sharing state reports a busy page lease and cannot duplicate an upload', { timeout: 10000 }, async t => {
  const { rpc, fixture, filePath, start } = await harness(t);
  const binding = await bind(rpc);
  const duplicate = await start();
  await eventually(async () => (await status(duplicate, binding.bindingId)).error?.code === 'LEASE_BUSY',
    'second process must report the live owner lease');
  await writeFile(filePath, '# Only the lease owner uploads\n');
  await eventually(() => fixture.content === '# Only the lease owner uploads\n', 'lease owner did not upload');
  await delay(1300);
  assert.equal(fixture.updates().length, 1, 'only one process can send the same page replacement');
  assert.equal((await status(duplicate, binding.bindingId)).error?.code, 'LEASE_BUSY');
});

test('stdin EOF and SIGTERM stop the configured watcher and exit within three seconds', { timeout: 16000 }, async t => {
  for (const shutdown of ['EOF', 'SIGTERM']) {
    await t.test(shutdown, { timeout: 7500 }, async t => {
      const { rpc, fixture, filePath } = await harness(t);
      await bind(rpc);
      await writeFile(filePath, `# Live save before ${shutdown}\n`);
      await eventually(() => fixture.updates().length === 1, 'watcher was not live before lifecycle check');
      await writeFile(filePath, '# Pending debounce must stop at shutdown\n');
      const started = performance.now();
      const outcome = shutdown === 'EOF' ? await rpc.end(3000) : await rpc.signal(shutdown, 3000);
      assert.ok(performance.now() - started < 3000, `${shutdown} shutdown is bounded`);
      assert.equal(outcome.code, 0);
      assert.equal(outcome.signal, null);
      const before = fixture.updates().length;
      await writeFile(filePath, '# Save after MCP stopped\n');
      await delay(1500);
      assert.equal(fixture.updates().length, before, 'closed processes leave no uploading watcher behind');
    });
  }
});

test('EOF and SIGTERM abort in-flight sync requests and preserve an uncertain intent for restart', { timeout: 18000 }, async t => {
  for (const shutdown of ['EOF', 'SIGTERM']) {
    await t.test(shutdown, { timeout: 8500 }, async t => {
      const { rpc, fixture, filePath, start } = await harness(t, { overrides: { DOCMOST_TIMEOUT_MS: '10000' } });
      const binding = await bind(rpc);
      let aborted = false;
      fixture.respond = (call, response) => {
        if (call.path !== '/api/pages/sync-update') return false;
        response.once('close', () => { aborted = !response.writableEnded; });
        return true; // Hold the write past the shutdown deadline; never apply it.
      };
      await writeFile(filePath, '# Outstanding write during process shutdown\n');
      await eventually(() => fixture.updates().length === 1, 'the held write was never dispatched');
      const started = performance.now();
      const outcome = shutdown === 'EOF' ? await rpc.end(3000) : await rpc.signal(shutdown, 3000);
      assert.ok(performance.now() - started < 3000, 'shutdown cannot wait for the ten-second API timeout');
      assert.equal(outcome.code, 0);
      await eventually(() => aborted, 'shutdown did not abort the upstream connection', 1000);
      fixture.respond = null;
      const restarted = await start();
      const recovered = await status(restarted, binding.bindingId);
      assert.ok(recovered.pending, 'shutdown retains the dispatched intent until its outcome is reconciled');
      assert.ok(recovered.error, 'an unapplied pending mutation must block automatic replay');
      await delay(1300);
      assert.equal(fixture.updates().length, 1, 'restart cannot resend an uncertain mutation');
    });
  }
});

test('restart validates its saved live baseline before uploading an offline local-only save', { timeout: 14000 }, async t => {
  const { rpc, fixture, filePath, start } = await harness(t);
  const binding = await bind(rpc);
  const baseline = fixture.revision;
  await rpc.end();
  const offline = '# Offline edit after clean shutdown\n';
  await writeFile(filePath, offline);
  const restarted = await start();
  await eventually(() => fixture.content === offline, 'restart did not reconcile the offline local change');
  assert.deepEqual(fixture.updates().map(call => call.body), [{ pageId: PAGE_ID, content: offline, expectedRevision: baseline, expectedSpaceId: SPACE_ID, expectedWorkspaceId: WORKSPACE_ID }]);
  await eventually(async () => (await status(restarted, binding.bindingId)).remoteRevision === fixture.revision,
    'restart did not confirm the uploaded baseline');
  await restarted.end();
  const again = await start();
  assert.equal((await status(again, binding.bindingId)).remoteRevision, fixture.revision);
  await delay(1300);
  assert.equal(fixture.updates().length, 1, 'a confirmed replacement is not replayed at the next startup');
});

test('a lost mutation acknowledgement is reconciled at restart without resending the pending write', { timeout: 14000 }, async t => {
  const { rpc, fixture, filePath, start } = await harness(t, { overrides: { DOCMOST_TIMEOUT_MS: '150' } });
  const binding = await bind(rpc);
  let loseAcknowledgement = true;
  fixture.respond = (call, _response) => {
    if (call.path !== '/api/pages/sync-update' || !loseAcknowledgement) return false;
    loseAcknowledgement = false;
    fixture.replaceRemote(call.body.content);
    return true; // The server applied the write, but the client never receives its reply.
  };
  const uncertain = '# Server applied this despite the missing acknowledgement\n';
  await writeFile(filePath, uncertain);
  await eventually(async () => Boolean((await status(rpc, binding.bindingId)).pending), 'uncertain mutation must persist pending intent');
  await delay(1400);
  assert.equal(fixture.updates().length, 1, 'an uncertain write cannot be automatically retried');
  await rpc.end();
  fixture.respond = null;
  const restarted = await start();
  await eventually(async () => {
    const current = await status(restarted, binding.bindingId);
    return !current.pending && !current.error && current.remoteRevision === fixture.revision;
  }, 'restart must confirm the pending proposed revision against live and persisted state');
  assert.equal(fixture.content, uncertain);
  assert.equal(fixture.updates().length, 1, 'pending reconciliation must not dispatch the same mutation again');
  await writeFile(filePath, '# New save after pending reconciliation\n');
  await eventually(() => fixture.content === '# New save after pending reconciliation\n', 'confirmed recovery must allow the next save');
  assert.equal(fixture.updates().length, 2);
});
