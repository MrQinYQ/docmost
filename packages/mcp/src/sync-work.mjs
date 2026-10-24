import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from './errors.mjs';

/** One finite work item owns the ledger, including its remote write hooks. */
export function createSyncWork({ getStore, refresh, signal, readOnly }) {
  const scope = new AsyncLocalStorage();
  let tail = Promise.resolve(), pending = 0;
  const current = () => { const value = scope.getStore(); return value?.active ? value : undefined; };
  async function run(operation) {
    if (current() || readOnly) return operation();
    pending++;
    const result = tail.then(async () => {
      signal.throwIfAborted();
      const store = await getStore(), ticket = await store.acquireOperation(signal);
      const context = { active: true, leases: new Map() };
      return scope.run(context, async () => {
        try { await refresh(); return await operation(); }
        finally {
          context.active = false;
          try {
            let failure;
            for (const { binding, lease } of context.leases.values()) {
              try { await store.release(lease); } catch (error) { failure ??= error; }
              finally { if (binding._lease === lease) binding._lease = undefined; }
            }
            if (failure) throw failure;
          } finally { await store.releaseOperation(ticket); }
        }
      });
    });
    const completed = result.finally(() => { pending--; });
    tail = completed.catch(() => {}); return completed;
  }
  async function acquire(binding) {
    const context = current();
    if (!context) throw new ApiError('INVALID_STATE', 'Page ownership requires an active synchronization operation.');
    const store = await getStore();
    if (!binding._lease) {
      const lease = await store.acquire(binding, signal, { recoverDead: true });
      binding._lease = lease; context.leases.set(lease.pathname, { binding, lease });
    }
    await store.assertLease(binding._lease);
  }
  function read(operation) {
    if (current() || readOnly) return operation();
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  }
  return { run, acquire, read, idle: () => tail, detach: callback => scope.exit(callback), active: () => Boolean(current()), busy: () => pending > 0 };
}
