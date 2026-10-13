import { describe, expect, it, vi } from "vitest";
import { getModelContext, registerDocmostTools } from "./registration";
import type { WebMcpTool } from "./types";

const tool = (name: string): WebMcpTool => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  execute: async () => ({ content: [] }),
});

describe("WebMCP registration", () => {
  it("does nothing when the browser does not support native WebMCP", () => {
    expect(getModelContext({}, {})).toBeUndefined();
  });

  it("prefers the Document API and supports the earlier Navigator API", () => {
    const documentContext = { registerTool: vi.fn() };
    const navigatorContext = { registerTool: vi.fn(), unregisterTool: vi.fn() };
    expect(
      getModelContext(
        { modelContext: documentContext },
        { modelContext: navigatorContext },
      ),
    ).toMatchObject({ api: documentContext, mode: "signal" });
    expect(
      getModelContext({}, { modelContext: navigatorContext }),
    ).toMatchObject({ api: navigatorContext, mode: "named" });
    expect(
      getModelContext({}, { modelContext: { registerTool: vi.fn() } }),
    ).toBeUndefined();
  });

  it("registers with abort signals and aborts exactly its own registrations", async () => {
    const signals: AbortSignal[] = [];
    const api = {
      registerTool: vi.fn((_tool, options) => {
        signals.push(options.signal);
      }),
    };
    const registration = registerDocmostTools({ api, mode: "signal" }, [
      tool("one"),
      tool("two"),
    ]);
    await registration.ready;
    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    registration.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("cleans up the legacy API without removing unrelated tools", async () => {
    const api = { registerTool: vi.fn(), unregisterTool: vi.fn() };
    const registration = registerDocmostTools({ api, mode: "named" }, [
      tool("one"),
    ]);
    await registration.ready;
    registration.dispose();
    registration.dispose();
    expect(api.unregisterTool).toHaveBeenCalledTimes(1);
    expect(api.unregisterTool).toHaveBeenCalledWith("one");
  });

  it("cleans up a legacy registration that completes after disposal", async () => {
    let finish!: () => void;
    const api = {
      registerTool: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      unregisterTool: vi.fn(),
    };
    const registration = registerDocmostTools({ api, mode: "named" }, [
      tool("one"),
      tool("two"),
    ]);
    await Promise.resolve();
    registration.dispose();
    finish();
    await registration.ready;
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.unregisterTool).toHaveBeenCalledWith("one");
  });

  it("serializes a remount behind old cleanup so duplicate names cannot race", async () => {
    let finish!: () => void;
    const events: string[] = [];
    const api = {
      registerTool: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        )
        .mockImplementation(() => {
          events.push("register-new");
        }),
      unregisterTool: vi.fn(() => {
        events.push("remove-old");
      }),
    };
    const old = registerDocmostTools({ api, mode: "named" }, [tool("one")]);
    await Promise.resolve();
    old.dispose();
    const next = registerDocmostTools({ api, mode: "named" }, [tool("one")]);
    finish();
    await Promise.all([old.ready, next.ready]);
    expect(events).toEqual(["remove-old", "register-new"]);
    next.dispose();
  });

  it("rolls back successful registrations when a later registration fails", async () => {
    const api = {
      registerTool: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("permission denied")),
      unregisterTool: vi.fn(),
    };
    const registration = registerDocmostTools({ api, mode: "named" }, [
      tool("one"),
      tool("two"),
    ]);
    await expect(registration.ready).rejects.toThrow("permission denied");
    expect(api.unregisterTool).toHaveBeenCalledWith("one");
    expect(api.unregisterTool).not.toHaveBeenCalledWith("two");
  });
});
