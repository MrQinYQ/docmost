import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { PrimitiveAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { ICurrentUser } from "@/features/user/types/user.types";
import { RESET } from "jotai/utils";
import type { ToolDependencies } from "./types";
import type { Editor } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
  yjsSyncedAtom,
} from "@/features/editor/atoms/editor-atoms";
import api from "@/lib/api-client";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  createTools: vi.fn((_deps: ToolDependencies) => []),
  context: { api: {}, mode: "named" },
}));
vi.mock("./registration", () => ({
  getModelContext: () => mocks.context,
  registerDocmostTools: mocks.register,
}));
vi.mock("./tools", () => ({ createDocmostTools: mocks.createTools }));
vi.mock("@/lib/api-client", () => ({ default: { post: vi.fn() } }));
import { WebMcpProvider } from "./webmcp-provider";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(api.post).mockReset();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("authenticated WebMCP lifecycle", () => {
  it("checks outgoing changes and stored content before copying the active editor", async () => {
    mocks.register.mockReturnValue({
      ready: Promise.resolve(),
      dispose: vi.fn(),
    });
    const client = new QueryClient();
    const store = createStore();
    store.set(currentUserAtom, {
      user: { id: "user" },
      workspace: { id: "workspace" },
    } as ICurrentUser);
    window.history.replaceState(null, "", "/s/docs/p/page-slug");
    client.setQueryData(["pages", "slug"], {
      id: "page",
      slugId: "slug",
      title: "Saved",
    });
    const schema = getSchema([StarterKit]);
    const content = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "New body" }] },
      ],
    };
    const collab = { hasUnsyncedChanges: true };
    store.set(
      pageEditorAtom as PrimitiveAtom<Editor | null>,
      {
        schema,
        state: { doc: schema.nodeFromJSON(content) },
        extensionManager: {
          extensions: [
            { name: "collaboration", options: { provider: collab } },
          ],
        },
      } as unknown as Editor,
    );
    store.set(yjsSyncedAtom, true);
    store.set(yjsConnectionStatusAtom, "connected");
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="workspace" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    await act(async () => {});
    const deps = mocks.createTools.mock.calls[0][0];
    await expect(
      deps.beforeMutation("duplicate_page", { pageId: "page" }),
    ).rejects.toThrow(/sync/i);
    expect(api.post).not.toHaveBeenCalled();
    collab.hasUnsyncedChanges = false;
    vi.mocked(api.post).mockResolvedValueOnce({
      data: { content: { type: "doc", content: [{ type: "paragraph" }] } },
    } as Awaited<ReturnType<typeof api.post>>);
    await expect(
      deps.beforeMutation("duplicate_page", { pageId: "page" }),
    ).rejects.toThrow(/saved/i);
    vi.mocked(api.post).mockResolvedValueOnce({ data: { content } } as Awaited<
      ReturnType<typeof api.post>
    >);
    await expect(
      deps.beforeMutation("duplicate_page", { pageId: "page" }),
    ).resolves.toBeUndefined();
    expect(api.post).toHaveBeenLastCalledWith(
      "/pages/info",
      { pageId: "page", format: "json" },
      { signal: deps.signal },
    );
  });
  it("revokes tools immediately when logout resets identity, even while query props remain populated", async () => {
    const dispose = vi.fn();
    mocks.register.mockReturnValue({ ready: Promise.resolve(), dispose });
    const client = new QueryClient();
    const store = createStore();
    store.set(currentUserAtom, {
      user: { id: "user" },
      workspace: { id: "workspace" },
    } as ICurrentUser);
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="workspace" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    await act(async () => {});
    const deps = mocks.createTools.mock.calls[0][0];
    expect(deps.isCurrent()).toBe(true);
    act(() => {
      store.set(currentUserAtom, RESET);
      expect(deps.isCurrent()).toBe(false);
      expect(deps.signal.aborted).toBe(true);
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it("aborts old calls and disposes registrations when the workspace changes", async () => {
    const dispose = vi.fn();
    mocks.register.mockReturnValue({ ready: Promise.resolve(), dispose });
    const client = new QueryClient();
    const store = createStore();
    store.set(currentUserAtom, {
      user: { id: "user" },
      workspace: { id: "first" },
    } as ICurrentUser);
    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="first" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    await act(async () => {});
    const oldDeps = mocks.createTools.mock.calls[0][0];
    expect(oldDeps.isCurrent()).toBe(true);
    act(() =>
      store.set(currentUserAtom, {
        user: { id: "user" },
        workspace: { id: "second" },
      } as ICurrentUser),
    );
    view.rerender(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="second" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    await act(async () => {});
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(oldDeps.signal.aborted).toBe(true);
    expect(oldDeps.isCurrent()).toBe(false);
    expect(mocks.createTools).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("does not register without a complete authenticated identity", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <WebMcpProvider userId="" workspaceId="" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("does not reregister for unrelated rerenders", async () => {
    mocks.register.mockReturnValue({
      ready: Promise.resolve(),
      dispose: vi.fn(),
    });
    const client = new QueryClient();
    const store = createStore();
    store.set(currentUserAtom, {
      user: { id: "user" },
      workspace: { id: "workspace" },
    } as ICurrentUser);
    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="workspace" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    view.rerender(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <WebMcpProvider userId="user" workspaceId="workspace" />
        </QueryClientProvider>
      </JotaiProvider>,
    );
    await act(async () => {});
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});
