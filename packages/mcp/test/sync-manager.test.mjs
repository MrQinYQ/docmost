import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink, chmod, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../src/errors.mjs';
import { createMarkdownSync } from '../src/sync.mjs';

const pageId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const workspaceId = '00000000-0000-4000-8000-000000000004';
const otherId = '00000000-0000-4000-8000-000000000005';
const hash = content => createHash('sha256').update(content).digest('hex');
const target = content => hash(`normalized:${content}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, overrides = {}) {
  assert.equal(typeof createMarkdownSync, 'function', 'createMarkdownSync must be implemented');
  const base = await realpath(await mkdtemp(join(tmpdir(), 'docmost-sync-manager-')));
  const root = join(base, 'markdown');
  const state = join(base, 'state');
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'note.md'), '# Local at bind\n');
  const remote = { pageId, spaceId, workspaceId, revision: hash('remote at bind'), persistedRevision: hash('remote at bind') };
  const identity = { user: { id: userId }, workspace: { id: workspaceId } };
  const calls = [];
  const api = { async post(path, body, signal, mutation) {
    calls.push({ path, body, signal, mutation });
    signal?.throwIfAborted();
    if (api.hook) {
      const result = await api.hook(path, body, signal, mutation);
      if (result !== undefined) return result;
    }
    if (path === 'users/me') return structuredClone(identity);
    if (path === 'pages/sync-state') return { ...remote, ...(body.content === undefined ? {} : { proposedRevision: target(body.content) }) };
    if (path === 'pages/sync-update') {
      if (body.expectedRevision !== remote.revision) throw new ApiError('CONFLICT', 'safe', { status: 409 });
      remote.revision = remote.persistedRevision = target(body.content);
      return { ...remote };
    }
    throw new Error('unexpected endpoint');
  } };
  const config = { origin: 'https://wiki.example.test', readOnly: false, syncRoot: root, syncStateDir: state, ...overrides };
  const managers = [];
  const make = (extra = {}) => {
    const manager = createMarkdownSync(config, { api, debounceMs: 20, scanMs: 10, ...extra });
    managers.push(manager);
    return manager;
  };
  t.after(async () => { await Promise.all(managers.map(manager => manager.close())); await rm(base, { recursive: true, force: true }); });
  return { base, root, state, api, identity, remote, calls, config, make };
}

async function eventually(read, check, message = 'expected state') {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await delay(10);
  }
  assert.fail(message);
}
const uploads = calls => calls.filter(call => call.path === 'pages/sync-update');
const bindingFile = (f, binding) => join(f.state, 'bindings', `${binding.bindingId}.json`);
const cached = async (manager, bindingId) => (await manager.status()).bindings.find(binding => binding.bindingId === bindingId);

test('binding records independent local and remote baselines without initial upload', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  assert.equal(binding.state, 'watching');
  assert.equal(binding.localHash, hash('# Local at bind\n'));
  assert.equal(binding.remoteRevision, f.remote.revision);
  assert.equal(uploads(f.calls).length, 0);
  assert.equal((await manager.status()).bindings.length, 1);
  await delay(60);
  assert.equal(uploads(f.calls).length, 0);
});

test('debounced save persists a pending intent before a conditional verified replacement', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  const initialRevision = f.remote.revision;
  let persistedBeforeWrite;
  f.api.hook = async (path) => {
    if (path !== 'pages/sync-update') return;
    const data = JSON.parse(await readFile(bindingFile(f, binding), 'utf8'));
    persistedBeforeWrite = data.pending;
  };
  await writeFile(join(f.root, 'note.md'), '# First save\n');
  await writeFile(join(f.root, 'note.md'), '# Final save\n');
  const synced = await eventually(() => cached(manager, binding.bindingId), value => value.state === 'synced');
  assert.equal(uploads(f.calls).length, 1);
  assert.deepEqual(uploads(f.calls)[0].body, { pageId, content: '# Final save\n', expectedRevision: initialRevision,
    expectedSpaceId: spaceId, expectedWorkspaceId: workspaceId });
  assert.equal(uploads(f.calls)[0].mutation, true);
  assert.deepEqual(persistedBeforeWrite, { localHash: hash('# Final save\n'), expectedRevision: initialRevision, proposedRevision: target('# Final save\n') });
  assert.equal(synced.remoteRevision, target('# Final save\n'));
  assert.equal(synced.pending, undefined);
  const serialized = await readFile(bindingFile(f, binding), 'utf8');
  assert.ok(!serialized.includes('# Final save'));
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  assert.equal((await stat(bindingFile(f, binding))).mode & 0o777, 0o600);
});

test('atomic editor rename is detected and later saves serialize against the last baseline', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, '.note.swap'), '# Atomic\n');
  await rename(join(f.root, '.note.swap'), join(f.root, 'note.md'));
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'synced');
  await writeFile(join(f.root, 'note.md'), '# Next\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.localHash === hash('# Next\n'));
  assert.equal(uploads(f.calls).length, 2);
  assert.equal(uploads(f.calls)[1].body.expectedRevision, target('# Atomic\n'));
});

test('live remote edits pause and resume never resets the conflicting revision', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.remote.revision = hash('browser live only');
  await writeFile(join(f.root, 'note.md'), '# Saved\n');
  const conflicted = await eventually(() => cached(manager, binding.bindingId), value => value.error?.code === 'CONFLICT');
  assert.equal(conflicted.state, 'conflict');
  assert.equal(uploads(f.calls).length, 0);
  await manager.control({ bindingId: binding.bindingId, action: 'resume' });
  await delay(80);
  assert.equal(uploads(f.calls).length, 0);
  assert.equal((await cached(manager, binding.bindingId)).error.code, 'CONFLICT');
  await assert.rejects(manager.resolve({ bindingId: binding.bindingId, expectedRevision: hash('stale') }), { code: 'CONFLICT' });
  await manager.resolve({ bindingId: binding.bindingId, expectedRevision: f.remote.revision });
  assert.equal(uploads(f.calls).length, 1);
  assert.equal((await cached(manager, binding.bindingId)).state, 'synced');
});

test('pause suppresses changes and resume uploads a retained local change', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId, enabled: false });
  assert.equal(binding.state, 'paused');
  await writeFile(join(f.root, 'note.md'), '# While paused\n');
  await delay(80);
  assert.equal(uploads(f.calls).length, 0);
  await manager.control({ bindingId: binding.bindingId, action: 'resume' });
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'synced');
  await manager.control({ bindingId: binding.bindingId, action: 'unbind' });
  await writeFile(join(f.root, 'note.md'), '# Unbound\n');
  await delay(80);
  assert.equal(uploads(f.calls).length, 1);
  assert.equal((await manager.status()).bindings.length, 0);
});

test('lost acknowledgement reconciles the proposed revision without resending', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.api.hook = async (path, body) => {
    if (path !== 'pages/sync-update') return;
    f.remote.revision = f.remote.persistedRevision = target(body.content);
    throw new ApiError('TIMEOUT', 'sensitive upstream text', { mayHaveSucceeded: true });
  };
  await writeFile(join(f.root, 'note.md'), '# Lost acknowledgement\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'synced');
  await delay(80);
  assert.equal(uploads(f.calls).length, 1);
});

test('unknown mutation result preserves intent and never blindly retries on resume or restart', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.api.hook = async path => { if (path === 'pages/sync-update') throw new ApiError('NETWORK_ERROR', 'credential upstream', { mayHaveSucceeded: true }); };
  await writeFile(join(f.root, 'note.md'), '# Uncertain\n');
  const pending = await eventually(() => cached(manager, binding.bindingId), value => value.state === 'unconfirmed');
  assert.ok(pending.pending);
  assert.ok(!JSON.stringify(pending).includes('credential'));
  await manager.control({ bindingId: binding.bindingId, action: 'resume' });
  await manager.close();
  const restarted = f.make();
  await restarted.start();
  await delay(80);
  assert.equal(uploads(f.calls).length, 1);
  assert.equal((await cached(restarted, binding.bindingId)).state, 'unconfirmed');
});

test('durability mismatch is unconfirmed and startup can reconcile a later persisted target', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.api.hook = async (path, body) => {
    if (path === 'pages/sync-update') { f.remote.revision = target(body.content); return { ...f.remote }; }
  };
  await writeFile(join(f.root, 'note.md'), '# Await durability\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'unconfirmed');
  await manager.close();
  f.remote.persistedRevision = f.remote.revision;
  const restarted = f.make();
  await restarted.start();
  assert.equal((await cached(restarted, binding.bindingId)).state, 'synced');
  assert.equal(uploads(f.calls).length, 1);
});

test('restart validates a changed local file before automatically uploading it', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await manager.close();
  await writeFile(join(f.root, 'note.md'), '# Offline save\n');
  const restarted = f.make();
  await restarted.start();
  await eventually(() => cached(restarted, binding.bindingId), value => value.state === 'synced');
  assert.equal(uploads(f.calls).length, 1);
});

test('identity or space changes block a binding instead of retargeting it', async t => {
  for (const kind of ['identity', 'space']) {
    const f = await fixture(t);
    const manager = f.make();
    const binding = await manager.bind({ filePath: 'note.md', pageId });
    if (kind === 'identity') f.identity.user.id = otherId;
    else f.remote.spaceId = otherId;
    await writeFile(join(f.root, 'note.md'), `# Changed ${kind}\n`);
    const blocked = await eventually(() => cached(manager, binding.bindingId), value => value.state === 'blocked');
    assert.equal(blocked.error.code, kind === 'identity' ? 'IDENTITY_CHANGED' : 'TARGET_CHANGED');
    assert.equal(blocked.spaceId, spaceId);
    assert.equal(uploads(f.calls).length, 0);
  }
});

test('idle managers share the ledger without reserving page leases', async t => {
  const f = await fixture(t);
  const first = f.make();
  const binding = await first.bind({ filePath: 'note.md', pageId });
  const second = f.make();
  await second.start();
  assert.equal((await cached(second, binding.bindingId)).state, 'watching');
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
  await first.close();
  await second.close();
  const third = f.make();
  await third.start();
  assert.equal((await cached(third, binding.bindingId)).state, 'watching');
  await third.close();
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
});

test('a confirmed exited owner is reclaimed inside the operation mutex', async t => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'leases'), { recursive: true, mode: 0o700 });
  const leasePath = join(f.state, 'leases', `${hash(`${f.config.origin}|${workspaceId}|${pageId}`)}.json`);
  await writeFile(leasePath, JSON.stringify({ pid: 999999999, nonce: 'stale-fixture' }), { mode: 0o600 });
  const manager = f.make();
  assert.equal((await manager.bind({ filePath: 'note.md', pageId })).state, 'watching');
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
});

test('source validation rejects escape paths, symlinks, nonfiles and invalid content', async t => {
  const f = await fixture(t);
  const manager = f.make();
  await mkdir(join(f.root, 'folder.md'));
  await symlink(join(f.root, 'note.md'), join(f.root, 'link.md'));
  await symlink(f.base, join(f.root, 'escape'));
  await writeFile(join(f.root, 'blank.md'), ' \n');
  await writeFile(join(f.root, 'bad.md'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(f.root, 'large.md'), Buffer.alloc(1_000_001, 120));
  for (const filePath of ['../outside.md', join(f.root, 'note.md'), 'note.txt', 'folder.md', 'link.md', 'escape/note.md', 'blank.md', 'bad.md', 'large.md']) {
    await assert.rejects(manager.bind({ filePath, pageId }), { code: 'INVALID_SOURCE' }, filePath);
  }
  assert.equal(uploads(f.calls).length, 0);
});

test('missing or temporarily blank bound files never clear the remote body', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '');
  await eventually(() => cached(manager, binding.bindingId), value => value.error?.code === 'INVALID_SOURCE');
  await rm(join(f.root, 'note.md'));
  await delay(70);
  assert.equal(uploads(f.calls).length, 0);
  assert.equal(f.remote.revision, binding.remoteRevision);
});

test('private state refuses permissive directories and symlink substitution', async t => {
  for (const kind of ['permissions', 'symlink']) {
    const f = await fixture(t);
    if (kind === 'permissions') { await mkdir(f.state, { mode: 0o700 }); await chmod(f.state, 0o755); }
    else await symlink(f.root, f.state);
    const manager = f.make();
    const status = await manager.start();
    assert.equal(status.state, 'blocked');
    assert.equal(status.error.code, 'INVALID_STATE');
    assert.equal(f.calls.length, 0);
  }
});

test('read-only initialization reports status without API, watchers, leases or uploads', async t => {
  const f = await fixture(t, { readOnly: true });
  const manager = f.make();
  assert.equal((await manager.status()).readOnly, true);
  await assert.rejects(manager.bind({ filePath: 'note.md', pageId }), { code: 'READ_ONLY' });
  await delay(70);
  assert.equal(f.calls.length, 0);
  assert.equal(uploads(f.calls).length, 0);
});

test('invalid endpoint responses, permissions and unsupported service never use pages/update', async t => {
  for (const code of ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'UNSUPPORTED_DEPLOYMENT', 'INVALID_RESPONSE']) {
    const f = await fixture(t);
    const manager = f.make();
    const binding = await manager.bind({ filePath: 'note.md', pageId });
    f.api.hook = async (path, body) => {
      if (path !== 'pages/sync-state') return;
      if (code === 'INVALID_RESPONSE') return { ...f.remote, proposedRevision: undefined };
      throw new ApiError(code, 'private upstream text', { status: 403 });
    };
    await writeFile(join(f.root, 'note.md'), '# Rejected\n');
    const blocked = await eventually(() => cached(manager, binding.bindingId), value => value.state === 'blocked');
    assert.equal(blocked.error.code, code);
    assert.ok(!JSON.stringify(blocked).includes('private upstream'));
    assert.equal(uploads(f.calls).length, 0);
    assert.ok(!f.calls.some(call => call.path === 'pages/update'));
  }
});

test('close aborts a dispatched write, keeps pending intent and stops future file processing', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  f.api.hook = async (path, body, signal) => {
    if (path !== 'pages/sync-update') return;
    dispatched();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError('CANCELLED', 'safe', { mayHaveSucceeded: true })), { once: true }));
  };
  await writeFile(join(f.root, 'note.md'), '# During close\n');
  await started;
  await manager.close();
  assert.ok(JSON.parse(await readFile(bindingFile(f, binding), 'utf8')).pending);
  assert.equal((await manager.status()).state, 'closed');
  await writeFile(join(f.root, 'note.md'), '# After close\n');
  await delay(80);
  assert.equal(uploads(f.calls).length, 1);
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
});

test('shutdown during initialization aborts identity without acquiring late leases or watches', async t => {
  const f = await fixture(t);
  let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  let identitySignal;
  f.api.hook = async (path, body, signal) => {
    if (path !== 'users/me') return;
    identitySignal = signal;
    dispatched();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError('CANCELLED', 'safe')), { once: true }));
  };
  const manager = f.make();
  const start = manager.start();
  await started;
  await manager.close();
  await start;
  assert.equal(identitySignal.aborted, true);
  assert.equal((await manager.status()).state, 'closed');
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
});

test('a second save while the first write is running uploads against the confirmed first revision', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  let release;
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  f.api.hook = async (path) => {
    if (path !== 'pages/sync-update' || uploads(f.calls).length !== 1) return;
    started();
    await new Promise(resolve => { release = resolve; });
  };
  await writeFile(join(f.root, 'note.md'), '# First in flight\n');
  await dispatched;
  await writeFile(join(f.root, 'note.md'), '# Second in flight\n');
  await delay(60);
  assert.equal(uploads(f.calls).length, 1);
  release();
  await eventually(() => cached(manager, binding.bindingId), value => value.localHash === hash('# Second in flight\n'));
  assert.equal(uploads(f.calls).length, 2);
  assert.equal(uploads(f.calls)[1].body.expectedRevision, target('# First in flight\n'));
});

test('storage creation never follows a symlink ancestor to create external directories', async t => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(f.base, 'storage-link'));
  f.config.syncStateDir = join(f.base, 'storage-link', 'new-state');
  const manager = f.make();
  assert.equal((await manager.start()).error.code, 'INVALID_STATE');
  await assert.rejects(stat(join(outside, 'new-state')), { code: 'ENOENT' });
});

test('source root substitution stops uploads even when the replacement is an owned directory', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await rename(f.root, join(f.base, 'original-markdown'));
  await mkdir(f.root, { mode: 0o700 });
  await writeFile(join(f.root, 'note.md'), '# Substituted root\n');
  const blocked = await eventually(() => cached(manager, binding.bindingId), value => value.error?.code === 'INVALID_SOURCE');
  assert.equal(blocked.state, 'blocked');
  assert.equal(uploads(f.calls).length, 0);
});

test('failed state persistence cannot discard pending intent or advance the visible baseline', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.api.hook = async path => {
    if (path === 'pages/sync-update') await chmod(bindingFile(f, binding), 0o644);
  };
  await writeFile(join(f.root, 'note.md'), '# Durable remote, failed state\n');
  const blocked = await eventually(() => cached(manager, binding.bindingId), value => value.error?.code === 'INVALID_STATE');
  assert.ok(blocked.pending, 'pending intent survives local confirmation write failure');
  assert.equal(blocked.localHash, binding.localHash);
  assert.equal(blocked.remoteRevision, binding.remoteRevision);
  await chmod(bindingFile(f, binding), 0o600);
});

test('restart rejects permissive or modified state files before contacting the server', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await manager.close();
  await chmod(bindingFile(f, binding), 0o644);
  const before = f.calls.length;
  const restarted = f.make();
  assert.equal((await restarted.start()).error.code, 'INVALID_STATE');
  assert.equal(f.calls.length, before);
  await chmod(bindingFile(f, binding), 0o600);
});

test('protocol revisions and target UUIDs are validated rather than accepted as baselines', async t => {
  for (const replacement of [{ pageId: 'page-slug' }, { spaceId: 'bad' }, { workspaceId: 'bad' }, { revision: 'bad' }, { persistedRevision: 'bad' }]) {
    const f = await fixture(t);
    const manager = f.make();
    f.api.hook = async path => path === 'pages/sync-state' ? { ...f.remote, ...replacement } : undefined;
    await assert.rejects(manager.bind({ filePath: 'note.md', pageId }), { code: 'INVALID_RESPONSE' });
    assert.equal((await manager.status()).bindings.length, 0);
  }
});

test('a manager-level storage failure stops uploads from its other active bindings', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const first = await manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'other.md'), '# Other at bind\n');
  const otherRemote = { ...f.remote, pageId: otherId };
  f.api.hook = async (path, body) => {
    if (body?.pageId === otherId && path === 'pages/sync-state') return { ...otherRemote, ...(body.content === undefined ? {} : { proposedRevision: target(body.content) }) };
    if (body?.pageId === otherId && path === 'pages/sync-update') {
      otherRemote.revision = otherRemote.persistedRevision = target(body.content);
      return { ...otherRemote };
    }
    if (path === 'pages/sync-update') await chmod(bindingFile(f, first), 0o644);
  };
  await manager.bind({ filePath: 'other.md', pageId: otherId });
  await writeFile(join(f.root, 'note.md'), '# Broken persistence\n');
  await eventually(() => manager.status(), value => value.state === 'blocked');
  await writeFile(join(f.root, 'other.md'), '# Must stop\n');
  await delay(120);
  assert.equal(uploads(f.calls).length, 1);
  await chmod(bindingFile(f, first), 0o600);
});

test('lease substitution stops an existing manager from writing or deleting the replacement lease', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  const leasePath = join(f.state, 'leases', hash(f.config.origin + '|' + workspaceId + '|' + pageId) + '.json');
  f.api.hook = async (path, body) => {
    if (path === 'pages/sync-state' && body.content === '# Replaced lease\n') {
      await writeFile(leasePath, JSON.stringify({ pid: process.pid, nonce: 'replacement-lease' }), { mode: 0o600 });
    }
  };
  await writeFile(join(f.root, 'note.md'), '# Replaced lease\n');
  const blocked = await eventually(() => cached(manager, binding.bindingId), value => value.error?.code === 'LEASE_BUSY');
  assert.equal(blocked.state, 'blocked');
  assert.equal(uploads(f.calls).length, 0);
  await manager.close();
  assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).nonce, 'replacement-lease');
});

test('close still releases an owned lease when shutdown state persistence is refused', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await chmod(bindingFile(f, binding), 0o644);
  await manager.close();
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
  assert.equal((await manager.status()).state, 'closed');
});

test('single binding status observes the current remote revision for explicit conflict resolution without rebasing', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.remote.revision = hash('browser revision to observe');
  await writeFile(join(f.root, 'note.md'), '# Explicitly resolve\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'conflict');
  const before = uploads(f.calls).length;
  const observed = await manager.status({ bindingId: binding.bindingId });
  assert.equal(observed.currentRevision, hash('browser revision to observe'));
  assert.equal(observed.currentPersistedRevision, binding.remoteRevision);
  assert.equal(observed.remoteRevision, binding.remoteRevision);
  assert.equal(uploads(f.calls).length, before);
  const serialized = JSON.parse(await readFile(bindingFile(f, binding), 'utf8'));
  assert.equal(serialized.remoteRevision, binding.remoteRevision);
  assert.equal(serialized.currentRevision, undefined);
  await manager.resolve({ bindingId: binding.bindingId, expectedRevision: observed.currentRevision });
  assert.equal((await cached(manager, binding.bindingId)).state, 'synced');
  assert.equal(uploads(f.calls).length, 1);
});

test('a newer remote edit after status observation rejects resolution against the observed revision', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.remote.revision = hash('first observed remote');
  await writeFile(join(f.root, 'note.md'), '# Resolve against observation\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'conflict');
  const observed = await manager.status({ bindingId: binding.bindingId });
  assert.equal(observed.currentRevision, hash('first observed remote'));
  f.remote.revision = hash('newer browser edit');
  await assert.rejects(manager.resolve({ bindingId: binding.bindingId, expectedRevision: observed.currentRevision }), { code: 'CONFLICT' });
  assert.equal(uploads(f.calls).length, 0);
  assert.equal((await cached(manager, binding.bindingId)).remoteRevision, binding.remoteRevision);
});

test('status list stays cached while a read-only single binding observes without acquiring a lease or uploading', async t => {
  const f = await fixture(t);
  const writer = f.make();
  const binding = await writer.bind({ filePath: 'note.md', pageId });
  const reader = createMarkdownSync({ ...f.config, readOnly: true }, { api: f.api, debounceMs: 20, scanMs: 10 });
  t.after(() => reader.close());
  await reader.start();
  const before = f.calls.length;
  await reader.status();
  assert.equal(f.calls.length, before);
  f.remote.revision = hash('readonly observed revision');
  const observed = await reader.status({ bindingId: binding.bindingId });
  assert.equal(observed.currentRevision, hash('readonly observed revision'));
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1).path, 'pages/sync-state');
  assert.equal(f.calls.at(-1).body.content, undefined);
  assert.equal(f.calls.at(-1).mutation, false);
  assert.equal((await readdir(join(f.state, 'leases'))).length, 0);
  assert.equal(uploads(f.calls).length, 0);
});

test('failed single binding observation throws a safe error instead of presenting an old current revision', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  f.api.hook = async path => { if (path === 'pages/sync-state') throw new ApiError('NETWORK_ERROR', 'private upstream detail'); };
  await assert.rejects(manager.status({ bindingId: binding.bindingId }), error => error.code === 'NETWORK_ERROR' && !error.message.includes('private upstream'));
  const list = await manager.status();
  assert.equal(list.bindings[0].remoteRevision, binding.remoteRevision);
  assert.equal(list.bindings[0].currentRevision, undefined);
  assert.equal(uploads(f.calls).length, 0);
});

test('shutdown during a read-only preview preserves a local-only change for validated restart', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  f.api.hook = async (path, body, signal) => {
    if (path !== 'pages/sync-state' || body.content === undefined) return;
    dispatched();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError('CANCELLED', 'safe')), { once: true }));
  };
  await writeFile(join(f.root, 'note.md'), '# Changed before dispatch\n');
  await started;
  await manager.close();
  assert.equal(uploads(f.calls).length, 0);
  assert.equal((await cached(manager, binding.bindingId)).pending, undefined);
  f.api.hook = undefined;
  const restarted = f.make();
  await restarted.start();
  await eventually(() => cached(restarted, binding.bindingId), value => value.state === 'synced');
  assert.equal(uploads(f.calls).length, 1);
});

test('explicit unbind removes an old source-root binding without reading the vanished old source', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await manager.close();
  await rm(f.root, { recursive: true });
  const newRoot = join(f.base, 'new-markdown');
  await mkdir(newRoot, { mode: 0o700 });
  f.config.syncRoot = newRoot;
  const restarted = f.make();
  await restarted.start();
  assert.equal((await cached(restarted, binding.bindingId)).error.code, 'TARGET_CHANGED');
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
  const before = f.calls.length;
  const result = await restarted.control({ bindingId: binding.bindingId, action: 'unbind' });
  assert.equal(result.state, 'unbound');
  assert.equal(f.calls.length, before);
  assert.deepEqual((await restarted.status()).bindings, []);
  assert.deepEqual(await readdir(join(f.state, 'bindings')), []);
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
  await writeFile(join(newRoot, 'note.md'), '# New root binding\n');
  assert.equal((await restarted.bind({ filePath: 'note.md', pageId })).state, 'watching');
});

test('explicit unbind removes an old identity binding using only its local target lease', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await manager.close();
  f.identity.user.id = otherId;
  const restarted = f.make();
  await restarted.start();
  assert.equal((await cached(restarted, binding.bindingId)).error.code, 'IDENTITY_CHANGED');
  const before = f.calls.length;
  const result = await restarted.control({ bindingId: binding.bindingId, action: 'unbind' });
  assert.equal(result.state, 'unbound');
  assert.equal(f.calls.length, before);
  assert.deepEqual(await readdir(join(f.state, 'leases')), []);
  assert.equal(uploads(f.calls).length, 0);
  const rebound = await restarted.bind({ filePath: 'note.md', pageId });
  assert.equal(rebound.state, 'watching');
  assert.equal(JSON.parse(await readFile(bindingFile(f, rebound), 'utf8')).userId, otherId);
});

test('unbind of an old target still refuses a real shared page lease owner', async t => {
  const f = await fixture(t);
  const first = f.make();
  const binding = await first.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.state, 'leases', hash(f.config.origin + '|' + workspaceId + '|' + pageId) + '.json'), JSON.stringify({ pid: process.pid, nonce: 'live-legacy-owner' }), { mode: 0o600 });
  const newRoot = join(f.base, 'different-markdown');
  await mkdir(newRoot, { mode: 0o700 });
  const second = createMarkdownSync({ ...f.config, syncRoot: newRoot }, { api: f.api, debounceMs: 20, scanMs: 10 });
  t.after(() => second.close());
  await second.start();
  assert.equal((await cached(second, binding.bindingId)).error.code, 'TARGET_CHANGED');
  await assert.rejects(second.control({ bindingId: binding.bindingId, action: 'unbind' }), { code: 'LEASE_BUSY' });
  assert.ok(JSON.parse(await readFile(bindingFile(f, binding), 'utf8')).bindingId);
  assert.equal((await readdir(join(f.state, 'leases'))).length, 1);
});

test('automatic and explicitly resolved conditional writes carry their pinned space and workspace', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  await writeFile(join(f.root, 'note.md'), '# Automatic pinned write\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'synced');
  assert.equal(uploads(f.calls)[0].body.expectedSpaceId, binding.spaceId);
  assert.equal(uploads(f.calls)[0].body.expectedWorkspaceId, binding.workspaceId);
  f.remote.revision = hash('browser after first write');
  await writeFile(join(f.root, 'note.md'), '# Explicit pinned write\n');
  await eventually(() => cached(manager, binding.bindingId), value => value.state === 'conflict');
  const observed = await manager.status({ bindingId: binding.bindingId });
  await manager.resolve({ bindingId: binding.bindingId, expectedRevision: observed.currentRevision });
  assert.equal(uploads(f.calls)[1].body.expectedSpaceId, binding.spaceId);
  assert.equal(uploads(f.calls)[1].body.expectedWorkspaceId, binding.workspaceId);
});

test('a page moving between preview and dispatch conflicts even when its content revision stayed the same', async t => {
  const f = await fixture(t);
  const manager = f.make();
  const binding = await manager.bind({ filePath: 'note.md', pageId });
  const initial = f.remote.revision;
  f.api.hook = async (path, body) => {
    if (path !== 'pages/sync-update') return;
    f.remote.spaceId = otherId;
    if (body.expectedSpaceId !== binding.spaceId || body.expectedWorkspaceId !== binding.workspaceId)
      throw new ApiError('INVALID_REQUEST', 'Missing pinned target fields', { status: 400 });
    if (body.expectedSpaceId !== f.remote.spaceId || body.expectedWorkspaceId !== f.remote.workspaceId)
      throw new ApiError('CONFLICT', 'Target moved before dispatch', { status: 409 });
  };
  await writeFile(join(f.root, 'note.md'), '# Must not cross spaces\n');
  const blocked = await eventually(() => cached(manager, binding.bindingId), value => ['conflict', 'unconfirmed', 'blocked'].includes(value.state));
  assert.equal(blocked.state, 'conflict');
  assert.equal(blocked.error.code, 'CONFLICT');
  assert.equal(blocked.spaceId, spaceId);
  assert.equal(blocked.pending, undefined);
  assert.equal(f.remote.revision, initial);
  assert.equal(f.remote.persistedRevision, initial);
  assert.equal(uploads(f.calls).length, 1);
  await manager.control({ bindingId: binding.bindingId, action: 'resume' });
  await delay(80);
  assert.equal(uploads(f.calls).length, 1);
});
