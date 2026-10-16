import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGitBinding, confirmedGitBinding } from '../src/git-binding.mjs';

const record = () => ({ source: 'git', localHash: 'a'.repeat(64), git: { version: 1, commonDir: '/private/tmp/repo/.git', objectFormat: 'sha1',
  published: { commit: 'b'.repeat(40), blob: 'c'.repeat(40), branch: 'refs/heads/feature', hash: 'a'.repeat(64) } } });

test('persistent Git records require exact repository, object format and confirmed content identity', () => {
  assert.doesNotThrow(() => validateGitBinding(record()));
  for (const mutate of [
    b => { b.git.published.hash = 'd'.repeat(64); },
    b => { b.git.published.commit = 'b'.repeat(64); },
    b => { b.git.commonDir = 'relative'; },
    b => { b.git.published.branch = 'refs/heads/../bad'; },
    b => { b.git.token = 'unexpected'; },
    b => { b.git.intent = { ...b.git.published, content: 'Never persist in record JSON' }; },
  ]) { const b = record(); mutate(b); assert.throws(() => validateGitBinding(b), { code: 'INVALID_STATE' }); }
});
test('confirming a Git publication advances metadata without mutating the previous durable state', () => {
  const b = record(); b.git.intent = { commit: 'd'.repeat(40), blob: 'e'.repeat(40), branch: 'refs/heads/other', hash: 'f'.repeat(64) };
  const next = confirmedGitBinding({ ...b, localHash: 'f'.repeat(64) });
  assert.equal(next.git.published.commit, 'd'.repeat(40)); assert.equal(next.git.intent, undefined);
  assert.equal(b.git.published.commit, 'b'.repeat(40)); assert.ok(b.git.intent);
  assert.doesNotThrow(() => validateGitBinding(next));
});

test('versioned paths keep a confirmed snapshot readable while a rename is pending', () => {
  const b = record(); b.git.published.filePath = 'old.md';
  b.git.intent = { commit: 'd'.repeat(40), blob: 'e'.repeat(40), branch: 'refs/heads/feature', hash: 'f'.repeat(64), filePath: 'new.md' };
  assert.doesNotThrow(() => validateGitBinding(b));
  const next = confirmedGitBinding({ ...b, localHash: 'f'.repeat(64) });
  assert.equal(next.git.published.filePath, 'new.md'); assert.equal(b.git.published.filePath, 'old.md');
});
