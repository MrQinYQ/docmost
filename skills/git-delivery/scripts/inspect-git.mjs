#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--commit'].includes(args[i]) || options[args[i]] !== undefined || !args[i + 1]) throw Error();
    options[args[i]] = args[i + 1];
  }
  if (!options['--repo'] || (options['--commit'] && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options['--commit']))) throw Error();
  const root = realpathSync(resolve(options['--repo']));
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  const git = (...input) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...input],
    { cwd: root, env, timeout: 30000, maxBuffer: 2_000_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const head = git('rev-parse', '--verify', 'HEAD').trim();
  let branch = null; try { branch = git('symbolic-ref', '-q', 'HEAD').trim(); } catch { /* Detached HEAD has no branch. */ }
  const changes = { staged: [], unstaged: [], untracked: [] };
  const records = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const status = record.slice(0, 2), path = record.slice(3);
    if (status === '??') { changes.untracked.push(path); continue; }
    const oldPath = /[RC]/.test(status) ? records[++i] : undefined;
    if (status[0] !== ' ') changes.staged.push({ status: status[0], path, ...(oldPath ? { oldPath } : {}) });
    if (status[1] !== ' ') changes.unstaged.push({ status: status[1], path, ...(oldPath ? { oldPath } : {}) });
  }
  const documents = [];
  if (options['--commit']) {
    const commit = options['--commit'];
    const parents = git('rev-list', '--parents', '-n', '1', commit).trim().split(' ');
    const diff = parents.length > 1
      ? git('diff', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-z', parents[1], commit, '--')
      : git('diff-tree', '--root', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', commit, '--');
    const entries = diff.split('\0');
    for (let i = 0; i + 1 < entries.length; i += 2) if (entries[i + 1].endsWith('.md')) documents.push({ status: entries[i], path: entries[i + 1] });
  }
  const commits = git('log', '-6', '--format=%H%x09%s').trim().split('\n').filter(Boolean).map(line => ({ oid: line.slice(0, line.indexOf('\t')), subject: line.slice(line.indexOf('\t') + 1) }));
  const mergeHead = git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
  process.stdout.write(JSON.stringify({ root, head, branch, changes, documents, commits, mergeInProgress: existsSync(resolve(root, mergeHead)) }) + '\n');
} catch {
  process.stderr.write('GIT_INSPECTION_FAILED: Use an accessible Git repository and an optional full commit ID. No changes were made.\n');
  process.exitCode = 1;
}
