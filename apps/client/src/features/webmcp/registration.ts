import type {
  ModelContextApi,
  ModelContextRegistration,
  WebMcpTool,
} from "./types";

const pending = new WeakMap<ModelContextApi, Promise<void>>();

export function getModelContext(
  doc: { modelContext?: unknown },
  nav: { modelContext?: unknown },
): ModelContextRegistration | undefined {
  const current = doc.modelContext as ModelContextApi | undefined;
  if (typeof current?.registerTool === "function")
    return { api: current, mode: "signal" };
  const legacy = nav.modelContext as ModelContextApi | undefined;
  if (
    typeof legacy?.registerTool === "function" &&
    typeof legacy?.unregisterTool === "function"
  )
    return { api: legacy, mode: "named" };
  return undefined;
}

/** Keep async teardown ahead of a React remount, without clearing other tools. */
export function registerDocmostTools(
  context: ModelContextRegistration,
  tools: WebMcpTool[],
): { ready: Promise<void>; dispose(): void } {
  const controller = new AbortController();
  const names = new Set<string>();
  let disposed = false;
  function removeNamedTools() {
    for (const name of names) {
      names.delete(name);
      context.api.unregisterTool?.(name);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    if (context.mode === "named") removeNamedTools();
  }
  const previous = pending.get(context.api);
  const ready = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    async () => {
      try {
        for (const tool of tools) {
          if (disposed) return;
          await context.api.registerTool(
            tool,
            context.mode === "signal"
              ? { signal: controller.signal }
              : undefined,
          );
          if (context.mode === "named") {
            names.add(tool.name);
            if (disposed) removeNamedTools();
          }
        }
      } catch (error) {
        const wasDisposed = disposed;
        dispose();
        if (!wasDisposed) throw error;
      }
    },
  );
  pending.set(context.api, ready);
  // Attaching both handlers avoids an unhandled rejection on the cleanup promise.
  void ready.then(
    () => {
      if (pending.get(context.api) === ready) pending.delete(context.api);
    },
    () => {
      if (pending.get(context.api) === ready) pending.delete(context.api);
    },
  );
  return { ready, dispose };
}
