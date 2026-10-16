import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class McpTestError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** Test/acceptance transport. No credentials, upstream stderr or page text are logged. */
export async function connectMcp(entry, env, { timeoutMs = 30000 } = {}) {
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let serial = 0, buffer = '', closed = false;
  function rejectPending(code) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new McpTestError(code)); }
    pending.clear();
  }
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; rejectPending('RPC_CLOSED'); resolve({ code, signal });
  }));
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.once('error', () => rejectPending('RPC_PROCESS_ERROR'));
  child.stdin.on('error', () => rejectPending('RPC_STDIN_CLOSED'));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8_000_000) { buffer = ''; rejectPending('RPC_OUTPUT_TOO_LARGE'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { rejectPending('RPC_INVALID_JSON'); continue; }
      const item = pending.get(message.id); if (!item) continue;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new McpTestError('RPC_PROTOCOL_ERROR')); else item.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new McpTestError('RPC_CLOSED'));
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new McpTestError('RPC_TIMEOUT')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const client = {
    child, exited, call,
    async tool(name, args = {}) {
      const result = await call('tools/call', { name, arguments: args });
      let data; try { data = JSON.parse(result.content[0].text); } catch { throw new McpTestError('RPC_INVALID_TOOL_RESULT'); }
      if (result.isError) throw new McpTestError(/^[A-Z][A-Z_0-9]{0,79}$/.test(data.error?.code ?? '') ? data.error.code : 'RPC_TOOL_ERROR', data.error?.status);
      return data;
    },
    async close() {
      if (closed) return exited;
      child.stdin.end();
      if (await Promise.race([exited.then(() => true), delay(4000, false, { ref: false })])) return exited;
      child.kill('SIGTERM');
      if (await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })])) return exited;
      child.kill('SIGKILL'); return exited;
    },
  };
  try {
    await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'git-delivery-acceptance', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return client;
  } catch (error) { await client.close(); throw error; }
}
