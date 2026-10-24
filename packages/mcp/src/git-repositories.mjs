import { isAbsolute, resolve } from 'node:path';
import { ApiError } from './errors.mjs';
import { contained, digest } from './sync-files.mjs';
import { openGitSource } from './git-source.mjs';

export const gitRepositoryId = git => digest(JSON.stringify([git.commonDir, git.objectFormat, git.instance ?? null]));
export const sameGitRepository = (binding, repository) => binding.source === 'git'
  && binding.git.commonDir === repository.commonDir && binding.git.objectFormat === repository.objectFormat
  && (binding.git.instance === undefined || binding.git.instance === repository.instance);

/** Readers are connection-local; durable identity remains in the existing binding. */
export function createGitRepositories({ stateDir, signal }) {
  const readers = new Map();
  function checkRoot(root) {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root)
      throw new ApiError('INVALID_SOURCE', 'Use the canonical absolute repository root detected in the current project.');
    if (contained(root, stateDir) || contained(stateDir, root))
      throw new ApiError('INVALID_STATE', 'Repository and private synchronization state must be separate directories.');
  }
  async function open(root) {
    checkRoot(root);
    let reader;
    try {
      if (!readers.has(root)) {
        const opening = openGitSource(root, { signal }); readers.set(root, opening);
        opening.catch(() => { if (readers.get(root) === opening) readers.delete(root); });
      }
      reader = await readers.get(root); const identity = await reader.identity();
      checkRoot(identity.commonDir);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INVALID_SOURCE', 'The selected repository is unavailable. Restore its directory before publishing.');
    }
    return reader;
  }
  async function forBinding(binding, root) {
    checkRoot(binding.root);
    // Committed trees/refs live in the pinned common directory. This also lets
    // recovery read an enrolled linked worktree after that checkout is removed.
    const selected = await open(root ?? binding.git.commonDir);
    if (!sameGitRepository(binding, await selected.identity()))
      throw new ApiError('TARGET_CHANGED', 'The selected project is not the repository enrolled for this document.');
    if (binding.git.instance === undefined)
      throw new ApiError('GIT_IDENTITY_UNCONFIRMED', 'This older record has no directory-instance identity. Explicitly confirm the trusted original repository before resuming.');
    const reader = await open(binding.git.commonDir), prefix = binding.git.prefix;
    if (!sameGitRepository(binding, await reader.identity())) throw new ApiError('TARGET_CHANGED', 'The enrolled repository directory was replaced.');
    // Always address trees from commonDir and the enrolled prefix, never the
    // invocation cwd. A linked checkout can disappear without changing paths.
    return { ...reader,
      readSnapshot: input => reader.readSnapshot({ ...input, filePath: prefix + input.filePath }),
      async findRename(input) {
        const path = await reader.findRename({ ...input, filePath: prefix + input.filePath });
        return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
      },
    };
  }
  async function confirm(binding, root) {
    if (binding.git.instance !== undefined) throw new ApiError('INVALID_REQUEST', 'Repository confirmation only applies to older unpinned records.');
    checkRoot(binding.root);
    const selected = await open(root), original = await open(binding.root);
    const repo = await selected.identity(), saved = await original.identity();
    if (!sameGitRepository(binding, repo) || !sameGitRepository(binding, saved) || repo.instance !== saved.instance)
      throw new ApiError('TARGET_CHANGED', 'The selected project is not the repository saved in this record.');
    const source = await original.readSnapshot({ commit: binding.git.published.commit, filePath: binding.git.published.filePath ?? binding.filePath });
    if (source.kind !== 'body' || source.hash !== binding.localHash || source.blob !== binding.git.published.blob)
      throw new ApiError('INVALID_SOURCE', 'The original confirmed Git content could not be verified. Preserve this record and restore its source.');
    return { ...binding.git, instance: saved.instance, prefix: saved.prefix };
  }
  return { open, forBinding, confirm };
}
