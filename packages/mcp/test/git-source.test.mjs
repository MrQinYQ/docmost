import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGitSource } from '../src/git-source.mjs';
import { createSyncStore } from '../src/sync-store.mjs';
import { createHash } from 'node:crypto';

async function fixture(t, format = 'sha1') {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'git-document-')));
  const root = join(temp, 'repo'); await mkdir(root);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'feature', `--object-format=${format}`);
  git('config', 'user.name', 'Synthetic Author'); git('config', 'user.email', 'author@example.invalid');
  const save = async (path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'docs: update delivery fixture'); return git('rev-parse', 'HEAD'); };
  await save('文 档.md', '# Committed original\n'); const first = commit();
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { temp, root, git, save, commit, first };
}

test('Git source reads the exact committed blob and leaves dirty workspace/index untouched', async t => {
  const f = await fixture(t); await f.save('文 档.md', '# Uncommitted private draft\n');
  const before = f.git('status', '--porcelain=v1');
  const source = await openGitSource(f.root);
  assert.equal((await source.identity()).objectFormat, 'sha1');
  assert.deepEqual(await source.resolveCommit({ commit: f.first, branch: 'refs/heads/feature' }), { commit: f.first, branch: 'refs/heads/feature' });
  const body = await source.readSnapshot({ commit: f.first, filePath: '文 档.md' });
  assert.equal(body.kind, 'body'); assert.equal(body.content, '# Committed original\n');
  assert.equal(body.blob, f.git('rev-parse', `${f.first}:文 档.md`));
  assert.match(body.hash, /^[a-f0-9]{64}$/); assert.equal(f.git('status', '--porcelain=v1'), before);
});

test('ref moves reject a new request but cannot alter an already pinned snapshot', async t => {
  const f = await fixture(t); const source = await openGitSource(f.root);
  await source.resolveCommit({ commit: f.first, branch: 'refs/heads/feature' });
  await f.save('文 档.md', '# Next\n'); const second = f.commit();
  await assert.rejects(source.resolveCommit({ commit: f.first, branch: 'refs/heads/feature' }), { code: 'GIT_REF_CHANGED' });
  assert.equal((await source.readSnapshot({ commit: f.first, filePath: '文 档.md' })).content, '# Committed original\n');
  assert.equal(await source.isAncestor(f.first, second), true);
  await assert.rejects(source.isAncestor('f'.repeat(40), second), { code: 'GIT_HISTORY_MISSING' });
});

test('divergent histories are distinct from missing objects and exact renames preserve identity', async t => {
  const f = await fixture(t); const source = await openGitSource(f.root);
  await rename(join(f.root, '文 档.md'), join(f.root, '改名.md')); const a = f.commit();
  assert.equal(await source.findRename({ fromCommit: f.first, toCommit: a, filePath: '文 档.md' }), '改名.md');
  assert.equal((await source.readSnapshot({ commit: a, filePath: '文 档.md' })).kind, 'deleted');
  f.git('checkout', '-qb', 'other', f.first); await f.save('文 档.md', '# Other branch\n'); const b = f.commit();
  assert.equal(await source.isAncestor(a, b), false);
  assert.equal(await source.findRename({ fromCommit: f.first, toCommit: b, filePath: '文 档.md' }), undefined);
});

test('source validates blob modes, UTF-8, size and nonblank content', async t => {
  const f = await fixture(t); await symlink('文 档.md', join(f.root, 'link.md'));
  await f.save('blank.md', '  \n'); await f.save('huge.md', 'x'.repeat(1_000_001)); await f.save('invalid.md', Buffer.from([0xff]));
  f.git('add', '-A'); f.git('update-index', '--add', '--cacheinfo', `160000,${f.first},submodule.md`);
  f.git('commit', '-qm', 'test: pin special source modes');
  const commit = f.git('rev-parse', 'HEAD'); const source = await openGitSource(f.root);
  assert.match(f.git('ls-tree', commit, '--', 'submodule.md'), /^160000 commit /);
  for (const filePath of ['link.md', 'submodule.md', 'blank.md', 'huge.md', 'invalid.md', '../outside.md', '/absolute.md', '文 档.md\0'])
    await assert.rejects(source.readSnapshot({ commit, filePath }), { code: 'INVALID_SOURCE' }, filePath);
  await assert.rejects(source.resolveCommit({ commit: '--help', branch: 'refs/heads/feature' }), { code: 'INVALID_REQUEST' });
});

test('unusual legal paths remain literal and duplicate rename candidates are not guessed', async t => {
  const f = await fixture(t); const source = await openGitSource(f.root);
  for (const name of ['-option.md', 'line\nbreak.md', '$(echo injected).md']) await f.save(name, '# Literal\n');
  const first = f.commit();
  for (const filePath of ['-option.md', 'line\nbreak.md', '$(echo injected).md'])
    assert.equal((await source.readSnapshot({ commit: first, filePath })).content, '# Literal\n');
  await rm(join(f.root, '文 档.md')); await f.save('copy1.md', '# Committed original\n'); await f.save('copy2.md', '# Committed original\n'); const next = f.commit();
  assert.equal(await source.findRename({ fromCommit: first, toCommit: next, filePath: '文 档.md' }), undefined);
});

test('linked worktrees share canonical repository identity and SHA-256 repositories are supported', async t => {
  const f = await fixture(t, 'sha256'); const other = join(f.temp, 'other');
  f.git('worktree', 'add', '-q', '-b', 'parallel', other);
  await writeFile(join(other, '文 档.md'), '# Different dirty workspace\n');
  const a = await openGitSource(f.root), b = await openGitSource(other);
  assert.equal((await a.identity()).commonDir, (await b.identity()).commonDir);
  assert.equal((await b.identity()).objectFormat, 'sha256'); assert.equal(f.first.length, 64);
  assert.equal((await b.readSnapshot({ commit: f.first, filePath: '文 档.md' })).content, '# Committed original\n');
});

test('push receipts inspect the actual bare ref without publishing or changing Git state', async t => {
  const f = await fixture(t); const bare = join(f.temp, 'remote.git'); f.git('init', '-q', '--bare', bare);
  f.git('remote', 'add', 'origin', bare); const source = await openGitSource(f.root);
  assert.equal((await source.confirmPush({ commit: f.first, branch: 'refs/heads/feature', remote: 'origin' })).state, 'unconfirmed');
  f.git('push', '-q', 'origin', 'feature');
  assert.equal((await source.confirmPush({ commit: f.first, branch: 'refs/heads/feature', remote: 'origin' })).state, 'confirmed');
  assert.equal((await source.confirmPush({ commit: f.first, branch: 'refs/heads/feature', remote: '--upload-pack=malicious' })).state, 'unconfirmed');
});

test('shallow graph boundaries report missing history even when both endpoint objects exist', async t => {
  const f = await fixture(t); await f.save('文 档.md', '# Shallow tip\n'); const commit = f.commit();
  await writeFile(join(f.root, '.git', 'shallow'), commit + '\n');
  const source = await openGitSource(f.root);
  await assert.rejects(source.isAncestor(f.first, commit), { code: 'GIT_HISTORY_MISSING' });
});

test('UTF-8 BOM content keeps a hash consistent with the complete published text', async t => {
  const f = await fixture(t); await f.save('文 档.md', '\uFEFF# Original with BOM\n'); const commit = f.commit();
  const source = await openGitSource(f.root), snapshot = await source.readSnapshot({ commit, filePath: '文 档.md' });
  assert.equal(snapshot.content, '\uFEFF# Original with BOM\n');
});

test('snapshot storage preserves a BOM original byte for byte when reconciling tasks', async t => {
  const f = await fixture(t), store = await createSyncStore(join(f.temp, 'state'));
  const content = '\uFEFF# Complete original\n', hash = createHash('sha256').update(content).digest('hex');
  const id = '00000000-0000-4000-8000-000000000001';
  await store.saveSnapshot(id, { content, hash });
  assert.equal(await store.readSnapshot(id, hash), content);
});
