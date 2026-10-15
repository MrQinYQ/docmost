#!/usr/bin/env node
// Synthetic, loopback-only real acceptance. --prepare performs read-only guards
// and health checks. The write run owns a UUID-scoped OpenViking root, dedicated
// Docmost sessions/spaces/pages, and private temporary sources/state/credentials.
// --tail-only checks optional-adapter compatibility; --delete-only proves
// initial indexing, complete subtree removal, and restoration. No flag runs all.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loginSession, saveSession } from '../../packages/mcp/src/session.mjs';
import { loadConfig } from '../../packages/mcp/src/config.mjs';
import { createApiClient } from '../../packages/mcp/src/api.mjs';
import { loadOpenVikingConfig } from '../../packages/mcp/src/openviking-config.mjs';
import { createOpenVikingClient } from '../../packages/mcp/src/openviking-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prepareOnly = process.argv.includes('--prepare');
const tailOnly = process.argv.includes('--tail-only');
const deleteOnly = process.argv.includes('--delete-only');
assert.ok(!(tailOnly && deleteOnly), 'Acceptance modes are mutually exclusive.');
assert.ok(process.argv.slice(2).every(value => ['--prepare', '--tail-only', '--delete-only'].includes(value)), 'Unknown acceptance flag.');
const output = join(root, 'data/local-docmost/openviking-sync-acceptance-provider'
  + (tailOnly ? '-tail-only' : deleteOnly ? '-delete-only' : '') + '.json');
const runId = randomUUID(), nonce = runId.slice(0, 8);
const expectedAccount = process.env.DOCMOST_OPENVIKING_ACCOUNT || 'personal';
const expectedUser = process.env.DOCMOST_OPENVIKING_USER || 'qinyequan';
// OpenViking 0.4.19 reindex_executor.py creates REINDEX_TASK_TYPE=admin_reindex.
const reindexTaskType = 'admin_reindex';
// A production root from the caller's environment is deliberately not reused.
const mirrorRoot = `viking://user/${expectedUser}/resources/docmost-mcp-acceptance-${runId}`;
const evidence = {
  version: 1, runId, mode: tailOnly ? 'tail-only' : deleteOnly ? 'delete-only' : 'full', startedAt: new Date().toISOString(),
  transport: 'real built stdio MCP and authenticated OpenViking HTTP',
  scope: 'new synthetic loopback Docmost pages and unique OpenViking acceptance root',
  checks: [], failures: [], createdPages: [], createdSpaces: [], resources: [], tasks: [], cleanup: {},
};
const users = {}, rpcs = new Set(), pages = new Set(), spaces = [], unavailableTargets = new Set();
const directories = new Set(), secrets = new Set();
const profiles = new Set();
const verifiedTaskBaselines = new Map();
const httpTrackers = [];
const runDeadline = Date.now() + 45 * 60 * 1000;
let origin, workspaceId, temporary, ov, ovConfig, key, phase = 'fixture and credential guards';
let interrupted = false, mirrorTouched = false;
let privateCredentials = false, authenticatedIdentity = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });

class SafeFailure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const safeCode = error => /^[A-Z][A-Z_0-9]{0,79}$/.test(error?.code ?? '')
  ? error.code : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'LOCAL_EXECUTION_FAILED';
const errorRecord = error => ({ code: safeCode(error),
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
function guardTime() {
  if (interrupted) throw new SafeFailure('ACCEPTANCE_INTERRUPTED');
  if (Date.now() >= runDeadline) throw new SafeFailure('RUN_DEADLINE');
}
async function check(label, operation) {
  phase = label; guardTime();
  await operation();
  evidence.checks.push({ phase: label, passed: true });
  // Never print responses, source bodies, credential paths, or exception text.
  process.stdout.write(JSON.stringify({ phase: label, passedChecks: evidence.checks.length }) + '\n');
}
// Two bindings share a serialized namespace: full tasks and several waited
// semantic deletes can cumulatively exceed two minutes. Each HTTP request is
// still bounded at 120s. Global queue barriers can include detached ancestor
// work, so convergence is bounded at 10m and the whole acceptance run at 45m.
async function eventually(operation, predicate, timeoutMs = 600000, intervalMs = 1000) {
  const end = Math.min(Date.now() + timeoutMs, runDeadline);
  while (Date.now() < end) {
    guardTime();
    const value = await operation();
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  throw new SafeFailure('CONDITION_TIMEOUT');
}
async function privateFile(file, limit = 65536) {
  if (!isAbsolute(file)) throw new SafeFailure('PRIVATE_FILE_REQUIRED');
  let current = parse(file).root, handle;
  try {
    for (const part of relative(current, file).split(/[\\/]/)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new SafeFailure('PRIVATE_FILE_SYMLINK');
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= limit);
    assert.equal(info.mode & 0o777, 0o600);
    if (process.getuid) assert.equal(info.uid, process.getuid());
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assert.ok(bytesRead <= limit);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await handle?.close(); }
}
function loopbackOrigin(input) {
  const url = new URL(input);
  assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  return url.origin;
}
function decode(reply) {
  if (reply.error) throw new SafeFailure('JSON_RPC_ERROR');
  let payload;
  try { payload = JSON.parse(reply.result.content[0].text); }
  catch { throw new SafeFailure('RPC_INVALID_RESULT'); }
  if (reply.result.isError) throw new SafeFailure(payload.error?.code ?? 'TOOL_ERROR', payload.error?.status);
  return payload;
}
// Use the same line-delimited JSON-RPC transport as acceptance-md-sync.mjs;
// the built adapter runs its existing MCP SDK, with no new runtime dependency.
function connect(env, { preload } = {}) {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), join(root, 'packages/mcp/dist/index.mjs')], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0, buffer = '', stderrBytes = 0, closed = false, exitCode, exitSignal;
  const pending = new Map();
  const finished = new Promise(done => child.once('close', done));
  function rejectPending(code) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new SafeFailure(code)); }
    pending.clear();
  }
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2000000) { rejectPending('RPC_OVERSIZED_OUTPUT'); return; }
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n'), line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { rejectPending('RPC_INVALID_JSON'); continue; }
      const item = pending.get(reply.id);
      if (item) { clearTimeout(item.timer); pending.delete(reply.id); item.resolve(reply); }
    }
  });
  child.once('error', () => rejectPending('RPC_PROCESS_ERROR'));
  child.once('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; rejectPending('RPC_CLOSED'); });
  child.stdin.on('error', () => rejectPending('RPC_STDIN_CLOSED'));
  const rpc = {
    send(method, params = {}) {
      if (closed) return Promise.reject(new SafeFailure('RPC_CLOSED'));
      return new Promise((done, fail) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); fail(new SafeFailure('RPC_TIMEOUT')); }, 130000);
        pending.set(id, { resolve: done, reject: fail, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    async close(method = 'eof') {
      const requestedBeforeExit = !closed;
      if (!closed) {
        if (method === 'sigterm') child.kill('SIGTERM'); else child.stdin.end();
        let timeout;
        const graceful = await Promise.race([finished.then(() => true), new Promise(done => {
          timeout = setTimeout(() => done(false), 12000);
        })]);
        clearTimeout(timeout);
        if (!graceful) { child.kill('SIGKILL'); await finished; throw new SafeFailure('RPC_GRACEFUL_CLOSE_TIMEOUT'); }
      }
      rpcs.delete(rpc);
      return { method, stopped: closed, stderrBytes, requestedBeforeExit, exitCode, exitSignal };
    },
  };
  rpcs.add(rpc);
  return rpc;
}
async function startRpc(env, options) {
  const rpc = connect(env, options);
  const initialized = await rpc.send('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'local-openviking-sync-acceptance', version: '1' },
  });
  assert.ok(initialized.result);
  rpc.notify('notifications/initialized');
  return rpc;
}
const call = (rpc, name, args = {}) => rpc.send('tools/call', { name, arguments: args }).then(decode);
function assertProviderAlias(value) {
  if (value?.openViking === undefined) return;
  assert.equal(value.knowledgeBase?.provider, 'openviking');
  assert.equal(value.knowledgeBase.enabled, true);
  const { provider, enabled, ...generic } = value.knowledgeBase;
  assert.deepEqual(generic, value.openViking);
}
const status = async (rpc, bindingId) => {
  const value = await call(rpc, 'get_markdown_sync_status', { bindingId }); assertProviderAlias(value); return value;
};
const cached = async (rpc, bindingId) => {
  const value = (await call(rpc, 'get_markdown_sync_status')).bindings.find(item => item.bindingId === bindingId);
  assertProviderAlias(value); return value;
};
const waitBinding = (rpc, bindingId, predicate, timeoutMs) => eventually(async () => {
  const value = await cached(rpc, bindingId);
  if (value?.openViking?.state === 'blocked') {
    const failure = { bindingId, code: safeCode(value.openViking.error), phase: value.openViking.phase,
      ...(value.openViking.uri ? { uri: value.openViking.uri } : {}) };
    (evidence.waitFailures ??= []).push(failure);
    throw new SafeFailure(failure.code);
  }
  return value;
}, predicate, timeoutMs);
const pageRead = id => call(users.writer.control, 'get_page', { pageId: id });
const readback = (id, marker) => eventually(() => pageRead(id), page => typeof page.content === 'string'
  && page.content.includes(marker), 20000, 300);
async function profile(label, connection = true) {
  const dir = join(temporary, label), source = join(dir, 'source'), state = join(dir, 'state');
  await mkdir(dir, { mode: 0o700 });
  await mkdir(source, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const env = { ...users.writer.env, DOCMOST_KNOWLEDGE_PROVIDER: connection ? 'openviking' : 'none',
    DOCMOST_SYNC_ROOT: await realpath(source), DOCMOST_SYNC_STATE_DIR: await realpath(state) };
  if (connection) Object.assign(env, {
    DOCMOST_OPENVIKING_URL: ovConfig.origin,
    DOCMOST_OPENVIKING_API_KEY_FILE: ovConfig.apiKeyFile,
    DOCMOST_OPENVIKING_ACCOUNT: expectedAccount, DOCMOST_OPENVIKING_USER: expectedUser,
    DOCMOST_OPENVIKING_ROOT_URI: mirrorRoot, DOCMOST_OPENVIKING_TIMEOUT_MS: '120000',
  });
  const result = { dir, source, state, env }; profiles.add(result); return result;
}
async function writeTracker(test, label, { trace = false } = {}) {
  const preload = join(test.dir, label + '.mjs'), counter = join(test.dir, label + '.counts');
  const diagnostics = join(test.dir, label + '.http.jsonl');
  const paths = ['pages/create', 'pages/update', 'pages/sync-update', 'pages/delete', 'pages/restore',
    'pages/move', 'pages/move-to-space', 'pages/duplicate', 'spaces/create', 'spaces/update', 'spaces/delete']
    .map(path => new URL(path, users.writer.config.apiBase).pathname);
  const source = [
    "import { appendFile } from 'node:fs/promises';",
    'const originalFetch = globalThis.fetch;',
    'const docmostOrigin = ' + JSON.stringify(origin) + ';',
    'const openVikingOrigin = ' + JSON.stringify(ovConfig.origin) + ';',
    'const counter = ' + JSON.stringify(counter) + ';',
    'const diagnostics = ' + JSON.stringify(diagnostics) + ';',
    'const trace = ' + JSON.stringify(trace) + ';',
    'const rootUri = ' + JSON.stringify(mirrorRoot) + ';',
    'const paths = new Set(' + JSON.stringify(paths) + ');',
    'globalThis.fetch = async (input, options) => {',
    "  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);",
    "  const method = (options?.method ?? input.method ?? 'GET').toUpperCase();",
    "  const tag = url.origin === docmostOrigin && method === 'POST' && paths.has(url.pathname) ? 'docmost'",
    "    : url.origin === openVikingOrigin && ((method === 'POST' && ['/api/v1/content/write', '/api/v1/content/reindex'].includes(url.pathname)) || (method === 'DELETE' && url.pathname === '/api/v1/fs')) ? 'openviking' : undefined;",
    "  if (tag) await appendFile(counter, tag + '\\n', { mode: 0o600 });",
    '  let requestUri = url.searchParams.get("uri") ?? url.searchParams.get("resource_id");',
    '  if (!requestUri && typeof options?.body === "string") { try { requestUri = JSON.parse(options.body).uri; } catch {} }',
    '  const own = value => typeof value === "string" && (value === rootUri || value.startsWith(rootUri + "/"));',
    '  let response; const requestStarted = Date.now();',
    '  try { response = await originalFetch(input, options); } catch (error) {',
    '    if (trace && url.origin === openVikingOrigin && own(requestUri)) {',
    '      const row = { at: Date.now(), method, path: url.pathname, uri: requestUri, httpStatus: 0,',
    '        durationMs: Date.now() - requestStarted,',
    '        transportError: typeof error?.name === "string" && /^[A-Za-z_]{1,64}$/.test(error.name) ? error.name : "RequestError" };',
    '      await appendFile(diagnostics, JSON.stringify(row) + "\\n", { mode: 0o600 });',
    '    }',
    '    throw error;',
    '  }',
    '  const durationMs = Date.now() - requestStarted;',
    '  if (trace && url.origin === openVikingOrigin && ((own(requestUri) && (response.status >= 400 || tag === "openviking"))',
    '    || url.pathname.startsWith("/api/v1/tasks/") || (own(requestUri) && url.pathname === "/api/v1/content/reindex"))) {',
    '    const text = await response.clone().text();',
    '    if (Buffer.byteLength(text) <= 16384) {',
    '      let payload; try { payload = JSON.parse(text); } catch {}',
    '      const task = payload?.result, details = payload?.error?.details;',
    '      const uri = own(requestUri) ? requestUri : own(task?.resource_id) ? task.resource_id : own(task?.uri) ? task.uri : undefined;',
    '      if (uri) {',
    '        const word = value => typeof value === "string" && /^[A-Za-z_]{1,64}$/.test(value) ? value : undefined;',
    '        const row = { at: Date.now(), method, path: url.pathname, uri, httpStatus: response.status, durationMs,',
    '          errorCode: word(payload?.error?.code), errorResource: own(details?.resource) ? details.resource : undefined,',
    '          errorType: word(details?.type), expected: word(details?.expected), actual: word(details?.actual),',
    '          taskId: typeof task?.task_id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(task.task_id) ? task.task_id : undefined,',
    '          taskStatus: word(task?.status), mode: word(task?.result?.mode),',
    '          semanticStatus: word(task?.semantic_status), vectorStatus: word(task?.vector_status),',
    '          failedRecords: Number.isInteger(task?.result?.failed_records) ? task.result.failed_records : undefined,',
    '          unsupportedRecords: Number.isInteger(task?.result?.unsupported_records) ? task.result.unsupported_records : undefined };',
    '        await appendFile(diagnostics, JSON.stringify(row) + "\\n", { mode: 0o600 });',
    '      }',
    '    }',
    '  }',
    '  return response;',
    '};',
  ].join('\n');
  await writeFile(preload, source, { mode: 0o600 }); await chmod(preload, 0o600);
  await writeFile(counter, '', { mode: 0o600 }); await chmod(counter, 0o600);
  await writeFile(diagnostics, '', { mode: 0o600 }); await chmod(diagnostics, 0o600);
  const tracker = { preload,
    async counts() {
      const rows = (await readFile(counter, 'utf8')).split('\n').filter(Boolean);
      assert.ok(rows.every(row => ['docmost', 'openviking'].includes(row)));
      return { docmost: rows.filter(row => row === 'docmost').length, openViking: rows.filter(row => row === 'openviking').length };
    },
    async diagnostics() {
      const text = await readFile(diagnostics, 'utf8'); assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
      return text.split('\n').filter(Boolean).map(row => JSON.parse(row));
    } };
  if (trace) httpTrackers.push(tracker);
  return tracker;
}
async function save(test, file, content) {
  const path = join(test.source, file);
  await writeFile(path, content, { mode: 0o600 }); await chmod(path, 0o600);
}
async function direct(user, path, body) {
  assert.ok(['spaces/members/add', 'spaces/delete'].includes(path));
  const url = new URL(path, user.config.apiBase); assert.equal(url.origin, origin);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + user.config.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); throw new SafeFailure('DIRECT_API_DENIED', response.status); }
  const text = await response.text();
  if (!text.trim()) return;
  const payload = JSON.parse(text); assert.equal(payload.success, true); return payload.data;
}
async function ovRequest(path, { method = 'GET', query, body } = {}) {
  const url = new URL(path, ovConfig.apiBase);
  if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  // Additional acceptance reads are limited to this run's resource tree; task
  // lookups are only issued for IDs returned from its precisely scoped listing.
  for (const value of [query?.uri, query?.resource_id, body?.target_uri].filter(Boolean)) {
    assert.ok(value === mirrorRoot || value.startsWith(mirrorRoot + '/'));
  }
  let response;
  try {
    response = await fetch(url, { method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
      headers: { 'X-API-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new SafeFailure('OV_NETWORK_ERROR'); }
  if (!response.ok) { await response.body?.cancel(); throw new SafeFailure('OV_REQUEST_FAILED', response.status); }
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
  const payload = JSON.parse(text); assert.equal(payload.status, 'ok'); return payload.result;
}
async function statOwnResource(uri) {
  assert.ok(uri === mirrorRoot || uri.startsWith(mirrorRoot + '/'));
  const url = new URL('fs/stat', ovConfig.apiBase); url.searchParams.set('uri', uri);
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
    headers: { 'X-API-Key': key, Accept: 'application/json' } });
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 16384);
  const payload = JSON.parse(text);
  if (response.status === 404 && payload.status === 'error' && payload.error?.code === 'NOT_FOUND'
    && payload.error.details?.resource === uri && ['file', 'directory'].includes(payload.error.details?.type))
    return { uri, present: false, httpStatus: 404, errorCode: 'NOT_FOUND', resourceType: payload.error.details.type };
  if (!response.ok) throw new SafeFailure('OV_REQUEST_FAILED', response.status);
  assert.equal(payload.status, 'ok'); assert.equal(payload.result?.uri, uri);
  assert.equal(typeof payload.result.isDir, 'boolean');
  return { uri, present: true, httpStatus: 200, isDir: payload.result.isDir };
}
const statOwnRoot = async () => (await statOwnResource(mirrorRoot)).present;
async function waitForQueues(label, deadlineLimit = runDeadline) {
  const started = Date.now(), deadline = Math.min(started + 600000, deadlineLimit);
  const record = { label, attempts: 0 };
  (evidence.queueBarriers ??= []).push(record);
  while (Date.now() < deadline) {
    record.attempts++;
    try {
      record.queues = await ov.waitProcessed(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      record.durationMs = Date.now() - started; record.completed = true;
      // Counters describe global history. Only exact own tasks determine this
      // run's failure counts; upstream errors/messages are never retained.
      return;
    } catch (error) {
      if (error.code !== 'OV_PROCESSING_PENDING') throw error;
      record.lastObservation = 'OV_PROCESSING_PENDING';
    }
  }
  throw new SafeFailure('QUEUE_BARRIER_TIMEOUT');
}
function pageDirectory(uri) {
  assert.ok(typeof uri === 'string' && uri.startsWith(mirrorRoot + '/') && uri.endsWith('/document.md'));
  const value = uri.slice(0, -'/document.md'.length); directories.add(value); return value;
}
async function tasksFor(directory) {
  assert.ok(directories.has(directory));
  const tasks = await ovRequest('tasks', { query: { task_type: reindexTaskType, resource_id: directory, limit: 200 } });
  assert.ok(Array.isArray(tasks) && tasks.length < 200);
  assert.ok(tasks.every(task => task.task_type === reindexTaskType && task.resource_id === directory));
  return tasks;
}
async function taskSignature() {
  const ids = [];
  for (const directory of directories) for (const task of await tasksFor(directory)) ids.push(task.task_id);
  return [...new Set(ids)].sort();
}
async function find(directory, query, level = 2) {
  assert.ok(directories.has(directory));
  assert.ok([0, 1, 2].includes(level));
  const result = await ovRequest('search/find', { method: 'POST', body: {
    query, target_uri: directory, context_type: 'resource', level, limit: 20,
  } });
  const hits = ['resources', 'memories', 'skills'].flatMap(name => result[name] ?? []);
  assert.ok(hits.every(hit => typeof hit.uri === 'string' && (hit.uri === directory || hit.uri.startsWith(directory + '/'))));
  return hits;
}
async function verifyDeletedDirectories(uris, query, markers) {
  await waitForQueues('subtree deleted before restore');
  const proof = evidence.subtreeDeleted.derivedResources = [];
  for (const uri of uris) {
    const directory = pageDirectory(uri);
    const [resourceStat, entries, abstract, overview] = await Promise.all([
      statOwnResource(directory), ov.list(directory), ov.read(directory + '/.abstract.md'), ov.read(directory + '/.overview.md'),
    ]);
    const summary = text => ({ present: text !== undefined,
      bytes: text === undefined ? 0 : Buffer.byteLength(text),
      markersPresent: text === undefined ? false : markers.some(marker => text.includes(marker)) });
    const record = { directory, stat: resourceStat,
      entries: entries?.map(entry => ({ name: entry.name, isDir: entry.isDir })),
      L0: summary(abstract), L1: summary(overview), retrieval: [] };
    proof.push(record);
    for (const level of [0, 1, 2]) {
      const hits = await find(directory, query, level);
      record.retrieval.push({ level, count: hits.length, uris: hits.map(hit => hit.uri) });
      assert.equal(hits.length, 0);
    }
    assert.equal(resourceStat.present, false);
    assert.equal(entries, undefined); assert.equal(abstract, undefined); assert.equal(overview, undefined);
  }
  evidence.subtreeDeleted.allDerivedResourcesAbsent = true;
}
async function verifyMirror(rpc, binding, content, query, label) {
  const item = await eventually(async () => {
    const value = await cached(rpc, binding.bindingId);
    if (value?.openViking?.state === 'blocked') {
      const failure = { label, pageId: binding.pageId, bindingId: binding.bindingId,
        code: safeCode(value.openViking.error), phase: value.openViking.phase };
      if (value.openViking.taskId) {
        const task = await ovRequest('tasks/' + encodeURIComponent(value.openViking.taskId));
        assert.ok(typeof task.resource_id === 'string' && task.resource_id.startsWith(mirrorRoot + '/'));
        Object.assign(failure, { taskId: task.task_id, status: task.status, resultPresent: task.result != null,
          failedRecords: task.result?.failed_records ?? null, unsupportedRecords: task.result?.unsupported_records ?? null });
        // This recognized, path-free server failure is safe to record. Never
        // retain arbitrary upstream model messages or source/credential text.
        if (typeof task.error === 'string' && /^lock acquire timed out after [0-9]+ms$/.test(task.error)) {
          failure.backendCode = 'OV_TASK_LOCK_TIMEOUT'; failure.safeMessage = task.error;
        }
      }
      (evidence.processingFailures ??= []).push(failure);
      throw new SafeFailure(failure.code);
    }
    return value;
  }, value => value?.state === 'synced' && value?.openViking?.state === 'synced');
  const observed = await status(rpc, binding.bindingId);
  assert.equal(item.knowledgeBase.state, 'synced'); assert.equal(observed.knowledgeBase.state, 'synced');
  assert.equal(item.openViking.confirmedRevision, observed.currentRevision);
  assert.equal(observed.currentRevision, observed.currentPersistedRevision);
  const uri = item.openViking.uri, directory = pageDirectory(uri);
  (evidence.mirrorSnapshots ??= []).push({ label, pageId: binding.pageId, bindingId: binding.bindingId,
    uri, confirmedRevision: item.openViking.confirmedRevision, provider: item.knowledgeBase.provider,
    providerEnabled: item.knowledgeBase.enabled, providerState: item.knowledgeBase.state, compatibilityAliasMatched: true });
  assert.equal(await ov.read(uri), content);
  const previousTaskIds = verifiedTaskBaselines.get(directory) ?? new Set();
  let observedTasks;
  const task = await eventually(async () => {
    const tasks = await tasksFor(directory);
    observedTasks = tasks;
    (evidence.taskLookups ??= {})[label] = { uri: directory, taskType: reindexTaskType, count: tasks.length,
      tasks: tasks.map(value => ({ taskId: value.task_id, status: value.status, mode: value.result?.mode,
        resultPresent: value.result != null })) };
    const completed = tasks.filter(value => !previousTaskIds.has(value.task_id)
      && value.status === 'completed' && value.result?.mode === 'semantic_and_vectors');
    return completed.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  }, value => value !== undefined);
  assert.match(task.task_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const exact = await ovRequest('tasks/' + encodeURIComponent(task.task_id));
  assert.equal(exact.task_id, task.task_id); assert.equal(exact.status, 'completed');
  assert.equal(exact.result.uri, directory); assert.equal(exact.result.mode, 'semantic_and_vectors');
  assert.equal(exact.result.failed_records, 0); assert.equal(exact.result.unsupported_records, 0);
  assert.ok(exact.result.rebuilt_records > 0 && Array.isArray(exact.result.warnings));
  const abstract = await ov.read(directory + '/.abstract.md');
  const overview = await ov.read(directory + '/.overview.md');
  assert.ok(typeof abstract === 'string' && abstract.trim().length > 0);
  assert.ok(typeof overview === 'string' && overview.trim().length > 0);
  const hits = await eventually(() => find(directory, query), value => value.some(hit => hit.uri === uri), 15000);
  evidence.resources.push({ label, pageId: binding.pageId, bindingId: binding.bindingId, uri,
    confirmedRevision: item.openViking.confirmedRevision, rawBytes: Buffer.byteLength(content),
    abstractBytes: Buffer.byteLength(abstract), overviewBytes: Buffer.byteLength(overview), scopedHits: hits.length });
  evidence.tasks.push({ label, taskId: exact.task_id, uri: directory, status: exact.status,
    mode: exact.result.mode, failedRecords: exact.result.failed_records,
    unsupportedRecords: exact.result.unsupported_records, rebuiltRecords: exact.result.rebuilt_records,
    warningsCount: exact.result.warnings.length, newSincePreviousVerification: true });
  verifiedTaskBaselines.set(directory, new Set(observedTasks.map(value => value.task_id)));
  return item;
}
async function discoverOwnDirectories() {
  // Failure may occur before the first completed binding exposes its URI.
  // Discover only this UUID root so any already submitted task still settles
  // before recursive cleanup. Unknown/oversized layouts prevent removal.
  const queued = [mirrorRoot], visited = new Set();
  while (queued.length) {
    const directory = queued.shift();
    assert.ok(directory === mirrorRoot || directory.startsWith(mirrorRoot + '/'));
    assert.ok(!visited.has(directory) && visited.size < 1000);
    visited.add(directory);
    let entries;
    try { entries = await ov.list(directory); }
    catch (error) { if (error.code === 'OV_NOT_FOUND') continue; throw error; }
    if (entries === undefined) continue;
    if (entries.some(entry => entry.name === 'document.md')) directories.add(directory);
    for (const entry of entries.filter(value => value.isDir === true || value.is_dir === true
      || value.isDirectory === true || value.type === 'directory')) {
      assert.ok(typeof entry.name === 'string' && !/[\\/\u0000-\u001f]/.test(entry.name)
        && !['', '.', '..'].includes(entry.name));
      queued.push(directory + '/' + entry.name);
    }
  }
}
async function bindAndResolve(rpc, test, page, file, content) {
  await save(test, file, content);
  const binding = await call(rpc, 'bind_markdown', { filePath: file, pageId: page.id, enabled: true });
  assertProviderAlias(binding);
  assert.equal(binding.openViking.state, 'waiting_docmost');
  const current = await status(rpc, binding.bindingId);
  assert.match(current.currentRevision, /^[a-f0-9]{64}$/);
  mirrorTouched = true;
  const resolved = await call(rpc, 'resolve_markdown_sync', { bindingId: binding.bindingId, expectedRevision: current.currentRevision });
  assertProviderAlias(resolved);
  assert.equal(resolved.state, 'synced');
  return binding;
}
async function createPage(rpc, title, spaceId, parentPageId = null) {
  // Omitted body is the supported empty-create contract; supplied Markdown
  // content is nonempty by schema even when the destination should be empty.
  const page = await call(rpc, 'create_page', { title, spaceId, parentPageId });
  assert.match(page.id, /^[0-9a-f-]{36}$/i); pages.add(page.id);
  evidence.createdPages.push({ pageId: page.id, spaceId, parentPageId }); return page;
}
async function unavailableLoopbackTarget() {
  // Hold the port ourselves to prevent another process from receiving the key
  // between port discovery and the unavailable-service test. Reject the socket
  // before reading request bytes; this target provides no OpenViking service.
  const server = createServer(socket => socket.destroy());
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  const target = { origin: 'http://127.0.0.1:' + port,
    async close() {
      await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
      unavailableTargets.delete(target);
    } };
  unavailableTargets.add(target); return target;
}
async function privateState(directory) {
  const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(info.uid, process.getuid());
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), data = await lstat(path);
    assert.ok(!data.isSymbolicLink());
    if (data.isDirectory()) await privateState(path);
    else {
      assert.ok(data.isFile()); assert.equal(data.mode & 0o777, 0o600);
      const text = await readFile(path, 'utf8');
      for (const secret of secrets) assert.ok(!text.includes(secret));
    }
  }
}
async function standaloneKnowledgeProbe(provider) {
  guardTime();
  const label = 'probe-' + provider, preload = join(temporary, label + '.mjs'), counter = join(temporary, label + '.count');
  await writeFile(counter, '', { mode: 0o600 });
  const source = [
    "import { appendFile } from 'node:fs/promises';",
    'const originalFetch = globalThis.fetch;',
    'const counter = ' + JSON.stringify(counter) + ';',
    'const origin = ' + JSON.stringify(ovConfig.origin) + ';',
    'const allowed = ' + JSON.stringify(provider === 'openviking') + ';',
    'globalThis.fetch = async (input, options) => {',
    '  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);',
    '  const method = (options?.method ?? input.method ?? "GET").toUpperCase();',
    '  await appendFile(counter, "request\\n", { mode: 0o600 });',
    '  if (!allowed || method !== "GET" || url.origin !== origin || url.pathname !== "/health" || url.search)',
    '    throw new Error("PROBE_UNEXPECTED_REQUEST");',
    '  return originalFetch(input, options);',
    '};',
  ].join('\n');
  await writeFile(preload, source, { mode: 0o600 });
  const env = { ...process.env, PATH: join(temporary, 'no-binaries') };
  for (const name of Object.keys(env)) if (name.startsWith('DOCMOST_')) delete env[name];
  Object.assign(env, { DOCMOST_KNOWLEDGE_PROVIDER: provider, DOCMOST_OPENVIKING_URL: ovConfig.origin,
    DOCMOST_OPENVIKING_API_KEY_FILE: provider === 'none' ? join(temporary, 'none-key-must-not-be-read') : ovConfig.apiKeyFile,
    DOCMOST_OPENVIKING_ACCOUNT: expectedAccount, DOCMOST_OPENVIKING_USER: expectedUser,
    DOCMOST_OPENVIKING_ROOT_URI: mirrorRoot, DOCMOST_OPENVIKING_TIMEOUT_MS: '120000' });
  assert.ok(!env.DOCMOST_URL && !env.DOCMOST_SESSION_FILE && !env.DOCMOST_DEFAULT_SPACE_ID && !env.DOCMOST_API_TOKEN);
  const child = spawn(process.execPath, ['--import', preload, join(root, 'packages/mcp/dist/index.mjs'), '--check-knowledge'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderrBytes = 0, timedOut = false, oversized = false, forceTimer, stopping = false;
  const stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true; child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  const timer = setTimeout(() => {
    timedOut = true; stop();
  }, 20000);
  const interruptionWatcher = setInterval(() => { if (interrupted || Date.now() >= runDeadline) stop(); }, 100);
  child.stdout.on('data', bytes => {
    if (Buffer.byteLength(stdout) + bytes.length > 65536) { oversized = true; stop(); return; }
    stdout += bytes;
  });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
  let exit;
  try {
    exit = await new Promise((done, fail) => { child.once('error', () => fail(new SafeFailure('PROBE_SPAWN_FAILED')));
      child.once('close', (code, signal) => done({ code, signal })); });
  } finally { clearTimeout(timer); clearTimeout(forceTimer); clearInterval(interruptionWatcher); }
  guardTime();
  if (timedOut) throw new SafeFailure('PROBE_TIMEOUT');
  if (oversized) throw new SafeFailure('PROBE_OVERSIZED_OUTPUT');
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(stderrBytes, 0);
  const value = JSON.parse(stdout.trim());
  const allowedKeys = provider === 'none' ? ['success', 'provider', 'state']
    : ['success', 'provider', 'state', 'origin', 'accountId', 'userId', 'rootUri'];
  assert.deepEqual(Object.keys(value).sort(), [...allowedKeys].sort());
  assert.equal(value.success, true); assert.equal(value.provider, provider);
  assert.equal(value.state, provider === 'none' ? 'disabled' : 'ready');
  if (provider === 'openviking') {
    assert.equal(value.origin, ovConfig.origin); assert.equal(value.accountId, expectedAccount);
    assert.equal(value.userId, expectedUser); assert.equal(value.rootUri, mirrorRoot);
  }
  const fetchRequests = (await readFile(counter, 'utf8')).trim().split('\n').filter(Boolean).length;
  assert.equal(fetchRequests, provider === 'none' ? 0 : 1);
  (evidence.standaloneProbes ??= []).push({ provider, success: true, state: value.state,
    safeKeys: allowedKeys, docmostPrerequisitesPresent: false, fetchRequests, resourceWrites: 0,
    privateRootValidated: provider === 'openviking', staleSettingsIgnored: provider === 'none' });
}

try {
  const fixture = JSON.parse(await readFile(join(root, 'data/local-docmost/fixtures.json'), 'utf8'));
  const accounts = JSON.parse(await privateFile(join(root, 'data/local-docmost/accounts.json')));
  origin = loopbackOrigin(fixture.apiUrl); workspaceId = fixture.workspaceId;
  assert.equal(loopbackOrigin(accounts.apiUrl), origin); assert.equal(accounts.workspaceId, workspaceId);
  assert.match(workspaceId, /^[0-9a-f-]{36}$/i);
  for (const role of ['writer', 'reader', 'admin']) {
    assert.equal(accounts[role].email, role + '@webmcp.test');
    assert.ok(typeof accounts[role].password === 'string' && accounts[role].password.length > 0);
    secrets.add(accounts[role].password);
    assert.match(fixture.users[role].id, /^[0-9a-f-]{36}$/i);
  }
  assert.ok((await stat(join(root, 'packages/mcp/dist/index.mjs'))).isFile());
  assert.equal(expectedAccount, 'personal'); assert.equal(expectedUser, 'qinyequan');
  let ovUrl = process.env.DOCMOST_OPENVIKING_URL;
  if (process.env.DOCMOST_OPENVIKING_API_KEY_FILE) {
    key = (await privateFile(process.env.DOCMOST_OPENVIKING_API_KEY_FILE)).trim();
    ovUrl ||= 'http://127.0.0.1:1933';
  } else {
    const existing = JSON.parse(await privateFile(join(homedir(), '.openviking/ovcli.conf')));
    key = existing.api_key;
    ovUrl ||= existing.url;
    assert.equal(existing.account, expectedAccount); assert.equal(existing.user, expectedUser);
  }
  assert.ok(typeof key === 'string' && /^[A-Za-z0-9._~+/-]+=*$/.test(key)); secrets.add(key);
  const ovOrigin = loopbackOrigin(ovUrl); assert.equal(ovOrigin, 'http://127.0.0.1:1933');
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'docmost-openviking-acceptance-')));
  await chmod(temporary, 0o700);
  const privateKey = join(temporary, 'openviking-api-key');
  await writeFile(privateKey, key, { mode: 0o600 }); await chmod(privateKey, 0o600);
  await mkdir(join(temporary, 'no-binaries'), { mode: 0o700 });
  ovConfig = loadOpenVikingConfig({
    DOCMOST_OPENVIKING_URL: ovOrigin, DOCMOST_OPENVIKING_API_KEY_FILE: privateKey,
    DOCMOST_OPENVIKING_ACCOUNT: expectedAccount, DOCMOST_OPENVIKING_USER: expectedUser,
    DOCMOST_OPENVIKING_ROOT_URI: mirrorRoot, DOCMOST_OPENVIKING_TIMEOUT_MS: '120000',
  });
  assert.ok(ovConfig && !ovConfig.error); ov = createOpenVikingClient(ovConfig); privateCredentials = true;
  await check('guarded loopback fixtures and authenticated existing OpenViking identity', async () => {
    const identity = await ov.identity();
    assert.equal(identity.accountId, expectedAccount); assert.equal(identity.userId, expectedUser);
    assert.ok(['admin', 'user'].includes(identity.role)); authenticatedIdentity = true;
    let response;
    try { response = await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(5000) }); }
    catch { throw new SafeFailure('DOCMOST_HEALTH_UNAVAILABLE'); }
    assert.equal(response.status, 200); await response.body?.cancel();
    evidence.origin = origin; evidence.openViking = { origin: ovOrigin, account: identity.accountId, user: identity.userId,
      role: identity.role, rootUri: mirrorRoot, fullSemanticAndVectors: true };
  });
  await check('standalone selected provider probes need no Docmost configuration and cannot write resources', async () => {
    await standaloneKnowledgeProbe('none'); await standaloneKnowledgeProbe('openviking');
  });
  if (prepareOnly) {
    guardTime();
    evidence.success = true;
  } else {
    const loginConfig = { origin, apiBase: origin + '/api/', timeoutMs: 15000, allowLocalHttp: true };
    await check('fresh revocable synthetic writer and admin sessions with no ov in PATH', async () => {
      for (const role of ['writer', 'admin']) {
        const session = await loginSession(loginConfig, accounts[role]); secrets.add(session.token);
        const dir = join(temporary, 'session-' + role), file = join(dir, 'session.json');
        const env = { ...process.env, PATH: join(temporary, 'no-binaries'), DOCMOST_URL: origin,
          DOCMOST_AUTH_MODE: 'session', DOCMOST_SESSION_FILE: file,
          DOCMOST_DEFAULT_SPACE_ID: fixture.spaces.shared.id, DOCMOST_ALLOW_LOCAL_HTTP: '1',
          DOCMOST_READ_ONLY: '0', DOCMOST_API_TOKEN: '', DOCMOST_API_TOKEN_FILE: '' };
        for (const name of Object.keys(env)) if (name.startsWith('DOCMOST_OPENVIKING_')
          || ['DOCMOST_KNOWLEDGE_PROVIDER', 'DOCMOST_DEFAULT_PARENT_PAGE_ID', 'DOCMOST_SYNC_ROOT', 'DOCMOST_SYNC_STATE_DIR'].includes(name)) delete env[name];
        env.DOCMOST_KNOWLEDGE_PROVIDER = 'none';
        users[role] = { session, dir, file, env, config: { ...loginConfig, token: session.token, authMode: 'session', session } };
        users[role].api = createApiClient(users[role].config);
        await mkdir(dir, { mode: 0o700 }); await saveSession(file, session);
        users[role].config = await loadConfig(env); users[role].api = createApiClient(users[role].config);
        users[role].control = await startRpc(env);
        const identity = await call(users[role].control, 'get_current_user');
        assert.equal(identity.user.id, fixture.users[role].id); assert.equal(identity.workspace.id, workspaceId);
        assert.equal((await users[role].control.send('tools/list')).result.tools.length, 22);
      }
      evidence.noOvExecutablePath = true;
    });
    let space;
    await check('new synthetic space and writer membership', async () => {
      space = await call(users.admin.control, 'create_space', {
        name: 'OpenViking acceptance ' + nonce, slug: 'ov-acceptance-' + nonce,
        description: 'Synthetic loopback acceptance; contains no company documents',
      });
      spaces.push(space);
      evidence.createdSpaces.push({ spaceId: space.id });
      await direct(users.admin, 'spaces/members/add', { spaceId: space.id, role: 'writer',
        userIds: [users.writer.session.userId], groupIds: [] });
    });
    const main = await profile('main');
    const mainTracker = await writeTracker(main, 'main-writes', { trace: true });
    let rpc = await startRpc(main.env, mainTracker), parent, child, parentBinding, childBinding, parentMirror, childMirror;
    let parentBody = `# Synthetic cobalt otter ${nonce}\n\nThe cobalt otter navigation beacon is a synthetic acceptance device. Its signal activates every seventeen seconds. Test token COBALT-OTTER-${nonce}.\n`;
    const childBody = `# Synthetic amber penguin ${nonce}\n\nThe amber penguin compass is a synthetic acceptance device below the cobalt otter beacon. Its calibration uses five imaginary stars. Test token AMBER-PENGUIN-${nonce}.\n`;
    const parentQuery = `COBALT-OTTER-${nonce} cobalt otter beacon seventeen seconds`;
    const childQuery = `AMBER-PENGUIN-${nonce} amber penguin compass five imaginary stars`;
    await check('configured provider discovery 28 includes canonical and compatibility retry tools', async () => {
      const tools = (await rpc.send('tools/list')).result.tools;
      assert.equal(tools.length, 28);
      for (const name of ['bind_markdown', 'get_markdown_sync_status', 'set_markdown_sync', 'resolve_markdown_sync', 'retry_knowledge_sync', 'retry_openviking_sync'])
        assert.ok(tools.some(tool => tool.name === name));
      evidence.configuredDiscovery = tools.length;
    });
    if (!tailOnly) {
    await check('empty-create bind current revision and explicit initial MD resolution', async () => {
      parent = await createPage(rpc, 'Cobalt otter ' + nonce, space.id);
      child = await createPage(rpc, 'Amber penguin ' + nonce, space.id, parent.id);
      parentBinding = await bindAndResolve(rpc, main, parent, 'parent.md', parentBody);
      childBinding = await bindAndResolve(rpc, main, child, 'child.md', childBody);
      await readback(parent.id, 'COBALT-OTTER-' + nonce); await readback(child.id, 'AMBER-PENGUIN-' + nonce);
    });
    await check('two exact originals completed full tasks summaries vectors and scoped semantic hits', async () => {
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'initial parent');
      childMirror = await verifyMirror(rpc, childBinding, childBody, childQuery, 'initial child');
      assert.ok(parentMirror.openViking.uri.includes('--' + space.id + '/'));
      assert.ok(childMirror.openViking.uri.startsWith(pageDirectory(parentMirror.openViking.uri) + '/'));
      assert.ok(childMirror.openViking.uri.includes('--' + child.id + '/document.md'));
    });
    if (!deleteOnly) {
    await check('normal MD save confirms new Docmost body and full OpenViking processing', async () => {
      parentBody += `\nSAVE-UPDATE-${nonce}: The synthetic beacon now also reports a violet cloud.\n`;
      await save(main, 'parent.md', parentBody); await readback(parent.id, 'SAVE-UPDATE-' + nonce);
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'MD update');
    });
    await check('title-only MCP rename refreshes registered parent and child layout', async () => {
      const oldParent = parentMirror.openViking.uri, oldChild = childMirror.openViking.uri;
      await call(rpc, 'update_page', { pageId: parent.id, title: 'Renamed cobalt otter ' + nonce });
      await waitBinding(rpc, parentBinding.bindingId, item => item?.openViking?.state === 'synced' && item.openViking.uri !== oldParent);
      await waitBinding(rpc, childBinding.bindingId, item => item?.openViking?.state === 'synced' && item.openViking.uri !== oldChild);
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'renamed parent');
      childMirror = await verifyMirror(rpc, childBinding, childBody, childQuery, 'renamed descendant');
      assert.equal(await ov.read(oldParent), undefined); assert.equal(await ov.read(oldChild), undefined);
      assert.ok(childMirror.openViking.uri.startsWith(pageDirectory(parentMirror.openViking.uri) + '/'));
    });
    await check('explicit within-space move refreshes child URI and clears owned old body', async () => {
      const oldChild = childMirror.openViking.uri;
      await call(rpc, 'move_page', { pageId: child.id, parentPageId: null, position: 'a0000' });
      assert.equal((await pageRead(child.id)).parentPageId, null);
      await waitBinding(rpc, childBinding.bindingId, item => item?.openViking?.state === 'synced' && item.openViking.uri !== oldChild);
      childMirror = await verifyMirror(rpc, childBinding, childBody, childQuery, 'moved child');
      assert.ok(!childMirror.openViking.uri.startsWith(pageDirectory(parentMirror.openViking.uri) + '/'));
      assert.equal(await ov.read(oldChild), undefined);
      await call(rpc, 'move_page', { pageId: child.id, parentPageId: parent.id, position: 'a0000' });
      await waitBinding(rpc, childBinding.bindingId, item => item?.openViking?.state === 'synced'
        && item.openViking.uri.startsWith(pageDirectory(parentMirror.openViking.uri) + '/'));
      childMirror = await verifyMirror(rpc, childBinding, childBody, childQuery, 'returned child');
    });
    await check('remote body conflict never exports unconfirmed local MD', async () => {
      const uri = parentMirror.openViking.uri, taskIds = await taskSignature();
      await call(users.writer.control, 'update_page', { pageId: parent.id, content: 'SYNTHETIC-WEB-CONFLICT-' + nonce, operation: 'replace' });
      await save(main, 'parent.md', 'SYNTHETIC-LOCAL-MUST-NOT-EXPORT-' + nonce);
      await waitBinding(rpc, parentBinding.bindingId, item => item?.state === 'conflict' && item?.error?.code === 'CONFLICT', 20000);
      assert.equal(await ov.read(uri), parentBody); assert.deepEqual(await taskSignature(), taskIds);
      parentBody += `\nMERGED-SYNTHETIC-${nonce}: Explicitly resolved test body.\n`;
      await save(main, 'parent.md', parentBody);
      const current = await status(rpc, parentBinding.bindingId);
      await call(rpc, 'resolve_markdown_sync', { bindingId: parentBinding.bindingId, expectedRevision: current.currentRevision });
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'explicit conflict resolution');
    });
    }
    await check('explicit subtree trash clears both managed originals and semantic detail hits', async () => {
      const before = [parentMirror.openViking.uri, childMirror.openViking.uri];
      await call(rpc, 'delete_page', { pageId: parent.id });
      for (const binding of [parentBinding, childBinding])
        // This subtree serializes multiple model-backed leaf, directory, and
        // pruning deletes. Observed successful requests took35–47s each; allow
        // the bounded whole queue ten minutes while keeping HTTP at120s.
        await waitBinding(rpc, binding.bindingId, item => item?.openViking?.state === 'deleted', 600000);
      for (const uri of before) assert.equal(await ov.read(uri), undefined);
      const hits = await find(pageDirectory(before[0]), parentQuery + ' ' + childQuery);
      assert.equal(hits.length, 0);
      evidence.subtreeDeleted = { pageIds: [parent.id, child.id], originalsAbsent: true, detailHits: hits.length };
      // Deleted ledgers deliberately clear uri. Keep the confirmed before-URI
      // array and inspect it synchronously here, before any restore is issued.
      await verifyDeletedDirectories(before, parentQuery + ' ' + childQuery,
        ['COBALT-OTTER-' + nonce, 'AMBER-PENGUIN-' + nonce]);
    });
    await check('restore rereads matching private MD and reindexes both registered pages', async () => {
      await call(rpc, 'restore_page', { pageId: parent.id });
      await readback(parent.id, (deleteOnly ? 'COBALT-OTTER-' : 'MERGED-SYNTHETIC-') + nonce);
      await readback(child.id, 'AMBER-PENGUIN-' + nonce);
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'restored parent');
      childMirror = await verifyMirror(rpc, childBinding, childBody, childQuery, 'restored child');
    });
    if (!deleteOnly) {
    await check('stdin EOF stops later Docmost writes and new OpenViking tasks', async () => {
      const taskIds = await taskSignature(), oldBody = parentBody;
      evidence.eof = await rpc.close();
      assert.equal(evidence.eof.requestedBeforeExit, true); assert.equal(evidence.eof.exitCode, 0); assert.equal(evidence.eof.exitSignal, null);
      parentBody += `\nAFTER-EOF-${nonce}: Synthetic offline edit.\n`;
      await save(main, 'parent.md', parentBody); await sleep(2500);
      assert.ok(!(await pageRead(parent.id)).content.includes('AFTER-EOF-' + nonce));
      assert.equal(await ov.read(parentMirror.openViking.uri), oldBody);
      assert.deepEqual(await taskSignature(), taskIds);
    });
    await check('restart reconciles offline MD through both targets', async () => {
      rpc = await startRpc(main.env, mainTracker); await readback(parent.id, 'AFTER-EOF-' + nonce);
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'EOF restart');
    });
    await check('SIGTERM stops later Docmost writes and new OpenViking tasks', async () => {
      const taskIds = await taskSignature(), oldBody = parentBody;
      evidence.sigterm = await rpc.close('sigterm');
      assert.equal(evidence.sigterm.requestedBeforeExit, true); assert.equal(evidence.sigterm.exitCode, 0); assert.equal(evidence.sigterm.exitSignal, null);
      parentBody += `\nAFTER-SIGTERM-${nonce}: Another synthetic offline edit.\n`;
      await save(main, 'parent.md', parentBody); await sleep(2500);
      assert.ok(!(await pageRead(parent.id)).content.includes('AFTER-SIGTERM-' + nonce));
      assert.equal(await ov.read(parentMirror.openViking.uri), oldBody);
      assert.deepEqual(await taskSignature(), taskIds);
    });
    await check('second restart reconciles without an ov executable', async () => {
      rpc = await startRpc(main.env, mainTracker); await readback(parent.id, 'AFTER-SIGTERM-' + nonce);
      parentMirror = await verifyMirror(rpc, parentBinding, parentBody, parentQuery, 'SIGTERM restart');
      await rpc.close();
    });
    await check('readonly discovery and saved MD cause zero writes or new tasks', async () => {
      const taskIds = await taskSignature();
      const tracker = await writeTracker(main, 'readonly-writes');
      const readonly = await startRpc({ ...main.env, DOCMOST_READ_ONLY: '1' }, tracker);
      const tools = (await readonly.send('tools/list')).result.tools;
      assert.equal(tools.length, 11); assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
      assert.ok(!tools.some(tool => ['retry_knowledge_sync', 'retry_openviking_sync'].includes(tool.name)));
      await save(main, 'parent.md', 'READONLY-MUST-NOT-EXPORT-' + nonce); await sleep(2500);
      assert.ok(!(await pageRead(parent.id)).content.includes('READONLY-MUST-NOT-EXPORT-' + nonce));
      assert.equal(await ov.read(parentMirror.openViking.uri), parentBody); assert.deepEqual(await taskSignature(), taskIds);
      await readonly.close();
      const writes = await tracker.counts(); assert.deepEqual(writes, { docmost: 0, openViking: 0 });
      evidence.readonlyWriteRequests = writes; await save(main, 'parent.md', parentBody);
      evidence.readonlyDiscovery = tools.length;
    });
    }
    }
    if (!deleteOnly) {
    await check('unconfigured no-binary Markdown tools keep original discovery and upload behavior', async () => {
      const plain = await profile('unconfigured', false);
      // Explicit none must suppress even stale, otherwise valid OV settings.
      Object.assign(plain.env, { DOCMOST_OPENVIKING_URL: ovConfig.origin, DOCMOST_OPENVIKING_API_KEY_FILE: ovConfig.apiKeyFile,
        DOCMOST_OPENVIKING_ROOT_URI: mirrorRoot, DOCMOST_OPENVIKING_ACCOUNT: expectedAccount, DOCMOST_OPENVIKING_USER: expectedUser });
      const plainTracker = await writeTracker(plain, 'none-writes');
      const plainRpc = await startRpc(plain.env, plainTracker);
      const tools = (await plainRpc.send('tools/list')).result.tools;
      assert.equal(tools.length, 26); assert.ok(!tools.some(tool => ['retry_knowledge_sync', 'retry_openviking_sync'].includes(tool.name)));
      assert.deepEqual((await call(plainRpc, 'get_markdown_sync_status')).knowledgeBase,
        { provider: 'none', enabled: false, state: 'disabled' });
      const page = await createPage(plainRpc, 'Unconfigured synthetic ' + nonce, space.id);
      await save(plain, 'plain.md', 'UNCONFIGURED-INITIAL-' + nonce);
      const binding = await call(plainRpc, 'bind_markdown', { filePath: 'plain.md', pageId: page.id, enabled: true });
      assert.equal(binding.openViking, undefined);
      assert.equal(binding.knowledgeBase, undefined);
      await save(plain, 'plain.md', 'UNCONFIGURED-SAVE-' + nonce); await readback(page.id, 'UNCONFIGURED-SAVE-' + nonce);
      await waitBinding(plainRpc, binding.bindingId, item => item?.state === 'synced', 20000);
      assert.equal((await status(plainRpc, binding.bindingId)).openViking, undefined);
      assert.equal((await plainTracker.counts()).openViking, 0);
      await plainRpc.close(); evidence.unconfiguredDiscovery = tools.length;
    });
    await check('unreachable optional OpenViking stays nonfatal and retry never repeats Docmost write', async () => {
      const offline = await profile('unreachable'), unavailable = await unavailableLoopbackTarget();
      const tracker = await writeTracker(offline, 'unreachable-writes');
      const offlineRpc = await startRpc({ ...offline.env, DOCMOST_OPENVIKING_URL: unavailable.origin,
        DOCMOST_OPENVIKING_TIMEOUT_MS: '1000' }, tracker);
      const page = await createPage(offlineRpc, 'Offline synthetic ' + nonce, space.id);
      const binding = await bindAndResolve(offlineRpc, offline, page, 'offline.md', 'OFFLINE-SYNTHETIC-' + nonce);
      await readback(page.id, 'OFFLINE-SYNTHETIC-' + nonce);
      const item = await waitBinding(offlineRpc, binding.bindingId, value => value?.state === 'synced'
        && value.openViking?.state === 'retrying', 20000);
      assert.ok(['OV_NETWORK_ERROR', 'OV_TIMEOUT'].includes(item.openViking.error.code));
      const before = await status(offlineRpc, binding.bindingId);
      const requestsBefore = await tracker.counts(); assert.ok(requestsBefore.docmost >= 2);
      const retry = await call(offlineRpc, 'retry_knowledge_sync', { bindingId: binding.bindingId });
      assert.equal(retry.provider, 'openviking'); assert.equal(retry.enabled, true);
      const after = await status(offlineRpc, binding.bindingId);
      const requestsAfter = await tracker.counts(); assert.equal(requestsAfter.docmost, requestsBefore.docmost);
      assert.equal(after.currentRevision, before.currentRevision);
      assert.equal(after.currentPersistedRevision, before.currentPersistedRevision);
      assert.equal(after.state, 'synced');
      assert.equal(item.knowledgeBase.state, 'retrying'); assert.equal(after.knowledgeBase.provider, 'openviking');
      evidence.offline = { docmostSynced: true, mirrorState: item.openViking.state,
        provider: item.knowledgeBase.provider, providerEnabled: item.knowledgeBase.enabled,
        compatibilityAliasMatched: true, retryTool: 'retry_knowledge_sync',
        error: item.openViking.error.code, retryPreservedDocmostRevision: true,
        docmostWriteRequestsBeforeRetry: requestsBefore.docmost, docmostWriteRequestsAfterRetry: requestsAfter.docmost };
      await offlineRpc.close(); await unavailable.close();
    });
    }
    await check('source and mirror state are private and contain no credentials', async () => {
      if (tailOnly) {
        await save(main, 'parent.md', 'TAIL-PRIVATE-PARENT-' + nonce);
        await save(main, 'child.md', 'TAIL-PRIVATE-CHILD-' + nonce);
      }
      assert.equal((await stat(main.source)).mode & 0o777, 0o700);
      for (const file of ['parent.md', 'child.md']) assert.equal((await stat(join(main.source, file))).mode & 0o777, 0o600);
      for (const test of profiles) { await privateState(test.source); await privateState(test.state); }
      if (parentBinding) {
        const stored = await readFile(join(main.state, 'bindings', parentBinding.bindingId + '.json'), 'utf8');
        assert.ok(!stored.includes(parentBody));
      }
    });
    evidence.success = true;
  }
} catch (error) {
  evidence.success = false; evidence.failures.push({ phase, ...errorRecord(error) });
} finally {
  const errors = [];
  async function cleanup(label, operation) {
    try { await operation(); } catch (error) { errors.push({ phase: label, ...errorRecord(error) }); }
  }
  for (const rpc of [...rpcs]) await cleanup('close stdio MCP', () => rpc.close());
  for (const tracker of httpTrackers) await cleanup('capture only synthetic HTTP diagnostics', async () => {
    (evidence.openVikingHttpDiagnostics ??= []).push(...await tracker.diagnostics());
  });
  for (const target of [...unavailableTargets]) await cleanup('close unavailable loopback fixture', () => target.close());
  let trashed = 0, deletedSpaces = 0;
  for (const pageId of pages) await cleanup('trash own synthetic page', async () => {
    await users.writer.api.post('pages/delete', { pageId, permanentlyDelete: false }, undefined, true); trashed++;
  });
  for (const space of spaces) await cleanup('delete own synthetic space', async () => {
    await direct(users.admin, 'spaces/delete', { spaceId: space.id }); deletedSpaces++;
  });
  evidence.cleanup = { mcpClosed: rpcs.size === 0, pagesCreated: pages.size, pagesTrashed: trashed,
    spacesCreated: spaces.length, spacesDeleted: deletedSpaces, sessions: {} };
  // The whole recursive target was freshly minted by this process, not supplied
  // by the caller. Cleanup never removes a production root or sibling resource.
  if (!prepareOnly && mirrorTouched && ov) await cleanup('remove own unique OpenViking test root', async () => {
    // Cleanup must still run after a main-run timeout; give this recovery stage
    // its own shared 10m bound rather than inheriting an already expired guard.
    const cleanupDeadline = Date.now() + 600000;
    assert.equal(mirrorRoot, `viking://user/${expectedUser}/resources/docmost-mcp-acceptance-${runId}`);
    await ov.identity();
    await discoverOwnDirectories();
    // Stop clients first and settle their precisely scoped submitted tasks. A
    // server-side task can continue after MCP exits and must precede cleanup.
    for (const directory of directories) {
      const tasks = await tasksFor(directory);
      for (const task of tasks.filter(item => ['pending', 'running', 'cancelling'].includes(item.status))) {
        const end = Math.min(Date.now() + 120000, cleanupDeadline);
        let completed = false;
        while (Date.now() < end) {
          const current = await ov.task(task.task_id);
          if (['completed', 'failed', 'cancelled'].includes(current.status)) { completed = true; break; }
          await sleep(1000);
        }
        if (!completed) throw new SafeFailure('CLEANUP_TASK_TIMEOUT');
      }
    }
    await waitForQueues('cleanup after own tasks terminal', cleanupDeadline);
    let absent = false;
    const recovery = evidence.cleanup.recoveringCleanup = { root: mirrorRoot, attempts: [] };
    // A dispatched semantic deletion may finish after its client exits and
    // recreate metadata. Read exact ownership/presence before each bounded
    // removal; an uncertain removal error is never automatically replayed.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (Date.now() >= cleanupDeadline) throw new SafeFailure('CLEANUP_DEADLINE');
      const present = await statOwnRoot();
      const record = { attempt, existedBeforeRemoval: present };
      recovery.attempts.push(record);
      if (!present) { record.absentConfirmed = true; absent = true; break; }
      const started = Date.now();
      try {
        const removal = await ov.remove(mirrorRoot, { recursive: true },
          AbortSignal.timeout(Math.max(1, cleanupDeadline - Date.now())));
        record.semanticStatus = ['complete', 'skipped', 'failed', 'queued', 'pending', 'deferred'].includes(removal.semanticStatus)
          ? removal.semanticStatus : 'unknown';
        if (removal.semanticStatus !== 'complete') throw new SafeFailure('OV_PROCESSING_PENDING');
        record.removeCompleted = true;
      } catch (error) {
        if (error.code !== 'OV_NOT_FOUND' || await statOwnRoot()) throw error;
        record.removeMissingConfirmed = true;
      }
      record.durationMs = Date.now() - started;
      await waitForQueues('cleanup after own root removal attempt ' + attempt, cleanupDeadline);
      if (!await statOwnRoot()) {
        record.absentConfirmed = true; absent = true; break;
      }
      record.absentConfirmed = false;
    }
    if (!absent) throw new SafeFailure('CLEANUP_ROOT_STILL_EXISTS');
    evidence.cleanup.openVikingRootRemoved = true;
    evidence.cleanup.openVikingRootAbsentConfirmed = true;
    if (Date.now() + 10000 >= cleanupDeadline) throw new SafeFailure('CLEANUP_DEADLINE');
    const proofStarted = Date.now();
    await sleep(10000);
    const delayed = await statOwnResource(mirrorRoot);
    evidence.additionalRootAbsenceProof = { elapsedMs: Date.now() - proofStarted, ...delayed };
    assert.equal(delayed.present, false);
  });
  for (const [role, user] of Object.entries(users)) {
    const result = { revoked: false, replayDenied401: false };
    await cleanup(role + ' logout and denied replay', async () => {
      await user.api.post('auth/logout', {}, undefined, true); result.revoked = true;
      await assert.rejects(user.api.post('users/me', {}), error => error.code === 'UNAUTHENTICATED' && error.status === 401);
      result.replayDenied401 = true;
    });
    evidence.cleanup.sessions[role] = result;
  }
  if (temporary) await cleanup('remove private credentials sessions MD and state', async () => {
    await rm(temporary, { recursive: true, force: true }); evidence.cleanup.temporaryFilesDeleted = true;
  });
  evidence.cleanup.errors = errors;
  if (errors.length) evidence.success = false;
  evidence.completedAt = new Date().toISOString(); evidence.passedChecks = evidence.checks.length;
  if (prepareOnly) {
    process.stdout.write(JSON.stringify({ prepared: evidence.success, loopbackOnly: true,
      privateCredentials, authenticatedIdentity, writesPerformed: false,
      ...(evidence.failures.length ? { failures: evidence.failures } : {}),
      ...(errors.length ? { cleanupErrors: errors } : {}) }) + '\n');
  } else {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const report = JSON.stringify(evidence, null, 2) + '\n';
    for (const secret of secrets) assert.ok(!report.includes(secret));
    await writeFile(output, report, { mode: 0o600 }); await chmod(output, 0o600);
    process.stdout.write(JSON.stringify({ success: evidence.success, passedChecks: evidence.passedChecks,
      failures: evidence.failures, cleanup: evidence.cleanup }) + '\n');
  }
  if (evidence.success === false) process.exitCode = 1;
}
