import { AsyncLocalStorage } from 'node:async_hooks';

/** Schedule this connection's callbacks; never coordinate or wait on other processes. */
export function createSyncWork({ refresh, signal, readOnly }) {
  const scope = new AsyncLocalStorage();
  let tail = Promise.resolve(), pending = 0;
  const current = () => { const value = scope.getStore(); return value?.active ? value : undefined; };
  async function run(operation) {
    if (current() || readOnly) return operation();
    pending++;
    const result = tail.then(async () => {
      signal.throwIfAborted();
      const context = { active: true };
      return scope.run(context, async () => {
        try { await refresh(); return await operation(); }
        finally { context.active = false; }
      });
    });
    const completed = result.finally(() => { pending--; });
    tail = completed.catch(() => {}); return completed;
  }
  function read(operation) {
    if (current() || readOnly) return operation();
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  }
  return { run, read, idle: () => tail, detach: callback => scope.exit(callback), active: () => Boolean(current()), busy: () => pending > 0 };
}
