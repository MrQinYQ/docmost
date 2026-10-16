import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, utimes, rm, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('standalone delivery inspection reports staged/untracked/deleted documents without reading their bodies', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'git-delivery-helper-')); const repo = join(temp, 'repo'); await mkdir(repo);
  t.after(() => rm(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'feature'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'remove.md'), '# Secret original body'); await writeFile(join(repo, 'tracked.md'), '# Tracked');
  git('add', '-A'); git('commit', '-qm', 'docs: add example');
  await rm(join(repo, 'remove.md')); await writeFile(join(repo, '新 文档.md'), '# Never expose draft'); git('add', '-A');
  await writeFile(join(repo, 'untracked.md'), '# Other private draft'); const before = git('status', '--porcelain=v1');
  await utimes(join(repo, 'tracked.md'), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
  const indexBefore = await readFile(join(repo, '.git', 'index'));
  const helper = join(temp, 'inspect.mjs'); await copyFile(fileURLToPath(new URL('../../../skills/git-delivery/scripts/inspect-git.mjs', import.meta.url)), helper);
  const stdout = execFileSync(process.execPath, [helper, '--repo', repo, '--commit', git('rev-parse', 'HEAD')], { encoding: 'utf8' });
  const result = JSON.parse(stdout); assert.equal(result.branch, 'refs/heads/feature');
  assert.ok(result.changes.staged.some(change => change.path === '新 文档.md'));
  assert.ok(result.changes.staged.some(change => change.path === 'remove.md' && change.status === 'D'));
  assert.ok(result.changes.untracked.includes('untracked.md'));
  assert.equal(/Secret original|Never expose|Other private/.test(stdout), false);
  assert.deepEqual(await readFile(join(repo, '.git', 'index')), indexBefore, 'read-only inspection must not refresh the Git index');
  assert.equal(git('status', '--porcelain=v1'), before);
});
