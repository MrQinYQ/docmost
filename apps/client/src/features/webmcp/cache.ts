import type { QueryClient } from "@tanstack/react-query";
import type { MutationKind } from "./types";

export async function syncToolMutation(
  client: QueryClient,
  kind: MutationKind,
  result: Record<string, unknown>,
): Promise<void> {
  if (kind === "comment") {
    await client.invalidateQueries({
      queryKey: result.pageId ? ["comments", result.pageId] : ["comments"],
    });
    return;
  }
  if (kind === "space") {
    for (const alias of [result.id, result.slug]) {
      if (typeof alias === "string")
        client.setQueryData(
          ["space", alias],
          (old: Record<string, unknown> | undefined) =>
            old ? { ...old, ...result } : old,
        );
    }
    await Promise.all(
      ["spaces", "space"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
    return;
  }
  if (kind === "page") {
    // A formatted tool response may be Markdown, while UI caches expect JSON.
    const { content: _content, ...metadata } = result;
    for (const alias of [result.id, result.slugId]) {
      if (typeof alias === "string")
        client.setQueryData(
          ["pages", alias],
          (old: Record<string, unknown> | undefined) =>
            old ? { ...old, ...metadata } : old,
        );
    }
  }
  await Promise.all(
    [
      "pages",
      "sidebar-pages",
      "root-sidebar-pages",
      "recent-changes",
      "pages-created-by-user",
      "breadcrumbs",
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  );
}
