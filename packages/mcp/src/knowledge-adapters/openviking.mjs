import { ApiError } from '../errors.mjs';
import { createOpenVikingClient, OPENVIKING_ERROR_CODES } from '../openviking-client.mjs';
import { validOpenVikingIdentifier, validOpenVikingUri, openVikingUriMatchesUser } from '../openviking-config.mjs';
import { createMirror, mirrorStatus, validateMirror } from './openviking/mirror.mjs';
import { createMirrorTree } from './openviking/mirror-tree.mjs';
import { resolveMirrorLayout } from './openviking/mirror-layout.mjs';

const connectionError = code => new ApiError(code,
  'The OpenViking connection could not be confirmed. Check its configuration and selected namespace.');

/** A probe may authenticate and read identity, but cannot publish or index. */
async function checkConnection(connection, { signal, fetchImpl, client } = {}) {
  try {
    if (signal?.aborted) throw connectionError('OV_CANCELLED');
    if (!connection || connection.error) throw connectionError('OV_CONFIG_ERROR');
    const identity = await (client ?? createOpenVikingClient(connection, { fetchImpl })).identity(signal);
    if (signal?.aborted) throw connectionError('OV_CANCELLED');
    const rootUri = connection.rootUri ?? identity?.rootUri ?? `viking://user/${identity?.userId}/resources/docmost-mcp`;
    if (!validOpenVikingIdentifier(identity?.accountId) || !validOpenVikingIdentifier(identity?.userId)
      || !validOpenVikingUri(rootUri) || !openVikingUriMatchesUser(rootUri, identity.userId))
      throw connectionError('OV_INVALID_RESPONSE');
    if ((connection.accountId && connection.accountId !== identity.accountId)
      || (connection.userId && connection.userId !== identity.userId)) throw connectionError('OV_IDENTITY_CHANGED');
    return { origin: connection.origin, accountId: identity.accountId, userId: identity.userId, rootUri };
  } catch (error) {
    // Do not forward error messages or upstream metadata from injected clients.
    const code = signal?.aborted ? 'OV_CANCELLED'
      : OPENVIKING_ERROR_CODES.has(error?.code) ? error.code : 'OV_REQUEST_FAILED';
    throw connectionError(code);
  }
}

function createRuntime(connection, context) {
  const { config, post, store, persist, deletionReady } = context;
  const signal = context.signal ?? new AbortController().signal;
  const client = context.client ?? createOpenVikingClient(connection);
  const mirror = createMirror({ ...config, openViking: connection }, { client, post, store, persist, signal, deletionReady });
  const tree = createMirrorTree({ config: { ...connection, readOnly: config.readOnly }, client, store, persist, signal });
  return {
    mirror,
    tree,
    async resolveLayout(binding, allowDeleted = false) {
      validateMirror(binding.mirror);
      const rootUri = binding.mirror?.target?.rootUri ?? connection?.rootUri ?? 'viking://user/local/resources/docmost-mcp';
      const target = binding.mirror?.target;
      const owners = [...(store.load ? await store.load() : []), ...(store.loadMirrorHistory ? await store.loadMirrorHistory() : [])];
      const claims = [binding, ...owners.map(item => item.value)].filter(owner => target
        && ['origin', 'accountId', 'userId', 'rootUri'].every(key => target[key] === owner.mirror?.target?.[key]))
        .flatMap(owner => { validateMirror(owner.mirror); return owner.mirror.nodes ?? []; });
      return resolveMirrorLayout({ rootUri, origin: binding.origin, workspaceId: binding.workspaceId, pageId: binding.pageId, allowDeleted, claims }, post);
    },
    block(binding, reason) {
      const state = mirror.initial(binding);
      state.state = 'blocked';
      state.errorCode = reason === 'configuration' ? 'OV_CONFIG_ERROR' : 'OV_DOCMOST_CHANGED';
      delete state.retryAt;
      return mirrorStatus(binding);
    },
  };
}

export const openVikingAdapter = Object.freeze({
  id: 'openviking', validateState: validateMirror, stateStatus: mirrorStatus, createRuntime, checkConnection,
});
