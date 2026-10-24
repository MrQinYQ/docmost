import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, realpath, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownSync } from '../src/sync.mjs';

const pageId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';
const parentId = '00000000-0000-4000-8000-000000000005';
const otherId = '00000000-0000-4000-8000-000000000006';
const hash = value => createHash('sha256').update(value).digest('hex');
const rootUri = 'viking://user/test/resources/docmost-mcp';

async function fixture(t, { readOnly = false, offline = false, scanMs = 10, rootUri = 'viking://user/test/resources/docmost-mcp' } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'docmost-page-source-')));
  const config = { origin: 'https://docmost.test', knowledgeStateDir: join(temp, 'state'), readOnly,
    knowledgeBase: { provider: 'openviking', config: { origin: 'http://127.0.0.1:1933', rootUri } } };
  const pages = new Map([
    [pageId, { id: pageId, workspaceId, spaceId, title: 'A Page', parentPageId: parentId,
      content: '# Full original\n\nFirst paragraph.\n\n## Second section\n\nLast paragraph.\n', deletedAt: null,
      permissions: { canEdit: false, hasRestriction: true } }],
    [parentId, { id: parentId, workspaceId, spaceId, title: 'Parent', parentPageId: null, content: '# Parent\n', deletedAt: null }],
    [otherId, { id: otherId, workspaceId, spaceId, title: 'Unregistered', parentPageId: parentId, content: '# Other\n', deletedAt: null }],
  ]);
  const resources = new Map(), directories = new Set(), tasks = new Map(), writes = [], calls = [];
  const state = { offline, userId, workspaceId };
  const api = { async post(path, input) {
    calls.push({ path, input });
    if (path === 'users/me') return { user: { id: state.userId }, workspace: { id: state.workspaceId } };
    if (path === 'pages/info') {
      if (state.failInfo) throw Object.assign(new Error('synthetic temporary read failure'), { code: 'NETWORK_ERROR' });
      const value = pages.get(input.pageId);
      if (!value) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND', status: 404 });
      return structuredClone(value);
    }
    if (path === 'spaces/info') return { id: spaceId, workspaceId, name: 'Space' };
    throw Object.assign(new Error('Original deployment has no conditional sync endpoints'), { code: 'UNSUPPORTED_DEPLOYMENT', status: 404 });
  } };
  function addDirectory(uri) {
    while (uri.startsWith(rootUri)) { directories.add(uri); if (uri === rootUri) break; uri = uri.slice(0, uri.lastIndexOf('/')); }
  }
  let serial = 0;
  const client = {
    async identity() {
      if (state.offline) throw Object.assign(new Error('synthetic offline'), { code: 'OV_NETWORK_ERROR' });
      return { accountId: 'personal', userId: 'test', rootUri };
    },
    async read(uri) { return resources.get(uri); },
    async write(uri, content) { writes.push({ uri, content }); resources.set(uri, content); addDirectory(uri.slice(0, uri.lastIndexOf('/'))); },
    async reindex(uri, mode) {
      if (mode === 'prune_orphans' && !resources.has(uri) && !directories.has(uri)) addDirectory(uri);
      const taskId = `page_task_${++serial}`;
      tasks.set(taskId, { taskId, uri, status: 'completed', failedRecords: 0, unsupportedRecords: 0 });
      return { taskId };
    },
    async task(id) { return tasks.get(id); }, async tasks() { return []; }, async waitProcessed() { return {}; },
    async list(uri) {
      if (!directories.has(uri)) return undefined;
      const direct = candidate => candidate.startsWith(uri + '/') && !candidate.slice(uri.length + 1).includes('/');
      return [...[...resources.keys()].filter(direct).map(value => ({ name: value.slice(uri.length + 1), uri: value, isDir: false })),
        ...[...directories].filter(direct).map(value => ({ name: value.slice(uri.length + 1), uri: value, isDir: true }))];
    },
    async remove(uri, { recursive = false } = {}) {
      resources.delete(uri);
      if (recursive) {
        for (const key of resources.keys()) if (key.startsWith(uri + '/')) resources.delete(key);
        for (const key of directories) if (key === uri || key.startsWith(uri + '/')) directories.delete(key);
      }
      return { semanticStatus: 'complete' };
    },
  };
  const managers = [];
  const create = (overrides = {}) => {
    const manager = createMarkdownSync({ ...config, ...overrides }, { api, mirrorClient: client, scanMs, debounceMs: 10 });
    managers.push(manager); return manager;
  };
  const manager = create(); await manager.start();
  t.after(async () => { for (const value of managers) await value.close(); await rm(temp, { recursive: true, force: true }); });
  return { manager, create, config, pages, state, resources, tasks, writes, calls, temp, api };
}
async function eventually(read, predicate) {
  const deadline = Date.now() + 3000;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail(`Page knowledge state did not settle: ${JSON.stringify(value)}`);
}
const settled = (manager, id = pageId) => eventually(() => manager.pageStatus({ pageId: id }), value => value.knowledgeBase?.state === 'synced');

test('an existing readable page keeps its complete Markdown and hierarchy without a local root or sync endpoints', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.manager.syncPage, 'function');
  const result = await f.manager.syncPage({ pageId });
  assert.equal(result.source, 'docmost');
  const complete = await settled(f.manager);
  assert.match(complete.knowledgeBase.uri, /Space\/Parent\/A-Page\/document\.md$/);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), f.pages.get(pageId).content);
  assert.equal(complete.knowledgeBase.confirmedRevision, hash(f.pages.get(pageId).content));
  assert.ok(f.calls.some(call => call.path === 'pages/info' && call.input.format === 'markdown'));
  assert.equal(f.calls.some(call => call.path.includes('sync-')), false);
  assert.equal(f.calls.some(call => !['pages/info', 'users/me', 'spaces/info'].includes(call.path)), false);
  const stored = JSON.parse(await readFile(join(f.config.knowledgeStateDir, 'bindings', result.bindingId + '.json'), 'utf8'));
  assert.equal(stored.source, 'docmost'); assert.equal(stored.filePath, undefined); assert.equal(stored.root, undefined);
  assert.equal(JSON.stringify(complete).includes('First paragraph'), false, 'status must not leak exported Markdown');
  assert.equal(f.resources.size, 1, 'ancestors and nearby pages are not enrolled or exported');
});

test('a successful MCP refresh exports only enrolled pages and updates a changed body', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId });
  const first = await settled(f.manager);
  f.pages.get(pageId).content = '# Updated\n\nThe whole updated body.\n';
  await f.manager.refreshPageMirrors({ pageId, includeDescendants: false });
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.confirmedRevision === hash(f.pages.get(pageId).content));
  assert.equal(f.resources.get(first.knowledgeBase.uri), '# Updated\n\nThe whole updated body.\n');
  await f.manager.refreshPageMirrors({ pageId: otherId, includeDescendants: true });
  assert.equal((await f.manager.pageStatus()).bindings.length, 1);
  assert.equal(f.resources.size, 1);
});

test('pending page exports survive restart and never call a local-file or conditional-sync path', async t => {
  const f = await fixture(t, { offline: true });
  const result = await f.manager.syncPage({ pageId });
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'retrying');
  await f.manager.close(); f.state.offline = false;
  const restarted = f.create(); await restarted.start();
  await restarted.retryKnowledge({ bindingId: result.bindingId });
  const complete = await settled(restarted);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), f.pages.get(pageId).content);
  assert.equal(f.calls.some(call => call.path.includes('sync-')), false);
});

test('a parent rename refreshes enrolled descendants while preserving full documents', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId });
  const first = await settled(f.manager);
  f.pages.get(parentId).title = 'Renamed parent';
  await f.manager.refreshPageMirrors({ pageId: parentId, includeDescendants: true });
  const complete = await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'synced' && value.knowledgeBase.uri !== first.knowledgeBase.uri);
  assert.match(complete.knowledgeBase.uri, /Renamed-parent\//);
  assert.equal(f.resources.has(first.knowledgeBase.uri), false);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), f.pages.get(pageId).content);
});

test('explicit delete and restore reuse durable deletion without a local Markdown source', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId });
  const first = await settled(f.manager);
  await f.manager.capturePageUpdate({ pageId });
  const deletion = await f.manager.beforePageOperation({ kind: 'delete', pageId: parentId });
  f.pages.get(parentId).deletedAt = f.pages.get(pageId).deletedAt = '2026-10-15T00:00:00Z';
  await f.manager.afterPageOperation(deletion);
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'deleted');
  assert.equal(f.resources.has(first.knowledgeBase.uri), false);
  const restoration = await f.manager.beforePageOperation({ kind: 'restore', pageId: parentId });
  f.pages.get(parentId).deletedAt = f.pages.get(pageId).deletedAt = null;
  await f.manager.afterPageOperation(restoration);
  const complete = await settled(f.manager);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), f.pages.get(pageId).content);
});

test('page export is idempotent and rejects identity changes before transferring source content', async t => {
  const f = await fixture(t);
  const first = await f.manager.syncPage({ pageId }); await settled(f.manager);
  const again = await f.manager.syncPage({ pageId });
  assert.equal(again.bindingId, first.bindingId); assert.equal((await f.manager.pageStatus()).bindings.length, 1);
  const count = f.writes.length; f.state.userId = otherId;
  f.pages.get(pageId).content = '# New private source\n';
  await f.manager.refreshPageMirrors({ pageId });
  assert.equal(f.writes.length, count);
  assert.equal((await f.manager.pageStatus({ pageId })).error.code, 'IDENTITY_CHANGED');
});

test('page sync protects a live legacy owner without reading source or changing its lease', async t => {
  const f = await fixture(t); const binding = await f.manager.syncPage({ pageId }); await settled(f.manager);
  const ledgerPath = join(f.config.knowledgeStateDir, 'bindings', binding.bindingId + '.json');
  const leasePath = join(f.config.knowledgeStateDir, 'leases', hash(`${f.config.origin}|${workspaceId}|${pageId}`) + '.json');
  await eventually(async () => (await readdir(join(f.config.knowledgeStateDir, 'leases'))).length, value => value === 0);
  const ownedLease = JSON.stringify({ pid: process.pid, nonce: 'live-legacy-page-owner' });
  await writeFile(leasePath, ownedLease, { mode: 0o600 });
  await eventually(async () => JSON.parse(await readFile(ledgerPath, 'utf8')), value => value.mirror.state === 'synced' && !value.mirror.pending);
  const ledger = await readFile(ledgerPath, 'utf8');
  const duplicate = f.create(); await duplicate.start();
  assert.equal((await duplicate.pageStatus({ pageId })).error.code, 'LEASE_BUSY');
  const callCount = f.calls.length, writeCount = f.writes.length;
  await assert.rejects(duplicate.syncPage({ pageId }), { code: 'LEASE_BUSY' });
  assert.equal(f.calls.length, callCount, 'a process without the lease cannot read or publish this source');
  assert.equal(f.writes.length, writeCount);
  assert.equal(await readFile(ledgerPath, 'utf8'), ledger);
  assert.equal(await readFile(leasePath, 'utf8'), ownedLease);
});

test('read-only page knowledge status never creates storage or dispatches a source read', async t => {
  const f = await fixture(t, { readOnly: true });
  assert.equal(typeof f.manager.pageStatus, 'function');
  assert.deepEqual((await f.manager.pageStatus()).bindings, []);
  await assert.rejects(f.manager.syncPage({ pageId }), { code: 'READ_ONLY' });
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.temp), []);
});

test('a body-update intent survives restart and cannot report old persisted content as the new result', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); await settled(f.manager);
  assert.equal(typeof f.manager.capturePageUpdate, 'function');
  const ticket = await f.manager.capturePageUpdate({ pageId });
  assert.equal(ticket.previousHash, hash(f.pages.get(pageId).content));
  await f.manager.refreshPageMirrors({ pageId, expectedPreviousHash: ticket.previousHash });
  const pending = await f.manager.pageStatus({ pageId });
  assert.equal(pending.knowledgeBase.state, 'waiting_docmost');
  assert.equal(pending.openViking.state, 'waiting_docmost');
  await f.manager.close();
  const restarted = f.create(); await restarted.start();
  assert.equal((await restarted.pageStatus({ pageId })).knowledgeBase.state, 'waiting_docmost');
  f.pages.get(pageId).content = '# Persisted later\n\nComplete new body.\n';
  const complete = await settled(restarted);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), '# Persisted later\n\nComplete new body.\n');
  assert.equal(complete.knowledgeBase.confirmedRevision, hash('# Persisted later\n\nComplete new body.\n'));
});

test('a definite rejected update cancels only its own durable refresh intent', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); await settled(f.manager);
  const oldTicket = await f.manager.capturePageUpdate({ pageId });
  f.pages.get(pageId).content = '# The earlier write persisted\n';
  const currentTicket = await f.manager.capturePageUpdate({ pageId });
  await f.manager.cancelPageUpdate(oldTicket);
  assert.equal((await f.manager.pageStatus({ pageId })).knowledgeBase.state, 'waiting_docmost');
  await f.manager.cancelPageUpdate(currentTicket);
  await settled(f.manager);
});

test('a page-only manager retains dormant MD ledgers and cannot enroll the same page from a second source', async t => {
  const f = await fixture(t); await f.manager.close();
  const oldBinding = { version: 1, bindingId: otherId, filePath: 'note.md', pageId, spaceId, workspaceId, userId,
    origin: f.config.origin, root: join(f.temp, 'dormant-md-root'), enabled: true, state: 'synced',
    localHash: hash('old MD source'), remoteRevision: hash('old conditional revision') };
  const filename = join(f.config.knowledgeStateDir, 'bindings', otherId + '.json');
  await writeFile(filename, JSON.stringify(oldBinding), { mode: 0o600 });
  const restarted = f.create(); await restarted.start();
  assert.equal((await restarted.pageStatus()).state, 'running');
  await assert.rejects(restarted.syncPage({ pageId }), { code: 'BINDING_EXISTS' });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), oldBinding);
});

test('denied, non-Markdown or oversized source responses never enqueue an export', async t => {
  const f = await fixture(t);
  for (const change of [{ permissions: { read: false } }, { content: { type: 'doc' } }, { content: 'x'.repeat(1_000_001) }]) {
    const before = structuredClone(f.pages.get(pageId)); Object.assign(f.pages.get(pageId), change);
    await assert.rejects(f.manager.syncPage({ pageId }), error => ['FORBIDDEN', 'INVALID_RESPONSE'].includes(error.code));
    f.pages.set(pageId, before);
  }
  assert.equal(f.writes.length, 0); assert.deepEqual((await f.manager.pageStatus()).bindings, []);
});

test('explicit none preserves an enrolled page ledger and pending body-update intent unchanged', async t => {
  const f = await fixture(t); const binding = await f.manager.syncPage({ pageId }); await settled(f.manager);
  await f.manager.capturePageUpdate({ pageId }); await f.manager.close();
  const filename = join(f.config.knowledgeStateDir, 'bindings', binding.bindingId + '.json');
  const before = await readFile(filename, 'utf8'), count = f.writes.length;
  const disabled = f.create({ knowledgeBase: undefined }); await disabled.start();
  f.pages.get(pageId).content = '# Changed while disabled\n';
  await disabled.refreshPageMirrors({ pageId }); await disabled.close();
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.equal(f.writes.length, count);
});

test('a failed descendant layout refresh is durable and retries after restart instead of losing a successful move', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); const first = await settled(f.manager);
  f.pages.get(parentId).title = 'Renamed while offline'; f.state.failInfo = true;
  await f.manager.refreshPageMirrors({ pageId: parentId, includeDescendants: true });
  const pending = await f.manager.pageStatus({ pageId });
  assert.equal(pending.knowledgeBase.state, 'waiting_docmost');
  await f.manager.close(); f.state.failInfo = false;
  const restarted = f.create(); await restarted.start();
  const complete = await eventually(() => restarted.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'synced' && value.knowledgeBase.uri !== first.knowledgeBase.uri);
  assert.match(complete.knowledgeBase.uri, /Renamed-while-offline/);
  assert.equal(f.resources.has(first.knowledgeBase.uri), false);
});

test('a real local save remains safe when a watcher dispatches across MD and page source records', async t => {
  const f = await fixture(t); await f.manager.close();
  // The OS watcher boundary is injected: this host can exhaust its watch limit.
  // Source reads, the save itself, conditional writes and mirror state remain real.
  const notifications = [];
  t.mock.method(fs, 'watch', (_path, _options, callback) => {
    notifications.push(callback); return { on() { return this; }, close() {} };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const localRoot = join(f.temp, 'md'); await mkdir(localRoot, { mode: 0o700 });
  await writeFile(join(localRoot, 'note.md'), '# Local before\n');
  const mdRevision = value => hash(`conditional:${value}`);
  const remote = { pageId: otherId, spaceId, workspaceId,
    revision: mdRevision('# Local before\n'), persistedRevision: mdRevision('# Local before\n') };
  const original = f.api.post;
  f.api.post = async (path, input, ...args) => {
    if (path === 'pages/sync-state' && input.pageId === otherId)
      return { ...remote, ...(input.content !== undefined ? { proposedRevision: mdRevision(input.content) } : {}) };
    if (path === 'pages/sync-update' && input.pageId === otherId) {
      assert.equal(input.expectedRevision, remote.revision);
      remote.revision = remote.persistedRevision = mdRevision(input.content); return { ...remote };
    }
    return original(path, input, ...args);
  };
  const mixed = f.create({ syncRoot: localRoot, syncStateDir: f.config.knowledgeStateDir }); await mixed.start();
  await mixed.bind({ filePath: 'note.md', pageId: otherId });
  await mixed.syncPage({ pageId }); await settled(mixed);
  await writeFile(join(localRoot, 'note.md'), '# Local after\n');
  assert.equal(notifications.length, 1);
  notifications[0]('change', 'note.md');
  await eventually(() => mixed.status(), value => value.bindings.find(binding => binding.pageId === otherId)?.remoteRevision === mdRevision('# Local after\n'));
  assert.equal((await mixed.pageStatus({ pageId })).knowledgeBase.state, 'synced');
});

test('unrelated metadata refresh does not revive or reread an explicitly deleted enrolled page', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); await settled(f.manager);
  const deletion = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.pages.get(pageId).deletedAt = '2026-10-15T00:00:00Z'; await f.manager.afterPageOperation(deletion);
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'deleted');
  const count = f.calls.filter(call => call.path === 'pages/info' && call.input.pageId === pageId).length;
  await f.manager.refreshPageMirrors();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await f.manager.pageStatus({ pageId })).knowledgeBase.state, 'deleted');
  assert.equal(f.calls.filter(call => call.path === 'pages/info' && call.input.pageId === pageId).length, count);
});

test('retry of a pending confirmed page deletion does not require reading an undeleted Markdown body', async t => {
  const f = await fixture(t); const binding = await f.manager.syncPage({ pageId }); await settled(f.manager);
  const deletion = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.pages.get(pageId).deletedAt = '2026-10-15T00:00:00Z'; f.state.offline = true;
  await f.manager.afterPageOperation(deletion);
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'retrying');
  f.state.offline = false;
  const before = f.calls.length;
  await f.manager.retryKnowledge({ bindingId: binding.bindingId });
  assert.equal(f.calls.slice(before).some(call => call.path === 'pages/info' && call.input.format === 'markdown'), false);
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'deleted');
});

test('invalid persisted storage is an explicit page-status error rather than an unenrolled result', async t => {
  const f = await fixture(t); await f.manager.close();
  await writeFile(join(f.config.knowledgeStateDir, 'bindings', pageId + '.json'), '{"version":0}', { mode: 0o600 });
  const restarted = f.create(); await restarted.start();
  assert.equal((await restarted.pageStatus()).state, 'blocked');
  await assert.rejects(restarted.pageStatus({ pageId }), { code: 'INVALID_STATE' });
  await assert.rejects(restarted.refreshPageMirrors({ pageId }), { code: 'INVALID_STATE' });
});

test('explicit page resync can acknowledge the current saved body after a no-op update and rename', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); const first = await settled(f.manager);
  const ticket = await f.manager.capturePageUpdate({ pageId });
  f.pages.get(pageId).title = 'Renamed without changing the body';
  await f.manager.refreshPageMirrors({ pageId, expectedPreviousHash: ticket.previousHash, refreshTicketId: ticket.id });
  assert.equal((await f.manager.pageStatus({ pageId })).knowledgeBase.state, 'waiting_docmost');
  await f.manager.syncPage({ pageId });
  const complete = await settled(f.manager);
  assert.notEqual(complete.knowledgeBase.uri, first.knowledgeBase.uri);
  assert.equal(f.resources.get(complete.knowledgeBase.uri), f.pages.get(pageId).content);
  assert.equal(f.resources.has(first.knowledgeBase.uri), false);
});

test('explicit same-body sync upgrades an old synced page ledger that lacks ancestor completion', async t => {
  const f = await fixture(t); const binding = await f.manager.syncPage({ pageId }); await settled(f.manager); await f.manager.close();
  const filename = join(f.config.knowledgeStateDir, 'bindings', binding.bindingId + '.json');
  const ledger = JSON.parse(await readFile(filename, 'utf8')); delete ledger.mirror.ancestorsReady;
  await writeFile(filename, JSON.stringify(ledger));
  const count = f.tasks.size, restarted = f.create(); await restarted.start();
  await restarted.syncPage({ pageId }); await settled(restarted);
  assert.ok(f.tasks.size > count, 'an old page-only success requires new ancestor processing');
  await eventually(async () => JSON.parse(await readFile(filename, 'utf8')), value => value.mirror.ancestorsReady === true);
});

test('a second body update cannot dispatch until the preceding saved-body change is confirmed', async t => {
  const f = await fixture(t, { scanMs: 60000 });
  const binding = await f.manager.syncPage({ pageId });
  for (let turn = 0; turn < 12 && (await f.manager.pageStatus({ pageId })).knowledgeBase.state !== 'synced'; turn++)
    await f.manager.retryKnowledge({ bindingId: binding.bindingId });
  assert.equal((await f.manager.pageStatus({ pageId })).knowledgeBase.state, 'synced');
  const first = await f.manager.capturePageUpdate({ pageId });
  await assert.rejects(f.manager.capturePageUpdate({ pageId }), { code: 'SAVE_PENDING' });
  const filename = join(f.config.knowledgeStateDir, 'bindings', binding.bindingId + '.json');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).pageRefresh.id, first.id);

  f.pages.get(pageId).content = '# First persisted update\n';
  const second = await f.manager.capturePageUpdate({ pageId });
  assert.equal(second.previousHash, hash('# First persisted update\n'));
  assert.notEqual(second.id, first.id);
  f.pages.get(pageId).content = '# Second persisted update\n';
  await f.manager.refreshPageMirrors({ pageId, expectedPreviousHash: first.previousHash, refreshTicketId: first.id });
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).pageRefresh.id, second.id,
    'a late prior response must not confirm or clear the current write intent');
  await f.manager.refreshPageMirrors({ pageId, expectedPreviousHash: second.previousHash, refreshTicketId: second.id });
  for (let turn = 0; turn < 14 && (await f.manager.pageStatus({ pageId })).knowledgeBase.state !== 'synced'; turn++)
    await f.manager.retryKnowledge({ bindingId: binding.bindingId });
  const complete = await f.manager.pageStatus({ pageId });
  assert.equal(complete.knowledgeBase.state, 'synced');
  assert.equal(f.resources.get(complete.knowledgeBase.uri), '# Second persisted update\n');
});


test('shared root enrolls, refreshes and deletes through the same durable page protocol', async t => {
  const rootUri = 'viking://resources/docmost-mcp';
  const f = await fixture(t, { rootUri }); await f.manager.syncPage({ pageId });
  const first = await settled(f.manager);
  assert.equal(first.knowledgeBase.uri, `${rootUri}/Space/Parent/A-Page/document.md`);
  f.pages.get(pageId).content = '# Full shared update\n';
  await f.manager.refreshPageMirrors({ pageId, includeDescendants: false });
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.confirmedRevision === hash('# Full shared update\n'));
  assert.equal(f.resources.get(first.knowledgeBase.uri), '# Full shared update\n');
  const deletion = await f.manager.beforePageOperation({ kind: 'delete', pageId });
  f.pages.get(pageId).deletedAt = '2026-10-16T00:00:00Z';
  await f.manager.afterPageOperation(deletion);
  await eventually(() => f.manager.pageStatus({ pageId }), value => value.knowledgeBase?.state === 'deleted');
  assert.equal(f.resources.has(first.knowledgeBase.uri), false);
});

test('re-enrolling a same-title sibling reuses its claimed suffix without reindexing unchanged content', async t => {
  const f = await fixture(t); await f.manager.syncPage({ pageId }); await settled(f.manager);
  f.pages.get(otherId).title = 'A Page';
  await f.manager.syncPage({ pageId: otherId });
  const first = await settled(f.manager, otherId);
  assert.match(first.knowledgeBase.uri, /A-Page--[a-f0-9]{8}\/document.md$/);
  const taskCount = f.tasks.size;
  await f.manager.syncPage({ pageId: otherId }); await settled(f.manager, otherId);
  assert.equal(f.tasks.size, taskCount);
  assert.equal((await f.manager.pageStatus({ pageId: otherId })).knowledgeBase.uri, first.knowledgeBase.uri);
});
