import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ApiError } from './errors.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const owns = info => !process.getuid || info.uid === process.getuid();
export const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const contained = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const invalid = () => new ApiError('INVALID_SOURCE', 'Use an owned regular UTF-8 Markdown file under the configured source root, at most 1,000,000 bytes and with nonblank content.');

export function validRelativeFile(filePath) {
  return typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 4096
    && !isAbsolute(filePath) && !filePath.includes('\\') && !filePath.includes('\0')
    && !filePath.split('/').some(part => !part || part === '.' || part === '..')
    && filePath.endsWith('.md');
}

// Reject symlinks in every component, including a substituted configured root.
export async function absoluteDirectory(path, code = 'INVALID_STATE') {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path)
    throw new ApiError(code, 'The configured directory must be an existing absolute non-symlink directory.');
  let current = parse(path).root;
  let info;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ApiError(code, 'Directory symlinks and non-directory paths are not allowed.');
  }
  if (!info || !owns(info) || await realpath(path) !== path)
    throw new ApiError(code, 'The configured directory must be owned by the current user.');
  return info;
}

export async function readMarkdown(root, rootInfo, filePath) {
  let handle;
  try {
    if (!validRelativeFile(filePath)) throw invalid();
    const beforeRoot = await absoluteDirectory(root, 'INVALID_SOURCE');
    if (!sameFile(rootInfo, beforeRoot)) throw invalid();
    const components = filePath.split('/');
    let current = root;
    const snapshots = [[root, beforeRoot]];
    for (const [index, part] of components.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (!owns(info) || info.isSymbolicLink() || (index === components.length - 1 ? !info.isFile() : !info.isDirectory())) throw invalid();
      snapshots.push([current, info]);
    }
    const before = snapshots.at(-1)[1];
    if (before.size > 1_000_000) throw invalid();
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || !owns(opened) || !sameFile(before, opened) || opened.size > 1_000_000) throw invalid();
    const bytes = Buffer.alloc(1_000_001);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1_000_000) throw invalid();
    const after = await handle.stat();
    if (!sameFile(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw invalid();
    for (const [path, snapshot] of snapshots) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !owns(info) || !sameFile(snapshot, info)) throw invalid();
    }
    if (await realpath(current) !== current) throw invalid();
    const buffer = bytes.subarray(0, length);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (!content.trim()) throw invalid();
    return { content, hash: digest(buffer) };
  } catch { throw invalid(); }
  finally { await handle?.close(); }
}
