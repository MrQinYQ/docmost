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
  const dirs = { bindings: join(path, 'bindings'), leases: join(path, 'leases') };
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
  async function read(pathname, name) {
    await check(name);
    let handle;
    try {
      const before = await lstat(pathname);
      if (!safeFile(before) || before.size > 1_000_000) throw fail();
      handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!safeFile(opened) || !sameFile(before, opened)) throw fail();
      const text = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(text) > 1_000_000) throw fail();
      await check(name);
      if (!sameFile(opened, await lstat(pathname))) throw fail();
      return JSON.parse(text);
    } catch (error) { if (error.code === 'ENOENT') throw error; throw fail(); }
    finally { await handle?.close(); }
  }
  async function atomicWrite(filename, value) {
    if (readOnly) throw fail();
    await check('bindings');
    const path = join(dirs.bindings, filename);
    try { if (!safeFile(await lstat(path))) throw fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    const temp = join(dirs.bindings, `.${filename}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close(); handle = undefined;
      await check('bindings');
      await rename(temp, path);
      const dir = await open(dirs.bindings, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw fail(); }
    finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
  return {
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
