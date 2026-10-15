import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ApiError } from './errors.mjs';
import { absoluteDirectory, owns, sameFile, digest } from './sync-files.mjs';

const fail = () => new ApiError('INVALID_STATE', 'Sync storage must use owned private non-symlink directories (0700) and regular files (0600).');
const safeDir = info => owns(info) && info.isDirectory() && (info.mode & 0o777) === 0o700;
const safeFile = info => owns(info) && info.isFile() && (info.mode & 0o777) === 0o600 && info.nlink === 1;

async function makeDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw fail();
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw fail();
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
      if (!safeDir(info)) throw fail();
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail();
  }
}

export async function createSyncStore(path, { readOnly = false } = {}) {
  if (!readOnly) await makeDirectory(path);
  let rootInfo;
  try { rootInfo = await absoluteDirectory(path); }
  catch (error) { if (readOnly && error.code === 'ENOENT') return { load: async () => [] }; throw fail(); }
  if (!safeDir(rootInfo)) throw fail();
  const dirs = { bindings: join(path, 'bindings'), leases: join(path, 'leases'), snapshots: join(path, 'snapshots'), history: join(path, 'history') };
  if (!readOnly) for (const dir of Object.values(dirs)) await makeDirectory(dir);
  const dirInfo = {};
  for (const [name, dir] of Object.entries(dirs)) {
    try { dirInfo[name] = await lstat(dir); }
    catch (error) { if (readOnly && error.code === 'ENOENT') continue; throw fail(); }
    if (!safeDir(dirInfo[name]) || dirInfo[name].isSymbolicLink()) throw fail();
  }
  async function check(name) {
    try {
      const info = await absoluteDirectory(path);
      const child = await lstat(dirs[name]);
      if (!safeDir(info) || !sameFile(rootInfo, info) || !safeDir(child) || !sameFile(dirInfo[name], child)) throw fail();
    } catch { throw fail(); }
  }
  async function read(pathname, name, raw = false) {
    await check(name);
    let handle;
    try {
      const before = await lstat(pathname);
      if (!safeFile(before) || before.size > 1_000_000) throw fail();
      handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!safeFile(opened) || !sameFile(before, opened)) throw fail();
      const bytes = await handle.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (Buffer.byteLength(text) > 1_000_000) throw fail();
      await check(name);
      if (!sameFile(opened, await lstat(pathname))) throw fail();
      return raw ? text : JSON.parse(text);
    } catch (error) { if (error.code === 'ENOENT') throw error; throw fail(); }
    finally { await handle?.close(); }
  }
  async function atomicWrite(filename, value, name = 'bindings', raw = false) {
    if (readOnly) throw fail();
    await check(name);
    const path = join(dirs[name], filename);
    try { if (!safeFile(await lstat(path))) throw fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    const temp = join(dirs[name], `.${filename}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(raw ? value : JSON.stringify(value));
      await handle.sync();
      await handle.close(); handle = undefined;
      await check(name);
      await rename(temp, path);
      const dir = await open(dirs[name], constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw fail(); }
    finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
  function snapshotName(bindingId, hash) {
    if (!/^[0-9a-f-]{36}$/.test(bindingId) || !/^[0-9a-f]{64}$/.test(hash)) throw fail();
    return `${bindingId}-${hash}.md`;
  }
  return {
    async saveSnapshot(bindingId, { hash, content }) {
      const filename = snapshotName(bindingId, hash);
      if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000 || digest(content) !== hash) throw fail();
      await atomicWrite(filename, content, 'snapshots', true);
    },
    async readSnapshot(bindingId, hash) {
      const content = await read(join(dirs.snapshots, snapshotName(bindingId, hash)), 'snapshots', true);
      if (digest(content) !== hash) throw fail();
      return content;
    },
    async removeSnapshot(bindingId, hash) {
      const pathname = join(dirs.snapshots, snapshotName(bindingId, hash));
      try { await read(pathname, 'snapshots', true); await unlink(pathname); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    async pruneSnapshots(bindingId, retained) {
      if (!/^[0-9a-f-]{36}$/.test(bindingId) || retained.some(hash => !/^[0-9a-f]{64}$/.test(hash))) throw fail();
      await check('snapshots');
      const files = (await readdir(dirs.snapshots)).filter(name => name.startsWith(`${bindingId}-`) && !name.startsWith('.'));
      if (files.length > 5000) throw fail();
      for (const name of files) {
        const match = name.match(/^[0-9a-f-]{36}-([0-9a-f]{64})\.md$/);
        if (!match) throw fail();
        if (retained.includes(match[1])) continue;
        const pathname = join(dirs.snapshots, name);
        await read(pathname, 'snapshots', true); await unlink(pathname);
      }
    },
    async archiveMirror(binding) {
      if (!binding.mirror) return;
      if (!/^[0-9a-f-]{36}$/.test(binding.bindingId)) throw fail();
      const key = digest(`${binding.origin}|${binding.workspaceId}|${binding.pageId}`);
      // A later association to the same page must not erase the task fence
      // retained when an earlier association was explicitly removed.
      await atomicWrite(`${key}-${binding.bindingId}.json`, { bindingId: binding.bindingId, origin: binding.origin, workspaceId: binding.workspaceId, pageId: binding.pageId, mirror: binding.mirror, active: false }, 'history');
    },
    async loadMirrorHistory() {
      if (!dirInfo.history) return [];
      await check('history');
      const files = (await readdir(dirs.history)).filter(name => !name.startsWith('.'));
      if (files.length > 5000 || files.some(name => !/^[0-9a-f]{64}(?:-[0-9a-f-]{36})?\.json$/.test(name))) throw fail();
      const values = [];
      for (const filename of files) {
        const value = await read(join(dirs.history, filename), 'history');
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.active !== false
          || ['origin', 'workspaceId', 'pageId'].some(field => typeof value[field] !== 'string' || !value[field])
          || Object.keys(value).some(field => !['bindingId', 'origin', 'workspaceId', 'pageId', 'mirror', 'active'].includes(field))) throw fail();
        const key = digest(`${value.origin}|${value.workspaceId}|${value.pageId}`);
        const expected = value.bindingId === undefined ? `${key}.json` : `${key}-${value.bindingId}.json`;
        if (filename !== expected || (value.bindingId !== undefined && !/^[0-9a-f-]{36}$/.test(value.bindingId))) throw fail();
        values.push({ filename, value });
      }
      return values;
    },
    async load() {
      if (!dirInfo.bindings) return [];
      await check('bindings');
      const files = (await readdir(dirs.bindings)).filter(name => !name.startsWith('.'));
      if (files.length > 50 || files.some(name => !/^[0-9a-f-]{36}\.json$/.test(name))) throw fail();
      const values = [];
      for (const filename of files) values.push({ filename, value: await read(join(dirs.bindings, filename), 'bindings') });
      return values;
    },
    save: value => atomicWrite(`${value.bindingId}.json`, value),
    async remove(bindingId) {
      await check('bindings');
      const pathname = join(dirs.bindings, `${bindingId}.json`);
      await read(pathname, 'bindings');
      await unlink(pathname);
    },
    async acquire({ origin, workspaceId, pageId }, signal) {
      await check('leases');
      signal.throwIfAborted();
      const pathname = join(dirs.leases, `${digest(`${origin}|${workspaceId}|${pageId}`)}.json`);
      const value = { pid: process.pid, nonce: randomUUID() };
      let handle;
      try {
        handle = await open(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await handle.close(); handle = undefined;
        await check('leases');
        return { pathname, ...value };
      } catch (error) {
        if (error.code === 'EEXIST') throw new ApiError('LEASE_BUSY', 'Another sync process owns this page lease. For stale leases, confirm the process has stopped before manually removing its lease file.');
        throw fail();
      } finally { await handle?.close(); }
    },
    async assertLease(lease) {
      let value;
      try { value = await read(lease.pathname, 'leases'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!value || value.pid !== lease.pid || value.nonce !== lease.nonce)
        throw new ApiError('LEASE_BUSY', 'This process no longer owns the page lease.');
    },
    async release(lease) {
      if (!lease) return;
      const value = await read(lease.pathname, 'leases');
      if (value.pid === lease.pid && value.nonce === lease.nonce) await unlink(lease.pathname);
    },
  };
}
