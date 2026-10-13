import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { syncToolMutation } from "./cache";

describe("WebMCP UI cache synchronization", () => {
  it("updates both page aliases and invalidates sidebar/recent caches", async () => {
    const client = new QueryClient();
    client.setQueryData(["pages", "page"], {
      id: "page",
      title: "Old",
      content: "cached",
    });
    client.setQueryData(["pages", "slug"], {
      id: "page",
      title: "Old",
      content: "cached",
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await syncToolMutation(client, "page", {
      id: "page",
      slugId: "slug",
      title: "New",
      content: "# Markdown",
      spaceId: "space",
    });
    expect(client.getQueryData(["pages", "page"])).toMatchObject({
      title: "New",
      content: "cached",
    });
    expect(client.getQueryData(["pages", "slug"])).toMatchObject({
      title: "New",
      content: "cached",
    });
    expect(
      invalidate.mock.calls.map(([options]) => options?.queryKey?.[0]),
    ).toEqual(
      expect.arrayContaining([
        "pages",
        "sidebar-pages",
        "root-sidebar-pages",
        "recent-changes",
      ]),
    );
  });

  it("updates space ID and slug aliases without losing existing permission data", async () => {
    const client = new QueryClient();
    client.setQueryData(["space", "space"], {
      id: "space",
      slug: "docs",
      name: "Old",
      userRole: "admin",
    });
    client.setQueryData(["space", "docs"], {
      id: "space",
      slug: "docs",
      name: "Old",
      userRole: "admin",
    });
    await syncToolMutation(client, "space", {
      id: "space",
      slug: "docs",
      name: "New",
    });
    expect(client.getQueryData(["space", "space"])).toMatchObject({
      name: "New",
      userRole: "admin",
    });
    expect(client.getQueryData(["space", "docs"])).toMatchObject({
      name: "New",
      userRole: "admin",
    });
  });

  it("invalidates only the affected page's comment list", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await syncToolMutation(client, "comment", {
      pageId: "page",
      id: "comment",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["comments", "page"] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
