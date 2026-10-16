import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, eventually, pageId, hash } from './git-fixture.mjs';

test('binding persists exact Git identity without writing Docmost and publishes only a commit', async t => {
  const f = await fixture(t); const bound = await f.bind();
  assert.equal(bound.source, 'git'); assert.equal(f.state.writes, 0);
  await f.save('# Commit A\n'); const commit = f.commit(); await f.save('# Uncommitted draft\n');
  const result = await f.manager.publishGitDocuments({ commit, branch: 'refs/heads/feature' });
  assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.body, '# Commit A\n');
  assert.equal(result.documents[0].git.published.commit, commit); assert.equal(f.state.writes, 1);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.state.writes, 1, 'workspace saves never trigger Git publication');
  const stored = JSON.parse(await readFile(join(f.config.knowledgeStateDir, 'bindings', `${bound.bindingId}.json`), 'utf8'));
  assert.equal(stored.source, 'git'); assert.equal(stored.git.published.commit, commit); assert.equal(stored.git.intent, undefined);
  assert.equal(JSON.stringify(stored).includes('Commit A'), false);
  await f.manager.close(); const restarted = f.create(); await restarted.start();
  assert.equal((await restarted.getGitDocumentStatus({ bindingId: bound.bindingId })).git.published.commit, commit);
  assert.equal(f.state.writes, 1);
});

test('divergent branches pause on one page and merging the published commit resumes publication', async t => {
  const f = await fixture(t); await f.bind();
  await f.save('# Branch A\n'); const a = f.commit(); await f.manager.publishGitDocuments({ commit: a, branch: 'refs/heads/feature' });
  f.git('checkout', '-qb', 'other', f.first); await f.save('# Branch B\n'); const b = f.commit();
  const rejected = await f.manager.publishGitDocuments({ commit: b, branch: 'refs/heads/other' });
  assert.equal(rejected.documents[0].error.code, 'GIT_BRANCH_CONFLICT'); assert.equal(f.state.body, '# Branch A\n'); assert.equal(f.state.writes, 1);
  assert.equal((await f.manager.getGitDocumentStatus()).bindings.length, 1);
  try { f.git('merge', '--no-commit', 'feature'); } catch { /* Intentional document conflict resolved by this test. */ }
  await f.save('# Merged A and B\n'); const merged = f.commit();
  const result = await f.manager.publishGitDocuments({ commit: merged, branch: 'refs/heads/other' });
  assert.equal(result.documents[0].state, 'synced'); assert.equal(f.state.body, '# Merged A and B\n'); assert.equal(f.state.writes, 2);
});

test('unchanged content never rolls history backwards and still detects direct remote edits', async t => {
  const f = await fixture(t); const bound = await f.bind();
  await f.save('# Published\n'); const next = f.commit(); await f.manager.publishGitDocuments({ commit: next, branch: 'refs/heads/feature' });
  f.state.body = f.state.persisted = '# Web edited\n';
  const result = await f.manager.publishGitDocuments({ commit: next, branch: 'refs/heads/feature' });
  assert.equal(result.documents[0].error.code, 'CONFLICT'); assert.equal(f.state.writes, 1);
  const resolved = await f.manager.resolveGitDocumentConflict({ bindingId: bound.bindingId, commit: next, branch: 'refs/heads/feature', expectedRevision: hash('# Web edited\n') });
  assert.equal(resolved.state, 'synced'); assert.equal(f.state.body, '# Published\n');
});

test('explicit merged Git resolution may replace the observed live unpersisted edit through CAS', async t => {
  const f = await fixture(t); const bound = await f.bind();
  f.state.body = '# Live web edit not yet persisted\n';
  await f.save('# Merged web and Git changes\n'); const commit = f.commit();
  const paused = await f.manager.publishGitDocuments({ commit, branch: 'refs/heads/feature' });
  assert.equal(paused.documents[0].error.code, 'CONFLICT'); assert.equal(f.state.writes, 0);
  const result = await f.manager.resolveGitDocumentConflict({ bindingId: bound.bindingId, commit, branch: 'refs/heads/feature', expectedRevision: hash(f.state.body) });
  assert.equal(result.state, 'synced'); assert.equal(f.state.body, '# Merged web and Git changes\n'); assert.equal(f.state.writes, 1);
});

test('lost acknowledgements reconcile Git/content metadata atomically after restart without replay', async t => {
  const f = await fixture(t); const bound = await f.bind(); await f.save('# Acknowledgement lost\n'); const commit = f.commit();
  f.state.loseAck = true;
  const first = await f.manager.publishGitDocuments({ commit, branch: 'refs/heads/feature' });
  assert.equal(first.documents[0].state, 'unconfirmed'); assert.equal(f.state.writes, 1);
  await f.manager.close(); f.state.loseAck = false; f.state.failReads = false;
  const restarted = f.create(); await restarted.start();
  const status = await restarted.getGitDocumentStatus({ bindingId: bound.bindingId });
  assert.equal(status.git.published.commit, commit); assert.equal(status.git.intent, undefined); assert.equal(status.pending, undefined);
  assert.equal(f.state.writes, 1); assert.equal(status.state, 'synced');
});

test('rename keeps the same page and deletion pauses instead of deleting the page', async t => {
  const f = await fixture(t); const bound = await f.bind(); await rename(join(f.root, 'document.md'), join(f.root, 'renamed.md')); const renamed = f.commit();
  const result = await f.manager.publishGitDocuments({ commit: renamed, branch: 'refs/heads/feature' });
  assert.equal(result.documents[0].filePath, 'renamed.md'); assert.equal(result.documents[0].pageId, pageId); assert.equal(result.documents[0].bindingId, bound.bindingId);
  await rm(join(f.root, 'renamed.md')); const deleted = f.commit();
  const paused = await f.manager.publishGitDocuments({ commit: deleted, branch: 'refs/heads/feature' });
  assert.equal(paused.documents[0].error.code, 'GIT_SOURCE_DELETED'); assert.equal(f.state.writes, 0); assert.equal(f.state.deletedAt, undefined);
});

test('knowledge tasks preserve confirmed full text and retry without repeating Docmost writes', async t => {
  const f = await fixture(t, { knowledge: true }); const bound = await f.bind();
  await eventually(() => f.manager.getGitDocumentStatus({ bindingId: bound.bindingId }), s => s.knowledgeBase?.state === 'synced');
  await f.save('# Whole updated original\n\nFirst section\n\nSecond section\n'); const commit = f.commit(); f.state.offline = true;
  await f.manager.publishGitDocuments({ commit, branch: 'refs/heads/feature' });
  assert.equal(f.state.writes, 1); f.state.offline = false;
  await f.manager.retryKnowledge({ bindingId: bound.bindingId });
  const complete = await eventually(() => f.manager.getGitDocumentStatus({ bindingId: bound.bindingId }), s => s.knowledgeBase?.state === 'synced');
  assert.equal(f.resources.get(complete.knowledgeBase.uri), '# Whole updated original\n\nFirst section\n\nSecond section\n');
  assert.equal(f.state.writes, 1); assert.ok(f.tasks.size >= 4, 'page and space indexes are refreshed for both versions');
  await f.save('# Private uncommitted change\n');
  const retried = await f.manager.retryKnowledge({ bindingId: bound.bindingId });
  assert.notEqual(retried.state, 'blocked', 'a settled retry must use the published Git snapshot, not the workspace');
  assert.equal(f.resources.get(complete.knowledgeBase.uri), '# Whole updated original\n\nFirst section\n\nSecond section\n');
});

test('explicit source conversion retains one binding and disables the old save watcher', async t => {
  const f = await fixture(t, { markdown: true }); const md = await f.manager.bind({ pageId, filePath: 'document.md', enabled: true });
  const converted = await f.manager.bindGitDocument({ pageId, filePath: 'document.md', commit: f.first, branch: 'refs/heads/feature', replaceBindingId: md.bindingId });
  assert.equal(converted.bindingId, md.bindingId); assert.equal(converted.source, 'git');
  await f.save('# Saved but not committed\n'); await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(f.state.writes, 0);
  assert.equal((await f.manager.getGitDocumentStatus()).bindings.length, 1);
});

test('no-write enrollment can prove an exact saved export despite different editor block identities', async t => {
  const f = await fixture(t); f.state.proposedPrefix = 'different-block-identities:';
  const bound = await f.bind(); assert.equal(bound.state, 'synced'); assert.equal(f.state.writes, 0);
  const other = await fixture(t); other.state.body = other.state.persisted = '# Different original\n';
  await assert.rejects(other.bind(), { code: 'CONFLICT' }); assert.equal(other.state.writes, 0);
});

test('explicit resolution supersedes a conflicting unknown write only after including its intent history', async t => {
  const f = await fixture(t); const bound = await f.bind();
  await f.save('# Unknown committed write\n'); const intended = f.commit(); f.state.loseAck = true;
  await f.manager.publishGitDocuments({ commit: intended, branch: 'refs/heads/feature' });
  f.state.loseAck = false; f.state.failReads = false; f.state.body = f.state.persisted = '# Later webpage edit\n';
  f.git('checkout', '-qb', 'divergent', f.first); await f.save('# Does not include unknown write\n'); const divergent = f.commit();
  const rejected = await f.manager.resolveGitDocumentConflict({ bindingId: bound.bindingId, commit: divergent, branch: 'refs/heads/divergent', expectedRevision: hash(f.state.body) });
  assert.equal(rejected.error.code, 'GIT_BRANCH_CONFLICT'); assert.ok(rejected.pending); assert.equal(f.state.writes, 1);
  f.git('checkout', '-q', 'feature'); await f.save('# User merged original\n'); const merged = f.commit();
  const result = await f.manager.resolveGitDocumentConflict({ bindingId: bound.bindingId, commit: merged, branch: 'refs/heads/feature', expectedRevision: hash(f.state.body) });
  assert.equal(result.state, 'synced'); assert.equal(result.pending, undefined); assert.equal(result.git.published.commit, merged); assert.equal(f.state.writes, 2);
  await f.manager.close(); const restart = f.create(); await restart.start(); assert.equal((await restart.getGitDocumentStatus({ bindingId: bound.bindingId })).git.published.commit, merged);
});

const secondPage = '00000000-0000-4000-8000-000000000009';
function twoPages(f) { const post = f.api.post.bind(f.api); f.api.post = async (path, input) => { const result = await post(path, input); if (result.pageId) result.pageId = input.pageId; return result; }; }
test('ambiguous identical deleted blobs never merge two associations onto one rename', async t => {
  const f = await fixture(t); twoPages(f); await writeFile(join(f.root, 'other.md'), '# Initial\n'); const initial = f.commit();
  for (const [filePath, id] of [['document.md', pageId], ['other.md', secondPage]]) await f.manager.bindGitDocument({ filePath, pageId: id, commit: initial, branch: 'refs/heads/feature' });
  await rm(join(f.root, 'document.md')); await rename(join(f.root, 'other.md'), join(f.root, 'renamed.md')); const commit = f.commit();
  const result = await f.manager.publishGitDocuments({ commit, branch: 'refs/heads/feature' });
  assert.ok(result.documents.every(b => b.error?.code === 'GIT_SOURCE_DELETED')); assert.deepEqual(result.documents.map(b => b.filePath), ['document.md', 'other.md']);
  await f.manager.close(); const restart = f.create(); assert.equal((await restart.start()).error, undefined); assert.equal((await restart.getGitDocumentStatus()).bindings.length, 2);
});

test('different Markdown and Git roots retain distinct same-name file identities across restart', async t => {
  const f = await fixture(t); await f.manager.close(); twoPages(f);
  const mdRoot = join(f.temp, 'markdown'); await mkdir(mdRoot); await writeFile(join(mdRoot, 'document.md'), '# Initial\n');
  const options = { syncRoot: mdRoot, syncStateDir: f.config.knowledgeStateDir }, manager = f.create(options); await manager.start();
  await manager.bind({ filePath: 'document.md', pageId, enabled: true });
  const gitBound = await manager.bindGitDocument({ filePath: 'document.md', pageId: secondPage, commit: f.first, branch: 'refs/heads/feature' });
  await manager.close(); const restart = f.create(options); assert.equal((await restart.start()).error, undefined);
  assert.equal((await restart.getGitDocumentStatus({ bindingId: gitBound.bindingId })).state, 'synced');
});

test('dormant Markdown records still reserve their page and absolute file path', async t => {
  const f = await fixture(t, { markdown: true }); twoPages(f); await f.manager.bind({ filePath: 'document.md', pageId, enabled: false }); await f.manager.close();
  const restart = f.create({ syncRoot: undefined, syncStateDir: undefined }); await restart.start();
  await assert.rejects(restart.bindGitDocument({ filePath: 'document.md', pageId: secondPage, commit: f.first, branch: 'refs/heads/feature' }), { code: 'BINDING_EXISTS' });
  await f.save('# Initial\n'); await writeFile(join(f.root, 'other.md'), '# Initial\n'); const commit = f.commit();
  await assert.rejects(restart.bindGitDocument({ filePath: 'other.md', pageId, commit, branch: 'refs/heads/feature' }), { code: 'BINDING_EXISTS' });
});
