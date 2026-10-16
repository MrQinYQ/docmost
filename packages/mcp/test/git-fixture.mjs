import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMarkdownSync } from '../src/sync.mjs';

export const pageId = '00000000-0000-4000-8000-000000000001';
export const spaceId = '00000000-0000-4000-8000-000000000002';
export const workspaceId = '00000000-0000-4000-8000-000000000003';
export const userId = '00000000-0000-4000-8000-000000000004';
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function fixture(t, { knowledge = false, markdown = false } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'git-publication-'))), root = join(temp, 'repo'); await mkdir(root);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'feature'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'test@example.invalid');
  const save = async content => writeFile(join(root, 'document.md'), content);
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'docs: update fixture'); return git('rev-parse', 'HEAD'); };
  await save('# Initial\n'); const first = commit();
  const state = { body: '# Initial\n', persisted: '# Initial\n', writes: 0, offline: false, failReads: false, loseAck: false };
  const rootUri = 'viking://user/test/resources/docmost-mcp';
  const config = { origin: 'https://docmost.test', gitRoot: root, knowledgeStateDir: join(temp, 'state'),
    ...(markdown ? { syncRoot: root, syncStateDir: join(temp, 'state') } : {}),
    knowledgeBase: knowledge ? { provider: 'openviking', config: { origin: 'http://127.0.0.1:1933', rootUri } } : undefined };
  const api = { async post(path, input) {
    const fail = code => Object.assign(new Error('Synthetic failure'), { code });
    if (path === 'users/me') return { user: { id: userId }, workspace: { id: workspaceId } };
    if (path === 'pages/info') return { id: pageId, spaceId, workspaceId, parentPageId: null, title: 'Git document', content: state.persisted, deletedAt: state.deletedAt ?? null };
    if (path === 'spaces/info') return { id: spaceId, workspaceId, name: 'Test space' };
    const remote = () => ({ pageId, spaceId, workspaceId, revision: hash(state.body), persistedRevision: hash(state.persisted) });
    if (path === 'pages/sync-state') {
      if (state.failReads) throw fail('NETWORK_ERROR');
      return { ...remote(), ...(input.content !== undefined ? { proposedRevision: hash((state.proposedPrefix ?? '') + input.content) } : {}) };
    }
    if (path === 'pages/sync-update') {
      if (input.expectedRevision !== hash(state.body)) throw fail('CONFLICT');
      state.writes++; state.body = input.content; if (!state.holdPersistence) state.persisted = input.content;
      if (state.loseAck) { state.failReads = true; throw fail('NETWORK_ERROR'); }
      return remote();
    }
    throw fail('UNSUPPORTED_DEPLOYMENT');
  } };
  const resources = new Map(), dirs = new Set(), tasks = new Map(); let serial = 0;
  const addDir = uri => { while (uri.startsWith(rootUri)) { dirs.add(uri); if (uri === rootUri) break; uri = uri.slice(0, uri.lastIndexOf('/')); } };
  const client = {
    async identity() { if (state.offline) throw Object.assign(Error(), { code: 'OV_NETWORK_ERROR' }); return { accountId: 'personal', userId: 'test', rootUri }; },
    async read(uri) { return resources.get(uri); },
    async write(uri, content) { resources.set(uri, content); addDir(uri.slice(0, uri.lastIndexOf('/'))); },
    async reindex(uri) { const taskId = `git_task_${++serial}`; tasks.set(taskId, { taskId, uri, status: 'completed', failedRecords: 0, unsupportedRecords: 0 }); return { taskId }; },
    async task(id) { return tasks.get(id); }, async tasks() { return []; }, async waitProcessed() { return {}; },
    async list(uri) {
      if (!dirs.has(uri)) return;
      const direct = key => key.startsWith(uri + '/') && !key.slice(uri.length + 1).includes('/');
      return [...[...resources.keys()].filter(direct).map(key => ({ name: key.slice(uri.length + 1), uri: key, isDir: false })), ...[...dirs].filter(direct).map(key => ({ name: key.slice(uri.length + 1), uri: key, isDir: true }))];
    },
    async remove(uri) { for (const key of resources.keys()) if (key === uri || key.startsWith(uri + '/')) resources.delete(key); for (const key of dirs) if (key === uri || key.startsWith(uri + '/')) dirs.delete(key); return { semanticStatus: 'complete' }; },
  };
  const managers = [];
  const create = (overrides = {}) => { const manager = createMarkdownSync({ ...config, ...overrides }, { api, mirrorClient: client, scanMs: 10, debounceMs: 10 }); managers.push(manager); return manager; };
  const manager = create(); await manager.start();
  t.after(async () => { for (const m of managers) await m.close(); await rm(temp, { recursive: true, force: true }); });
  const bind = () => manager.bindGitDocument({ filePath: 'document.md', pageId, commit: first, branch: 'refs/heads/feature' });
  return { temp, root, first, git, save, commit, state, config, api, manager, create, bind, resources, tasks };
}
export async function eventually(read, predicate) {
  const until = Date.now() + 5000; let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); } while (Date.now() < until);
  throw Error(`Git fixture did not settle: ${JSON.stringify(value)}`);
}
