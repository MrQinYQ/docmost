import { ApiError } from '../../errors.mjs';
import { mirrorStatus, validateMirror } from './mirror.mjs';
import { validOpenVikingIdentifier, validOpenVikingUri } from '../../openviking-config.mjs';

const activePhases = new Set(['writing', 'submit_submitting', 'indexing', 'removing', 'prune_submitting', 'pruning', 'prune_removing', 'prune_verify']);
const terminal = task => task && ['completed', 'failed', 'cancelled'].includes(task.status);
const sameTarget = (a, b) => a && b && ['origin', 'accountId', 'userId', 'rootUri'].every(field => a[field] === b[field]);
const safeCode = error => error?.code === 'LEASE_BUSY' ? 'OV_TREE_BUSY'
  : /^OV_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OV_INVALID_STATE';

/** One task per mirror root, including tasks that outlive their MCP process.
 * The filesystem lease only coordinates users of this private state directory;
 * unrelated OpenViking writers still require normal conflict reconciliation.
 */
export function createMirrorTree({ config, client, store, persist, signal }) {
  const cancellation = new AbortController();
  const effective = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let owner, inFlight, closed = false, closing;
  const stopped = () => closed || effective.aborted || config?.readOnly;
  async function mark(binding, code) {
    if (stopped()) return mirrorStatus(binding);
    validateMirror(binding.mirror);
    const mirror = binding.mirror ??= { provider: 'openviking', version: 1, connectionOrigin: config?.origin, state: 'waiting_docmost' };
    mirror.errorCode = code;
    const transient = ['OV_TREE_BUSY', 'OV_NETWORK_ERROR', 'OV_TIMEOUT', 'OV_RATE_LIMITED'].includes(code);
    mirror.state = transient ? 'retrying' : 'blocked';
    if (transient) mirror.retryAt = Date.now() + 1000;
    else delete mirror.retryAt;
    await persist(binding);
    return mirrorStatus(binding);
  }
  async function releaseOwner() {
    if (!owner) return;
    const previous = owner;
    owner = undefined;
    // release() checks the nonce and cannot remove another process's lease.
    await store.release(previous.lease);
  }
  async function holdsServerWork(candidate, observeAcknowledged = false) {
    const mirror = candidate.binding.mirror;
    const job = mirror?.pending;
    if (!sameTarget(mirror?.target, candidate.target) || !activePhases.has(job?.phase)) return false;
    if (job.phase === 'prune_verify') {
      // The filesystem deletion is acknowledged, but detached ancestor
      // summaries may outlive it. Keep the lease during its owner's retry;
      // another binding may proceed only after a read-only queue barrier.
      if (!observeAcknowledged) return true;
      try { await client.waitProcessed(effective); return false; }
      catch { return true; }
    }
    if (!job.taskId) return true;
    try { return !terminal(await client.task(job.taskId, effective)); }
    catch { return true; }
  }
  async function freshBlocker(binding, target) {
    const active = await store.load(), history = await store.loadMirrorHistory();
    let queuesIdle = false;
    for (const { value } of history) validateMirror(value.mirror);
    for (const { value, historical } of [...active, ...history.map(item => ({ ...item, historical: true }))]) {
      // An archived task remains a fence even if its page is bound again.
      if ((!historical && value.bindingId === binding.bindingId) || !sameTarget(value.mirror?.target, target)) continue;
      const job = value.mirror?.pending;
      if (!activePhases.has(job?.phase)) continue;
      if (job.phase === 'prune_verify') {
        try { if (!queuesIdle) { await client.waitProcessed(effective); queuesIdle = true; } }
        catch { return true; }
        continue;
      }
      if (!job.taskId) return true;
      try { if (!terminal(await client.task(job.taskId, effective))) return true; }
      catch { return true; }
    }
    return false;
  }
  async function run(binding, work) {
    validateMirror(binding.mirror);
    // Unconfirmed Docmost bodies and settled pages have no OpenViking work.
    // They must not authenticate, acquire a lease or gain retry state simply
    // because another page is using the optional mirror namespace.
    if (stopped() || !config || !binding.mirror?.pending || binding.mirror.pending.phase === 'await_docmost') return mirrorStatus(binding);
    if (inFlight) return mark(binding, 'OV_TREE_BUSY');
    let finished;
    inFlight = { done: new Promise(resolve => { finished = resolve; }) };
    try {
      effective.throwIfAborted();
      if (config.error) throw new ApiError('OV_CONFIG_ERROR', 'The optional OpenViking connection is not configured correctly.');
      if (!client) throw new ApiError('OV_CONFIG_ERROR', 'Configure the optional OpenViking HTTP client first.');
      const identity = await client.identity(effective);
      const rootUri = config.rootUri ?? identity.rootUri;
      if (!validOpenVikingIdentifier(identity.accountId) || !validOpenVikingIdentifier(identity.userId)
        || !validOpenVikingUri(rootUri) || rootUri.split('/')[3] !== identity.userId)
        throw new ApiError('OV_INVALID_RESPONSE', 'OpenViking namespace ownership could not be confirmed.');
      const target = { origin: config.origin, accountId: identity.accountId, userId: identity.userId, rootUri };
      if (owner && !sameTarget(owner.target, target)) throw new ApiError('OV_TARGET_CHANGED', 'The OpenViking namespace changed while a task was retained.');
      if (owner && owner.bindingId !== binding.bindingId) {
        if (await holdsServerWork(owner, true)) return await mark(binding, 'OV_TREE_BUSY');
        await releaseOwner();
      }
      if (!owner) {
        const lease = await store.acquire({ origin: `openviking:${target.origin}`, workspaceId: target.accountId, pageId: target.rootUri }, effective);
        owner = { bindingId: binding.bindingId, binding, target, lease };
        // The previous process may have released its local lease while an
        // asynchronous server task was still running. Re-read disk metadata,
        // rather than relying on this manager's startup snapshot.
        if (await freshBlocker(binding, target)) {
          await releaseOwner();
          return await mark(binding, 'OV_TREE_BUSY');
        }
      }
      await store.assertLease(owner.lease);
      effective.throwIfAborted();
      if (binding.mirror?.errorCode === 'OV_TREE_BUSY') {
        binding.mirror.state = 'pending'; delete binding.mirror.errorCode; delete binding.mirror.retryAt;
        await persist(binding);
      }
      const result = await work();
      await store.assertLease(owner.lease);
      return result;
    } catch (error) {
      if (!stopped()) return await mark(binding, safeCode(error));
      return mirrorStatus(binding);
    } finally {
      try {
        if (owner && (stopped() || !await holdsServerWork(owner))) await releaseOwner();
      } finally { finished(); inFlight = undefined; }
    }
  }
  function close() {
    if (closing) return closing;
    closed = true; cancellation.abort();
    closing = (async () => { await inFlight?.done; await releaseOwner(); })();
    return closing;
  }
  return { run, close };
}
