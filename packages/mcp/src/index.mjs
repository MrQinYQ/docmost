#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.mjs';
import { ApiError } from './api.mjs';
import { checkConnection, createDocmostServer, listAccessibleSpaces } from './server.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Docmost local MCP (stdio)\nRequired: DOCMOST_URL, DOCMOST_API_TOKEN or DOCMOST_API_TOKEN_FILE, DOCMOST_DEFAULT_SPACE_ID\nOptional: DOCMOST_DEFAULT_PARENT_PAGE_ID, DOCMOST_READ_ONLY=1, DOCMOST_TIMEOUT_MS, DOCMOST_ALLOW_LOCAL_HTTP=1 (loopback only)\n--list-spaces [--cursor value] discovers accessible space UUIDs before configuring a default.\n--check validates the Token identity, default space and optional parent; without flags starts stdio.\n');
  } else {
    const discovery = args[0] === '--list-spaces';
    const cursor = discovery && args.length === 3 && args[1] === '--cursor' ? args[2] : undefined;
    const validArgs = args.length === 0 || (args.length === 1 && ['--check', '--list-spaces'].includes(args[0]))
      || (discovery && args.length === 3 && args[1] === '--cursor' && cursor.length > 0 && cursor.length <= 4096);
    if (!validArgs)
      throw new ConfigError('Supported arguments: --help, --check, or --list-spaces [--cursor value]. Configure credentials privately; select a default space before starting stdio.');
    const config = await loadConfig(process.env, { requireDefaultSpace: !discovery });
    if (args[0] === '--check') {
      const info = await checkConnection(config);
      process.stdout.write(`${JSON.stringify({ success: true, ...info, readOnly: config.readOnly })}\n`);
    } else if (discovery) {
      process.stdout.write(`${JSON.stringify(await listAccessibleSpaces(config, cursor))}\n`);
    } else {
      const handle = serveStdio(() => createDocmostServer(config), {
        onerror: () => process.stderr.write('Docmost MCP protocol error. Check client compatibility.\n'),
      });
      const shutdown = () => { void handle.close(); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }
  }
} catch (error) {
  const message = error instanceof ConfigError || error instanceof ApiError ? `${error.code}: ${error.message}` : 'STARTUP_FAILED: Docmost MCP could not start.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
