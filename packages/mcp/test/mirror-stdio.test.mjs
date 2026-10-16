import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const userId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
async function connection(t, override) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'docmost-optional-ov-')));
  const root = join(temp, 'source'); await mkdir(root, { mode: 0o700 });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request without logging headers */ }
    const data = { user: { id: userId, name: 'Synthetic' }, workspace: { id: workspaceId, name: 'Synthetic workspace' } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, PATH: '/usr/bin:/bin', DOCMOST_URL: `http://127.0.0.1:${server.address().port}`,
    DOCMOST_ALLOW_LOCAL_HTTP: '1', DOCMOST_AUTH_MODE: 'api_key', DOCMOST_API_TOKEN: 'synthetic-token',
    DOCMOST_API_TOKEN_FILE: undefined, DOCMOST_SESSION_FILE: undefined, DOCMOST_DEFAULT_SPACE_ID: spaceId,
    DOCMOST_DEFAULT_PARENT_PAGE_ID: undefined, DOCMOST_SYNC_ROOT: root, DOCMOST_SYNC_STATE_DIR: join(temp, 'state'),
    DOCMOST_KNOWLEDGE_PROVIDER: undefined, DOCMOST_OPENVIKING_URL: undefined, DOCMOST_OPENVIKING_API_KEY_FILE: undefined, DOCMOST_OPENVIKING_ROOT_URI: undefined,
    DOCMOST_OPENVIKING_ACCOUNT: undefined, DOCMOST_OPENVIKING_USER: undefined, DOCMOST_READ_ONLY: '0', ...override };
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', stderr = '', sequence = 0;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.on('data', text => {
    buffer += text;
    while (buffer.includes('\n')) {
      const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
      const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id);
    }
  });
  const stopped = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => { child.stdin.end(); await stopped; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(`MCP timeout ${stderr}`)), 4000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'optional-ov-test', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { request };
}
test('optional remote integration exposes retry without ov binary and Docmost read still works', async t => {
  const rpc = await connection(t, { DOCMOST_OPENVIKING_URL: 'https://remote.example.invalid', DOCMOST_OPENVIKING_API_KEY_FILE: '/private/tmp/unused-private-key' });
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.equal(tools.length, 30); assert.ok(tools.some(x => x.name === 'retry_openviking_sync'));
  assert.ok(tools.some(x => x.name === 'sync_page_to_knowledge'));
  assert.ok(tools.some(x => x.name === 'get_page_knowledge_status'));
  assert.ok(tools.some(x => x.name === 'retry_knowledge_sync'));
  const current = (await rpc.request('tools/call', { name: 'get_current_user', arguments: {} })).result;
  assert.notEqual(current.isError, true); assert.equal(JSON.parse(current.content[0].text).user.id, userId);
});
test('absent URL ignores other OV settings without requiring local installation', async t => {
  const rpc = await connection(t, { DOCMOST_OPENVIKING_API_KEY_FILE: '/does/not/exist' });
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.equal(tools.length, 26); assert.ok(!tools.some(x => x.name === 'retry_openviking_sync'));
  assert.ok(!tools.some(x => x.name === 'retry_knowledge_sync'));
});
test('invalid optional configuration and readonly mode preserve Docmost discovery', async t => {
  const rpc = await connection(t, { DOCMOST_OPENVIKING_URL: 'invalid', DOCMOST_READ_ONLY: '1' });
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.equal(tools.length, 12); assert.ok(!tools.some(x => x.name === 'retry_openviking_sync'));
  assert.ok(tools.some(x => x.name === 'get_page_knowledge_status'));
  assert.ok(!tools.some(x => x.name === 'sync_page_to_knowledge'));
  assert.ok(!tools.some(x => x.name === 'retry_knowledge_sync'));
});

test('explicit none overrides stale provider settings and reports disabled through stdio', async t => {
  const rpc = await connection(t, { DOCMOST_KNOWLEDGE_PROVIDER: 'none', DOCMOST_OPENVIKING_URL: 'invalid', DOCMOST_OPENVIKING_API_KEY_FILE: '/does/not/exist' });
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.equal(tools.length, 26); assert.ok(!tools.some(x => x.name.startsWith('retry_')));
  const result = (await rpc.request('tools/call', { name: 'get_markdown_sync_status', arguments: {} })).result;
  assert.equal(JSON.parse(result.content[0].text).knowledgeBase.state, 'disabled');
});

test('unsupported provider stays separate from Docmost and does not register an OpenViking alias', async t => {
  const rpc = await connection(t, { DOCMOST_KNOWLEDGE_PROVIDER: 'not-supported', DOCMOST_OPENVIKING_URL: 'https://remote.example.invalid', DOCMOST_OPENVIKING_API_KEY_FILE: '/does/not/exist' });
  const tools = (await rpc.request('tools/list')).result.tools;
  assert.equal(tools.length, 29); assert.ok(tools.some(x => x.name === 'retry_knowledge_sync'));
  assert.ok(!tools.some(x => x.name === 'retry_openviking_sync'));
  const current = (await rpc.request('tools/call', { name: 'get_current_user', arguments: {} })).result;
  assert.notEqual(current.isError, true);
  const status = (await rpc.request('tools/call', { name: 'get_markdown_sync_status', arguments: {} })).result;
  assert.equal(JSON.parse(status.content[0].text).knowledgeBase.error.code, 'KB_UNSUPPORTED_PROVIDER');
});
