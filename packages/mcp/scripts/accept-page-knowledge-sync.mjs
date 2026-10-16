#!/usr/bin/env node
/**
 * Approval-scoped acceptance through the newly-built MCP stdio server.
 * Default: read-only discovery and original-page baselines. --run is required
 * for publishing the three originals and mutating uniquely tracked test copies.
 * Credentials stay inside the selected environment/MCP/OV client in memory.
 * No session-file reads, cookies, direct Docmost HTTP, or ov CLI are used here.
 * Real deployment/page metadata is supplied by a private --targets JSON file.
 * --resume <private report> verifies an existing moved copy without replaying
 * create/edit/move. It is read-only unless --run is also supplied. The source
 * report is preserved; outputs default to -resumed[-read-only].json.
 * This bounded fixture expects exactly three pages under two parent levels;
 * it does not claim to validate arbitrary document-tree depths.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, rename, chmod, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConnectionConfig } from '../src/config.mjs';
import { createOpenVikingClient } from '../src/openviking-client.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(packageRoot, '../..');
const entry = resolve(packageRoot, 'dist/index.mjs');
const reportDir = resolve(root, 'data/local-docmost');
const syntheticTargets = {
  version: 1, origin: 'https://docs.example.invalid',
  spaceId: '00000000-0000-4000-8000-000000000001', spaceName: 'Example space',
  businessId: '00000000-0000-4000-8000-000000000002', businessTitle: 'Example parent',
  adId: '00000000-0000-4000-8000-000000000003', adTitle: 'Example section',
  originals: [
    { id: '00000000-0000-4000-8000-000000000004', title: 'Example document one' },
    { id: '00000000-0000-4000-8000-000000000005', title: 'Example document two' },
    { id: '00000000-0000-4000-8000-000000000006', title: 'Example document three' },
  ],
};
let { origin: sourceOrigin, spaceId, adId, businessId, originals, spaceName, businessTitle, adTitle } = syntheticTargets;
const protectedIds = new Set([...originals.map(page => page.id), adId, businessId]);
const readTools = new Set(['get_current_user', 'get_page', 'get_space', 'list_child_pages', 'search_pages', 'get_page_knowledge_status']);
const writeTools = new Set(['sync_page_to_knowledge', 'create_page', 'update_page', 'move_page', 'delete_page', 'retry_knowledge_sync']);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const directory = uri => uri.slice(0, uri.lastIndexOf('/'));
const safeCode = error => /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || '') ? error.code : 'ACCEPTANCE_FAILED';

class AcceptanceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function need(condition, code, message) {
  if (!condition) throw new AcceptanceError(code, message);
}

function configureTargets(value) {
  need(value && typeof value === 'object' && value.version === 1, 'INVALID_TARGETS', 'Use a version 1 private targets JSON object.');
  let origin;
  try { origin = new URL(value.origin); } catch { throw new AcceptanceError('INVALID_TARGETS', 'The targets deployment origin is invalid.'); }
  need(['https:', 'http:'].includes(origin.protocol) && origin.href === `${origin.origin}/` && !origin.username && !origin.password,
    'INVALID_TARGETS', 'The targets origin must be a deployment root without credentials, path, query or fragment.');
  need(['spaceId', 'businessId', 'adId'].every(field => uuid(value[field])) && Array.isArray(value.originals) && value.originals.length === 3,
    'INVALID_TARGETS', 'Targets require a space UUID, exactly two parent UUIDs and three original pages.');
  need(['spaceName', 'businessTitle', 'adTitle'].every(field => typeof value[field] === 'string' && value[field].trim())
    && value.originals.every(page => uuid(page?.id) && typeof page.title === 'string' && page.title.trim()),
  'INVALID_TARGETS', 'Targets require explicit space, ancestor and document names.');
  const allIds = [value.spaceId, value.businessId, value.adId, ...value.originals.map(page => page.id)];
  need(new Set(allIds).size === allIds.length, 'INVALID_TARGETS', 'Target identities must be distinct.');
  sourceOrigin = origin.origin;
  ({ spaceId, businessId, adId, spaceName, businessTitle, adTitle } = value);
  originals = value.originals.map(page => ({ id: page.id, title: page.title }));
  protectedIds.clear();
  for (const id of [businessId, adId, ...originals.map(page => page.id)]) protectedIds.add(id);
}

async function loadPrivateTargets(path) {
  need(typeof path === 'string' && path.length > 0, 'TARGETS_REQUIRED', 'Pass --targets pointing to a private JSON file; real targets are not bundled in this script.');
  const file = resolve(path);
  const info = await lstat(file);
  need(info.isFile() && !info.isSymbolicLink() && info.size <= 65536
    && (process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid())),
  'INVALID_TARGETS_FILE', 'Targets must be an owner-owned private regular file (mode 0600), at most 64 KiB.');
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch { throw new AcceptanceError('INVALID_TARGETS', 'Cannot parse the private targets JSON file.'); }
  configureTargets(data); return file;
}

function validateResumeReport(prior) {
  need(prior?.version === 1 && prior.mode === 'explicit-run' && /^\d{13}-[a-f0-9]{10}$/.test(prior.runId || ''),
    'INVALID_RESUME_REPORT', 'Resume requires an explicit-run report with its original generated run ID.');
  need(prior.sourceOrigin === sourceOrigin && prior.sourceSpaceId === spaceId && uuid(prior.workspaceId) && uuid(prior.userId),
    'RESUME_TARGET_MISMATCH', 'Resume report does not match the approved targets and canonical identity.');
  need(Array.isArray(prior.originals) && prior.originals.length === originals.length && Array.isArray(prior.events)
    && Array.isArray(prior.creationAttempts), 'INVALID_RESUME_REPORT', 'Resume requires all three protected-original baselines and its recorded creation/status evidence.');
  for (const original of originals) {
    const record = prior.originals.find(page => page.before?.id === original.id);
    need(record?.before.title === original.title && record.before.spaceId === spaceId && record.before.parentPageId === adId
      && /^[a-f0-9]{64}$/.test(record.before.bodySha256 || '') && record.knowledge?.rawSha256 === record.before.bodySha256,
    'RESUME_BASELINE_MISMATCH', 'Resume requires the exact protected-original identities and previously confirmed rawhash evidence.');
  }
  need(Array.isArray(prior.created) && prior.created.length === 2, 'INVALID_RESUME_REPORT', 'This resume supports exactly the existing moved copy and its temporary parent.');
  const copy = prior.created.find(page => page.purpose === 'same-parent-business-document-copy');
  const parent = prior.created.find(page => page.purpose === 'temporary-move-parent');
  const prefix = `MCP知识同步验收-${prior.runId}`;
  need(copy && parent && copy.pageId !== parent.pageId && /^[a-f0-9]{64}$/.test(copy.updatedBodySha256 || ''),
    'INVALID_RESUME_REPORT', 'Resume requires a previously edited copy and a distinct temporary parent.');
  for (const [page, suffix] of [[copy, '副本'], [parent, '临时目录']]) {
    need(uuid(page.pageId) && !protectedIds.has(page.pageId) && page.title === `${prefix}-${suffix}` && page.deleted === false
      && page.savedMetadata?.id === page.pageId && page.savedMetadata.title === page.title && page.savedMetadata.spaceId === spaceId && page.savedMetadata.parentPageId === adId
      && /^[a-f0-9]{64}$/.test(page.savedMetadata.bodySha256 || '')
      && prior.creationAttempts?.some(intent => intent.state === 'confirmed' && intent.pageId === page.pageId && intent.title === page.title),
    'INVALID_RESUME_REPORT', 'A resume resource is not a unique, active UUID confirmed by this run\'s recorded creation.');
  }
  need(typeof prior.sharedKnowledgeAncestry?.adDirectory === 'string' && Array.isArray(copy.uris) && copy.uris.length > 0,
    'INVALID_RESUME_REPORT', 'Resume requires the previously verified knowledge parent and old copy URIs.');
  return { copy, parent };
}

function resumeMarker(body, expectedHash) {
  need(typeof body === 'string' && digest(body) === expectedHash, 'RESUME_COPY_CHANGED', 'The existing copy body differs from the recorded completed edit.');
  const markers = body.match(/(?<![A-Za-z0-9_])mcpknowledgetest[a-f0-9]{20}(?![A-Za-z0-9_])/g) || [];
  need(markers.length === 1, 'RESUME_MARKER_MISMATCH', 'The saved copy must contain exactly one complete generated acceptance marker.');
  return markers[0];
}

function assertResumeWrite(validationComplete, name, args = {}, created = []) {
  const enrollTemporaryParent = name === 'sync_page_to_knowledge' && uuid(args.pageId)
    && created.some(page => page.pageId === args.pageId && page.purpose === 'temporary-move-parent');
  need(validationComplete && (['retry_knowledge_sync', 'delete_page'].includes(name) || enrollTemporaryParent),
    'RESUME_NO_REPLAY', 'Resume requires complete read-only verification and cannot replay create/update/move or republish the copy/originals. Only its tracked temporary parent may be enrolled for directory cleanup.');
}

function resumeCleanupEligible(enabled, validationComplete, failed, moveVerified) {
  return Boolean(enabled && validationComplete && !failed && moveVerified);
}

async function loadResumeReport(path) {
  const sourcePath = resolve(path);
  need(sourcePath.startsWith(`${reportDir}/`) && sourcePath.endsWith('.json'), 'INVALID_RESUME_REPORT', 'Resume requires an ignored local private JSON report.');
  const info = await lstat(sourcePath);
  need(info.isFile() && !info.isSymbolicLink() && info.size < 4 * 1024 * 1024
    && (process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid())),
  'INVALID_RESUME_REPORT', 'Resume report must be an owner-owned private regular file.');
  const text = await readFile(sourcePath, 'utf8');
  let prior; try { prior = JSON.parse(text); } catch { throw new AcceptanceError('INVALID_RESUME_REPORT', 'Resume report is not valid JSON.'); }
  validateResumeReport(prior); return { sourcePath, sourceSha256: digest(text), prior };
}

function assertKnowledgeRead(method, endpoint) {
  const allowedGet = /^(?:health|content\/(?:read|abstract|overview)|fs\/ls|tasks(?:\/[A-Za-z0-9._:-]+)?)$/;
  need((method === 'GET' && allowedGet.test(endpoint)) || (method === 'POST' && endpoint === 'search/find'),
    'READ_ONLY_PROBE', 'Knowledge HTTP probes only permit health, raw reads, directory/task reads and find.');
}

function assertMutation(name, args, enabled, createdIds) {
  need(enabled, 'EXPLICIT_RUN_REQUIRED', 'Use --run for authorized acceptance writes.');
  if (name === 'sync_page_to_knowledge') {
    need(originals.some(page => page.id === args.pageId) || createdIds.has(args.pageId),
      'EXPORT_NOT_AUTHORIZED', 'Only the three approved original UUIDs and this run\'s test copies may be published.');
    return;
  }
  if (name === 'retry_knowledge_sync') return;
  need(['create_page', 'update_page', 'move_page', 'delete_page'].includes(name), 'MUTATION_NOT_ALLOWED', 'Unsupported acceptance mutation.');
  if (name === 'create_page') {
    need(args.spaceId === spaceId && args.parentPageId === adId, 'TEST_LOCATION_CHANGED', 'Test copies must be created beside the originals under the approved parent.');
    return;
  }
  need(uuid(args.pageId) && createdIds.has(args.pageId) && !protectedIds.has(args.pageId),
    'PROTECTED_ORIGINAL', 'Only UUIDs returned by this run\'s test-page creations may be changed or deleted.');
  if (name === 'move_page') need(createdIds.has(args.parentPageId), 'TEST_LOCATION_CHANGED', 'A test copy can only move into this run\'s temporary parent.');
}

function normalizePages(status) {
  const items = status?.pages ?? status?.bindings ?? (status?.page ? [status.page] : status?.pageId ? [status] : []);
  return Array.isArray(items) ? items.filter(item => item?.source === 'docmost' || item?.source === undefined) : [];
}
function enrolledPage(status, pageId) {
  const page = normalizePages(status).find(item => item.pageId === pageId);
  return page?.state === 'not_enrolled' ? undefined : page;
}
const knowledge = page => page?.knowledgeBase ?? page?.openViking ?? {};
function shouldRequestSync(page) {
  const kb = knowledge(page);
  // A fresh explicit import is also the one-shot migration/ancestor repair for
  // a previously synced ledger. Never interrupt a dispatched/unknown task.
  return !page || (!kb.phase && !kb.taskId && !['pending', 'processing', 'blocked', 'failed'].includes(kb.state));
}

function deletedHitUris(hits, ownedUris) {
  const roots = [...new Set(ownedUris.map(directory))];
  return hits.filter(hit => roots.some(uri => hit === uri || hit.startsWith(`${uri}/`)));
}

function staleSummary(text, resource) {
  return typeof text === 'string' && (text.includes(resource.pageId) || text.includes(resource.title));
}
function safeStatus(page) {
  if (!page) return null;
  const kb = knowledge(page);
  const safe = {};
  for (const name of ['bindingId', 'source', 'pageId', 'spaceId', 'workspaceId', 'localHash', 'remoteRevision', 'state']) {
    if (typeof page[name] === 'string') safe[name] = page[name].slice(0, 8192);
  }
  const bindingError = typeof page.errorCode === 'string' ? { code: page.errorCode } : page.error;
  if (bindingError?.code) safe.errorCode = safeCode(bindingError);
  safe.knowledgeBase = {};
  for (const name of ['provider', 'state', 'uri', 'confirmedRevision', 'phase', 'operation', 'taskId']) {
    if (typeof kb[name] === 'string') safe.knowledgeBase[name] = kb[name].slice(0, 8192);
  }
  if (kb.error?.code) safe.knowledgeBase.errorCode = safeCode(kb.error);
  return safe;
}

function assertNoBusyOriginalLease(status) {
  for (const original of originals) {
    const page = enrolledPage(status, original.id);
    need(page?.error?.code !== 'LEASE_BUSY' && page?.errorCode !== 'LEASE_BUSY',
      'LEASE_BUSY', 'A selected original is owned by another live MCP lease. No test copy was created; coordinate the owning process before retrying.');
  }
}

function metadata(page) {
  need(uuid(page?.id) && uuid(page.spaceId) && (page.parentPageId === null || uuid(page.parentPageId)), 'INVALID_PAGE_METADATA', 'Docmost page metadata is not canonical.');
  need(typeof page.content === 'string', 'INVALID_PAGE_BODY', 'Expected the complete Markdown page body.');
  return { id: page.id, title: page.title, slugId: page.slugId, spaceId: page.spaceId,
    parentPageId: page.parentPageId, position: page.position, updatedAt: page.updatedAt, deletedAt: page.deletedAt ?? null,
    format: 'markdown', bodyLengthUtf16: page.content.length, bodyBytesUtf8: Buffer.byteLength(page.content, 'utf8'), bodySha256: digest(page.content) };
}

function createdBodyComparison(suppliedBody, savedPage) {
  need(typeof suppliedBody === 'string' && typeof savedPage?.content === 'string' && savedPage.content.trim(),
    'INVALID_CREATED_BODY', 'A test page must be read back as complete nonblank canonical Markdown.');
  const canonicalBody = savedPage.content;
  return { canonicalBody,
    supplied: { bytes: Buffer.byteLength(suppliedBody, 'utf8'), lengthUtf16: suppliedBody.length, sha256: digest(suppliedBody) },
    savedCanonical: { bytes: Buffer.byteLength(canonicalBody, 'utf8'), lengthUtf16: canonicalBody.length, sha256: digest(canonicalBody) },
    normalizationObserved: digest(suppliedBody) !== digest(canonicalBody),
    note: 'A test copy is verified against its own saved Markdown after the Docmost Markdown/editor round trip. Protected-original rawhash checks remain separate and strict.' };
}

function assertSamePage(before, after) {
  for (const name of ['id', 'title', 'spaceId', 'parentPageId', 'position', 'updatedAt', 'bodySha256', 'bodyBytesUtf8', 'deletedAt']) {
    need(before[name] === after[name], 'ORIGINAL_CHANGED', `A protected original changed its ${name}; no repair or overwrite was attempted.`);
  }
}

function segment(title) {
  const safe = title.normalize('NFC').trim().replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._-]+/gu, '-')
    .replace(/\.{2,}/g, '-').replace(/-+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  let value = ''; for (const c of safe) { if (Buffer.byteLength(value + c) > 120) break; value += c; }
  return value || 'Untitled';
}
function assertHierarchy(uri, page, workspaceId, privateRoot, readableOnly = false) {
  need(typeof uri === 'string' && uri.startsWith(`${privateRoot}/`), 'WRONG_KNOWLEDGE_NAMESPACE', 'Knowledge URI is outside the selected mirror root.');
  const parts = uri.slice(privateRoot.length + 1).split('/').map(decodeURIComponent);
  const readable = [spaceName, businessTitle, adTitle, page.title].map(segment);
  const legacy = parts.length === 7 && /^[a-f0-9]{16}$/.test(parts[0]) && parts[1] === workspaceId
    && [spaceId, businessId, adId, page.id].every((id, index) => parts[index + 2].endsWith(`--${id}`)) && parts[6] === 'document.md';
  need((legacy && !readableOnly) || (parts.length === 5 && readable.every((name, i) => parts[i] === name) && parts[4] === 'document.md'),
    'HIERARCHY_MISMATCH', 'The full space/two-parent/page hierarchy was not preserved.');
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function compatiblePython(candidates, runner = spawnSync) {
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const probe = runner(candidate, ['-I', '-c', 'import tomllib'], { stdio: 'ignore', timeout: 5000 });
    if (probe.status === 0) return candidate;
  }
  throw new AcceptanceError('CONFIG_PYTHON_UNAVAILABLE', 'No existing Python with tomllib was found. No dependency was installed.');
}

function loadServerEnvironment(configPath, serverName) {
  const python = `import json,sys,tomllib\nwith open(sys.argv[1],'rb') as f: cfg=tomllib.load(f)\ns=cfg.get('mcp_servers',{}).get(sys.argv[2])\nif not isinstance(s,dict): raise SystemExit(2)\ne=s.get('env',{})\nif not isinstance(e,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in e.items()): raise SystemExit(3)\nprint(json.dumps(e))\n`;
  const interpreter = compatiblePython([
    process.env.DOCMOST_ACCEPTANCE_PYTHON,
    'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3',
    resolve(homedir(), '.local/share/mise/installs/python/latest/bin/python3'),
    resolve(homedir(), '.local/bin/python3.12'),
    '/opt/homebrew/bin/python3.14', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.14', '/usr/local/bin/python3.13', '/usr/local/bin/python3.12',
  ]);
  const result = spawnSync(interpreter, ['-I', '-c', python, configPath, serverName], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  need(result.status === 0, 'CONFIG_READ_FAILED', 'Cannot load the selected docmost MCP environment with Python tomllib.');
  // Captured only in memory: never print the parsed config, environment, stderr,
  // API token, or any session/key file contents.
  let env;
  try { env = JSON.parse(result.stdout); } catch { throw new AcceptanceError('CONFIG_READ_FAILED', 'The selected MCP environment is invalid.'); }
  need(env && !Array.isArray(env) && typeof env === 'object', 'CONFIG_READ_FAILED', 'The selected MCP environment is invalid.');
  return { ...process.env, ...env };
}

function decodeToolResult(result, name) {
  let value = result?.structuredContent;
  if (!value) {
    const text = result?.content?.find(item => item.type === 'text')?.text;
    try { value = JSON.parse(text); } catch { throw new AcceptanceError('INVALID_TOOL_RESULT', 'MCP returned an unexpected tool result.'); }
  }
  // Binding/status errors are domain state (for example a trashed Docmost page
  // while KB deletion is pending). Only the MCP envelope marks tool failure.
  if (result.isError) {
    const code = safeCode(value?.error || value);
    throw new AcceptanceError(code, `MCP tool ${name} failed (${code}); no blind write retry was made.`);
  }
  return value;
}

function startMcp(env) {
  const child = spawn(process.execPath, [entry], { cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let counter = 0, buffer = '', closed = false, stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  const closeEvent = new Promise(resolveExit => child.once('close', () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new AcceptanceError('MCP_EXITED', 'The MCP process exited.')); }
    pending.clear(); resolveExit();
  }));
  child.on('error', () => {
    for (const item of pending.values()) item.reject(new AcceptanceError('MCP_START_FAILED', 'Cannot start the built MCP process.'));
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { child.kill('SIGTERM'); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { child.kill('SIGTERM'); continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new AcceptanceError('MCP_RPC_FAILED', 'MCP JSON-RPC returned an error.'));
      else item.resolve(message.result);
    }
  });
  function request(method, params = {}, timeoutMs = 120000) {
    return new Promise((resolveResult, reject) => {
      if (closed) { reject(new AcceptanceError('MCP_EXITED', 'The MCP process is closed.')); return; }
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(new AcceptanceError('MCP_REQUEST_TIMEOUT', `MCP ${method} timed out; inspect live state before retrying a write.`)); }, timeoutMs);
      pending.set(id, { resolve: resolveResult, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    async initialize() {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'docmost-page-knowledge-acceptance', version: '1' } }, 15000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const result = await request('tools/list', {}, 15000);
      return result.tools || [];
    },
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      return decodeToolResult(result, name);
    },
    async close() {
      if (!closed) child.stdin.end();
      await Promise.race([closeEvent, sleep(5000)]);
      if (!closed) { child.kill('SIGTERM'); await Promise.race([closeEvent, sleep(5000)]); }
      if (!closed) { child.kill('SIGKILL'); await Promise.race([closeEvent, sleep(3000)]); }
      return { closed, stderrBytes };
    },
  };
}

async function openReadOnlyKnowledge(config) {
  let authenticatedHeaders;
  const guardedFetch = async (input, options = {}) => {
    const url = new URL(input);
    need(url.origin === config.origin, 'WRONG_KNOWLEDGE_ORIGIN', 'Knowledge probes must stay on the selected deployment.');
    const endpoint = url.pathname === '/health' ? 'health' : url.pathname.startsWith('/api/v1/') ? url.pathname.slice('/api/v1/'.length) : '';
    assertKnowledgeRead(options.method || 'GET', endpoint);
    if (options.headers?.['X-API-Key']) authenticatedHeaders = { ...options.headers };
    return fetch(url, { ...options, redirect: 'error', credentials: 'omit', signal: options.signal || AbortSignal.timeout(config.timeoutMs) });
  };
  const client = createOpenVikingClient(config, { fetchImpl: guardedFetch });
  const identity = await client.identity();
  return {
    identity, read: uri => client.read(uri), list: uri => client.list(uri), tasks: uri => client.tasks(uri), task: id => client.task(id),
    async summary(uri, level) {
      need(['abstract', 'overview'].includes(level), 'READ_ONLY_PROBE', 'Only documented L0/L1 endpoints are supported.');
      const url = new URL(`content/${level}`, config.apiBase); url.searchParams.set('uri', uri);
      const response = await guardedFetch(url, { headers: authenticatedHeaders });
      if (response.status === 404) { await response.body?.cancel(); return undefined; }
      need(response.ok, 'OV_SUMMARY_READ_FAILED', `Read-only summary probe returned HTTP ${response.status}.`);
      const envelope = await response.json();
      need(envelope.status === 'ok' && typeof envelope.result === 'string', 'OV_INVALID_RESPONSE', 'Summary endpoint returned an invalid envelope.');
      return envelope.result;
    },
    async find(query, targetUri) {
      need(authenticatedHeaders, 'OV_UNAUTHENTICATED', 'Knowledge identity was not verified.');
      const response = await guardedFetch(new URL('search/find', config.apiBase), {
        method: 'POST', headers: { ...authenticatedHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, target_uri: targetUri, context_type: ['resource'], limit: 30, read_content: false }),
      });
      need(response.ok, 'OV_FIND_FAILED', `Read-only knowledge find returned HTTP ${response.status}.`);
      const body = await response.json();
      need(body.status === 'ok' && body.result && typeof body.result === 'object', 'OV_FIND_FAILED', 'Knowledge find returned an invalid envelope.');
      return body.result;
    },
  };
}

async function diagnoseSummaries(options) {
  const sourcePath = resolve(options.diagnosticReport);
  need(sourcePath.startsWith(`${reportDir}/`) && sourcePath.endsWith('.json'), 'DIAGNOSTIC_REPORT_REQUIRED', 'Use an existing ignored local acceptance JSON report.');
  const report = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (options.targets) await loadPrivateTargets(options.targets);
  else configureTargets({ version: 1, origin: report.sourceOrigin, spaceId: report.sourceSpaceId, spaceName: report.sourceSpaceName || 'Reported space',
    businessId: report.ancestors?.[0]?.id, businessTitle: report.ancestors?.[0]?.title,
    adId: report.ancestors?.[1]?.id, adTitle: report.ancestors?.[1]?.title,
    originals: report.originals?.map(page => ({ id: page.before?.id, title: page.before?.title })) });
  const env = loadServerEnvironment(options.config, options.server);
  const config = loadConnectionConfig(env);
  need(config.openViking && !config.openViking.error, 'KNOWLEDGE_CONFIG_REQUIRED', 'OpenViking is not configured.');
  const ov = await openReadOnlyKnowledge(config.openViking);
  const last = [...(report.events || [])].reverse().find(event => event.status?.knowledgeBase?.uri);
  const uri = report.originals?.find(page => page.knowledge?.uri)?.knowledge.uri ?? last?.status?.knowledgeBase?.uri;
  need(typeof uri === 'string' && uri.startsWith(`${ov.identity.rootUri}/`), 'KNOWLEDGE_URI_REQUIRED', 'The report has no confirmed knowledge URI in the configured namespace.');
  const diagnostic = { capturedAt: new Date().toISOString(), mode: 'read-only-summary-diagnostic', sourceReport: sourcePath, uri, directories: [], taskEvidence: [] };
  const path = resolve(reportDir, `page-knowledge-summary-diagnostic-${Date.now()}.json`);
  const textFacts = text => text === undefined ? { exists: false } : { exists: true, bytes: Buffer.byteLength(text, 'utf8'), nonblank: text.trim().length > 0, sha256: digest(text) };
  for (let folder = directory(uri), level = 0; level < 4; folder = directory(folder), level++) {
    const row = { level: ['page', adTitle, businessTitle, spaceName][level], uri: folder, listing: [], raw: {}, canonical: {}, tasks: [] };
    try { row.listing = (await ov.list(folder) || []).map(item => ({ name: item.name, uri: item.uri, isDir: item.isDir })); }
    catch (error) { row.listError = safeCode(error); }
    for (const name of ['abstract', 'overview']) {
      try { row.raw[name] = textFacts(await ov.read(`${folder}/.${name}.md`)); }
      catch (error) { row.raw[name] = { errorCode: safeCode(error) }; }
      try { row.canonical[name] = textFacts(await ov.summary(folder, name)); }
      catch (error) { row.canonical[name] = { errorCode: safeCode(error) }; }
    }
    try { row.tasks = (await ov.tasks(folder)).map(task => ({ taskId: task.taskId, status: task.status, failedRecords: task.failedRecords, unsupportedRecords: task.unsupportedRecords })); }
    catch (error) { row.tasksError = safeCode(error); }
    diagnostic.directories.push(row); await saveReport(path, diagnostic);
    console.log(JSON.stringify({ level: row.level, raw: row.raw, canonical: row.canonical, listingNames: row.listing.map(item => item.name), tasks: row.tasks }));
  }
  const taskIds = [...new Set((report.events || []).map(event => event.status?.knowledgeBase?.taskId).filter(Boolean))];
  for (const taskId of taskIds) {
    try {
      const task = await ov.task(taskId);
      diagnostic.taskEvidence.push({ taskId, status: task.status, uri: task.uri, failedRecords: task.failedRecords, unsupportedRecords: task.unsupportedRecords });
    } catch (error) { diagnostic.taskEvidence.push({ taskId, errorCode: safeCode(error) }); }
  }
  await saveReport(path, diagnostic); console.log(`Diagnostic report ${path}`);
}

function resultUris(value) {
  const results = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.uri === 'string' && node.uri.startsWith('viking://')) results.add(node.uri);
    for (const child of Object.values(node)) if (child && typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(value); return [...results];
}

async function run(options) {
  const targetsFile = await loadPrivateTargets(options.targets);
  const resume = options.resume ? await loadResumeReport(options.resume) : undefined;
  const env = loadServerEnvironment(options.config, options.server);
  const config = loadConnectionConfig(env);
  need(config.origin === sourceOrigin && config.defaultSpaceId === spaceId, 'WRONG_DOCMOST_TARGET', 'The configured deployment/default space does not match the approved private targets.');
  need(config.authMode === 'session', 'WRONG_AUTH_MODE', 'Use the already-configured personal session; do not switch authentication modes.');
  need(config.syncStateDir, 'SYNC_LEDGER_REQUIRED', 'The existing private synchronization ledger must be configured.');
  need(!resume || resume.prior.syncStateDir === config.syncStateDir, 'RESUME_LEDGER_MISMATCH', 'Resume must use the same existing synchronization ledger.');
  need(!options.run || !config.readOnly, 'READ_ONLY_CONFIG', 'The selected MCP connection is read-only; acceptance did not override it.');
  if (!options.run) env.DOCMOST_READ_ONLY = '1';
  const executionId = `${Date.now()}-${randomBytes(5).toString('hex')}`;
  const runId = resume?.prior.runId || executionId;
  const reportPath = resolve(options.report || (resume
    ? resume.sourcePath.replace(/\.json$/, options.run ? '-resumed.json' : '-resumed-read-only.json')
    : resolve(reportDir, `page-knowledge-acceptance-${runId}.json`)));
  need(!resume || reportPath !== resume.sourcePath, 'RESUME_REPORT_OVERWRITE', 'Resume must preserve its original report.');
  if (resume) {
    try { await lstat(reportPath); throw new AcceptanceError('RESUME_REPORT_EXISTS', 'Choose a fresh --report path to preserve the earlier resume evidence.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const report = { version: 1, runId, startedAt: new Date().toISOString(), mode: options.run ? 'explicit-run' : 'read-only',
    sourceOrigin, sourceSpaceId: spaceId, sourceSpaceName: spaceName, targetsFile, actualEntry: entry, syncStateDir: config.syncStateDir,
    originals: resume ? resume.prior.originals.map(page => ({ before: structuredClone(page.before), knowledge: structuredClone(page.knowledge) })) : [],
    events: [], created: resume ? structuredClone(resume.prior.created) : [], cleanup: [],
    ...(resume ? { resumeOf: resume.sourcePath, resumeSourceSha256: resume.sourceSha256, executionId, creationAttempts: structuredClone(resume.prior.creationAttempts),
      sharedKnowledgeAncestry: structuredClone(resume.prior.sharedKnowledgeAncestry), resume: { validationComplete: false, retryRequested: false } } : {}),
    externalMutations: 'MCP tools only; OpenViking HTTP probes are restricted to read operations.' };
  const createdIds = new Set(report.created.map(page => page.pageId));
  const observed = new Map();
  const sources = new Map();
  const deadline = Date.now() + options.timeoutMs;
  let stopRequested = false, client, ov, failed, resumeCleanupAllowed = false;
  const onSignal = () => { stopRequested = true; };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  async function flush() { await saveReport(reportPath, report); }
  async function event(name, details = {}) {
    report.events.push({ at: new Date().toISOString(), name, ...details }); await flush();
    console.log(`${name}${details.pageId ? ` ${details.pageId}` : ''}${details.code ? ` ${details.code}` : ''}`);
  }
  function checkTime() { need(!stopRequested && Date.now() < deadline, 'ACCEPTANCE_CANCELLED', 'Acceptance was cancelled or reached its overall time bound.'); }
  async function call(name, args = {}, cleanup = false) {
    need(readTools.has(name) || writeTools.has(name), 'TOOL_NOT_ALLOWED', 'This acceptance tool is not allowlisted.');
    if (!cleanup) checkTime();
    if (writeTools.has(name)) {
      if (resume) assertResumeWrite(report.resume.validationComplete, name, args, report.created);
      assertMutation(name, args, options.run, createdIds);
    }
    return client.call(name, args);
  }
  async function pageStatus(pageId) {
    const status = await call('get_page_knowledge_status', { pageId });
    const page = enrolledPage(status, pageId);
    const safe = safeStatus(page);
    const fingerprint = JSON.stringify(safe);
    if (observed.get(pageId) !== fingerprint) {
      observed.set(pageId, fingerprint); await event('knowledge-status-changed', { pageId, status: safe });
    }
    return page;
  }
  async function waitKnowledge(pageId, predicate, label, cleanup = false) {
    const phaseDeadline = Math.min(deadline, Date.now() + options.phaseTimeoutMs);
    for (;;) {
      if (!cleanup) checkTime();
      const status = cleanup
        ? enrolledPage(await client.call('get_page_knowledge_status', { pageId }), pageId)
        : await pageStatus(pageId);
      if (await predicate(status)) return status;
      const kb = knowledge(status);
      need(!['blocked', 'failed'].includes(kb.state), 'KNOWLEDGE_BLOCKED', 'Knowledge synchronization is blocked; inspect its safe status instead of repeating publication.');
      need(Date.now() < phaseDeadline, 'KNOWLEDGE_WAIT_TIMEOUT', `Timed out waiting for ${label}; pending tasks were preserved.`);
      await sleep(5000);
    }
  }
  async function waitRaw(pageId, expectedBody) {
    return waitKnowledge(pageId, async page => {
      const kb = knowledge(page);
      if (kb.state !== 'synced' || typeof kb.uri !== 'string') return false;
      const body = await ov.read(kb.uri);
      return typeof body === 'string' && digest(body) === digest(expectedBody);
    }, 'the exact Markdown body to be confirmed in knowledge');
  }
  async function inspectKnowledge(page, original) {
    const uri = knowledge(page).uri;
    assertHierarchy(uri, original, report.workspaceId, ov.identity.rootUri, !resume);
    const raw = await ov.read(uri);
    need(typeof raw === 'string' && digest(raw) === original.bodySha256 && Buffer.byteLength(raw, 'utf8') === original.bodyBytesUtf8,
      'RAW_BODY_MISMATCH', 'Knowledge raw content is incomplete or differs from the full Docmost Markdown body.');
    const folders = [];
    let folder = directory(uri);
    for (let depth = 0; depth < 4; depth++) { folders.push(folder); folder = directory(folder); }
    const summaries = [];
    for (const folder of folders) {
      const entries = await ov.list(folder);
      need(Array.isArray(entries), 'MISSING_KNOWLEDGE_DIRECTORY', 'A required page or ancestor directory is missing.');
      for (const name of ['.abstract.md', '.overview.md']) {
        const summary = await ov.read(`${folder}/${name}`);
        need(typeof summary === 'string' && summary.trim().length > 0, 'MISSING_SUMMARY', 'A required page/ancestor L0 or L1 summary is missing.');
        summaries.push({ uri: `${folder}/${name}`, bytes: Buffer.byteLength(summary, 'utf8'), sha256: digest(summary) });
      }
    }
    const tasks = await ov.tasks(directory(uri));
    const found = resultUris(await ov.find(original.title, directory(uri)));
    need(found.some(hit => hit === directory(uri) || hit.startsWith(`${directory(uri)}/`)), 'KNOWLEDGE_SEARCH_MISS', 'Scoped semantic retrieval did not return this imported page.');
    return { uri, rawBytes: Buffer.byteLength(raw, 'utf8'), rawSha256: digest(raw), summaries,
      tasks: tasks.map(task => ({ taskId: task.taskId, status: task.status, failedRecords: task.failedRecords, unsupportedRecords: task.unsupportedRecords })), retrievalUris: found };
  }
  async function createTest(title, content, purpose) {
    const intent = { title, purpose, attemptedAt: new Date().toISOString(), bodySha256: digest(content), state: 'requesting' };
    (report.creationAttempts ??= []).push(intent); await flush();
    let page;
    try { page = await call('create_page', { spaceId, parentPageId: adId, title, content, format: 'markdown' }); }
    catch (error) {
      intent.state = 'unconfirmed'; intent.errorCode = safeCode(error); await flush();
      throw error;
    }
    need(uuid(page?.id) && !protectedIds.has(page.id), 'INVALID_TEST_CREATION', 'MCP did not return a unique canonical test-page UUID.');
    intent.state = 'confirmed'; intent.pageId = page.id;
    createdIds.add(page.id);
    const resource = { pageId: page.id, title, purpose, createdAt: new Date().toISOString(), deleted: false, uris: [] };
    report.created.push(resource);
    await event('test-page-created', { pageId: page.id, purpose });
    const saved = await call('get_page', { pageId: page.id, format: 'markdown' });
    need(saved.id === page.id && saved.spaceId === spaceId && saved.parentPageId === adId && !saved.deletedAt,
      'TEST_IDENTITY_CHANGED', 'The newly-created test page did not read back at its approved location.');
    const { canonicalBody, ...comparison } = createdBodyComparison(content, saved);
    resource.creationRoundtrip = comparison; resource.savedMetadata = metadata(saved); await flush();
    return { ...saved, content: canonicalBody };
  }
  async function deleteCreated(resource) {
    if (resource.deleted) return;
    const current = await client.call('get_page', { pageId: resource.pageId, format: 'markdown' });
    need(current.id === resource.pageId && current.spaceId === spaceId && current.title?.startsWith(`MCP知识同步验收-${runId}`),
      'TEST_IDENTITY_CHANGED', 'A tracked test page changed identity/location; cleanup stopped without touching it.');
    if (!current.deletedAt) {
      const children = await client.call('list_child_pages', { pageId: resource.pageId, limit: 100 });
      need(!children.meta?.hasNextPage && (children.items || []).every(item => createdIds.has(item.id)),
        'UNEXPECTED_TEST_DESCENDANTS', 'A test page has untracked descendants; cleanup did not delete its subtree.');
      await call('delete_page', { pageId: resource.pageId }, true);
    }
    resource.deleted = true; await event('test-page-soft-deleted', { pageId: resource.pageId });
  }
  async function inspectDeletedKnowledge(resource, marker) {
    const ownedUris = [...new Set(resource.uris)];
    const adDirectory = report.sharedKnowledgeAncestry.adDirectory;
    const evidence = { rawReads: [], retrieval: [], parentSummaries: [] };
    for (const uri of ownedUris) {
      need(await ov.read(uri) === undefined, 'DELETED_RAW_STILL_PRESENT', 'A deleted test copy still has an owned raw knowledge URI.');
      evidence.rawReads.push({ uri, exists: false });
    }
    for (const [queryType, query] of [['unique-marker', marker], ['complete-copy-title', resource.title]]) {
      const uris = resultUris(await ov.find(query, adDirectory));
      const stale = deletedHitUris(uris, ownedUris);
      evidence.retrieval.push({ queryType, targetUri: adDirectory, hitUris: uris, deletedHitUris: stale, limit: 30 });
      resource.deletionEvidence = evidence; await flush();
      need(stale.length === 0, 'DELETED_SEARCH_HIT', 'Scoped retrieval still returns a deleted test-page URI or its unique directory prefix.');
    }
    const parents = new Set();
    for (const uri of ownedUris) {
      let folder = directory(directory(uri));
      for (let depth = 0; depth < 10; depth++) {
        parents.add(folder);
        if (directory(folder) === ov.identity.rootUri || folder.endsWith(`--${spaceId}`)) break;
        need(folder.startsWith(`${ov.identity.rootUri}/`), 'HIERARCHY_MISMATCH', 'Deletion-summary checks left the approved hierarchy.');
        folder = directory(folder);
      }
    }
    for (const folder of parents) {
      const entries = await ov.list(folder);
      for (const name of ['.abstract.md', '.overview.md']) {
        const uri = `${folder}/${name}`;
        const text = await ov.read(uri);
        const row = { uri, directoryExists: entries !== undefined, exists: text !== undefined,
          ...(text === undefined ? {} : { bytes: Buffer.byteLength(text, 'utf8'), sha256: digest(text) }), staleReference: staleSummary(text, resource) };
        evidence.parentSummaries.push(row); resource.deletionEvidence = evidence; await flush();
        need(entries === undefined || (typeof text === 'string' && text.trim().length > 0),
          'MISSING_SUMMARY', 'A retained parent has no real stored L0/L1 summary after deletion.');
        need(!row.staleReference, 'STALE_PARENT_SUMMARY', 'A retained parent summary still names the deleted test-page UUID or complete title.');
      }
    }
    return evidence;
  }
  async function completeMovedCopy(resource, parent, copyBody, marker, oldUris, expectedUri) {
    const status = await waitKnowledge(resource.pageId, async page => {
      const kb = knowledge(page);
      return kb.state === 'synced' && kb.uri && !oldUris.includes(kb.uri) && (kb.uri.includes(`--${parent.id}/`) || kb.uri.includes(`/${segment(parent.title)}/`))
        && (!expectedUri || kb.uri === expectedUri) && digest((await ov.read(kb.uri)) ?? '') === digest(copyBody)
        && (await Promise.all(oldUris.map(uri => ov.read(uri)))).every(body => body === undefined);
    }, 'the automatic move and old-URI cleanup');
    if (!resource.uris.includes(knowledge(status).uri)) resource.uris.push(knowledge(status).uri);
    if (resume) { report.resume.moveVerified = true; resumeCleanupAllowed = true; }
    await event('test-copy-MCP-move-auto-sync-passed', { pageId: resource.pageId });
    // A structural parent has derived summaries even without an enrolled body.
    // Enroll this owned test page so its later MCP deletion owns folder cleanup.
    const parentResource = report.created.find(page => page.pageId === parent.id && page.purpose === 'temporary-move-parent');
    const savedParent = await call('get_page', { pageId: parent.id, format: 'markdown' });
    need(parentResource && savedParent.id === parent.id && savedParent.title === parentResource.title
      && savedParent.spaceId === spaceId && savedParent.parentPageId === adId && !savedParent.deletedAt
      && digest(savedParent.content) === parentResource.savedMetadata.bodySha256,
    'TEST_IDENTITY_CHANGED', 'The tracked temporary parent changed before its explicit enrollment; cleanup stopped.');
    if (!await pageStatus(parent.id)) await call('sync_page_to_knowledge', { pageId: parent.id });
    const parentStatus = await waitRaw(parent.id, savedParent.content);
    if (!parentResource.uris.includes(knowledge(parentStatus).uri)) parentResource.uris.push(knowledge(parentStatus).uri);
    await event('test-parent-explicitly-enrolled-for-directory-cleanup', { pageId: parent.id });
    await deleteCreated(resource);
    const deleted = await waitKnowledge(resource.pageId, async page => knowledge(page).state === 'deleted'
      && (await Promise.all(resource.uris.map(uri => ov.read(uri)))).every(body => body === undefined), 'automatic soft-delete cleanup');
    resource.deletedKnowledgeStatus = safeStatus(deleted);
    resource.deletionEvidence = await inspectDeletedKnowledge(resource, marker); await flush();
    await event('test-copy-MCP-delete-auto-sync-passed', { pageId: resource.pageId });
  }
  async function resumeExistingCopy() {
    const scope = validateResumeReport(resume.prior);
    const resource = report.created.find(page => page.pageId === scope.copy.pageId);
    const parentResource = report.created.find(page => page.pageId === scope.parent.pageId);
    const copy = await call('get_page', { pageId: resource.pageId, format: 'markdown' });
    const parent = await call('get_page', { pageId: parentResource.pageId, format: 'markdown' });
    need(copy.id === resource.pageId && copy.title === resource.title && copy.spaceId === spaceId && copy.parentPageId === parent.id && !copy.deletedAt
      && parent.id === parentResource.pageId && parent.title === parentResource.title && parent.spaceId === spaceId && parent.parentPageId === adId && !parent.deletedAt
      && digest(parent.content) === parentResource.savedMetadata.bodySha256,
    'RESUME_LAYOUT_CHANGED', 'Existing active test pages do not match the recorded completed move and temporary-parent body.');
    const marker = resumeMarker(copy.content, resource.updatedBodySha256);
    for (const page of [copy, parent]) {
      const children = await call('list_child_pages', { pageId: page.id, limit: 100 });
      need(!children.meta?.hasNextPage && (children.items || []).every(child => page.id === parent.id && child.id === copy.id),
        'UNEXPECTED_TEST_DESCENDANTS', 'Resume found an untracked descendant and did not authorize cleanup.');
    }
    const status = await pageStatus(copy.id);
    const historicStatus = [...resume.prior.events].reverse().find(event => event.status?.pageId === copy.id && event.status.bindingId)?.status;
    need(status?.source === 'docmost' && uuid(status.bindingId) && status.bindingId === historicStatus?.bindingId
      && status.spaceId === spaceId && status.workspaceId === report.workspaceId,
    'RESUME_BINDING_CHANGED', 'Resume cannot retarget the existing page mirror or ledger binding.');
    need(status.error?.code !== 'LEASE_BUSY' && status.errorCode !== 'LEASE_BUSY', 'LEASE_BUSY', 'The existing copy is owned by another live MCP lease.');
    need(config.knowledgeBase?.provider === 'openviking' && config.openViking && !config.openViking.error,
      'KNOWLEDGE_CONFIG_REQUIRED', 'The approved knowledge provider is not ready.');
    ov = await openReadOnlyKnowledge(config.openViking);
    for (const field of ['rootUri', 'accountId', 'userId']) need(ov.identity[field] === resume.prior.knowledgeIdentity?.[field],
      'RESUME_KNOWLEDGE_CHANGED', 'Resume must use the originally confirmed knowledge identity and private root.');
    report.knowledgeIdentity = ov.identity;
    for (const original of report.originals) need(digest((await ov.read(original.knowledge.uri)) ?? '') === original.before.bodySha256,
      'RESUME_BASELINE_MISMATCH', 'A previously confirmed original knowledge body no longer matches its baseline.');
    const adDirectory = report.sharedKnowledgeAncestry.adDirectory;
    need(adDirectory.startsWith(`${ov.identity.rootUri}/`) && adDirectory.endsWith(`--${adId}`), 'RESUME_LAYOUT_CHANGED', 'The prior knowledge parent is outside the approved hierarchy.');
    for (const uri of resource.uris) need(typeof uri === 'string' && uri.startsWith(`${adDirectory}/`) && uri.endsWith(`--${copy.id}/document.md`),
      'RESUME_LAYOUT_CHANGED', 'A recorded copy URI is outside its owned knowledge branch.');
    for (const page of [copy, parent]) need(Buffer.byteLength(page.title, 'utf8') <= 120 && /^[\p{L}\p{N}-]+$/u.test(page.title),
      'RESUME_LAYOUT_CHANGED', 'This bounded resume requires the original untruncated generated test titles.');
    const expectedUri = `${adDirectory}/${parent.title}--${parent.id}/${copy.title}--${copy.id}/document.md`;
    const oldUris = [...new Set(resource.uris.filter(uri => uri !== expectedUri))];
    need(oldUris.length > 0, 'RESUME_LAYOUT_CHANGED', 'The pre-move URI proof is missing.');
    report.resume = { ...report.resume, validationComplete: true, validatedCopy: metadata(copy), validatedParent: metadata(parent),
      markerSha256: digest(marker), pendingStatus: safeStatus(status), expectedMovedUri: expectedUri };
    await event('resume-read-only-verification-passed', { pageId: copy.id });
    if (!options.run) { report.result = 'resume-read-only-verified'; return; }
    const kb = knowledge(status);
    const alreadyMoved = kb.state === 'synced' && kb.uri === expectedUri && digest((await ov.read(expectedUri)) ?? '') === resource.updatedBodySha256
      && (await Promise.all(oldUris.map(uri => ov.read(uri)))).every(body => body === undefined);
    if (!alreadyMoved) {
      report.resume.retryRequested = true; report.resume.retryBindingId = status.bindingId; await flush();
      await call('retry_knowledge_sync', { bindingId: status.bindingId });
      await event('resume-existing-job-retried-once', { pageId: copy.id });
    }
    await completeMovedCopy(resource, parent, copy.content, marker, oldUris, expectedUri);
    report.result = 'resumed-acceptance-passed';
  }
  try {
    await flush();
    client = startMcp(env);
    const tools = await client.initialize();
    const names = new Set(tools.map(tool => tool.name));
    report.tools = [...names].sort();
    for (const name of ['get_current_user', 'get_page', 'get_space', 'get_page_knowledge_status']) need(names.has(name), 'MISSING_TOOL', `The built MCP does not expose ${name}.`);
    if (options.run) for (const name of writeTools) need(names.has(name), 'MISSING_TOOL', `The writable MCP does not expose ${name}.`);
    const identity = await call('get_current_user');
    need(!resume || (identity.workspace.id === resume.prior.workspaceId && identity.user.id === resume.prior.userId),
      'RESUME_IDENTITY_CHANGED', 'Resume must use the same authenticated user and workspace.');
    report.workspaceId = identity.workspace.id; report.userId = identity.user.id;
    const space = await call('get_space', { spaceId });
    need(space.id === spaceId && space.name === spaceName, 'WRONG_DOCMOST_TARGET', 'The approved target space was not returned.');
    const business = await call('get_page', { pageId: businessId, format: 'markdown' });
    const ad = await call('get_page', { pageId: adId, format: 'markdown' });
    need(business.parentPageId === null && business.title === businessTitle && ad.parentPageId === businessId && ad.title === adTitle,
      'ORIGINAL_LAYOUT_CHANGED', 'The approved two-parent ancestry changed.');
    report.ancestors = [metadata(business), metadata(ad)];
    for (const original of originals) {
      const page = await call('get_page', { pageId: original.id, format: 'markdown' });
      need(page.title === original.title && page.spaceId === spaceId && page.parentPageId === adId && !page.deletedAt,
        'ORIGINAL_LAYOUT_CHANGED', 'A protected original no longer matches its approved title, space or parent.');
      sources.set(page.id, page.content);
      if (resume) {
        const record = report.originals.find(item => item.before.id === page.id);
        assertSamePage(record.before, metadata(page)); record.resumeBefore = metadata(page);
      } else report.originals.push({ before: metadata(page) });
      await event('original-read-only-baseline', { pageId: page.id });
    }
    const initialStatus = await call('get_page_knowledge_status');
    report.initialPageStatus = normalizePages(initialStatus).map(safeStatus);
    report.knowledgeBase = { provider: initialStatus.knowledgeBase?.provider, enabled: initialStatus.knowledgeBase?.enabled, state: initialStatus.knowledgeBase?.state };
    await flush();
    assertNoBusyOriginalLease(initialStatus);
    await event('read-only-preflight-complete');
    if (resume) await resumeExistingCopy();
    else if (!options.run) { report.result = 'read-only-preflight-passed'; }
    else {
    need(config.knowledgeBase?.provider === 'openviking' && config.openViking && !config.openViking.error,
      'KNOWLEDGE_CONFIG_REQUIRED', 'The approved OpenViking provider is not ready.');
    ov = await openReadOnlyKnowledge(config.openViking);
    report.knowledgeIdentity = ov.identity;
    const rootBefore = await ov.list(ov.identity.rootUri);
    report.knowledgeRootBefore = { exists: rootBefore !== undefined,
      entries: rootBefore?.map(entry => ({ name: entry.name, isDir: entry.isDir })) ?? [] };
    await flush();
    for (const record of report.originals) {
      checkTime();
      const pageId = record.before.id;
      const current = await pageStatus(pageId);
      const kb = knowledge(current);
      if (shouldRequestSync(current) || (options.refreshOriginals && kb.state === 'synced')) {
        await call('sync_page_to_knowledge', { pageId });
        await event('original-publication-requested-once', { pageId });
      } else if (['blocked', 'failed'].includes(kb.state)) {
        throw new AcceptanceError('EXISTING_KNOWLEDGE_BLOCKED', 'An existing mirror is blocked. Inspect and explicitly repair it before repeating acceptance.');
      } else await event('existing-publication-observed-without-redispatch', { pageId });
      const ready = await waitRaw(pageId, sources.get(pageId));
      record.knowledge = await inspectKnowledge(ready, record.before);
      await event('original-fulltext-hierarchy-summaries-retrieval-passed', { pageId });
    }
    const adDirectory = directory(directory(report.originals[0].knowledge.uri));
    const importedChildren = await ov.list(adDirectory);
    need(originals.every(original => importedChildren?.some(item => (item.name === segment(original.title) || item.name?.endsWith(`--${original.id}`)) && item.isDir)),
      'HIERARCHY_MISMATCH', 'The configured parent knowledge directory does not contain all three imported page UUIDs.');
    report.sharedKnowledgeAncestry = { adDirectory, expectedPageIds: originals.map(page => page.id), allThreePresent: true };
    const titlePrefix = `MCP知识同步验收-${runId}`;
    const copy = await createTest(`${titlePrefix}-副本`, sources.get(originals[0].id), 'same-parent-business-document-copy');
    if (shouldRequestSync(await pageStatus(copy.id))) await call('sync_page_to_knowledge', { pageId: copy.id });
    let copyStatus = await waitRaw(copy.id, copy.content);
    const resource = report.created.find(item => item.pageId === copy.id);
    resource.uris.push(knowledge(copyStatus).uri); await flush();
    const marker = `mcpknowledgetest${randomBytes(10).toString('hex')}`;
    await call('update_page', { pageId: copy.id, content: `\n\n${marker}\n`, format: 'markdown', operation: 'append' });
    let copyBody;
    for (let attempt = 0; attempt < 30; attempt++) {
      const live = await call('get_page', { pageId: copy.id, format: 'markdown' });
      if (live.content.includes(marker)) { copyBody = live.content; break; }
      await sleep(1000);
    }
    need(copyBody, 'DOCMOST_PERSISTENCE_TIMEOUT', 'The test append was not persisted in Docmost.');
    copyStatus = await waitRaw(copy.id, copyBody);
    const modifiedUri = knowledge(copyStatus).uri;
    resource.uris.push(modifiedUri); resource.updatedBodySha256 = digest(copyBody); await flush();
    const modifiedHits = resultUris(await ov.find(marker, directory(modifiedUri)));
    need(modifiedHits.some(uri => uri.startsWith(`${directory(modifiedUri)}/`) || uri === directory(modifiedUri)), 'KNOWLEDGE_SEARCH_MISS', 'The appended test marker was not retrievable.');
    await event('test-copy-MCP-edit-auto-sync-passed', { pageId: copy.id });
    const temporaryParent = await createTest(`${titlePrefix}-临时目录`, 'Temporary acceptance directory. Only this run\'s tracked test copy may be placed here.', 'temporary-move-parent');
    const copyBeforeMove = await call('get_page', { pageId: copy.id, format: 'markdown' });
    await call('move_page', { pageId: copy.id, parentPageId: temporaryParent.id, position: copyBeforeMove.position });
    const moved = await call('get_page', { pageId: copy.id, format: 'markdown' });
    need(moved.parentPageId === temporaryParent.id && digest(moved.content) === digest(copyBody), 'MOVE_MISMATCH', 'The test move changed the body or did not set the test parent.');
    await completeMovedCopy(resource, temporaryParent, copyBody, marker, [modifiedUri]);
    report.result = 'full-acceptance-passed';
    }
  } catch (error) {
    failed = error;
    report.result = 'failed'; report.error = { code: safeCode(error) };
    await event('acceptance-failed', { code: safeCode(error) });
  } finally {
    if (client && options.run && (!resume || resumeCleanupEligible(options.run, report.resume.validationComplete, failed, resumeCleanupAllowed))) {
      // Only canonical IDs returned by our successful creations are cleaned.
      // Never remove imported originals or other existing KB resources.
      const cleanupOrder = [...report.created].sort((a, b) => Number(a.purpose === 'temporary-move-parent') - Number(b.purpose === 'temporary-move-parent'));
      for (const resource of cleanupOrder) {
        try {
          await deleteCreated(resource);
          let knowledgeState = 'not-checked';
          if (ov) {
            const cleanupDeadline = Date.now() + options.phaseTimeoutMs;
            for (;;) {
              const status = enrolledPage(await client.call('get_page_knowledge_status', { pageId: resource.pageId }), resource.pageId);
              if (!status || knowledge(status).state === 'deleted') { knowledgeState = status ? 'deleted' : 'not_enrolled'; break; }
              need(Date.now() < cleanupDeadline, 'CLEANUP_PENDING', 'The test page is trashed but its knowledge cleanup is still pending.');
              await sleep(5000);
            }
            for (const uri of new Set(resource.uris)) {
              need(await ov.read(uri) === undefined && await ov.list(directory(uri)) === undefined,
                'CLEANUP_DIRECTORY_PRESENT', 'The deleted test page still has raw content or a generated directory.');
            }
          }
          report.cleanup.push({ pageId: resource.pageId, docmostSoftDeleted: true, knowledgeState,
            ...(ov && resource.uris.length ? { knowledgeDirectoriesAbsent: true } : {}) });
        } catch (error) {
          report.cleanup.push({ pageId: resource.pageId, errorCode: safeCode(error) });
          failed ??= error; report.result = 'failed';
        }
        await flush();
      }
    } else if (resume && report.created.some(page => !page.deleted)) {
      report.cleanupDeferred = { reason: !options.run ? 'READ_ONLY_RESUME' : !report.resume.validationComplete ? 'RESUME_PRECHECK_FAILED' : safeCode(failed),
        pageIds: report.created.filter(page => !page.deleted).map(page => page.pageId) };
    }
    if (client && report.originals.length) {
      for (const original of report.originals) {
        try {
          const current = await client.call('get_page', { pageId: original.before.id, format: 'markdown' });
          original.after = metadata(current); assertSamePage(original.before, original.after); original.unchanged = true;
        } catch (error) {
          original.unchanged = safeCode(error) === 'ORIGINAL_CHANGED' ? false : null;
          original.finalVerificationError = safeCode(error); failed ??= error; report.result = 'failed';
        }
      }
    }
    if (client) report.transport = await client.close();
    report.completedAt = new Date().toISOString();
    const originalsChanged = report.originals.some(page => page.unchanged === false);
    const originalsUnavailable = report.originals.length !== originals.length || report.originals.some(page => page.unchanged == null);
    report.originalsFinalVerification = originalsChanged ? 'changed' : originalsUnavailable ? 'unavailable' : 'unchanged';
    report.originalsUnchanged = originalsChanged ? false : originalsUnavailable ? null : true;
    await flush();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    console.log(`Report ${reportPath}`);
  }
  if (failed) throw failed;
}

function parseOptions(args) {
  const options = { run: false, config: resolve(homedir(), '.codex/config.toml'), server: 'docmost', timeoutMs: 30 * 60 * 1000, phaseTimeoutMs: 10 * 60 * 1000 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--run') options.run = true;
    else if (arg === '--refresh-originals') options.refreshOriginals = true;
    else if (['--config', '--server', '--report', '--targets', '--resume', '--diagnose-summaries', '--timeout-ms', '--phase-timeout-ms'].includes(arg)) {
      const value = args[++index]; need(value, 'INVALID_ARGUMENTS', `${arg} requires a value.`);
      const field = { '--config': 'config', '--server': 'server', '--report': 'report', '--targets': 'targets', '--resume': 'resume', '--diagnose-summaries': 'diagnosticReport', '--timeout-ms': 'timeoutMs', '--phase-timeout-ms': 'phaseTimeoutMs' }[arg];
      options[field] = arg.endsWith('-ms') ? Number(value) : value;
    } else throw new AcceptanceError('INVALID_ARGUMENTS', 'Use --targets, --resume, --run, --config, --server, --report, --diagnose-summaries, timeout options or --self-test.');
  }
  need(!options.refreshOriginals || (options.run && !options.resume), 'INVALID_ARGUMENTS', '--refresh-originals requires a fresh explicit --run.');
  need(!options.resume || !options.diagnosticReport, 'INVALID_ARGUMENTS', 'Use either --resume or --diagnose-summaries for a single invocation.');
  for (const field of ['timeoutMs', 'phaseTimeoutMs']) need(Number.isSafeInteger(options[field]) && options[field] >= 1000 && options[field] <= 2 * 60 * 60 * 1000,
    'INVALID_ARGUMENTS', 'Timeout bounds must be from 1 second to 2 hours.');
  return options;
}

function selfTest() {
  configureTargets(syntheticTargets);
  const resumeId = '1700000000000-0123456789';
  const fixturePage = (id, purpose, suffix) => ({ pageId: id, purpose, title: `MCP知识同步验收-${resumeId}-${suffix}`, deleted: false,
    savedMetadata: { id, title: `MCP知识同步验收-${resumeId}-${suffix}`, spaceId, parentPageId: adId, bodySha256: 'b'.repeat(64) },
    uris: ['viking://user/test/resources/docmost/old/document.md'] });
  const resumeFixture = { version: 1, mode: 'explicit-run', runId: resumeId, sourceOrigin, sourceSpaceId: spaceId,
    userId: '00000000-0000-4000-8000-000000000009', workspaceId: '00000000-0000-4000-8000-00000000000a',
    originals: originals.map(page => ({ before: { ...page, spaceId, parentPageId: adId, bodySha256: 'a'.repeat(64) }, knowledge: { rawSha256: 'a'.repeat(64) } })),
    created: [fixturePage('00000000-0000-4000-8000-000000000007', 'same-parent-business-document-copy', '副本'),
      fixturePage('00000000-0000-4000-8000-000000000008', 'temporary-move-parent', '临时目录')],
    sharedKnowledgeAncestry: { adDirectory: 'viking://user/test/resources/docmost/section' }, events: [] };
  resumeFixture.created[0].updatedBodySha256 = 'c'.repeat(64);
  resumeFixture.creationAttempts = resumeFixture.created.map(page => ({ state: 'confirmed', pageId: page.pageId, title: page.title }));
  assert.equal(validateResumeReport(resumeFixture).copy.pageId, resumeFixture.created[0].pageId);
  assert.throws(() => validateResumeReport({ ...resumeFixture, mode: 'read-only' }), { code: 'INVALID_RESUME_REPORT' });
  assert.throws(() => validateResumeReport({ ...resumeFixture, runId: '../unsafe' }), { code: 'INVALID_RESUME_REPORT' });
  const wrongOriginal = structuredClone(resumeFixture); wrongOriginal.originals[0].knowledge.rawSha256 = 'd'.repeat(64);
  assert.throws(() => validateResumeReport(wrongOriginal), { code: 'RESUME_BASELINE_MISMATCH' });
  const protectedCopy = structuredClone(resumeFixture); protectedCopy.created[0].pageId = originals[0].id;
  assert.throws(() => validateResumeReport(protectedCopy), { code: 'INVALID_RESUME_REPORT' });
  const wrongPrefix = structuredClone(resumeFixture); wrongPrefix.created[0].title += '-unexpected';
  assert.throws(() => validateResumeReport(wrongPrefix), { code: 'INVALID_RESUME_REPORT' });
  const marker = 'mcpknowledgetest0123456789abcdef0123', resumeBody = `Example saved body\n${marker}\n`;
  assert.equal(resumeMarker(resumeBody, digest(resumeBody)), marker);
  assert.throws(() => resumeMarker(resumeBody, 'e'.repeat(64)), { code: 'RESUME_COPY_CHANGED' });
  for (const invalid of ['Example body', `${marker}\n${marker}`, `${marker}a`]) {
    assert.throws(() => resumeMarker(invalid, digest(invalid)), { code: 'RESUME_MARKER_MISMATCH' });
  }
  assert.throws(() => assertResumeWrite(false, 'delete_page'), { code: 'RESUME_NO_REPLAY' });
  for (const name of ['create_page', 'update_page', 'move_page', 'sync_page_to_knowledge']) {
    assert.throws(() => assertResumeWrite(true, name), { code: 'RESUME_NO_REPLAY' });
  }
  assertResumeWrite(true, 'retry_knowledge_sync'); assertResumeWrite(true, 'delete_page');
  assert.doesNotThrow(() => assertResumeWrite(true, 'sync_page_to_knowledge',
    { pageId: resumeFixture.created[1].pageId }, resumeFixture.created),
  'A verified temporary parent must be enrolled so its generated directory can be removed by MCP cleanup.');
  assert.throws(() => assertResumeWrite(true, 'sync_page_to_knowledge',
    { pageId: resumeFixture.created[0].pageId }, resumeFixture.created), { code: 'RESUME_NO_REPLAY' });
  assert.throws(() => assertResumeWrite(false, 'sync_page_to_knowledge',
    { pageId: resumeFixture.created[1].pageId }, resumeFixture.created), { code: 'RESUME_NO_REPLAY' });
  assert.equal(resumeCleanupEligible(false, true, undefined, true), false);
  assert.equal(resumeCleanupEligible(true, false, undefined, true), false);
  assert.equal(resumeCleanupEligible(true, true, new AcceptanceError('FORBIDDEN', 'unavailable'), true), false);
  assert.equal(resumeCleanupEligible(true, true, undefined, false), false);
  assert.equal(resumeCleanupEligible(true, true, undefined, true), true);
  assert.equal(parseOptions(['--resume', '/private/example-report.json']).resume, '/private/example-report.json');
  assert.equal(parseOptions(['--resume', '/private/example-report.json']).run, false);
  assert.equal(parseOptions(['--resume', '/private/example-report.json', '--run']).run, true);
  const busyOriginal = { source: 'docmost', pageId: originals[0].id, state: 'paused',
    error: { code: 'LEASE_BUSY', message: 'private lease diagnostic' }, knowledgeBase: { state: 'pending' } };
  assert.deepEqual(safeStatus(busyOriginal).errorCode, 'LEASE_BUSY', 'Safe evidence must retain the binding error code.');
  assert(!JSON.stringify(safeStatus(busyOriginal)).includes('private lease diagnostic'));
  assert.throws(() => assertNoBusyOriginalLease({ bindings: [busyOriginal] }), { code: 'LEASE_BUSY' },
    'An enrolled selected original with a busy lease must fail preflight before any test creation.');
  const pendingDeletion = { source: 'docmost', pageId: originals[0].id, state: 'paused',
    error: { code: 'NOT_FOUND' }, knowledgeBase: { state: 'pending', operation: 'delete' } };
  assert.deepEqual(decodeToolResult({ content: [{ type: 'text', text: JSON.stringify(pendingDeletion) }] }, 'get_page_knowledge_status'), pendingDeletion,
    'A valid status snapshot must preserve its domain error while knowledge deletion is pending.');
  assert.equal(decodeToolResult({ structuredContent: pendingDeletion }, 'get_page_knowledge_status').knowledgeBase.state, 'pending');
  assert.throws(() => decodeToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }) }] }, 'get_page'),
    { code: 'UNAUTHENTICATED' }, 'A real isError tool envelope must still fail.');
  assert.equal(createdBodyComparison('# Example\n', { content: '# Example\n\n' }).canonicalBody, '# Example\n\n',
    'A created copy must mirror its saved canonical Markdown, not the original create request bytes.');
  assert.equal(createdBodyComparison('# Example\n', { content: '# Example\n\n' }).normalizationObserved, true);
  const { canonicalBody: privateBody, ...safeCreationEvidence } = createdBodyComparison('private-body', { content: 'private-body\n' });
  assert.equal(privateBody, 'private-body\n');
  assert(!JSON.stringify(safeCreationEvidence).includes('private-body'), 'Creation evidence must only contain hashes and lengths.');
  assert.throws(() => configureTargets({ ...syntheticTargets, origin: 'https://user:secret@example.invalid' }), { code: 'INVALID_TARGETS' });
  assert.throws(() => configureTargets({ ...syntheticTargets, adId: syntheticTargets.businessId }), { code: 'INVALID_TARGETS' });
  assert.throws(() => assertKnowledgeRead('POST', 'content/write'), undefined, 'Knowledge writes must never bypass MCP tools.');
  assert.throws(() => assertKnowledgeRead('DELETE', 'fs'));
  assertKnowledgeRead('POST', 'search/find'); assertKnowledgeRead('GET', 'content/read'); assertKnowledgeRead('GET', 'tasks/accepted-task');
  assert.throws(() => assertMutation('update_page', { pageId: originals[0].id }, true, new Set([originals[0].id])));
  assert.throws(() => assertMutation('sync_page_to_knowledge', { pageId: originals[0].id }, false, new Set()));
  assert.throws(() => assertMutation('sync_page_to_knowledge', { pageId: adId }, true, new Set()));
  assertMutation('sync_page_to_knowledge', { pageId: originals[0].id }, true, new Set());
  assert.throws(() => assertMutation('delete_page', { pageId: 'untracked' }, true, new Set()));
  assert.throws(() => assertSamePage({ id: originals[0].id, bodySha256: 'old' }, { id: originals[0].id, bodySha256: 'new' }));
  assert.equal(normalizePages({ pages: [{ source: 'docmost', pageId: originals[0].id }] }).length, 1);
  assert.equal(normalizePages({ source: 'docmost', pageId: originals[0].id, bindingId: 'fixture' })[0].bindingId, 'fixture');
  assert.equal(enrolledPage({ source: 'docmost', pageId: originals[0].id, state: 'not_enrolled', knowledgeBase: { state: 'configured' } }, originals[0].id), undefined,
    'A not_enrolled snapshot must trigger initial publication rather than passive waiting.');
  assert.equal(shouldRequestSync({ knowledgeBase: { state: 'synced', uri: 'owned-uri' } }), true,
    'A previously synced page must get exactly one explicit idempotent ancestor-repair request.');
  assert.equal(shouldRequestSync({ knowledgeBase: { state: 'processing', phase: 'indexing', taskId: 'existing-task' } }), false,
    'An existing publication task must only be observed, not dispatched again.');
  assert.deepEqual(deletedHitUris(['viking://user/test/resources/root/old/.abstract.md', 'viking://user/test/resources/root/other/document.md'],
    ['viking://user/test/resources/root/old/document.md']), ['viking://user/test/resources/root/old/.abstract.md']);
  assert.equal(staleSummary(`Former child ${originals[0].id}`, { pageId: originals[0].id, title: 'unique-copy-title' }), true);
  assert.equal(staleSummary('Another similar page is allowed.', { pageId: originals[0].id, title: 'unique-copy-title' }), false);
  const privateRoot = 'viking://user/test/resources/docmost';
  const uri = `${privateRoot}/0123456789abcdef/workspace/ExampleSpace--${spaceId}/ExampleParent--${businessId}/ExampleSection--${adId}/ExampleDocument--${originals[0].id}/document.md`;
  assertHierarchy(uri, originals[0], 'workspace', privateRoot);
  assert.throws(() => assertHierarchy(uri, originals[0], 'workspace', privateRoot, true));
  assertHierarchy(`${privateRoot}/Example-space/Example-parent/Example-section/Example-document-one/document.md`, originals[0], 'workspace', privateRoot, true);
  assert.throws(() => assertHierarchy(uri.replace(`/ExampleParent--${businessId}`, ''), originals[0], 'workspace', privateRoot));
  assert(!JSON.stringify(safeStatus({ pageId: originals[0].id, token: 'synthetic-secret', knowledgeBase: { state: 'pending', content: 'private-body' } })).includes('synthetic-secret'));
  assert.equal(parseOptions([]).run, false); assert.equal(parseOptions(['--run']).run, true);
  assert.equal(parseOptions(['--targets', '/private/example-targets.json']).targets, '/private/example-targets.json');
  const probes = [];
  assert.equal(compatiblePython(['system39', 'bundled312'], candidate => {
    probes.push(candidate); return { status: candidate === 'bundled312' ? 0 : 1 };
  }), 'bundled312');
  assert.deepEqual(probes, ['system39', 'bundled312']);
  assert.throws(() => compatiblePython(['system39'], () => ({ status: 1 })), { code: 'CONFIG_PYTHON_UNAVAILABLE' });
  console.log('PASS resume report/identity/prefix/rawhash/marker validation, no-replay writes, failure-deferred cleanup and explicit --run parsing');
  console.log('PASS read-only knowledge HTTP guard, original UUID protection, ancestry, safe evidence and tool/status regressions');
}

const options = process.argv.includes('--self-test') ? undefined : parseOptions(process.argv.slice(2));
const work = !options ? Promise.resolve(selfTest())
  : options.diagnosticReport ? diagnoseSummaries(options) : run(options);
work.catch(error => {
  // Never expose arbitrary upstream messages, child stderr, config or content.
  console.error(`Acceptance stopped: ${safeCode(error)}. Inspect the private report; pending writes must be reconciled before retrying.`);
  process.exitCode = 1;
});
