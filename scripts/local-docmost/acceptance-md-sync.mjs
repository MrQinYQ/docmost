#!/usr/bin/env node
// Real, synthetic, loopback-only acceptance. Run after building/restarting the
// local server and packages/mcp. No fixture page or existing session is mutated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loginSession, saveSession } from '../../packages/mcp/src/session.mjs';
import { loadConfig } from '../../packages/mcp/src/config.mjs';
import { createApiClient } from '../../packages/mcp/src/api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'data/local-docmost/md-sync-acceptance.json');
const localRequire = createRequire(join(root, 'package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const { HocuspocusProvider } = localRequire('@hocuspocus/provider');
const Y = localRequire('yjs');
const WebSocket = serverRequire('ws');
const nonce = Date.now().toString(36);
const evidence = {
  version: 1, startedAt: new Date().toISOString(),
  transport: 'real stdio MCP, personal sessions, live Hocuspocus WebSocket',
  checks: [], failures: [], cleanup: {},
};
const users = {}, profiles = [], rpcs = new Set(), providers = new Set();
const pages = new Set(), spaces = [];
let origin, workspaceId, temporary, phase = 'fixture guards';
const runDeadline = Date.now() + 240000;

class SafeFailure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const safeCode = error => /^[A-Z][A-Z_0-9]{0,79}$/.test(error?.code ?? '')
  ? error.code : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'LOCAL_EXECUTION_FAILED';
const errorRecord = error => ({ code: safeCode(error),
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
async function check(label, operation) {
  phase = label;
  if (Date.now() >= runDeadline) throw new SafeFailure('RUN_DEADLINE');
  await operation();
  evidence.checks.push({ phase: label, passed: true });
  // Progress is deliberately limited to labels and counters, never raw API data.
  process.stdout.write(JSON.stringify({ phase: label, passedChecks: evidence.checks.length }) + '\n');
}
async function eventually(operation, predicate, timeoutMs = 12000) {
  const end = Math.min(Date.now() + timeoutMs, runDeadline);
  while (Date.now() < end) {
    const value = await operation();
    if (predicate(value)) return value;
    await sleep(180);
  }
  throw new SafeFailure('CONDITION_TIMEOUT');
}
function decode(reply) {
  if (reply.error) throw new SafeFailure('JSON_RPC_ERROR');
  let payload;
  try { payload = JSON.parse(reply.result.content[0].text); }
  catch { throw new SafeFailure('RPC_INVALID_RESULT'); }
  if (reply.result.isError) throw new SafeFailure(payload.error?.code ?? 'TOOL_ERROR', payload.error?.status);
  return payload;
}
function connect(env) {
  const child = spawn(process.execPath, [join(root, 'packages/mcp/dist/index.mjs')], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0, buffer = '', stderrBytes = 0, closed = false;
  const pending = new Map();
  const finished = new Promise(resolveFinished => child.once('close', () => resolveFinished()));
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
  child.once('close', () => { closed = true; rejectPending('RPC_CLOSED'); });
  child.stdin.on('error', () => rejectPending('RPC_STDIN_CLOSED'));
  const rpc = {
    send(method, params = {}) {
      if (closed) return Promise.reject(new SafeFailure('RPC_CLOSED'));
      return new Promise((resolveReply, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new SafeFailure('RPC_TIMEOUT')); }, 20000);
        pending.set(id, { resolve: resolveReply, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    async close(method = 'eof') {
      if (!closed) {
        if (method === 'sigterm') child.kill('SIGTERM'); else child.stdin.end();
        let timeout;
        const graceful = await Promise.race([finished.then(() => true), new Promise(resolveClose => {
          timeout = setTimeout(() => resolveClose(false), 6000);
        })]);
        clearTimeout(timeout);
        if (!graceful) { child.kill('SIGKILL'); await finished; throw new SafeFailure('RPC_GRACEFUL_CLOSE_TIMEOUT'); }
      }
      rpcs.delete(rpc);
      return { method, stopped: closed, stderrBytes };
    },
  };
  rpcs.add(rpc);
  return rpc;
}
async function startRpc(env) {
  const rpc = connect(env);
  const initialized = await rpc.send('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'local-markdown-sync-acceptance', version: '1' },
  });
  assert.ok(initialized.result);
  rpc.notify('notifications/initialized');
  return rpc;
}
const call = (rpc, name, args = {}) => rpc.send('tools/call', { name, arguments: args }).then(decode);
async function denied(rpc, name, args, expected) {
  try { await call(rpc, name, args); }
  catch (error) {
    assert.equal(error.code, expected.code);
    if (expected.status !== undefined) assert.equal(error.status, expected.status);
    return errorRecord(error);
  }
  throw new SafeFailure('EXPECTED_TOOL_DENIAL');
}
async function direct(user, path, body = {}) {
  assert.ok(new Set(['auth/collab-token', 'spaces/members/add', 'spaces/delete']).has(path));
  const url = new URL(path, user.config.apiBase);
  assert.equal(url.origin, origin);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + user.config.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); throw new SafeFailure('DIRECT_API_DENIED', response.status); }
  const text = await response.text();
  if (!text.trim()) return;
  let payload;
  try { payload = JSON.parse(text); } catch { throw new SafeFailure('DIRECT_INVALID_RESULT'); }
  assert.equal(payload.success, true);
  return payload.data;
}
async function profile(role, label) {
  const dir = join(temporary, label);
  await mkdir(dir, { mode: 0o700 });
  const source = join(dir, 'source'), state = join(dir, 'state');
  await mkdir(source, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const env = { ...users[role].env, DOCMOST_SYNC_ROOT: await realpath(source), DOCMOST_SYNC_STATE_DIR: await realpath(state) };
  const result = { dir, source, state, env, role };
  profiles.push(result);
  return result;
}
async function save(test, relative, content, atomic = false) {
  const path = join(test.source, relative);
  if (atomic) {
    const replacement = path + '.' + randomUUID() + '.tmp';
    await writeFile(replacement, content, { mode: 0o600 });
    await rename(replacement, path);
  } else await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
const pageRead = id => call(users.writer.control, 'get_page', { pageId: id });
const readback = (id, marker) => eventually(() => pageRead(id), page => page.content.includes(marker));
const allStatus = rpc => call(rpc, 'get_markdown_sync_status');
const bindingStatus = (rpc, bindingId) => call(rpc, 'get_markdown_sync_status', { bindingId });
const cachedBinding = async (rpc, id) => (await allStatus(rpc)).bindings.find(item => item.bindingId === id);
const waitBinding = (rpc, id, predicate) => eventually(() => cachedBinding(rpc, id), predicate);
async function createPage(label) {
  const page = await call(users.writer.control, 'create_page', {
    title: 'MD sync acceptance ' + nonce + ' ' + label, parentPageId: null,
    content: 'REMOTE-INITIAL-' + nonce + '-' + label,
  });
  pages.add(page.id);
  return page;
}
async function openEditor(pageId) {
  const { token } = await direct(users.writer, 'auth/collab-token');
  assert.equal(typeof token, 'string');
  const document = new Y.Doc();
  let resolveSynced, rejectSynced;
  const synced = new Promise((done, fail) => { resolveSynced = done; rejectSynced = fail; });
  const provider = new HocuspocusProvider({
    url: origin.replace(/^http/, 'ws') + '/collab', name: 'page.' + pageId,
    document, token, WebSocketPolyfill: WebSocket,
    onSynced: ({ state }) => { if (state) resolveSynced(); },
    onAuthenticationFailed: () => rejectSynced(new SafeFailure('COLLAB_AUTH_FAILED')),
  });
  const editor = { document, provider,
    async close() {
      const socket = provider.configuration.websocketProvider.webSocket;
      let timeout;
      const socketClosed = !socket || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve(true) : new Promise(done => socket.once('close', () => done(true)));
      provider.destroy(); document.destroy();
      const closed = await Promise.race([socketClosed, new Promise(done => {
        timeout = setTimeout(() => done(false), 3000);
      })]);
      clearTimeout(timeout);
      if (!closed) {
        socket.terminate(); await socketClosed;
        throw new SafeFailure('COLLAB_GRACEFUL_CLOSE_TIMEOUT');
      }
      providers.delete(editor);
    },
    append(marker) {
      document.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.setAttribute('id', randomUUID());
        const text = new Y.XmlText(); text.insert(0, marker); paragraph.insert(0, [text]);
        const fragment = document.getXmlFragment('default'); fragment.insert(fragment.length, [paragraph]);
      });
    },
    contains: marker => document.getXmlFragment('default').toString().includes(marker),
  };
  providers.add(editor);
  let timeout;
  try {
    await Promise.race([synced, new Promise((_, fail) => {
      timeout = setTimeout(() => fail(new SafeFailure('COLLAB_SYNC_TIMEOUT')), 12000);
    })]);
  } finally { clearTimeout(timeout); }
  return editor;
}

try {
  const fixture = JSON.parse(await readFile(join(root, 'data/local-docmost/fixtures.json'), 'utf8'));
  const accounts = JSON.parse(await readFile(join(root, 'data/local-docmost/accounts.json'), 'utf8'));
  const url = new URL(fixture.apiUrl);
  assert.ok(new Set(['127.0.0.1', 'localhost', '[::1]']).has(url.hostname));
  assert.equal(url.protocol, 'http:'); assert.equal(url.pathname, '/');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  origin = url.origin; workspaceId = fixture.workspaceId;
  assert.equal(new URL(accounts.apiUrl).origin, origin);
  assert.equal(accounts.workspaceId, workspaceId);
  assert.ok(/^[0-9a-f-]{36}$/i.test(workspaceId));
  for (const role of ['admin', 'writer', 'reader']) assert.equal(accounts[role].email, role + '@webmcp.test');
  evidence.origin = origin;
  if (process.argv.includes('--prepare')) {
    assert.ok((await stat(join(root, 'packages/mcp/dist/index.mjs'))).isFile());
    process.stdout.write(JSON.stringify({ prepared: true, loopbackOnly: true, modulesAvailable: true }) + '\n');
  } else {
    await check('local health and guarded synthetic fixtures', async () => {
      const response = await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); await response.body?.cancel();
    });
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'docmost-md-sync-acceptance-')));
    await chmod(temporary, 0o700);
    const loginConfig = { origin, apiBase: origin + '/api/', timeoutMs: 15000, allowLocalHttp: true };
    await check('fresh revocable writer reader admin sessions', async () => {
      for (const role of ['writer', 'reader', 'admin']) {
        const account = accounts[role];
        const session = await loginSession(loginConfig, { email: account.email, password: account.password });
        const dir = join(temporary, 'session-' + role);
        const file = join(dir, 'session.json');
        const env = { ...process.env, DOCMOST_URL: origin, DOCMOST_AUTH_MODE: 'session',
          DOCMOST_SESSION_FILE: file, DOCMOST_DEFAULT_SPACE_ID: fixture.spaces.shared.id,
          DOCMOST_ALLOW_LOCAL_HTTP: '1', DOCMOST_READ_ONLY: '0', DOCMOST_API_TOKEN: '', DOCMOST_API_TOKEN_FILE: '' };
        for (const key of ['DOCMOST_DEFAULT_PARENT_PAGE_ID', 'DOCMOST_SYNC_ROOT', 'DOCMOST_SYNC_STATE_DIR']) delete env[key];
        // Register the candidate immediately so even a later local storage or
        // configuration failure still revokes this newly issued credential.
        users[role] = { session, dir, file, env,
          config: { ...loginConfig, token: session.token, authMode: 'session', session } };
        users[role].api = createApiClient(users[role].config);
        await mkdir(dir, { mode: 0o700 });
        await saveSession(file, session);
        users[role].config = await loadConfig(env);
        users[role].api = createApiClient(users[role].config);
        users[role].control = await startRpc(env);
        const identity = await call(users[role].control, 'get_current_user');
        assert.equal(identity.user.id, fixture.users[role].id);
        assert.equal(identity.workspace.id, workspaceId);
      }
    });
    const main = await profile('writer', 'main');
    let rpc = await startRpc(main.env), binding;
    const page = await createPage('lifecycle');
    await check('normal discovery 26 including four sync tools', async () => {
      const tools = (await rpc.send('tools/list')).result.tools;
      assert.equal(tools.length, 26);
      for (const name of ['bind_markdown', 'get_markdown_sync_status', 'set_markdown_sync', 'resolve_markdown_sync']) assert.ok(tools.some(tool => tool.name === name));
      evidence.discovery = 26;
    });
    await save(main, 'main.md', 'LOCAL-INITIAL-' + nonce);
    await check('bind different local body has no initial upload', async () => {
      binding = await call(rpc, 'bind_markdown', { filePath: 'main.md', pageId: page.id, enabled: true });
      await sleep(1600);
      const actual = await pageRead(page.id);
      assert.ok(actual.content.includes('REMOTE-INITIAL-' + nonce));
      assert.ok(!actual.content.includes('LOCAL-INITIAL-' + nonce));
      assert.equal(binding.spaceId, fixture.spaces.shared.id);
    });
    await check('save uploads and confirms persisted full body', async () => {
      await save(main, 'main.md', 'SAVE-ONE-' + nonce);
      await readback(page.id, 'SAVE-ONE-' + nonce);
      const status = await waitBinding(rpc, binding.bindingId, value => value?.state === 'synced');
      const fresh = await bindingStatus(rpc, binding.bindingId);
      assert.equal(fresh.currentRevision, status.remoteRevision);
      assert.equal(fresh.currentPersistedRevision, status.remoteRevision);
    });
    await check('rapid saves and atomic rename converge to latest body', async () => {
      for (let i = 0; i < 3; i++) { await save(main, 'main.md', 'RAPID-' + nonce + '-' + i); await sleep(80); }
      await save(main, 'main.md', 'ATOMIC-FINAL-' + nonce, true);
      const actual = await readback(page.id, 'ATOMIC-FINAL-' + nonce);
      assert.ok(!actual.content.includes('SAVE-ONE-' + nonce));
      await waitBinding(rpc, binding.bindingId, value => value?.state === 'synced');
    });
    await check('duplicate live MCP gets page lease busy', async () => {
      const duplicate = await startRpc(main.env);
      const duplicateState = await eventually(() => allStatus(duplicate), state => state.bindings.some(item => item.error?.code === 'LEASE_BUSY'));
      assert.equal(duplicateState.bindings[0].error.code, 'LEASE_BUSY');
      await duplicate.close();
      assert.ok(!(await cachedBinding(rpc, binding.bindingId)).error);
    });
    await check('pause prevents uploads after saves', async () => {
      const paused = await call(rpc, 'set_markdown_sync', { bindingId: binding.bindingId, action: 'pause' });
      assert.equal(paused.enabled, false);
      await save(main, 'main.md', 'PAUSED-SAVE-' + nonce); await sleep(2000);
      assert.ok((await pageRead(page.id)).content.includes('ATOMIC-FINAL-' + nonce));
    });
    await check('resume uploads a saved local change', async () => {
      await call(rpc, 'set_markdown_sync', { bindingId: binding.bindingId, action: 'resume' });
      await readback(page.id, 'PAUSED-SAVE-' + nonce);
      await waitBinding(rpc, binding.bindingId, value => value?.state === 'synced');
    });
    await check('stdin EOF stops subsequent local uploads', async () => {
      evidence.eof = await rpc.close();
      await save(main, 'main.md', 'AFTER-EOF-' + nonce); await sleep(2200);
      assert.ok((await pageRead(page.id)).content.includes('PAUSED-SAVE-' + nonce));
    });
    await check('restart reconciles local-only offline save', async () => {
      rpc = await startRpc(main.env);
      await readback(page.id, 'AFTER-EOF-' + nonce);
      await waitBinding(rpc, binding.bindingId, value => value?.state === 'synced');
    });
    await check('SIGTERM stops subsequent local uploads', async () => {
      evidence.sigterm = await rpc.close('sigterm');
      await save(main, 'main.md', 'AFTER-SIGTERM-' + nonce); await sleep(2200);
      assert.ok((await pageRead(page.id)).content.includes('AFTER-EOF-' + nonce));
    });
    await check('restart with changed remote pauses conflict', async () => {
      await call(users.writer.control, 'update_page', { pageId: page.id, content: 'OFFLINE-REMOTE-' + nonce, operation: 'replace' });
      rpc = await startRpc(main.env);
      const conflict = await waitBinding(rpc, binding.bindingId, value => value?.error?.code === 'CONFLICT');
      assert.equal(conflict.state, 'conflict');
      assert.ok((await pageRead(page.id)).content.includes('OFFLINE-REMOTE-' + nonce));
    });
    await check('resume preserves unresolved remote conflict', async () => {
      const old = await cachedBinding(rpc, binding.bindingId);
      const status = await call(rpc, 'set_markdown_sync', { bindingId: binding.bindingId, action: 'resume' });
      assert.equal(status.remoteRevision, old.remoteRevision); assert.equal(status.error.code, 'CONFLICT');
      await sleep(1300); assert.ok((await pageRead(page.id)).content.includes('OFFLINE-REMOTE-' + nonce));
    });
    await check('fresh status exposes revision and explicit resolution uploads merged MD', async () => {
      const observed = await bindingStatus(rpc, binding.bindingId);
      assert.notEqual(observed.currentRevision, observed.remoteRevision);
      assert.match(observed.currentPersistedRevision, /^[a-f0-9]{64}$/);
      await save(main, 'main.md', 'OFFLINE-MERGED-' + nonce);
      await call(rpc, 'resolve_markdown_sync', { bindingId: binding.bindingId, expectedRevision: observed.currentRevision });
      await readback(page.id, 'OFFLINE-MERGED-' + nonce);
    });
    let editor, firstLive, baseline;
    const webOne = 'LIVE-WEB-ONE-' + nonce, webTwo = 'LIVE-WEB-TWO-' + nonce;
    await check('real active WebSocket edit differs from unpersisted DB body', async () => {
      editor = await openEditor(page.id);
      baseline = await bindingStatus(rpc, binding.bindingId);
      editor.append(webOne);
      firstLive = await eventually(() => bindingStatus(rpc, binding.bindingId), status => status.currentRevision !== status.currentPersistedRevision, 4000);
      assert.ok(editor.contains(webOne));
      assert.ok(!(await pageRead(page.id)).content.includes(webOne));
      evidence.liveCollaboration = { websocketConnected: true, liveRevisionDiffersFromPersisted: true, dbDoesNotYetContainWebEdit: true };
    });
    await check('MD save conflicts with live unpersisted edit and preserves web body', async () => {
      await save(main, 'main.md', 'MD-MUST-NOT-OVERWRITE-LIVE-' + nonce);
      const conflict = await waitBinding(rpc, binding.bindingId, value => value?.error?.code === 'CONFLICT');
      assert.equal(conflict.remoteRevision, baseline.remoteRevision);
      assert.ok(editor.contains(webOne)); assert.ok(!editor.contains('MD-MUST-NOT-OVERWRITE-LIVE-' + nonce));
      const fresh = await bindingStatus(rpc, binding.bindingId);
      assert.equal(fresh.currentRevision, firstLive.currentRevision);
      assert.notEqual(fresh.currentRevision, fresh.remoteRevision);
      evidence.liveCollaboration.mdConflictPreservedWebBody = true;
    });
    let observedLive;
    await check('status read keeps conflict baseline and returns current live revision', async () => {
      observedLive = await bindingStatus(rpc, binding.bindingId);
      assert.equal(observedLive.remoteRevision, baseline.remoteRevision);
      assert.equal(observedLive.state, 'conflict');
      assert.equal(observedLive.currentRevision, firstLive.currentRevision);
    });
    await check('new WebSocket edit rejects previously observed resolve revision', async () => {
      editor.append(webTwo);
      await eventually(() => bindingStatus(rpc, binding.bindingId), status => status.currentRevision !== observedLive.currentRevision, 4000);
      await denied(rpc, 'resolve_markdown_sync', { bindingId: binding.bindingId, expectedRevision: observedLive.currentRevision }, { code: 'CONFLICT' });
      assert.ok(editor.contains(webOne) && editor.contains(webTwo));
      assert.ok(!editor.contains('MD-MUST-NOT-OVERWRITE-LIVE-' + nonce));
      evidence.liveCollaboration.staleExplicitResolutionRejected = true;
    });
    await check('explicit fresh merged resolution persists and reaches active editor', async () => {
      await save(main, 'main.md', webOne + '\n\n' + webTwo + '\n\nMERGED-LOCAL-' + nonce);
      const fresh = await bindingStatus(rpc, binding.bindingId);
      const resolved = await call(rpc, 'resolve_markdown_sync', { bindingId: binding.bindingId, expectedRevision: fresh.currentRevision });
      assert.equal(resolved.state, 'synced');
      const actual = await readback(page.id, 'MERGED-LOCAL-' + nonce);
      assert.ok(actual.content.includes(webOne) && actual.content.includes(webTwo));
      await eventually(async () => editor.contains('MERGED-LOCAL-' + nonce), Boolean);
      evidence.liveCollaboration.explicitMergedResolutionPersisted = true;
      await editor.close();
    });
    await check('unbind prevents later saves and leaves file and page', async () => {
      const unbound = await call(rpc, 'set_markdown_sync', { bindingId: binding.bindingId, action: 'unbind' });
      assert.equal(unbound.state, 'unbound');
      await save(main, 'main.md', 'AFTER-UNBIND-' + nonce); await sleep(1800);
      assert.ok((await pageRead(page.id)).content.includes('MERGED-LOCAL-' + nonce));
      assert.equal((await allStatus(rpc)).bindings.length, 0);
      assert.ok((await stat(join(main.source, 'main.md'))).isFile());
    });
    const restricted = await profile('reader', 'reader'), readerPage = await createPage('reader');
    let readerRpc, readerBinding;
    await save(restricted, 'reader.md', 'READER-INITIAL-' + nonce);
    await check('reader can observe and bind accessible page', async () => {
      readerRpc = await startRpc(restricted.env);
      readerBinding = await call(readerRpc, 'bind_markdown', { filePath: 'reader.md', pageId: readerPage.id, enabled: true });
      assert.match((await bindingStatus(readerRpc, readerBinding.bindingId)).currentRevision, /^[a-f0-9]{64}$/);
    });
    await check('reader conditional server write is HTTP 403', async () => {
      const state = await users.reader.api.post('pages/sync-state', { pageId: readerPage.id });
      await assert.rejects(users.reader.api.post('pages/sync-update', {
        pageId: readerPage.id, expectedRevision: state.revision,
        expectedSpaceId: state.spaceId, expectedWorkspaceId: state.workspaceId,
        content: 'READER-DENIED-' + nonce,
      }, undefined, true), error => error.code === 'FORBIDDEN' && error.status === 403);
      evidence.readerDenied = { code: 'FORBIDDEN', status: 403 };
    });
    await check('reader automatic save blocks and never uses admin override', async () => {
      await save(restricted, 'reader.md', 'READER-DENIED-' + nonce);
      const status = await waitBinding(readerRpc, readerBinding.bindingId, value => value?.error?.code === 'FORBIDDEN');
      assert.equal(status.state, 'blocked');
      assert.ok((await pageRead(readerPage.id)).content.includes('REMOTE-INITIAL-' + nonce));
      assert.ok(!(await pageRead(readerPage.id)).content.includes('READER-DENIED-' + nonce));
      await readerRpc.close();
    });
    const readonly = await profile('writer', 'readonly'), readonlyPage = await createPage('readonly');
    await save(readonly, 'readonly.md', 'READONLY-INITIAL-' + nonce);
    const writableReadonly = await startRpc(readonly.env);
    const readonlyBinding = await call(writableReadonly, 'bind_markdown', { filePath: 'readonly.md', pageId: readonlyPage.id, enabled: true });
    await writableReadonly.close();
    await save(readonly, 'readonly.md', 'READONLY-MUST-NOT-UPLOAD-' + nonce);
    const readonlyRpc = await startRpc({ ...readonly.env, DOCMOST_READ_ONLY: '1' });
    await check('readonly discovery 11 exposes only sync status', async () => {
      const tools = (await readonlyRpc.send('tools/list')).result.tools;
      assert.equal(tools.length, 11); assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
      assert.ok(tools.some(tool => tool.name === 'get_markdown_sync_status'));
      assert.ok(!tools.some(tool => ['bind_markdown', 'set_markdown_sync', 'resolve_markdown_sync'].includes(tool.name)));
      evidence.readonlyDiscovery = 11;
    });
    await check('readonly restart with enabled binding never uploads local changes', async () => {
      const status = await allStatus(readonlyRpc);
      assert.equal(status.readOnly, true); assert.equal(status.bindings[0].bindingId, readonlyBinding.bindingId);
      await sleep(2200);
      assert.ok((await pageRead(readonlyPage.id)).content.includes('REMOTE-INITIAL-' + nonce));
      assert.ok(!(await pageRead(readonlyPage.id)).content.includes('READONLY-MUST-NOT-UPLOAD-' + nonce));
      await readonlyRpc.close();
    });
    const pin = await profile('writer', 'target-pin'), pinPage = await createPage('target-pin');
    await save(pin, 'pin.md', 'PIN-INITIAL-' + nonce);
    const pinRpc = await startRpc(pin.env);
    const pinBinding = await call(pinRpc, 'bind_markdown', { filePath: 'pin.md', pageId: pinPage.id, enabled: true });
    const pinState = await users.writer.api.post('pages/sync-state', { pageId: pinPage.id });
    await check('server rejects wrong workspace pin without overwriting', async () => {
      await assert.rejects(users.writer.api.post('pages/sync-update', {
        pageId: pinPage.id, content: 'WRONG-WORKSPACE-' + nonce, expectedRevision: pinState.revision,
        expectedSpaceId: pinState.spaceId, expectedWorkspaceId: randomUUID(),
      }, undefined, true), error => error.code === 'CONFLICT' && error.status === 409);
      assert.ok((await pageRead(pinPage.id)).content.includes('REMOTE-INITIAL-' + nonce));
    });
    await check('synthetic destination space setup with writer membership', async () => {
      const space = await call(users.admin.control, 'create_space', {
        name: 'MD pin acceptance ' + nonce, slug: 'md-pin-' + nonce, description: 'Synthetic loopback-only acceptance',
      });
      spaces.push(space);
      await direct(users.admin, 'spaces/members/add', { spaceId: space.id, role: 'writer', userIds: [users.writer.session.userId], groupIds: [] });
      await call(users.writer.control, 'move_page_to_space', { pageId: pinPage.id, spaceId: space.id });
      assert.equal((await pageRead(pinPage.id)).spaceId, space.id);
    });
    await check('server rejects old space pin after move and preserves body', async () => {
      await assert.rejects(users.writer.api.post('pages/sync-update', {
        pageId: pinPage.id, content: 'WRONG-SPACE-' + nonce, expectedRevision: pinState.revision,
        expectedSpaceId: pinState.spaceId, expectedWorkspaceId: pinState.workspaceId,
      }, undefined, true), error => error.code === 'CONFLICT' && error.status === 409);
      assert.ok((await pageRead(pinPage.id)).content.includes('REMOTE-INITIAL-' + nonce));
    });
    await check('moved bound target blocks automatic save', async () => {
      await save(pin, 'pin.md', 'MOVED-MUST-NOT-UPLOAD-' + nonce);
      const status = await waitBinding(pinRpc, pinBinding.bindingId, value => value?.error?.code === 'TARGET_CHANGED');
      assert.equal(status.state, 'blocked');
      assert.ok(!(await pageRead(pinPage.id)).content.includes('MOVED-MUST-NOT-UPLOAD-' + nonce));
    });
    await check('state and source remain private and contain no body or credentials', async () => {
      assert.equal((await stat(main.source)).mode & 0o777, 0o700);
      assert.equal((await stat(main.state)).mode & 0o777, 0o700);
      assert.equal((await stat(join(main.source, 'main.md'))).mode & 0o777, 0o600);
      const stored = await readFile(join(pin.state, 'bindings', pinBinding.bindingId + '.json'), 'utf8');
      assert.ok(!stored.includes('MOVED-MUST-NOT-UPLOAD-'));
      for (const user of Object.values(users)) assert.ok(!stored.includes(user.session.token));
      assert.ok(!stored.includes('password'));
    });
    evidence.success = true;
  }
} catch (error) {
  evidence.success = false; evidence.failures.push({ phase, ...errorRecord(error) });
  if (process.argv.includes('--prepare')) process.stdout.write(JSON.stringify({ prepared: false, failures: evidence.failures }) + '\n');
} finally {
  const errors = [];
  async function cleanup(label, operation) {
    try { await operation(); } catch (error) { errors.push({ phase: label, ...errorRecord(error) }); }
  }
  for (const editor of [...providers]) await cleanup('close collaboration provider', () => editor.close());
  for (const rpc of [...rpcs]) await cleanup('close stdio MCP', () => rpc.close());
  let trashed = 0, deletedSpaces = 0;
  for (const pageId of pages) await cleanup('trash synthetic page', async () => {
    await users.writer.api.post('pages/delete', { pageId, permanentlyDelete: false }, undefined, true); trashed++;
  });
  for (const space of spaces) await cleanup('delete synthetic space', async () => {
    await direct(users.admin, 'spaces/delete', { spaceId: space.id }); deletedSpaces++;
  });
  evidence.cleanup = { collaborationClosed: providers.size === 0, mcpClosed: rpcs.size === 0,
    pagesCreated: pages.size, pagesTrashed: trashed, spacesCreated: spaces.length,
    spacesDeleted: deletedSpaces, sessions: {} };
  for (const [role, user] of Object.entries(users)) {
    const result = { revoked: false, replayDenied401: false };
    await cleanup(role + ' logout and replay', async () => {
      await user.api.post('auth/logout', {}, undefined, true);
      result.revoked = true;
      await assert.rejects(user.api.post('users/me', {}), error => error.code === 'UNAUTHENTICATED' && error.status === 401);
      result.replayDenied401 = true;
    });
    evidence.cleanup.sessions[role] = result;
  }
  if (temporary) await cleanup('remove temporary sessions source and state', async () => {
    await rm(temporary, { recursive: true, force: true });
    evidence.cleanup.temporaryFilesDeleted = true;
  });
  evidence.cleanup.errors = errors;
  if (errors.length) evidence.success = false;
  evidence.completedAt = new Date().toISOString();
  evidence.passedChecks = evidence.checks.length;
  if (!process.argv.includes('--prepare')) {
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    await chmod(output, 0o600);
    process.stdout.write(JSON.stringify({ success: evidence.success, passedChecks: evidence.passedChecks,
      failures: evidence.failures, cleanup: evidence.cleanup }) + '\n');
  }
  if (evidence.success === false) process.exitCode = 1;
}
