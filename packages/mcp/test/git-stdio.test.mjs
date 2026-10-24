import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture, pageId, spaceId } from './git-fixture.mjs';

const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
async function connect(t, options = {}) {
  const f = await fixture(t); await f.manager.close();
  const paths = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url); let body = '';
    for await (const chunk of req) body += chunk;
    try {
      if (options.missing && req.url.includes('sync-')) { res.writeHead(404); res.end(JSON.stringify({ message: `Cannot POST ${req.url}` })); return; }
      const data = await f.api.post(req.url.slice('/api/'.length), JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, success: true, status: 200 }));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, DOCMOST_URL: `http://127.0.0.1:${server.address().port}`, DOCMOST_ALLOW_LOCAL_HTTP: '1',
    DOCMOST_AUTH_MODE: 'api_key', DOCMOST_API_TOKEN: 'synthetic-git-stdio-token', DOCMOST_API_TOKEN_FILE: undefined, DOCMOST_SESSION_FILE: undefined,
    DOCMOST_DEFAULT_SPACE_ID: spaceId, DOCMOST_DEFAULT_PARENT_PAGE_ID: undefined, DOCMOST_READ_ONLY: options.readOnly ? '1' : '0',
    DOCMOST_GIT_ROOT: options.rootless ? undefined : f.root, DOCMOST_KNOWLEDGE_STATE_DIR: f.config.knowledgeStateDir,
    DOCMOST_SYNC_ROOT: undefined, DOCMOST_SYNC_STATE_DIR: undefined, DOCMOST_KNOWLEDGE_PROVIDER: 'none' };
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', serial = 0; const requests = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line), pending = requests.get(message.id);
      if (pending) { requests.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
    }
  });
  const exited = once(child, 'close');
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => reject(Error(`RPC timed out; ${stderr}`)), 8000);
    requests.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    let forced = false;
    if (!await Promise.race([exited.then(() => true), delay(4000, false, { ref: false })])) {
      forced = true; child.kill('SIGTERM');
      if (!await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })])) child.kill('SIGKILL');
    }
    await exited; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const pending of requests.values()) clearTimeout(pending.timer);
    assert.equal(forced, false, 'stdio must release its active work and exit after EOF');
  });
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'git-delivery-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tool = async (name, args) => {
    const result = await call('tools/call', { name, arguments: args });
    let data; try { data = JSON.parse(result.content[0].text); } catch { data = { validationError: result.content[0].text }; }
    return { result, data };
  };
  // Schema-rejection cases can finish before eager startup has created its
  // private directories. Wait for startup before fixture cleanup may run.
  await tool('get_git_document_status', {});
  return { ...f, child, exited, paths, call, tool, env };
}

test('real stdio exposes Git tools without MD/knowledge and publishes a committed feature snapshot', { timeout: 20000 }, async t => {
  const f = await connect(t); const { tools } = await f.call('tools/list');
  for (const name of ['bind_git_document', 'publish_git_documents', 'get_git_document_status', 'set_git_document_sync', 'resolve_git_document_conflict']) assert.ok(tools.some(tool => tool.name === name), name);
  const bound = await f.tool('bind_git_document', { pageId, filePath: 'document.md', commit: f.first, branch: 'refs/heads/feature' });
  assert.equal(bound.data.source, 'git'); assert.equal(f.state.writes, 0);
  await f.save('# Stdio committed body\n'); const commit = f.commit(); await f.save('# Private workspace draft\n');
  const published = await f.tool('publish_git_documents', { commit, branch: 'refs/heads/feature' });
  assert.equal(published.data.documents[0].state, 'synced'); assert.equal(f.state.body, '# Stdio committed body\n');
  f.child.stdin.end(); await f.exited;
  await f.save('# Changed after EOF\n'); assert.equal(f.state.writes, 1);
});

test('read-only stdio exposes only Git status and never dispatches writes', async t => {
  const f = await connect(t, { readOnly: true }); const { tools } = await f.call('tools/list');
  assert.ok(tools.some(tool => tool.name === 'get_git_document_status'));
  assert.equal(tools.some(tool => ['bind_git_document', 'publish_git_documents', 'set_git_document_sync', 'resolve_git_document_conflict'].includes(tool.name)), false);
  assert.equal(f.state.writes, 0);
});

test('rootless stdio discovers publication tools and accepts per-call project context', async t => {
  const f = await connect(t, { rootless: true }); const { tools } = await f.call('tools/list');
  assert.ok(tools.some(tool => tool.name === 'publish_git_documents'));
  const bound = await f.tool('bind_git_document', { repositoryRoot: f.root, pageId, filePath: 'document.md', commit: f.first, branch: 'refs/heads/feature' });
  assert.equal(bound.result.isError, undefined); assert.equal(bound.data.repository.root, f.root);
  await f.save('# Context selected committed body\n'); const commit = f.commit();
  const r = await f.tool('publish_git_documents', { repositoryRoot: f.root, commit, branch: 'refs/heads/feature' }); assert.equal(r.data.documents[0].state, 'synced');
});

test('missing conditional endpoints report unsupported and never fall back to ordinary update', async t => {
  const f = await connect(t, { missing: true });
  const result = await f.tool('bind_git_document', { pageId, filePath: 'document.md', commit: f.first, branch: 'refs/heads/feature' });
  assert.equal(result.result.isError, true); assert.equal(result.data.error.code, 'UNSUPPORTED_DEPLOYMENT');
  assert.equal(f.paths.includes('/api/pages/update'), false); assert.equal(f.state.writes, 0);
});

test('invalid commit/path schemas cannot invoke Git publication', async t => {
  const f = await connect(t);
  const result = await f.tool('bind_git_document', { pageId, filePath: '../outside.md', commit: '--help', branch: 'refs/heads/feature' });
  assert.equal(result.result.isError, true); assert.equal(f.state.writes, 0);
});

test('acceptance client uses real stdio and closes its own connection cleanly', { timeout: 15000 }, async t => {
  const f = await connect(t);
  await f.tool('get_git_document_status', {});
  f.child.stdin.end(); await f.exited;
  const { connectMcp } = await import('../scripts/stdio-client.mjs');
  const client = await connectMcp(entry, f.env);
  try {
    const tools = await client.call('tools/list'); assert.ok(tools.tools.some(tool => tool.name === 'publish_git_documents'));
    assert.deepEqual((await client.tool('get_git_document_status', {})).bindings, []);
  } finally { await client.close(); }
  assert.equal((await client.exited).code, 0);
});
