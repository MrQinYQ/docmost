import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMarkdownSync } from '../src/sync.mjs';
import { fixture, pageId } from './git-fixture.mjs';

const otherPage = '00000000-0000-4000-8000-000000000009';
const branch = 'refs/heads/feature';
async function projects(t) {
  const a = await fixture(t), b = await fixture(t); await a.manager.close(); await b.manager.close();
  // Identical objects/refs/paths in different repositories must remain isolated.
  b.git('fetch', '-q', a.root, 'feature'); b.git('reset', '--hard', a.first); b.first = a.first;
  const pages = new Map([[pageId, a], [otherPage, b]]);
  const api = { async post(path, input) {
    const f = pages.get(input?.pageId) ?? a, result = await f.api.post(path, input);
    return { ...result, ...(result.pageId ? { pageId: input.pageId } : {}), ...(path === 'pages/info' ? { id: input.pageId } : {}) };
  } };
  const create = overrides => { const manager = createMarkdownSync({ ...a.config, gitRoot: undefined, ...overrides }, { api, scanMs: 15 }); t.after(() => manager.close()); return manager; };
  const manager = create(); await manager.start();
  const bind = (p, id) => manager.bindGitDocument({ repositoryRoot: p.root, pageId: id, filePath: 'document.md', commit: p.first, branch });
  return { a, b, manager, create, bind };
}

test('one rootless connection scopes equal commit/ref/file names to each repository', async t => {
  const f = await projects(t), first = await f.bind(f.a, pageId), second = await f.bind(f.b, otherPage);
  assert.equal(first.repository.root, f.a.root); assert.notEqual(first.repository.id, second.repository.id);
  assert.equal((await f.manager.getGitDocumentStatus({ repositoryRoot: f.a.root })).bindings.length, 1);
  assert.equal((await f.manager.getGitDocumentStatus()).bindings.length, 2);
  await f.a.save('# Project A committed\n'); const a = f.a.commit(); await f.a.save('# Private A draft\n');
  await f.b.save('# Project B committed\n'); const b = f.b.commit();
  await assert.rejects(f.manager.publishGitDocuments({ repositoryRoot: f.a.root, commit: a, branch, bindingIds: [first.bindingId, second.bindingId] }), { code: 'TARGET_CHANGED' });
  assert.equal(f.a.state.writes + f.b.state.writes, 0);
  const published = await f.manager.publishGitDocuments({ repositoryRoot: f.a.root, commit: a, branch });
  assert.equal(published.documents.length, 1); assert.equal(published.documents[0].pageId, pageId);
  assert.equal(f.a.state.body, '# Project A committed\n'); assert.equal(f.b.state.writes, 0);
  await f.manager.publishGitDocuments({ repositoryRoot: f.b.root, commit: b, branch }); assert.equal(f.b.state.body, '# Project B committed\n');
  await assert.rejects(f.manager.getGitDocumentStatus({ repositoryRoot: f.b.root, bindingId: first.bindingId }), { code: 'TARGET_CHANGED' });
  await assert.rejects(f.manager.publishGitDocuments({ commit: a, branch }), { code: 'INVALID_REQUEST' });
});

test('legacy records and unknown writes restart without a configured Git root or ledger migration', async t => {
  const f = await fixture(t), bound = await f.bind(); await f.save('# Legacy uncertain write\n'); const commit = f.commit(); f.state.loseAck = true;
  await f.manager.publishGitDocuments({ commit, branch }); assert.equal(f.state.writes, 1); await f.manager.close();
  f.state.loseAck = false; f.state.failReads = false;
  const restarted = f.create({ gitRoot: undefined }); assert.equal((await restarted.start()).error, undefined);
  const status = await restarted.getGitDocumentStatus({ bindingId: bound.bindingId });
  assert.equal(status.git.published.commit, commit); assert.equal(status.pending, undefined); assert.equal(status.bindingId, bound.bindingId); assert.equal(status.state, 'synced'); assert.equal(f.state.writes, 1);
  await f.save('# Next explicit project commit\n'); const next = f.commit();
  const result = await restarted.publishGitDocuments({ repositoryRoot: f.root, commit: next, branch }); assert.equal(result.documents[0].bindingId, bound.bindingId);
});

test('linked worktrees share repository identity and cannot duplicate an enrolled source', async t => {
  const f = await projects(t), linked = join(f.a.temp, 'linked'); f.a.git('worktree', 'add', '-qb', 'linked', linked, f.a.first);
  const bound = await f.manager.bindGitDocument({ repositoryRoot: linked, pageId, filePath: 'document.md', commit: f.a.first, branch: 'refs/heads/linked' });
  await assert.rejects(f.bind(f.a, otherPage), { code: 'BINDING_EXISTS' });
  f.a.git('worktree', 'remove', linked);
  await f.a.save('# Main checkout committed\n'); const commit = f.a.commit();
  const result = await f.manager.publishGitDocuments({ repositoryRoot: f.a.root, commit, branch }); assert.equal(result.documents[0].bindingId, bound.bindingId); assert.equal(result.documents[0].state, 'synced');
  await f.manager.close(); const restarted = f.create(); await restarted.start(); assert.equal((await restarted.getGitDocumentStatus({ bindingId: bound.bindingId })).state, 'synced');
});

test('an unavailable repository blocks only its bindings and cannot poison another project', async t => {
  const f = await projects(t), a = await f.bind(f.a, pageId), b = await f.bind(f.b, otherPage); await f.manager.close();
  await rename(f.a.root, f.a.root + '-unavailable'); const restarted = f.create(); assert.equal((await restarted.start()).error, undefined);
  const all = await restarted.getGitDocumentStatus(); assert.equal(all.bindings.find(x => x.bindingId === a.bindingId).state, 'blocked');
  assert.equal((await restarted.getGitDocumentStatus({ bindingId: b.bindingId })).state, 'synced');
  await f.b.save('# Independent project update\n'); const commit = f.b.commit();
  const r = await restarted.publishGitDocuments({ repositoryRoot: f.b.root, commit, branch }); assert.equal(r.documents[0].state, 'synced');
});

test('explicit project context cannot overlap private state or guess a relative source root', async t => {
  const f = await projects(t); await assert.rejects(f.manager.bindGitDocument({ repositoryRoot: 'relative', pageId, filePath: 'document.md', commit: f.a.first, branch }), { code: 'INVALID_SOURCE' });
  const state = join(f.a.root, 'private-state'); await mkdir(state);
  const manager = f.create({ knowledgeStateDir: state }); await manager.start();
  await assert.rejects(manager.bindGitDocument({ repositoryRoot: f.a.root, pageId, filePath: 'document.md', commit: f.a.first, branch }), { code: 'INVALID_STATE' }); assert.equal(f.a.state.writes, 0);
});

test('a separate Git metadata directory cannot overlap the private synchronization ledger', async t => {
  const f = await fixture(t); await f.manager.close();
  const root = join(f.temp, 'separate-source'), metadata = join(f.config.knowledgeStateDir, 'git-metadata');
  f.git('init', '-q', '-b', 'feature', '--separate-git-dir', metadata, root);
  f.git('-C', root, 'config', 'user.name', 'Synthetic'); f.git('-C', root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'document.md'), '# Initial\n'); f.git('-C', root, 'add', 'document.md'); f.git('-C', root, 'commit', '-qm', 'docs: initial');
  const manager = f.create({ gitRoot: undefined }); await manager.start();
  await assert.rejects(manager.bindGitDocument({ repositoryRoot: root, filePath: 'document.md', pageId, commit: f.git('-C', root, 'rev-parse', 'HEAD'), branch }), { code: 'INVALID_STATE' });
  assert.equal((await manager.getGitDocumentStatus()).bindings.length, 0);
});

test('changing invocation root preserves enrolled subdirectory paths and detects duplicate tree paths', async t => {
  const f = await projects(t), docs = join(f.a.root, 'docs'); await mkdir(docs); await writeFile(join(docs, 'document.md'), '# Initial\n'); const first = f.a.commit();
  const bound = await f.manager.bindGitDocument({ repositoryRoot: docs, filePath: 'document.md', pageId, commit: first, branch });
  await assert.rejects(f.manager.bindGitDocument({ repositoryRoot: f.a.root, filePath: 'docs/document.md', pageId: otherPage, commit: first, branch }), { code: 'BINDING_EXISTS' });
  await f.a.save('# Unrelated root Markdown\n'); await writeFile(join(docs, 'document.md'), '# Intended nested Markdown\n'); const next = f.a.commit();
  const result = await f.manager.publishGitDocuments({ repositoryRoot: f.a.root, commit: next, branch });
  assert.equal(result.documents[0].bindingId, bound.bindingId); assert.equal(result.documents[0].state, 'synced'); assert.equal(f.a.state.body, '# Intended nested Markdown\n');
  await f.manager.close(); const restarted = f.create(); await restarted.start();
  assert.equal((await restarted.getGitDocumentStatus({ bindingId: bound.bindingId })).state, 'synced');
});

test('a same-path replacement clone cannot inherit pinned associations after restart', async t => {
  const f = await fixture(t), bound = await f.bind(); await f.manager.close();
  const old = f.root + '-original'; await rename(f.root, old); execFileSync('git', ['clone', '-q', old, f.root]);
  f.git('config', 'user.name', 'Synthetic'); f.git('config', 'user.email', 'test@example.invalid'); await f.save('# Replacement clone\n'); const commit = f.commit();
  const restarted = f.create({ gitRoot: undefined }); await restarted.start();
  const status = await restarted.getGitDocumentStatus({ bindingId: bound.bindingId }); assert.equal(status.error.code, 'TARGET_CHANGED');
  await assert.rejects(restarted.publishGitDocuments({ repositoryRoot: f.root, commit, branch, bindingIds: [bound.bindingId] }), { code: 'TARGET_CHANGED' });
  assert.equal(f.state.writes, 0);
});

test('old records preserve IDs and paths but require explicit first trust before adopting directory identity', async t => {
  const f = await fixture(t); await f.manager.close(); const docs = join(f.root, 'docs'); await mkdir(docs); await writeFile(join(docs, 'document.md'), '# Initial\n'); const first = f.commit();
  const legacy = f.create({ gitRoot: docs }); await legacy.start(); const bound = await legacy.bindGitDocument({ pageId, filePath: 'document.md', commit: first, branch }); await legacy.close();
  const filename = join(f.config.knowledgeStateDir, 'bindings', bound.bindingId + '.json'), old = JSON.parse(await readFile(filename, 'utf8')); delete old.git.instance; delete old.git.prefix; await writeFile(filename, JSON.stringify(old), { mode: 0o600 });
  await f.save('# Unrelated root file\n'); await writeFile(join(docs, 'document.md'), '# Legacy nested document\n'); const commit = f.commit();
  const restarted = f.create({ gitRoot: undefined }); await restarted.start();
  let status = await restarted.getGitDocumentStatus({ bindingId: bound.bindingId }); assert.equal(status.error.code, 'GIT_IDENTITY_UNCONFIRMED'); assert.equal(status.bindingId, bound.bindingId);
  await restarted.publishGitDocuments({ repositoryRoot: f.root, commit, branch }); assert.equal(f.state.writes, 0);
  await assert.rejects(restarted.setGitDocumentSync({ bindingId: bound.bindingId, action: 'resume' }), { code: 'GIT_IDENTITY_UNCONFIRMED' }); assert.equal(f.state.writes, 0);
  await restarted.setGitDocumentSync({ bindingId: bound.bindingId, action: 'confirm-repository', repositoryRoot: f.root });
  const result = await restarted.publishGitDocuments({ repositoryRoot: f.root, commit, branch }); assert.equal(result.documents[0].bindingId, bound.bindingId); assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.body, '# Legacy nested document\n');
});

test('explicit first trust reconciles an old unknown write without replaying it or losing its intent', async t => {
  const f = await fixture(t), bound = await f.bind(); await f.save('# Previously dispatched content\n'); const commit = f.commit(); f.state.loseAck = true;
  await f.manager.publishGitDocuments({ commit, branch }); await f.manager.close();
  const filename = join(f.config.knowledgeStateDir, 'bindings', bound.bindingId + '.json'), old = JSON.parse(await readFile(filename, 'utf8')); delete old.git.instance; delete old.git.prefix; await writeFile(filename, JSON.stringify(old), { mode: 0o600 });
  f.state.loseAck = false; f.state.failReads = false;
  const restarted = f.create({ gitRoot: undefined }); await restarted.start(); let status = await restarted.getGitDocumentStatus({ bindingId: bound.bindingId });
  assert.equal(status.error.code, 'GIT_IDENTITY_UNCONFIRMED'); assert.ok(status.pending); assert.equal(status.git.intent.commit, commit);
  status = await restarted.setGitDocumentSync({ bindingId: bound.bindingId, action: 'confirm-repository', repositoryRoot: f.root });
  assert.equal(status.bindingId, bound.bindingId); assert.equal(status.git.published.commit, commit); assert.equal(status.pending, undefined); assert.equal(status.git.intent, undefined); assert.equal(f.state.writes, 1);
});
