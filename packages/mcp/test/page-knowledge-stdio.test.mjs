import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const spaceId = '00000000-0000-4000-8000-000000000003';
const pageId = '00000000-0000-4000-8000-000000000004';

async function fixture(t, { readOnly = false, provider = 'openviking' } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'docmost-page-stdio-')));
  const calls = [];
  let content = '# Complete original\n\n第一行\n', rejectUpdate = false, rejectCapture = false, deferUpdates = false;
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    calls.push({ path: req.url, body });
    if ((req.url === '/api/pages/update' && rejectUpdate)
      || (req.url === '/api/pages/info' && body.format === 'markdown' && rejectCapture)) {
      rejectCapture = false;
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); return;
    }
    let data;
    if (req.url === '/api/users/me') data = { user: { id: userId }, workspace: { id: workspaceId } };
    else if (req.url === '/api/spaces/info') data = { id: spaceId, workspaceId, name: 'Test space' };
    else if (['/api/pages/info', '/api/pages/update'].includes(req.url)) {
      if (req.url.endsWith('/update') && body.content && !deferUpdates) content = body.operation === 'append' ? content + '\n' + body.content : body.content;
      data = { id: pageId, workspaceId, spaceId, title: '完整原文', parentPageId: null, deletedAt: null, content, permissions: { canEdit: true } };
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: `Cannot POST ${req.url}` })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const connections = [];
  async function connect() {
  const child = spawn(process.execPath, [entry], { env: { ...process.env,
    DOCMOST_URL: `http://127.0.0.1:${http.address().port}`, DOCMOST_ALLOW_LOCAL_HTTP: '1',
    DOCMOST_AUTH_MODE: 'api_key', DOCMOST_API_TOKEN: 'synthetic-page-token', DOCMOST_API_TOKEN_FILE: undefined,
    DOCMOST_SESSION_FILE: undefined, DOCMOST_DEFAULT_SPACE_ID: spaceId,
    DOCMOST_SYNC_ROOT: undefined, DOCMOST_SYNC_STATE_DIR: undefined,
    DOCMOST_KNOWLEDGE_STATE_DIR: join(temp, 'ledger'), DOCMOST_KNOWLEDGE_PROVIDER: provider,
    DOCMOST_OPENVIKING_URL: 'https://knowledge.example.invalid', DOCMOST_OPENVIKING_API_KEY_FILE: join(temp, 'unused-key'),
    DOCMOST_READ_ONLY: readOnly ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', sequence = 0, stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr += value; });
  child.stdout.on('data', value => {
    buffer += value;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id);
    }
  });
  const stopped = new Promise(resolve => child.once('close', resolve));
  connections.push({ child, stopped });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr.slice(0,300)}`)), 6000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'page-knowledge-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const value = JSON.parse(response.result.content[0].text);
    assert.notEqual(response.result.isError, true, JSON.stringify(value)); return value;
  };
  return { request, call };
  }
  t.after(async () => {
    for (const { child } of connections) child.stdin.end();
    await Promise.all(connections.map(({ stopped }) => stopped));
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
    await rm(temp, { force: true, recursive: true });
  });
  return { ...await connect(), connect, stateDir: join(temp, 'ledger'), calls,
    rejectUpdates() { rejectUpdate = true; }, rejectCapture() { rejectCapture = true; }, deferUpdates() { deferUpdates = true; } };
}

test('page-only MCP exposes enrollment and status without a Markdown root or conditional endpoints', async t => {
  const f = await fixture(t), tools = (await f.request('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(tools.includes('sync_page_to_knowledge'));
  assert.ok(tools.includes('get_page_knowledge_status'));
  assert.ok(tools.includes('retry_knowledge_sync'));
  assert.ok(!tools.includes('bind_markdown'));
  const enrolled = await f.call('sync_page_to_knowledge', { pageId });
  assert.equal(enrolled.pageId, pageId); assert.equal(enrolled.source, 'docmost');
  const status = await f.call('get_page_knowledge_status', { pageId });
  assert.equal(status.pageId, pageId);
  assert.equal((await f.call('get_page_knowledge_status')).bindings.length, 1);
  assert.ok(!f.calls.some(call => /sync-state|sync-update/.test(call.path)));
  const result = await f.call('update_page', { pageId, content: '第二行', operation: 'append' });
  assert.ok(result.knowledgeBase, 'successful body updates must report their separate knowledge stage');
  assert.ok(f.calls.slice(f.calls.findIndex(call => call.path === '/api/pages/update') + 1).some(call => call.path === '/api/pages/info' && call.body.format === 'markdown'));
});

test('read-only page knowledge exposes status but no enrollment or retry', async t => {
  const f = await fixture(t, { readOnly: true }), names = (await f.request('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(names.includes('get_page_knowledge_status'));
  assert.ok(!names.includes('sync_page_to_knowledge')); assert.ok(!names.includes('retry_knowledge_sync'));
  assert.equal((await f.call('get_page_knowledge_status')).readOnly, true);
  assert.ok(!f.calls.some(call => call.path === '/api/pages/info'));
});

test('none does not expose page export tools even when a private state directory is configured', async t => {
  const f = await fixture(t, { provider: 'none' }), names = (await f.request('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(!names.includes('sync_page_to_knowledge')); assert.ok(!names.includes('get_page_knowledge_status'));
});

test('an enrolled page held by another startup process reports LEASE_BUSY without taking its lease or writing Docmost', async t => {
  const f = await fixture(t);
  await f.call('sync_page_to_knowledge', { pageId });
  const leases = join(f.stateDir, 'leases');
  const owned = new Map(await Promise.all((await readdir(leases)).map(async name => [name, await readFile(join(leases, name), 'utf8')])));
  assert.ok(owned.size > 0, 'the original process must own a live page lease');
  const peer = await f.connect();
  const response = await peer.request('tools/call', { name: 'sync_page_to_knowledge', arguments: { pageId } });
  const reply = response.result;
  assert.equal(reply.isError, true);
  const remaining = new Map(await Promise.all((await readdir(leases)).map(async name => [name, await readFile(join(leases, name), 'utf8')])));
  assert.deepEqual(remaining, owned, 'the second process must not replace the original lease nonce or owner');
  assert.ok(f.calls.every(call => ['/api/users/me', '/api/pages/info', '/api/spaces/info'].includes(call.path)),
    'enrollment and its lease rejection must never write Docmost');
  assert.equal(JSON.parse(reply.content[0].text).error.code, 'LEASE_BUSY');
});

test('a failed knowledge preflight stays separate from a successful Docmost edit and cannot publish stale content', async t => {
  const f = await fixture(t);
  await f.call('sync_page_to_knowledge', { pageId });
  f.rejectCapture();
  const result = await f.call('update_page', { pageId, content: '保存的正文', operation: 'replace' });
  assert.equal(result.content, '保存的正文');
  assert.equal(result.knowledgeBase.state, 'blocked');
  const updateIndex = f.calls.findIndex(call => call.path === '/api/pages/update');
  assert.ok(updateIndex >= 0);
  assert.ok(!f.calls.slice(updateIndex + 1).some(call => call.path === '/api/pages/info'));
});

test('a second body update is not dispatched while the first saved version is unconfirmed', async t => {
  const f = await fixture(t);
  await f.call('sync_page_to_knowledge', { pageId });
  f.deferUpdates();
  await f.call('update_page', { pageId, content: '尚未保存的第一版', operation: 'replace' });
  const reply = (await f.request('tools/call', { name: 'update_page', arguments: { pageId, content: '第二版', operation: 'replace' } })).result;
  assert.equal(reply.isError, true);
  assert.equal(JSON.parse(reply.content[0].text).error.code, 'SAVE_PENDING');
  assert.equal(f.calls.filter(call => call.path === '/api/pages/update').length, 1);
});

test('replacing with the identical saved Markdown does not leave an endless save intent', async t => {
  const f = await fixture(t), content = '# Complete original\n\n第一行\n';
  await f.call('sync_page_to_knowledge', { pageId });
  await f.call('update_page', { pageId, title: '同正文改名', content, operation: 'replace' });
  const state = await f.call('get_page_knowledge_status', { pageId });
  assert.notEqual(state.knowledgeBase.state, 'waiting_docmost');
  const reply = await f.call('update_page', { pageId, content: '接着修改', operation: 'replace' });
  assert.equal(reply.content, '接着修改');
});
