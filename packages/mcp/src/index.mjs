#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig, loadConnectionConfig } from './config.mjs';
import { ApiError, createApiClient } from './api.mjs';
import { AuthError } from './errors.mjs';
import { promptCredentials } from './prompt.mjs';
import { loadSession, loginSession, saveSession, removeSession, logoutSession } from './session.mjs';
import { checkConnection, createDocmostServer, listAccessibleSpaces } from './server.mjs';
import { createMarkdownSync } from './sync.mjs';
import { loadKnowledgeConfig } from './knowledge-config.mjs';
import { checkKnowledgeConnection, knowledgeSelection } from './knowledge.mjs';

async function login(config) {
  try {
    const previous = await loadSession(config.sessionFile, config.origin, { allowExpired: true });
    if (previous.expiresAt > Date.now())
      throw new AuthError('SESSION_EXISTS', 'A live session is already saved. Run --logout before logging in again.');
  } catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
  process.stderr.write(`Log in to ${config.origin} in this local terminal. Your password will not be stored.\n`);
  const credentials = await promptCredentials();
  let session;
  try { session = await loginSession(config, credentials); }
  finally { credentials.password = ''; }
  try { await saveSession(config.sessionFile, session); }
  catch {
    let revoked = false;
    try { await logoutSession(config, session); revoked = true; } catch { /* report uncertainty */ }
    throw new AuthError('SESSION_SAVE_FAILED', revoked
      ? 'Cannot save the private session file. The newly-created server session was revoked; check storage before retrying.'
      : 'Cannot save the private session file, and server revocation could not be confirmed. Check account Sessions before retrying.');
  }
  process.stdout.write(`${JSON.stringify({ success: true, userId: session.userId, workspaceId: session.workspaceId, sessionId: session.sessionId, expiresAt: session.expiresAt, sessionFile: config.sessionFile })}\n`);
}

async function logout(config) {
  const session = await loadSession(config.sessionFile, config.origin, { allowExpired: true });
  let serverRevoked = false;
  const expired = session.expiresAt <= Date.now();
  if (!expired) {
    try { await logoutSession(config, session); serverRevoked = true; } catch { /* no automatic retry */ }
  }
  await removeSession(config.sessionFile, config.origin, { expectedSessionId: session.sessionId });
  process.stdout.write(`${JSON.stringify({ localRemoved: true, serverRevoked, expired })}\n`);
  if (!expired && !serverRevoked) {
    process.stderr.write('LOGOUT_UNCONFIRMED: The local credential was removed, but server revocation could not be confirmed. Check account Sessions.\n');
    process.exitCode = 1;
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Page knowledge sync: DOCMOST_KNOWLEDGE_STATE_DIR (private absolute directory; defaults to DOCMOST_SYNC_STATE_DIR).\nsync_page_to_knowledge enrolls a saved Docmost page; get_page_knowledge_status reports its full-original URI and processing state. No local MD root or conditional endpoint is required for page enrollment.\n');
    process.stdout.write('Docmost local MCP (stdio)\nRequired: DOCMOST_URL, DOCMOST_DEFAULT_SPACE_ID and an explicit credential source.\nCommunity: DOCMOST_AUTH_MODE=session and DOCMOST_SESSION_FILE (private absolute path).\nAPI Key: DOCMOST_AUTH_MODE=api_key (compatibility default) and DOCMOST_API_TOKEN or DOCMOST_API_TOKEN_FILE.\nOptional: DOCMOST_DEFAULT_PARENT_PAGE_ID, DOCMOST_READ_ONLY=1, DOCMOST_TIMEOUT_MS, DOCMOST_ALLOW_LOCAL_HTTP=1 (loopback only)\nOptional Markdown sync: DOCMOST_SYNC_ROOT and DOCMOST_SYNC_STATE_DIR (separate absolute directories). Only explicitly bound .md files sync while stdio is running. Requires compatible conditional sync endpoints; no uploads in read-only mode.\n--login performs personal email/password login in your own local terminal; no password is stored.\n--logout revokes only the dedicated personal session and removes its local file.\n--list-spaces [--cursor value] discovers accessible space UUIDs before configuring a default.\nLogin/logout/space discovery do not require a default space.\nOpenViking scope: DOCMOST_OPENVIKING_SCOPE=personal (default) or shared; DOCMOST_OPENVIKING_ROOT_URI overrides the matching concrete resource root. Shared roots inherit OpenViking ACL, not Docmost ACL.\nOptional knowledge base: DOCMOST_KNOWLEDGE_PROVIDER=none|openviking; omitted provider preserves a configured legacy OpenViking URL.\n--check-knowledge validates only the selected knowledge-base connection and selected resource namespace; no Docmost login or default space is needed.\n--check validates identity, default space and optional parent; without flags starts stdio.\n');
  } else if (args.length === 1 && args[0] === '--check-knowledge') {
    const report = await checkKnowledgeConnection(loadKnowledgeConfig(process.env));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.success) process.exitCode = 1;
  } else {
    const discovery = args[0] === '--list-spaces';
    const cursor = discovery && args.length === 3 && args[1] === '--cursor' ? args[2] : undefined;
    const authentication = args[0] === '--login' || args[0] === '--logout';
    const validArgs = args.length === 0 || (args.length === 1 && ['--check', '--list-spaces', '--login', '--logout'].includes(args[0]))
      || (discovery && args.length === 3 && args[1] === '--cursor' && cursor.length > 0 && cursor.length <= 4096);
    if (!validArgs)
      throw new ConfigError('Supported arguments: --help, --login, --logout, --check, --check-knowledge, or --list-spaces [--cursor value]. Password arguments are not supported.');
    const config = authentication
      ? loadConnectionConfig(process.env, { requireDefaultSpace: false })
      : await loadConfig(process.env, { requireDefaultSpace: !discovery });
    if (authentication) {
      if (config.authMode !== 'session') throw new ConfigError('--login and --logout require DOCMOST_AUTH_MODE=session and DOCMOST_SESSION_FILE.');
      if (args[0] === '--login') await login(config);
      else await logout(config);
    } else if (args[0] === '--check') {
      const info = await checkConnection(config);
      process.stdout.write(`${JSON.stringify({ success: true, ...info, readOnly: config.readOnly })}\n`);
    } else if (discovery) {
      process.stdout.write(`${JSON.stringify(await listAccessibleSpaces(config, cursor))}\n`);
    } else {
      const syncManager = config.syncRoot || (config.syncStateDir && knowledgeSelection(config))
        ? createMarkdownSync(config, { api: createApiClient(config) }) : undefined;
      const transport = new StdioServerTransport();
      const handle = serveStdio(() => createDocmostServer(config, { syncManager }), {
        transport,
        onerror: () => process.stderr.write('Docmost MCP protocol error. Check client compatibility.\n'),
      });
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        const stopped = syncManager?.close();
        void Promise.all([stopped, handle.close()]).catch(() => {
          process.stderr.write('SYNC_SHUTDOWN_FAILED: Check sync status before restarting; an in-flight upload may have completed.\n');
          process.exitCode = 1;
        });
      };
      const onclose = transport.onclose;
      transport.onclose = () => { onclose?.(); shutdown(); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      void syncManager?.start().catch(() => process.stderr.write('SYNC_STARTUP_FAILED: Inspect the configured Markdown or page knowledge sync status.\n'));
    }
  }
} catch (error) {
  const message = error instanceof ConfigError || error instanceof ApiError || error instanceof AuthError ? `${error.code}: ${error.message}` : 'STARTUP_FAILED: Docmost MCP could not start.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
