#!/usr/bin/env node
// Isolated real-service acceptance. Never authenticates to company deployments.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loginSession, saveSession, logoutSession } from '../../packages/mcp/src/session.mjs';
import { loadConfig } from '../../packages/mcp/src/config.mjs';
import { createApiClient } from '../../packages/mcp/src/api.mjs';
import { loadOpenVikingConfig } from '../../packages/mcp/src/openviking-config.mjs';
import { createOpenVikingClient } from '../../packages/mcp/src/openviking-client.mjs';
import { connectMcp } from '../../packages/mcp/scripts/stdio-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesRoot = resolve(process.env.DOCMOST_ACCEPTANCE_FIXTURE_ROOT || root);
const mode = process.argv[2];
const coreOnly = process.argv.includes('--core-only');
assert.ok(['--prepare', '--run', '--resume'].includes(mode), 'Use --prepare, --run or --resume REPORT');
const digest = s => createHash('sha256').update(s).digest('hex');
const safeCode = e => /^[A-Z][A-Z_0-9]{0,79}$/.test(e?.code ?? '') ? e.code : e?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'ACCEPTANCE_FAILED';
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DOCMOST_') && !k.startsWith('GIT_')));
const report = { version: 1, runId: randomUUID(), startedAt: new Date().toISOString(), checks: [], resources: [], cleanup: {}, failures: [] };
let output, temporary, loginConfig, session, api, control, origin, proxy, priorReport, proxyBlocked = false;
const clients = new Set(), editors = new Set(), connections = new Map();
let phase = 'guards';
async function persist() { if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
async function check(label, fn) { phase = label; await fn(); report.checks.push({ phase: label, passed: true }); await persist(); process.stdout.write(JSON.stringify({ phase: label, passed: true }) + '\n'); }
async function eventually(fn, predicate, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await fn(); if (predicate(value)) return value; await delay(350); }
  const e = new Error(); e.code = 'ACCEPTANCE_TIMEOUT'; throw e;
}
async function direct(path, body) {
  assert.ok(['auth/collab-token', 'spaces/delete'].includes(path));
  const response = await fetch(new URL(path, loginConfig.apiBase), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { await response.body?.cancel(); const e = new Error(); e.code = 'LOCAL_DIRECT_API_FAILED'; e.status = response.status; throw e; }
  const payload = await response.json(); assert.equal(payload.success, true); return payload.data;
}
async function connect(env) { const c = await connectMcp(join(root, 'packages/mcp/dist/index.mjs'), env, { timeoutMs: 45000 }); clients.add(c); return c; }
async function close(c) { await c.close(); clients.delete(c); }
function git(repo, ...args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], { env: { ...cleanEnv, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function commit(p, text, file = p.file) { await writeFile(join(p.repo, file), text); git(p.repo, 'add', '--', file); git(p.repo, 'commit', '-qm', 'docs: update synthetic delivery original'); return git(p.repo, 'rev-parse', 'HEAD'); }
const args = (p, commit = git(p.repo, 'rev-parse', 'HEAD'), branch = git(p.repo, 'symbolic-ref', 'HEAD')) => ({ repositoryRoot: p.repo, commit, branch });
async function settled(p, knowledge = false) {
  return eventually(() => p.rpc.tool('get_git_document_status', { bindingId: p.bindingId }), s => s.state === 'synced' && !s.pending && (!knowledge || s.knowledgeBase?.state === 'synced'), knowledge ? 240000 : 30000);
}
async function publish(p, commitId) { const r = await p.rpc.tool('publish_git_documents', args(p, commitId)); assert.equal(r.documents[0].state, 'synced'); return settled(p); }
async function readPage(id) { return control.tool('get_page', { pageId: id }); }
async function newProfile(label, ovEnv) {
  const dir = join(temporary, label); await mkdir(dir, { mode: 0o700 });
  const scope = ovEnv.DOCMOST_OPENVIKING_SCOPE ?? 'core';
  let connection = connections.get(scope);
  const repo = join(dir, 'repo'), bare = join(dir, 'origin.git'), state = connection?.state ?? join(temporary, 'state-' + scope);
  await mkdir(repo, { mode: 0o700 }); git(repo, 'init', '-q', '-b', 'feature'); git(repo, 'config', 'user.name', 'Git Delivery Acceptance'); git(repo, 'config', 'user.email', 'acceptance@webmcp.test');
  git(repo, 'init', '-q', '--bare', bare); git(repo, 'remote', 'add', 'origin', bare);
  const page = await control.tool('create_page', { title: label, content: '# Synthetic Git delivery\n\nBaseline original.', spaceId: report.spaceId, parentPageId: report.parentId });
  const resource = { label, pageId: page.id, repo, bare, state, file: 'document.md', ...(ovEnv.DOCMOST_OPENVIKING_SCOPE ? { knowledgeScope: ovEnv.DOCMOST_OPENVIKING_SCOPE } : {}) }; report.resources.push(resource); await persist();
  const original = (await readPage(page.id)).content; const first = await commit(resource, original);
  git(repo, 'branch', 'qa'); git(repo, 'push', '-q', '-u', 'origin', 'feature', 'qa');
  const converting = scope === 'core' && !connection;
  const env = connection?.env ?? { ...control.env, ...ovEnv, DOCMOST_KNOWLEDGE_STATE_DIR: state,
    ...(converting ? { DOCMOST_SYNC_ROOT: repo, DOCMOST_SYNC_STATE_DIR: state } : {}) };
  if (!connection) { connection = { env, state, rpc: await connect(env) }; connections.set(scope, connection); }
  const rpc = connection.rpc;
  Object.defineProperties(resource, { rpc: { get: () => connection.rpc, set: value => { connection.rpc = value; }, enumerable: false }, env: { value: env, enumerable: false } });
  const old = converting ? await rpc.tool('bind_markdown', { filePath: resource.file, pageId: page.id, enabled: true }) : undefined;
  const bound = await rpc.tool('bind_git_document', { repositoryRoot: repo, filePath: resource.file, pageId: page.id, commit: first, branch: 'refs/heads/feature', ...(old ? { replaceBindingId: old.bindingId } : {}) });
  if (old) { assert.equal(bound.bindingId, old.bindingId); assert.equal(bound.source, 'git'); resource.sourceConversion = { sameBinding: true, previousSource: 'markdown', currentSource: 'git' }; }
  resource.bindingId = bound.bindingId; resource.first = first;
  // Never serialize environment/session/client objects into the evidence.
  await persist(); return resource;
}
async function openEditor(pageId) {
  const req = createRequire(join(fixturesRoot, 'package.json')), serverReq = createRequire(join(fixturesRoot, 'apps/server/package.json'));
  const { HocuspocusProvider } = req('@hocuspocus/provider'), Y = req('yjs'), WebSocket = serverReq('ws');
  const { token } = await direct('auth/collab-token', {}), document = new Y.Doc();
  let done, fail; const synced = new Promise((y, n) => { done = y; fail = n; });
  const provider = new HocuspocusProvider({ url: origin.replace(/^http/, 'ws') + '/collab', name: 'page.' + pageId, document, token, WebSocketPolyfill: WebSocket,
    onSynced: ({ state }) => { if (state) done(); }, onAuthenticationFailed: () => fail(new Error('COLLAB_AUTH_FAILED')) });
  const editor = { async close() { const socket = provider.configuration.websocketProvider.webSocket; provider.destroy(); document.destroy(); if (socket && socket.readyState !== WebSocket.CLOSED) await Promise.race([new Promise(r => socket.once('close', r)), delay(3000).then(() => socket.terminate())]); editors.delete(editor); },
    append(text) { document.transact(() => { const p = new Y.XmlElement('paragraph'); p.setAttribute('id', randomUUID()); const t = new Y.XmlText(); t.insert(0, text); p.insert(0, [t]); const f = document.getXmlFragment('default'); f.insert(f.length, [p]); }); } };
  editors.add(editor); await Promise.race([synced, delay(10000).then(() => { throw new Error('COLLAB_TIMEOUT'); })]); return editor;
}
async function cleanup() {
  for (const editor of [...editors]) try { await editor.close(); } catch (e) { report.failures.push({ phase: 'close editor', code: safeCode(e) }); }
  // Delete through each owning connection so its exact knowledge mirror is retired.
  for (const p of [...report.resources].reverse()) {
    try {
      if (!p.rpc && p.env) p.rpc = await connect(p.env);
      await (p.rpc ?? control).tool('delete_page', { pageId: p.pageId });
      if (p.bindingId && p.knowledgeScope) {
        const s = await eventually(async () => (await p.rpc.tool('get_git_document_status')).bindings.find(b => b.bindingId === p.bindingId), s => s.knowledgeBase?.state === 'deleted', 240000);
        if (p.uri && p.ov) assert.equal(await p.ov.read(p.uri), undefined); p.cleanup = { docmostDeleted: true, originalRemoved: Boolean(p.uri && p.ov), state: s.knowledgeBase.state };
        if (p.uri && p.ov) {
          const namespace = (await p.ov.identity()).rootUri + '/Git验收-' + report.runId.slice(0, 8);
          assert.ok(p.uri.startsWith(namespace + '/'));
          await p.ov.remove(namespace, { recursive: true }); assert.equal(await p.ov.list(namespace), undefined); p.cleanup.testNamespaceRemoved = true;
        }
      } else p.cleanup = { docmostDeleted: true };
    } catch (e) { report.failures.push({ phase: 'cleanup ' + p.label, code: safeCode(e) }); }
  }
  for (const c of [...clients]) try { await close(c); } catch (e) { report.failures.push({ phase: 'close MCP', code: safeCode(e) }); }
  if (report.spaceId && api) try { await direct('spaces/delete', { spaceId: report.spaceId }); report.cleanup.spaceDeleted = true; } catch (e) { report.failures.push({ phase: 'delete test space', code: safeCode(e) }); }
  if (session) try { await logoutSession(loginConfig, session); report.cleanup.sessionRevoked = true; if (temporary) await rm(join(temporary, 'auth'), { recursive: true, force: true }); report.cleanup.sessionFileRemoved = true; } catch (e) { report.failures.push({ phase: 'revoke session', code: safeCode(e) }); }
  if (proxy) { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); }
  report.cleanup.mcpClosed = clients.size === 0; report.cleanup.collaborationClosed = editors.size === 0;
}

try {
  const fixture = JSON.parse(await readFile(join(fixturesRoot, 'data/local-docmost/fixtures.json'), 'utf8'));
  const accounts = JSON.parse(await readFile(join(fixturesRoot, 'data/local-docmost/accounts.json'), 'utf8'));
  const url = new URL(fixture.apiUrl); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); assert.equal(url.protocol, 'http:'); assert.equal(url.pathname, '/'); assert.ok(!url.username && !url.password && !url.search && !url.hash);
  origin = url.origin; assert.equal(new URL(accounts.apiUrl).origin, origin); assert.equal(accounts.workspaceId, fixture.workspaceId); assert.equal(accounts.admin.email, 'admin@webmcp.test');
  const health = await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(5000) }); assert.equal(health.status, 200); await health.body?.cancel();
  let ovEnv, ovConfig, identity;
  if (!coreOnly) {
    if (!process.env.DOCMOST_ACCEPTANCE_OV_PROFILE) { const e = new Error(); e.code = 'ACCEPTANCE_OV_PROFILE_REQUIRED'; throw e; }
    ovEnv = JSON.parse(await readFile(process.env.DOCMOST_ACCEPTANCE_OV_PROFILE, 'utf8'));
    assert.ok(Object.keys(ovEnv).every(k => k.startsWith('DOCMOST_OPENVIKING_')));
    ovConfig = loadOpenVikingConfig(ovEnv); assert.ok(ovConfig && !ovConfig.error); identity = await createOpenVikingClient(ovConfig).identity();
  }
  if (mode === '--prepare') { process.stdout.write(JSON.stringify({ prepared: true, origin, openViking: coreOnly ? 'skipped' : { origin: ovConfig.origin, userId: identity.userId }, writes: 0 }) + '\n'); }
  else {
    // Resume is reconciliation-only: do not replay unknown mutations from an earlier process.
    if (mode === '--resume') { priorReport = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')); assert.equal(priorReport.version, 1); assert.equal(priorReport.origin, origin); assert.ok(/^[0-9a-f-]{36}$/.test(priorReport.runId)); assert.ok(priorReport.finishedAt); assert.ok(priorReport.resources.every(p => p.cleanup?.docmostDeleted && (!p.knowledgeScope || p.cleanup.originalRemoved))); report.previousRunId = priorReport.runId; }
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'docmost-git-delivery-'))); await chmod(temporary, 0o700);
    const reportDir = join(root, 'data/local-docmost', 'git-delivery-' + report.runId); await mkdir(reportDir, { recursive: true, mode: 0o700 }); output = join(reportDir, 'report.json');
    report.origin = origin; report.temporary = temporary; report.gitRemote = 'isolated local bare, no GitHub authentication claim';
    loginConfig = { origin, apiBase: origin + '/api/', timeoutMs: 15000, allowLocalHttp: true };
    session = await loginSession(loginConfig, { email: accounts.admin.email, password: accounts.admin.password });
    const sessionFile = join(temporary, 'auth/session.json'); await saveSession(sessionFile, session);
    const env = { ...cleanEnv, DOCMOST_URL: origin, DOCMOST_AUTH_MODE: 'session', DOCMOST_SESSION_FILE: sessionFile, DOCMOST_ALLOW_LOCAL_HTTP: '1', DOCMOST_DEFAULT_SPACE_ID: fixture.spaces.shared.id, DOCMOST_KNOWLEDGE_PROVIDER: 'none' };
    const config = await loadConfig(env); api = createApiClient(config); control = await connect(env); control.env = env;
    await check('fresh local user identity', async () => { const who = await control.tool('get_current_user'); assert.equal(who.user.id, fixture.users.admin.id); assert.equal(who.workspace.id, fixture.workspaceId); });
    if (priorReport && !priorReport.cleanup.spaceDeleted) {
      const oldSpace = await control.tool('get_space', { spaceId: priorReport.spaceId });
      assert.equal(oldSpace.slug, 'git-' + priorReport.runId); await direct('spaces/delete', { spaceId: priorReport.spaceId }); report.cleanup.priorSpaceDeleted = true;
    }
    const space = await control.tool('create_space', { name: 'Git验收-' + report.runId.slice(0, 8), slug: 'git-' + report.runId }); report.spaceId = space.id; await persist();
    const parent = await control.tool('create_page', { title: '文档父目录', content: '# Parent', spaceId: space.id, parentPageId: null }); report.parentId = parent.id; await persist();
    const p = await newProfile('Git固定快照', {});
    const other = await newProfile('另一个项目', {});
    await check('feature commit before push excludes dirty working tree', async () => {
      const text = '# Git delivery original\n\nCommitted first section.\n\nCommitted second section.\n';
      p.a = await commit(p, text); await writeFile(join(p.repo, p.file), '# Never upload dirty draft\n');
      await delay(1500); assert.ok((await readPage(p.pageId)).content.includes('Baseline original.'));
      await publish(p, p.a);
      assert.equal(git(p.repo, '--git-dir', p.bare, 'rev-parse', 'refs/heads/feature'), p.first);
      const page = await readPage(p.pageId); assert.ok(page.content.includes('Committed second section.')); assert.ok(!page.content.includes('dirty draft'));
      assert.ok((await readPage(other.pageId)).content.includes('Baseline original.'));
      p.committedHash = digest(text); p.docmostSavedHash = digest(page.content);
    });
    await check('same rootless MCP process isolates concurrent projects and rejects mixed binding batches', async () => {
      assert.equal(p.rpc, other.rpc); assert.equal(p.env.DOCMOST_GIT_ROOT, undefined); assert.equal(p.state, other.state);
      const a = '# Project A\n\nCommitted second section.\n\nA-' + report.runId + '\n', b = '# Project B\n\nB-' + report.runId + '\n';
      p.a = await commit(p, a); const otherCommit = await commit(other, b);
      const before = await Promise.all([readPage(p.pageId), readPage(other.pageId)]);
      await assert.rejects(p.rpc.tool('publish_git_documents', { ...args(p), bindingIds: [p.bindingId, other.bindingId] }), { code: 'TARGET_CHANGED' });
      const after = await Promise.all([readPage(p.pageId), readPage(other.pageId)]); assert.deepEqual(after.map(x => x.content), before.map(x => x.content));
      await Promise.all([publish(p), publish(other)]);
      const pages = await Promise.all([readPage(p.pageId), readPage(other.pageId)]);
      assert.ok(pages[0].content.includes('A-' + report.runId) && !pages[0].content.includes('B-' + report.runId));
      assert.ok(pages[1].content.includes('B-' + report.runId) && !pages[1].content.includes('A-' + report.runId));
      const scoped = await p.rpc.tool('get_git_document_status', { repositoryRoot: p.repo }); assert.deepEqual(scoped.bindings.map(x => x.bindingId), [p.bindingId]);
      report.multiProject = { sameProcess: true, processId: p.rpc.child.pid, sameLedger: true, noConfiguredGitRoot: true, mixedBatchRejectedWithoutWrites: true, otherCommit };
    });
    await check('two live stdio processes release finite locks and reuse the newest Git baseline', async () => {
      const peer = await connect(p.env);
      try {
        const before = (await readPage(p.pageId)).content;
        const reply = await peer.tool('publish_git_documents', args(p, p.a)); assert.equal(reply.documents[0].state, 'synced');
        assert.equal((await readPage(p.pageId)).content, before);
        p.a = await commit(p, before + '\nPeer process committed update.\n');
        const updated = await peer.tool('publish_git_documents', args(p, p.a)); assert.equal(updated.documents[0].state, 'synced');
        const same = await p.rpc.tool('publish_git_documents', args(p, p.a)); assert.equal(same.documents[0].git.published.commit, p.a); assert.equal(same.documents[0].state, 'synced');
        assert.equal(peer.child.exitCode, null); assert.equal(p.rpc.child.exitCode, null);
        assert.deepEqual(await readdir(join(p.state, 'leases')), []); assert.deepEqual(await readdir(join(p.state, 'operations')), []);
        report.operationLocks = { bothProcessesConnected: true, idlePageLocks: 0, idleOperationTickets: 0, latestBaselineReused: true };
      } finally { await close(peer); }
    });
    await check('legacy default-root invocation then rootless restart preserves both project bindings', async () => {
      await close(p.rpc);
      const legacy = await connect({ ...p.env, DOCMOST_GIT_ROOT: p.repo });
      try {
        const r = await legacy.tool('publish_git_documents', { commit: p.a, branch: 'refs/heads/feature' }); assert.equal(r.documents.length, 1); assert.equal(r.documents[0].bindingId, p.bindingId);
      } finally { await close(legacy); }
      p.rpc = await connect(p.env);
      const all = await p.rpc.tool('get_git_document_status'); assert.deepEqual(all.bindings.map(x => x.bindingId).sort(), [p.bindingId, other.bindingId].sort());
      assert.equal((await settled(p)).git.published.commit, p.a); await settled(other);
      report.legacyRecovery = { sameLedgerAndBindingIds: true, noManualMigration: true, removedDefaultRoot: true };
    });
    await check('older unpinned record pauses and explicitly confirms its original repository without a page write', async () => {
      await close(p.rpc);
      const filename = join(p.state, 'bindings', p.bindingId + '.json'), saved = JSON.parse(await readFile(filename, 'utf8'));
      delete saved.git.instance; delete saved.git.prefix; await writeFile(filename, JSON.stringify(saved), { mode: 0o600 });
      p.rpc = await connect(p.env);
      const before = (await readPage(p.pageId)).content, pending = await p.rpc.tool('get_git_document_status', { bindingId: p.bindingId }); assert.equal(pending.error.code, 'GIT_IDENTITY_UNCONFIRMED');
      const trusted = await p.rpc.tool('set_git_document_sync', { bindingId: p.bindingId, action: 'confirm-repository', repositoryRoot: p.repo });
      assert.equal(trusted.bindingId, p.bindingId); assert.equal(trusted.state, 'synced'); assert.equal(trusted.git.published.commit, p.a); assert.equal((await readPage(p.pageId)).content, before);
      report.legacyRecovery.explicitFirstTrust = true;
    });
    await check('divergent branch pauses same page then merged ancestry publishes', async () => {
      git(p.repo, 'restore', '--', p.file); git(p.repo, 'checkout', '-qb', 'parallel', p.first); p.b = await commit(p, '# Parallel branch original\n');
      const r = await p.rpc.tool('publish_git_documents', args(p)); assert.equal(r.documents[0].error.code, 'GIT_BRANCH_CONFLICT'); assert.equal((await p.rpc.tool('get_git_document_status', { repositoryRoot: p.repo })).bindings.length, 1);
      assert.ok((await readPage(p.pageId)).content.includes('Committed second section.'));
      try { git(p.repo, 'merge', '--no-commit', 'feature'); } catch { /* Expected content conflict; explicit synthetic merge follows. */ }
      p.merged = await commit(p, '# Merged branch original\n\nBoth branch changes accepted.\n'); await publish(p);
      git(p.repo, 'push', '-q', 'origin', 'parallel'); git(p.repo, 'checkout', '-q', 'qa'); git(p.repo, 'merge', '--ff-only', 'parallel');
      await publish(p); git(p.repo, 'push', '-q', 'origin', 'qa');
      const receipt = await p.rpc.tool('publish_git_documents', { ...args(p), remote: 'origin' }); assert.equal(receipt.pushReceipt.state, 'confirmed'); assert.equal(git(p.repo, '--git-dir', p.bare, 'rev-parse', 'refs/heads/qa'), p.merged);
    });
    await check('authenticated live collaboration edit causes CAS pause and explicit resolution', async () => {
      const editor = await openEditor(p.pageId); editor.append('WEB-CONFLICT-' + report.runId);
      const live = await eventually(() => p.rpc.tool('get_git_document_status', { bindingId: p.bindingId }), s => s.currentRevision !== s.remoteRevision, 10000);
      p.liveCollaboration = { authenticated: true, changedLiveRevision: live.currentRevision !== live.remoteRevision };
      const r = await p.rpc.tool('publish_git_documents', args(p)); assert.equal(r.documents[0].error.code, 'CONFLICT');
      const current = await p.rpc.tool('get_git_document_status', { bindingId: p.bindingId });
      const merged = await commit(p, '# Resolved original\n\nWeb and Git edit reconciled.\n');
      await p.rpc.tool('resolve_git_document_conflict', { repositoryRoot: p.repo, bindingId: p.bindingId, commit: merged, branch: 'refs/heads/qa', expectedRevision: current.currentRevision }); await settled(p);
      await editor.close();
      assert.ok((await readPage(p.pageId)).content.includes('Web and Git edit reconciled.'));
    });
    await check('rename and restart preserve binding; source deletion preserves remote', async () => {
      await rename(join(p.repo, p.file), join(p.repo, 'renamed.md')); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'docs: rename synthetic original'); p.file = 'renamed.md';
      const s = await publish(p); assert.equal(s.filePath, p.file); assert.equal(s.bindingId, p.bindingId);
      await close(p.rpc); p.rpc = await connect(p.env); assert.equal((await settled(p)).filePath, p.file);
      await rm(join(p.repo, p.file)); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'docs: remove local synthetic source');
      const r = await p.rpc.tool('publish_git_documents', args(p)); assert.equal(r.documents[0].error.code, 'GIT_SOURCE_DELETED'); assert.ok((await readPage(p.pageId)).content.includes('reconciled'));
    });
    if (!coreOnly) {
    // Fault proxy targets exactly the already-authorized service; no content is forwarded while blocked.
    proxy = createServer(async (req, res) => {
      try {
        if (proxyBlocked) { req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"status":"error"}'); return; }
        const target = new URL(req.url, ovConfig.origin); assert.equal(target.origin, ovConfig.origin);
        const chunks = []; for await (const c of req) chunks.push(c);
        const response = await fetch(target, { method: req.method, headers: { 'X-API-Key': req.headers['x-api-key'], 'Content-Type': 'application/json' }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: 'error', signal: AbortSignal.timeout(120000) });
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    for (const scope of ['personal', 'shared']) await check(scope + ' real OpenViking complete original, processing and retry', async () => {
      const kEnv = { ...ovEnv, DOCMOST_OPENVIKING_URL: `http://127.0.0.1:${proxy.address().port}`, DOCMOST_OPENVIKING_SCOPE: scope, DOCMOST_KNOWLEDGE_PROVIDER: 'openviking' }; delete kEnv.DOCMOST_OPENVIKING_ROOT_URI;
      const k = await newProfile('知识库-' + scope, kEnv); k.knowledgeScope = scope;
      const realConfig = loadOpenVikingConfig({ ...kEnv, DOCMOST_OPENVIKING_URL: ovConfig.origin });
      Object.defineProperty(k, 'ov', { value: createOpenVikingClient(realConfig), enumerable: false }); await k.ov.identity();
      let s = await settled(k, true); k.uri = s.knowledgeBase.uri;
      const text = '# Git delivery knowledge original\n\nSynthetic branch delivery keeps the complete Markdown source.\n\nSecond section marker ' + report.runId + '\n';
      k.commit = await commit(k, text); proxyBlocked = scope === 'personal';
      await publish(k); assert.ok((await readPage(k.pageId)).content.includes('Second section marker'));
      if (proxyBlocked) { s = await eventually(() => k.rpc.tool('get_git_document_status', { bindingId: k.bindingId }), s => Boolean(s.knowledgeBase?.error), 30000); k.injectedFailure = s.knowledgeBase.error.code; proxyBlocked = false; await k.rpc.tool('retry_knowledge_sync', { bindingId: k.bindingId }); }
      s = await settled(k, true); k.uri = s.knowledgeBase.uri; k.originalHash = digest(text); assert.equal(digest(await k.ov.read(k.uri)), k.originalHash);
      k.tasks = await k.ov.tasks(k.uri.slice(0, k.uri.lastIndexOf('/'))); assert.ok(k.tasks.some(t => t.status === 'completed' && t.failedRecords === 0));
      assert.ok(k.uri.includes('/' + space.name + '/文档父目录/')); assert.ok(scope === 'personal' ? k.uri.startsWith('viking://user/') : k.uri.startsWith('viking://resources/'));
      k.knowledgeResult = { state: s.knowledgeBase.state, uri: k.uri, completeOriginalHash: k.originalHash };
      await writeFile(join(k.repo, k.file), '# Dirty content excluded during retry\n'); await k.rpc.tool('retry_knowledge_sync', { bindingId: k.bindingId }); assert.equal(digest(await k.ov.read(k.uri)), k.originalHash);
    });
    }
  }
} catch (e) { report.failures.push({ phase, code: safeCode(e), ...(Number.isInteger(e.status) ? { status: e.status } : {}) }); if (mode === '--prepare') process.stdout.write(JSON.stringify({ prepared: false, failures: report.failures }) + '\n'); process.exitCode = 1; }
finally {
  if (mode !== '--prepare') {
    proxyBlocked = false; await cleanup(); report.finishedAt = new Date().toISOString(); await persist();
    process.stdout.write(JSON.stringify({ report: output, checks: report.checks.length, failures: report.failures, cleanup: report.cleanup }) + '\n'); if (report.failures.length) process.exitCode = 1;
  }
}
