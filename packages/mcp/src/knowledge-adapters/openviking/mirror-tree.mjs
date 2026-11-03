import { ApiError } from '../../errors.mjs';
import { mirrorStatus, validateMirror } from './mirror.mjs';
import { validOpenVikingIdentifier, validOpenVikingUri, openVikingUriMatchesUser } from '../../openviking-config.mjs';

const safeCode = error => error?.code === 'CONFLICT' ? 'OV_CONFLICT'
  : /^OV_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OV_INVALID_STATE';

/** Validate each job independently. Other pages and server tasks never reserve a root. */
export function createMirrorTree({ config, client, persist, signal }) {
  const cancellation = new AbortController();
  const effective = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const inFlight = new Set();
  let closed = false, closing;
  const stopped = () => closed || effective.aborted || config?.readOnly;
  async function mark(binding, code) {
    if (stopped()) return mirrorStatus(binding);
    const mirror = binding.mirror;
    mirror.errorCode = code;
    const transient = ['OV_NETWORK_ERROR', 'OV_TIMEOUT', 'OV_RATE_LIMITED'].includes(code);
    mirror.state = transient ? 'retrying' : 'blocked';
    if (transient) mirror.retryAt = Date.now() + 1000;
    else delete mirror.retryAt;
    try { await persist(binding); }
    catch (error) { if (error.code !== 'CONFLICT') throw error; }
    return mirrorStatus(binding);
  }
  async function run(binding, work) {
    validateMirror(binding.mirror);
    if (stopped() || !config || !binding.mirror?.pending || binding.mirror.pending.phase === 'await_docmost') return mirrorStatus(binding);
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    inFlight.add(done);
    try {
      effective.throwIfAborted();
      if (config.error || !client) throw new ApiError('OV_CONFIG_ERROR', 'Configure the optional OpenViking HTTP connection first.');
      const identity = await client.identity(effective);
      const rootUri = config.rootUri ?? identity.rootUri;
      if (!validOpenVikingIdentifier(identity.accountId) || !validOpenVikingIdentifier(identity.userId)
        || !validOpenVikingUri(rootUri) || !openVikingUriMatchesUser(rootUri, identity.userId))
        throw new ApiError('OV_INVALID_RESPONSE', 'OpenViking namespace ownership could not be confirmed.');
      if (binding.mirror.target && ['origin', 'accountId', 'userId', 'rootUri'].some(key =>
        binding.mirror.target[key] !== ({ origin: config.origin, ...identity, rootUri })[key]))
        throw new ApiError('OV_TARGET_CHANGED', 'The configured OpenViking destination differs from this page record.');
      effective.throwIfAborted();
      return await work();
    } catch (error) {
      if (!stopped()) return await mark(binding, safeCode(error));
      return mirrorStatus(binding);
    } finally { finished(); inFlight.delete(done); }
  }
  function close() {
    if (closing) return closing;
    closed = true; cancellation.abort();
    return closing = Promise.allSettled([...inFlight]).then(() => {});
  }
  return { run, close };
}
