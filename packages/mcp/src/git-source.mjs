import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiError } from './errors.mjs';
import { absoluteDirectory, sameFile, digest, validRelativeFile } from './sync-files.mjs';

const messages = {
  INVALID_SOURCE: 'Use a committed, nonblank UTF-8 Markdown blob of at most 1,000,000 bytes in the configured Git repository.',
  INVALID_REQUEST: 'Use a full commit object ID and an existing refs/heads branch in the configured repository.',
  GIT_HISTORY_MISSING: 'The required commit is unavailable. Restore the repository history before publishing.',
  GIT_REF_CHANGED: 'The branch no longer points to the requested commit. Inspect its current HEAD before publishing.',
  TARGET_CHANGED: 'The configured repository identity changed. Inspect the association before publishing.',
  CANCELLED: 'Git inspection was cancelled.',
};
const fail = code => new ApiError(code, messages[code]);
const oid = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const branchName = value => typeof value === 'string' && value.startsWith('refs/heads/') && value.length <= 1024 && !/[\0\r\n]/.test(value);

function environment() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  return env;
}

export async function openGitSource(root, { signal } = {}) {
  const initial = await absoluteDirectory(root, 'INVALID_SOURCE');
  const run = (args, maxBuffer = 1_100_000) => new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(fail('CANCELLED'));
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, env: environment(), signal, timeout: 30000, maxBuffer, encoding: 'buffer' }, (error, stdout) => {
        if (signal?.aborted) return reject(fail('CANCELLED'));
        if (error && typeof error.code !== 'number') return reject(fail('INVALID_SOURCE'));
        resolveResult({ code: error?.code ?? 0, bytes: stdout ?? Buffer.alloc(0), text: (stdout ?? Buffer.alloc(0)).toString('utf8') });
      });
  });
  const commonResult = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const formatResult = await run(['rev-parse', '--show-object-format']);
  if (commonResult.code || formatResult.code || !['sha1', 'sha256'].includes(formatResult.text.trim())) throw fail('INVALID_SOURCE');
  const commonDir = resolve(commonResult.text.trim());
  const commonInfo = await absoluteDirectory(commonDir, 'INVALID_SOURCE');
  const commonStat = await lstat(commonDir, { bigint: true });
  const instance = digest(JSON.stringify([commonStat.dev.toString(), commonStat.ino.toString(), commonStat.birthtimeNs.toString()]));
  const prefixResult = await run(['rev-parse', '--show-prefix']);
  const prefix = prefixResult.text.trimEnd();
  if (prefixResult.code || (prefix && (!prefix.endsWith('/') || !validRelativeFile(prefix + 'document.md')))) throw fail('INVALID_SOURCE');
  const objectFormat = formatResult.text.trim();
  const length = objectFormat === 'sha256' ? 64 : 40;
  async function verify() {
    if (!sameFile(initial, await absoluteDirectory(root, 'TARGET_CHANGED'))
      || !sameFile(commonInfo, await absoluteDirectory(commonDir, 'TARGET_CHANGED'))) throw fail('TARGET_CHANGED');
    const current = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (current.code || resolve(current.text.trim()) !== commonDir || await realpath(root) !== root) throw fail('TARGET_CHANGED');
  }
  async function requireCommit(commit) {
    if (!oid(commit) || commit.length !== length) throw fail('INVALID_REQUEST');
    const result = await run(['cat-file', '-t', commit]);
    if (result.code || result.text.trim() !== 'commit') throw fail('GIT_HISTORY_MISSING');
  }
  async function requireBranch(branch) {
    if (!branchName(branch) || (await run(['check-ref-format', branch])).code) throw fail('INVALID_REQUEST');
  }
  async function readSnapshot({ commit, filePath }) {
    if (!validRelativeFile(filePath)) throw fail('INVALID_SOURCE');
    await verify(); await requireCommit(commit);
    const tree = await run(['ls-tree', '-z', commit, '--', filePath]);
    if (tree.code) throw fail('INVALID_SOURCE');
    if (!tree.bytes.length) return { kind: 'deleted', commit };
    const entries = tree.text.split('\0').filter(Boolean);
    const entry = entries.length === 1 && entries[0].match(/^([0-7]{6}) blob ([0-9a-f]+)\t([\s\S]*)$/);
    if (!entry || !['100644', '100755'].includes(entry[1]) || entry[3] !== filePath) throw fail('INVALID_SOURCE');
    const blob = entry[2];
    const size = await run(['cat-file', '-s', blob]);
    if (size.code || !/^\d+\s*$/.test(size.text) || Number(size.text) > 1_000_000) throw fail('INVALID_SOURCE');
    const raw = await run(['cat-file', 'blob', blob], 1_000_001);
    if (raw.code || raw.bytes.length !== Number(size.text)) throw fail('INVALID_SOURCE');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.bytes); } catch { throw fail('INVALID_SOURCE'); }
    if (!content.trim()) throw fail('INVALID_SOURCE');
    await verify();
    return { kind: 'body', commit, blob, content, hash: digest(raw.bytes) };
  }
  return {
    async identity() { await verify(); return { root, commonDir, objectFormat, instance, prefix }; },
    async resolveCommit({ commit, branch }) {
      await verify(); await requireCommit(commit); await requireBranch(branch);
      const current = await run(['rev-parse', '--verify', branch]);
      if (current.code || current.text.trim() !== commit) throw fail('GIT_REF_CHANGED');
      return { commit, branch };
    },
    readSnapshot,
    async isAncestor(before, after) {
      await verify(); await requireCommit(before); await requireCommit(after);
      const result = await run(['merge-base', '--is-ancestor', before, after]);
      if (result.code > 1) throw fail('GIT_HISTORY_MISSING');
      if (result.code === 1 && (await run(['rev-parse', '--is-shallow-repository'])).text.trim() === 'true') throw fail('GIT_HISTORY_MISSING');
      return result.code === 0;
    },
    async findRename({ fromCommit, toCommit, filePath }) {
      const old = await readSnapshot({ commit: fromCommit, filePath });
      if (old.kind !== 'body' || (await readSnapshot({ commit: toCommit, filePath })).kind !== 'deleted') return;
      const changes = await run(['diff-tree', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--no-renames', '--name-status', '-r', '-z', fromCommit, toCommit]);
      if (changes.code) throw fail('INVALID_SOURCE');
      const parts = changes.text.split('\0'), candidates = [], originals = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (!['A', 'D'].includes(parts[i]) || !validRelativeFile(parts[i + 1])) continue;
        const adding = parts[i] === 'A';
        const candidate = await readSnapshot({ commit: adding ? toCommit : fromCommit, filePath: parts[i + 1] });
        if (candidate.kind === 'body' && candidate.blob === old.blob) (adding ? candidates : originals).push(parts[i + 1]);
      }
      return candidates.length === 1 && originals.length === 1 ? candidates[0] : undefined;
    },
    async confirmPush({ commit, branch, remote }) {
      const result = { state: 'unconfirmed', commit, branch, remote };
      try {
        await verify(); await requireCommit(commit); await requireBranch(branch);
        if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(remote)) return result;
        const remotes = await run(['remote']);
        if (!remotes.text.split('\n').includes(remote)) return result;
        const refs = await run(['ls-remote', '--refs', remote, branch]);
        if (!refs.code && refs.text.split('\n').some(line => line === `${commit}\t${branch}`)) result.state = 'confirmed';
      } catch { /* A push receipt cannot prevent an otherwise authorized publication. */ }
      return result;
    },
  };
}
