import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncStore } from '../src/sync-store.mjs';
import { digest } from '../src/sync-files.mjs';

const bindingId = '00000000-0000-4000-8000-000000000001';
async function fixture(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'docmost-mirror-store-')));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, store: await createSyncStore(path) };
}
test('private snapshots retain exact confirmed source separately from binding metadata', async t => {
  const { store, path } = await fixture(t);
  assert.equal(typeof store.saveSnapshot, 'function');
  const content = '# 中文\n第一行\n';
  const hash = digest(content);
  await store.saveSnapshot(bindingId, { hash, content });
  assert.equal(await store.readSnapshot(bindingId, hash), content);
  const file = join(path, 'snapshots', `${bindingId}-${hash}.md`);
  assert.equal(await readFile(file, 'utf8'), content);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.removeSnapshot(bindingId, hash);
  await assert.rejects(store.readSnapshot(bindingId, hash));
});
test('snapshot files reject hash mismatch, traversal, oversize, and symlink substitution', async t => {
  const { store, path } = await fixture(t);
  assert.equal(typeof store.saveSnapshot, 'function');
  await assert.rejects(store.saveSnapshot('../escape', { hash: digest('x'), content: 'x' }));
  await assert.rejects(store.saveSnapshot(bindingId, { hash: digest('y'), content: 'x' }));
  const big = 'x'.repeat(1_000_001);
  await assert.rejects(store.saveSnapshot(bindingId, { hash: digest(big), content: big }));
  const hash = digest('x');
  await store.saveSnapshot(bindingId, { hash, content: 'x' });
  const file = join(path, 'snapshots', `${bindingId}-${hash}.md`);
  await rm(file);
  await symlink('/etc/hosts', file);
  await assert.rejects(store.readSnapshot(bindingId, hash));
  await assert.rejects(store.removeSnapshot(bindingId, hash));
});
test('unbinding and rebinding the same page retain every inactive server task fence', async t => {
  const { store } = await fixture(t);
  const binding = { bindingId, origin: 'https://docmost.example.test', workspaceId: 'workspace', pageId: 'page',
    mirror: { version: 1, state: 'processing', pending: { kind: 'body', phase: 'indexing', taskId: 'first-task' } } };
  await store.archiveMirror(binding);
  await store.archiveMirror({ ...binding, bindingId: '00000000-0000-4000-8000-000000000002',
    mirror: { ...binding.mirror, pending: { ...binding.mirror.pending, taskId: 'second-task' } } });
  const archived = await store.loadMirrorHistory();
  assert.equal(archived.length, 2);
  assert.deepEqual(archived.map(item => item.value.mirror.pending.taskId).sort(), ['first-task', 'second-task']);
  assert.ok(archived.every(item => item.value.active === false));
  assert.equal((await store.load()).length, 0);
});
