import { ApiError } from './errors.mjs';
import { openVikingAdapter } from './knowledge-adapters/openviking.mjs';

const adapters = Object.freeze({ openviking: openVikingAdapter });
const failure = (code, message) => ({ code, message });
const unsupported = () => failure('KB_UNSUPPORTED_PROVIDER', 'This knowledge-base provider is not supported. Choose none or openviking.');
const changed = () => failure('KB_TARGET_CHANGED', 'The stored knowledge-base provider differs from the selected provider. Existing tasks were retained.');
const stateProvider = state => state?.provider ?? 'openviking';
const adapterFor = (registry, id) => Object.hasOwn(registry, id) ? registry[id] : undefined;

export function knowledgeSelection(config) {
  if (Object.hasOwn(config, 'knowledgeBase')) return config.knowledgeBase;
  return config.openViking ? { provider: 'openviking', config: config.openViking } : undefined;
}

export function knowledgeConnectionStatus(config, registry = adapters) {
  const selection = knowledgeSelection(config);
  if (!selection) return { provider: 'none', enabled: false, state: 'disabled' };
  const error = selection.error ?? selection.config?.error ?? (!adapterFor(registry, selection.provider) ? unsupported() : undefined);
  return { provider: selection.provider, enabled: true, state: error ? 'blocked' : 'configured', ...(error ? { error } : {}) };
}

export function validateKnowledgeState(state, registry = adapters) {
  if (state === undefined) return;
  const adapter = adapterFor(registry, stateProvider(state));
  if (!adapter) throw new ApiError('KB_INVALID_STATE', 'The stored knowledge-base provider is not supported; its tasks were retained.');
  adapter.validateState(state);
}

export function legacyKnowledgeStatus(binding, registry = adapters) {
  return binding.mirror && stateProvider(binding.mirror) === 'openviking'
    ? adapterFor(registry, 'openviking')?.stateStatus(binding) : undefined;
}

export function knowledgeStatus(binding, config, registry = adapters) {
  const connection = knowledgeConnectionStatus(config, registry), state = binding.mirror;
  if (connection.state === 'blocked') return connection;
  if (state && connection.enabled && stateProvider(state) !== connection.provider)
    return { provider: connection.provider, enabled: true, state: 'blocked', error: changed() };
  if (!state) return connection.enabled ? { ...connection, state: 'waiting_docmost' } : undefined;
  const provider = stateProvider(state), adapter = adapterFor(registry, provider);
  if (!adapter) return { provider, enabled: false, state: 'blocked', error: failure('KB_INVALID_STATE', 'The stored provider is not supported.') };
  return { provider, enabled: connection.enabled && provider === connection.provider, ...adapter.stateStatus(binding) };
}

/** Provider factories own remote protocol details; this boundary fences provider changes. */
export function createKnowledgeRuntime(config, { adapters: registry = adapters, ...context } = {}) {
  const selection = knowledgeSelection(config);
  if (!selection || selection.error) return undefined;
  const adapter = adapterFor(registry, selection.provider);
  if (!adapter) return undefined;
  const runtime = adapter.createRuntime(selection.config, { ...context, config });
  const accepts = binding => !binding.mirror || stateProvider(binding.mirror) === adapter.id;
  const status = binding => knowledgeStatus(binding, config, registry);
  const mirror = Object.fromEntries(Object.entries(runtime.mirror).map(([name, operation]) => [name, (...args) => {
    if (accepts(args[0])) return operation(...args);
    if (name === 'canProcess') return false;
    if (name === 'initial') return args[0].mirror;
    if (name === 'retry') return status(args[0]);
  }]));
  return { id: adapter.id, accepts, status, mirror,
    tree: { run(binding, work) { return accepts(binding) ? runtime.tree.run(binding, work) : status(binding); },
      close() { return runtime.tree.close(); } },
    resolveLayout(binding, allowDeleted) {
      if (!accepts(binding)) throw new ApiError(changed().code, changed().message);
      return runtime.resolveLayout(binding, allowDeleted);
    },
    block(binding, reason) { if (accepts(binding)) return runtime.block(binding, reason); },
  };
}

/** A standalone, read-only diagnostic. Never exposes arbitrary remote messages. */
export async function checkKnowledgeConnection(selection, { adapters: registry = adapters, ...context } = {}) {
  if (!selection) return { success: true, provider: 'none', state: 'disabled' };
  const provider = selection.provider;
  try {
    const adapter = adapterFor(registry, provider);
    const error = selection.error ?? selection.config?.error ?? (!adapter ? unsupported() : undefined);
    if (error) throw new ApiError(error.code, error.message);
    const info = await adapter.checkConnection(selection.config, context);
    const safe = {};
    for (const key of ['origin', 'accountId', 'userId', 'rootUri'])
      if (typeof info[key] === 'string' && info[key].length <= 8192) safe[key] = info[key];
    return { success: true, provider, state: 'ready', ...safe };
  } catch (error) {
    const code = /^(?:KB|OV)_[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'KB_CONNECTION_FAILED';
    return { success: false, provider, state: 'blocked', error: failure(code,
      'Knowledge-base connection could not be verified. Check the provider, root URL, private credential file and expected identity.') };
  }
}
