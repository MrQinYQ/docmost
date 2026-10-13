import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import api from "@/lib/api-client";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import {
  titleEditorAtom,
  pageEditorAtom,
  yjsConnectionStatusAtom,
  yjsSyncedAtom,
} from "@/features/editor/atoms/editor-atoms";
import { extractPageSlugId } from "@/lib/utils";
import { createDocmostTools } from "./tools";
import { getModelContext, registerDocmostTools } from "./registration";
import { syncToolMutation } from "./cache";
import { reconcileToolPage } from "./tree";
import { assertEditorReady, assertStoredPageMatches } from "./editor-state";

export function WebMcpProvider({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const setTree = useSetAtom(treeDataAtom);
  const store = useStore();
  const currentUser = useAtomValue(currentUserAtom);
  const authenticated =
    currentUser?.user?.id === userId &&
    currentUser?.workspace?.id === workspaceId;
  const identity = `${userId}:${workspaceId}`;
  const activeIdentity = useRef<string | null>(identity);
  useLayoutEffect(() => {
    activeIdentity.current = authenticated ? identity : null;
    return () => {
      activeIdentity.current = null;
    };
  }, [identity, authenticated]);

  useEffect(() => {
    if (!userId || !workspaceId || !authenticated) return;
    const context = getModelContext(
      document as Document & { modelContext?: unknown },
      navigator as Navigator & { modelContext?: unknown },
    );
    if (!context) return;
    const controller = new AbortController();
    function isCurrent() {
      const session = store.get(currentUserAtom);
      return (
        !controller.signal.aborted &&
        activeIdentity.current === identity &&
        session?.user?.id === userId &&
        session?.workspace?.id === workspaceId
      );
    }
    const tools = createDocmostTools({
      signal: controller.signal,
      isCurrent,
      async beforeMutation(name, input) {
        const routePage = window.location.pathname
          .split("/p/")[1]
          ?.split("/")[0];
        const slugId = extractPageSlugId(routePage);
        const currentPage = queryClient.getQueryData<{
          id: string;
          slugId: string;
          title: string;
        }>(["pages", slugId]);
        const titleEditor = store.get(titleEditorAtom);
        const editor = store.get(pageEditorAtom);
        const provider = editor?.extensionManager.extensions.find(
          (extension) => extension.name === "collaboration",
        )?.options.provider as HocuspocusProvider | undefined;
        assertEditorReady(name, input, {
          pageId: currentPage?.id,
          slugId: currentPage?.slugId,
          cachedTitle: currentPage ? (currentPage.title ?? "") : undefined,
          titleText:
            slugId && titleEditor && !titleEditor.isDestroyed
              ? titleEditor.getText()
              : undefined,
          hasBodyEditor: Boolean(editor),
          connected: store.get(yjsConnectionStatusAtom) === "connected",
          synced: store.get(yjsSyncedAtom),
          hasUnsyncedChanges: editor
            ? !provider || provider.hasUnsyncedChanges
            : false,
        });
        const activePage =
          input.pageId === currentPage?.id ||
          input.pageId === currentPage?.slugId;
        if (
          editor &&
          activePage &&
          ["duplicate_page", "copy_page_to_space"].includes(name)
        ) {
          if (!isCurrent())
            throw new Error("This Docmost session is no longer active.");
          const response = await api.post(
            "/pages/info",
            { pageId: currentPage.id, format: "json" },
            { signal: controller.signal },
          );
          if (!isCurrent())
            throw new Error("This Docmost session is no longer active.");
          // The 10-second persistence debounce can lag behind a successful ACK.
          assertStoredPageMatches(editor, response.data?.content);
          if (provider?.hasUnsyncedChanges)
            throw new Error(
              "Wait for the active page's collaborative editor to sync before copying it.",
            );
        }
      },
      async post(path, body, signal) {
        const response = await api.post(path, body, { signal });
        return response.data;
      },
      async onMutation(kind, data) {
        if (!isCurrent()) return;
        if (kind === "page" && typeof data.id === "string") {
          setTree((tree) => reconcileToolPage(tree, data));
        }
        if (kind === "pageMove" && typeof data.pageId === "string") {
          const response = await api.post(
            "/pages/info",
            { pageId: data.pageId },
            { signal: controller.signal },
          );
          if (!isCurrent()) return;
          setTree((tree) => reconcileToolPage(tree, response.data));
        }
        await syncToolMutation(queryClient, kind, data);
      },
    });
    const registration = registerDocmostTools(context, tools);
    function revoke() {
      if (controller.signal.aborted) return;
      controller.abort();
      registration.dispose();
    }
    // Logout clears this atom before its HTTP request completes. Revoke now,
    // without waiting for the current-user query or React's passive cleanup.
    const unsubscribe = store.sub(currentUserAtom, () => {
      if (!isCurrent()) revoke();
    });
    void registration.ready.catch(() => {
      if (!controller.signal.aborted)
        console.warn("Docmost WebMCP tool registration failed.");
    });
    return () => {
      unsubscribe();
      revoke();
    };
  }, [
    identity,
    userId,
    workspaceId,
    authenticated,
    queryClient,
    setTree,
    store,
  ]);

  return null;
}
