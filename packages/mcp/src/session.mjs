import { constants, linkSync, unlinkSync } from 'node:fs';
import { open, lstat, mkdir, unlink, readdir } from 'node:fs/promises';
import { dirname, basename, join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AuthError, ConfigError } from './errors.mjs';
import { createApiClient } from './api.mjs';

const MAX_BYTES = 64 * 1024;
const RECORD_KEYS = ['version', 'origin', 'token', 'userId', 'workspaceId', 'sessionId', 'expiresAt'];
const invalid = () => new AuthError('SESSION_INVALID', 'The session record is invalid. Remove it deliberately and log in again.');
const unsafe = () => new AuthError('SESSION_FILE_UNSAFE', 'Session storage must use an owner-owned private directory (0700) and regular file (0600), without symlinks.');
const expired = () => new AuthError('SESSION_EXPIRED', 'The Docmost session expired. Run --login again.');

// Decoding only checks the credential structure. Authentication and signature
// verification are performed by Docmost through users/me and sessions.
export function decodeSessionToken(token, { allowExpired = false } = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_BYTES) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  }
  catch { throw invalid(); }
  if (payload?.type === 'access' && !payload.sessionId)
    throw new AuthError('SESSION_NOT_REVOCABLE', 'This deployment did not issue a revocable sessionId. Update its community session support; repeated login or copying a browser cookie cannot fix this.');
  if (!header || typeof header !== 'object' || Array.isArray(header) || typeof header.alg !== 'string' || !header.alg
    || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 'access'
    || ![payload.sub, payload.workspaceId, payload.sessionId].every(value => z.uuid().safeParse(value).success)
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= 0
    || !Number.isSafeInteger(payload.exp * 1000)) throw invalid();
  const expiresAt = payload.exp * 1000;
  if (!allowExpired && expiresAt <= Date.now()) throw expired();
  return { userId: payload.sub, workspaceId: payload.workspaceId, sessionId: payload.sessionId, expiresAt };
}

function validateRecord(record, origin, { allowExpired = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== RECORD_KEYS.length || !RECORD_KEYS.every(key => Object.hasOwn(record, key))
    || record.version !== 1 || typeof record.origin !== 'string') throw invalid();
  if (record.origin !== origin) throw new AuthError('SESSION_ORIGIN_MISMATCH', 'The session belongs to another Docmost origin.');
  const claims = decodeSessionToken(record.token, { allowExpired: true });
  if (record.userId !== claims.userId || record.workspaceId !== claims.workspaceId || record.sessionId !== claims.sessionId
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0 || record.expiresAt > claims.expiresAt) throw invalid();
  if (!allowExpired && record.expiresAt <= Date.now()) throw expired();
  return Object.fromEntries(RECORD_KEYS.map(key => [key, record[key]]));
}

function checkPrivate(stat, mode, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || (process.platform !== 'win32' && ((stat.mode & 0o777) !== mode || stat.uid !== process.getuid()))) throw unsafe();
}

async function privateParent(file, create = false) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw unsafe();
  const parent = dirname(file);
  try {
    if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
    checkPrivate(await lstat(parent), 0o700, true);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error.code === 'ENOENT' && !create) throw new AuthError('SESSION_NOT_FOUND', 'No saved Docmost session. Run --login first.');
    throw unsafe();
  }
}

async function loadRecordFile(file, origin, { allowExpired = false } = {}) {
  await privateParent(file);
  let handle;
  try {
    const before = await lstat(file);
    checkPrivate(before, 0o600);
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await handle.stat();
    checkPrivate(current, 0o600);
    if (before.dev !== current.dev || before.ino !== current.ino) throw unsafe();
    if (current.size > MAX_BYTES) throw invalid();
    // A bounded read also protects against a file growing after fstat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw invalid();
    let record;
    try { record = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { throw invalid(); }
    return validateRecord(record, origin, { allowExpired });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error.code === 'ENOENT') throw new AuthError('SESSION_NOT_FOUND', 'No saved Docmost session. Run --login first.');
    throw unsafe();
  } finally { await handle?.close(); }
}

const generationKey = record => createHash('sha256').update(record.token).digest('hex');
const sessionDirectory = file => `${file}.sessions`;

async function journalEntries(file) {
  const dir = sessionDirectory(file);
  try { checkPrivate(await lstat(dir), 0o700, true); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = await readdir(dir);
  if (names.length > 5000 || names.some(name => !name.startsWith('.')
    && !/^[0-9a-f]{64}\.(json|revoked)$/.test(name))) throw unsafe();
  for (const name of names.filter(name => !name.startsWith('.'))) checkPrivate(await lstat(join(dir, name)), 0o600);
  return names;
}

export async function loadSession(file, origin, { allowExpired = false } = {}) {
  await privateParent(file);
  let canonical;
  try { canonical = await loadRecordFile(file, origin, { allowExpired: true }); }
  catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
  const names = await journalEntries(file), candidates = new Map();
  if (canonical && !names.includes(`${generationKey(canonical)}.revoked`)) candidates.set(generationKey(canonical), canonical);
  for (const name of names.filter(name => name.endsWith('.json') && !names.includes(name.slice(0, -5) + '.revoked'))) {
    let record;
    try { record = await loadRecordFile(join(sessionDirectory(file), name), origin, { allowExpired: true }); }
    catch (error) { if (error.code === 'SESSION_NOT_FOUND') continue; throw error; }
    if (name !== `${generationKey(record)}.json`) throw unsafe();
    candidates.set(generationKey(record), record);
  }
  const live = [...candidates.values()].filter(record => record.expiresAt > Date.now());
  if (live.length > 1) throw new AuthError('SESSION_CHANGED', 'Concurrent logins saved different sessions. Preserve the files and choose the session to keep before reconnecting.');
  const selected = live[0] ?? [...candidates.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (!selected) throw new AuthError('SESSION_NOT_FOUND', 'No saved Docmost session. Run --login first.');
  return validateRecord(selected, origin, { allowExpired });
}

async function publishGeneration(file, record) {
  const dir = sessionDirectory(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  checkPrivate(await lstat(dir), 0o700, true);
  const target = join(dir, `${generationKey(record)}.json`), temp = join(dir, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = undefined;
    try { linkSync(temp, target); unlinkSync(temp); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await loadRecordFile(target, record.origin, { allowExpired: true }); }
  } finally { await handle?.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function saveSession(file, record) {
  const validated = validateRecord(record, record?.origin);
  const contents = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES) throw invalid();
  await privateParent(file, true);
  try {
    let previous;
    try { previous = await loadSession(file, validated.origin, { allowExpired: true }); }
    catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
    if (previous && previous.expiresAt > Date.now()) throw new AuthError('SESSION_EXISTS', 'A live session is already saved. Run --logout before logging in again.');
    if (previous) await removeSession(file, validated.origin, { expectedSessionId: previous.sessionId });
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      validateRecord(validated, validated.origin);
      // Publish the complete file without replacing an existing session. No
      // lock file or owner survives this call. Keep link/unlink in one turn.
      try { linkSync(temporary, file); unlinkSync(temporary); }
      catch (error) {
        if (error.code === 'EEXIST') throw new AuthError('SESSION_EXISTS', 'A session was saved concurrently. Its credential was preserved.');
        throw error;
      }
      await publishGeneration(file, validated);
    } finally {
      await handle?.close();
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('SESSION_SAVE_FAILED', 'Cannot update private session storage. Check the path, owner and permissions.');
  }
}

export async function removeSession(file, origin, { expectedSessionId } = {}) {
  await privateParent(file);
  try {
    const current = await loadSession(file, origin, { allowExpired: true });
    if (expectedSessionId !== undefined && current.sessionId !== expectedSessionId)
      throw new AuthError('SESSION_CHANGED', 'A newer session replaced the outgoing session. Its credential was preserved; repeat logout only if you intend to end that newer session.');
    // Revocation is tied to this credential generation, never to what happens
    // to occupy the compatibility pathname later. Saved generations remain
    // authoritative if a delayed unlink removes a newer compatibility copy.
    const dir = sessionDirectory(file);
    await mkdir(dir, { recursive: true, mode: 0o700 }); checkPrivate(await lstat(dir), 0o700, true);
    const marker = join(dir, `${generationKey(current)}.revoked`);
    let revoked;
    try { revoked = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); await revoked.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; checkPrivate(await lstat(marker), 0o600); }
    finally { await revoked?.close(); }
    await unlink(join(dir, `${generationKey(current)}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    let canonical;
    try { canonical = await loadRecordFile(file, origin, { allowExpired: true }); }
    catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
    if (canonical?.sessionId === current.sessionId) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('SESSION_REMOVE_FAILED', 'Cannot remove private session storage. Check the path, owner and permissions.');
  }
}

function checkTransport(config) {
  let base;
  try { base = new URL(config.origin); }
  catch { throw new ConfigError('A valid Docmost deployment origin is required.'); }
  if (base.origin !== config.origin || base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || config.apiBase !== `${base.origin}/api/`
    || (base.protocol !== 'https:' && !(base.protocol === 'http:' && config.allowLocalHttp === true && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 120000)
    throw new ConfigError('Use a pinned HTTPS Docmost origin; explicit loopback HTTP is allowed for local testing.');
}

function unsupported(data) {
  if (!data || typeof data !== 'object') return false;
  return ['userHasMfa', 'requiresMfaSetup', 'isMfaEnforced', 'mfaRequired', 'requiresMfa', 'enforceSso', 'enforceSSO', 'ssoRequired'].some(key => data[key] === true);
}

function stopUnsupported() {
  throw new AuthError('LOGIN_UNSUPPORTED', 'This deployment requires SSO or MFA. This password-login adapter cannot complete that flow.');
}

async function loginBody(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new AuthError('LOGIN_RESPONSE_TOO_LARGE', 'Docmost login response exceeds 64 KiB.');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new AuthError('LOGIN_RESPONSE_TOO_LARGE', 'Docmost login response exceeds 64 KiB.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new AuthError('LOGIN_INVALID_RESPONSE', 'Docmost returned an invalid login response.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.success !== true)
    throw new AuthError('LOGIN_INVALID_RESPONSE', 'Docmost returned an invalid login response.');
  return envelope.data;
}

function sessionCookie(headers) {
  if (typeof headers.getSetCookie !== 'function') throw new AuthError('LOGIN_INVALID_RESPONSE', 'Separate Set-Cookie headers are required for Docmost login.');
  const cookies = headers.getSetCookie();
  if (!Array.isArray(cookies) || cookies.some(cookie => typeof cookie !== 'string')
    || cookies.reduce((size, cookie) => size + Buffer.byteLength(cookie), 0) > MAX_BYTES) throw invalid();
  // Set-Cookie must never be split on commas: Expires contains a comma.
  const matches = cookies.map(cookie => cookie.split(';').map(part => part.trim())).filter(parts => parts[0].startsWith('authToken='));
  if (matches.length !== 1) throw new AuthError('LOGIN_INVALID_RESPONSE', 'Docmost did not return one revocable authToken cookie.');
  const [cookie, ...attributes] = matches[0];
  const token = cookie.slice('authToken='.length);
  const claims = decodeSessionToken(token);
  let expiresAt = claims.expiresAt;
  const seen = new Set();
  for (const attribute of attributes) {
    const equal = attribute.indexOf('=');
    const name = (equal < 0 ? attribute : attribute.slice(0, equal)).toLowerCase();
    if (!['expires', 'max-age'].includes(name)) continue;
    if (equal < 0 || seen.has(name)) throw invalid();
    seen.add(name);
    const value = attribute.slice(equal + 1).trim();
    let bound;
    if (name === 'expires') bound = Date.parse(value);
    else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
      bound = Date.now() + Number(value) * 1000;
    }
    if (!Number.isSafeInteger(bound)) throw invalid();
    expiresAt = Math.min(expiresAt, bound);
  }
  if (expiresAt <= Date.now()) throw expired();
  return { token, ...claims, expiresAt };
}

export async function loginSession(config, { email, password }, fetchImpl = globalThis.fetch) {
  checkTransport(config);
  if (typeof email !== 'string' || !email.trim() || Buffer.byteLength(email) > 320
    || typeof password !== 'string' || !password || Buffer.byteLength(password) > MAX_BYTES)
    throw new AuthError('LOGIN_INVALID_CREDENTIALS', 'Enter a valid email and a nonempty password in the local terminal.');
  const body = JSON.stringify({ email, password });
  if (Buffer.byteLength(body) > MAX_BYTES) throw new AuthError('LOGIN_INVALID_CREDENTIALS', 'Login credentials exceed the local request limit.');
  const timeout = AbortSignal.timeout(config.timeoutMs);
  let candidate;
  let identityVerified = false;
  try {
    const response = await fetchImpl(new URL('auth/login', config.apiBase), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body, redirect: 'error', credentials: 'omit', signal: timeout,
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new AuthError('LOGIN_FAILED', 'Docmost rejected password login. Check credentials and whether this deployment requires SSO or MFA. No retry was made.');
    }
    const data = await loginBody(response, timeout);
    if (unsupported(data)) stopUnsupported();
    candidate = { version: 1, origin: config.origin, ...sessionCookie(response.headers) };
    const api = createApiClient({ ...config, authMode: 'session', token: candidate.token }, fetchImpl);
    const me = await api.post('users/me', {}, timeout);
    if (unsupported(me?.workspace)) stopUnsupported();
    if (me?.user?.id !== candidate.userId || me?.user?.workspaceId !== candidate.workspaceId || me?.workspace?.id !== candidate.workspaceId)
      throw new AuthError('SESSION_IDENTITY_MISMATCH', 'Docmost did not verify the expected user, workspace and current session.');
    identityVerified = true;
    const result = await api.post('sessions', {}, timeout);
    const current = Array.isArray(result?.sessions) ? result.sessions.filter(session => session?.isCurrentDevice === true) : [];
    if (current.length !== 1 || current[0].id !== candidate.sessionId)
      throw new AuthError('SESSION_IDENTITY_MISMATCH', 'Docmost did not verify the expected user, workspace and current session.');
    return validateRecord(candidate, config.origin);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const failure = error instanceof AuthError ? error
      : timeout.aborted ? new AuthError('TIMEOUT', 'Docmost login timed out. No retry was made.')
        : candidate ? new AuthError('LOGIN_VERIFICATION_FAILED', 'Docmost could not verify the new session.')
          : new AuthError('NETWORK_ERROR', 'Cannot reach Docmost for password login. Check TLS, network and redirects. No retry was made.');
    if (!candidate) throw failure;
    // Revoke only when users/me authenticated the exact candidate identity.
    // A failed or mismatched identity response must not authorize revocation.
    let revoked = false;
    if (identityVerified) {
      try { await logoutSession(config, candidate, fetchImpl); revoked = true; }
      catch { /* Remote cleanup is best effort; report uncertainty below. */ }
    }
    throw new AuthError(failure.code, `${failure.message} Credentials were not saved. ${revoked
      ? 'The dedicated server session was revoked.'
      : 'A server login session may remain; check Sessions in Docmost.'}`);
  }
}

export async function logoutSession(config, record, fetchImpl = globalThis.fetch) {
  checkTransport(config);
  const validated = validateRecord(record, config.origin);
  const api = createApiClient({ ...config, authMode: 'session', token: validated.token }, fetchImpl);
  try { await api.post('auth/logout', {}, undefined, true); }
  catch { throw new AuthError('LOGOUT_FAILED', 'Could not confirm revocation of the dedicated Docmost session.'); }
}
