import { describe, expect, it, vi } from "vitest";
import { createDocmostTools } from "./tools";

const spaceId = "11111111-1111-4111-8111-111111111111";
const commentId = "22222222-2222-4222-8222-222222222222";
const page = {
  id: "page-id",
  slugId: "slug",
  spaceId,
  title: "Page",
  content: { type: "doc", content: [] },
  space: { slug: "docs" },
};
const comment = { id: commentId, pageId: page.id, content: "{}" };

function setup() {
  const post = vi.fn(
    async (
      path: string,
      _body: unknown,
      _signal: AbortSignal,
    ): Promise<unknown> => {
      if (path === "/users/me")
        return {
          user: {
            id: "user",
            name: "Alice",
            password: "secret",
            settings: { secret: true },
          },
          workspace: { id: "workspace", name: "Docs", licenseKey: "secret" },
        };
      if (path.startsWith("/comments/")) return comment;
      if (
        path === "/spaces/info" ||
        path.endsWith("spaces/create") ||
        path.endsWith("spaces/update")
      )
        return { id: spaceId, slug: "docs", name: "Docs" };
      if (
        [
          "/pages/info",
          "/pages/create",
          "/pages/update",
          "/pages/duplicate",
        ].includes(path)
      )
        return page;
      return { items: [page], meta: { nextCursor: "next", hasNextPage: true } };
    },
  );
  const isCurrent = vi.fn(() => true);
  const onMutation = vi.fn();
  const controller = new AbortController();
  const tools = createDocmostTools({
    post,
    isCurrent,
    onMutation,
    signal: controller.signal,
  });
  const call = (name: string, input: unknown = {}) =>
    tools.find((tool) => tool.name === name)!.execute(input);
  return { tools, post, isCurrent, onMutation, controller, call };
}

function resultData(result: unknown) {
  return JSON.parse(
    (result as { content: { text: string }[] }).content[0].text,
  );
}

describe("Docmost WebMCP tools", () => {
  it("retains the actual effective space membership returned by the backend", async () => {
    const { post, call } = setup();
    post.mockResolvedValueOnce({
      id: spaceId,
      name: "Docs",
      slug: "docs",
      membership: {
        userId: "reader",
        role: "reader",
        internalToken: "not-for-tools",
      },
    });
    const data = resultData(await call("get_space", { spaceId }));
    expect(data.membership).toEqual({ userId: "reader", role: "reader" });
    expect(JSON.stringify(data)).not.toContain("not-for-tools");
  });
  it("advertises defaults as optional inputs rather than required outputs", () => {
    const { tools } = setup();
    expect(
      tools.find((tool) => tool.name === "list_spaces")!.inputSchema.required ??
        [],
    ).not.toContain("limit");
    expect(
      tools.find((tool) => tool.name === "get_page")!.inputSchema.required,
    ).toEqual(["pageId"]);
  });
  it("exposes all 20 official names with discoverable schemas and read hints", () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "search_pages",
        "get_page",
        "create_page",
        "update_page",
        "list_pages",
        "list_child_pages",
        "duplicate_page",
        "copy_page_to_space",
        "move_page",
        "move_page_to_space",
        "get_space",
        "list_spaces",
        "create_space",
        "update_space",
        "get_comments",
        "create_comment",
        "update_comment",
        "search_attachments",
        "list_workspace_members",
        "get_current_user",
      ].sort(),
    );
    expect(tools.filter((tool) => tool.annotations.readOnlyHint)).toHaveLength(
      10,
    );
    for (const tool of tools)
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
  });

  it.each([
    ["search_pages", { query: "guide", spaceId }, "/search"],
    ["get_page", { pageId: page.id }, "/pages/info"],
    ["create_page", { spaceId, title: "New" }, "/pages/create"],
    ["update_page", { pageId: page.id, title: "Renamed" }, "/pages/update"],
    ["list_pages", { spaceId }, "/pages/recent"],
    ["list_child_pages", { pageId: page.id }, "/pages/sidebar-pages"],
    ["duplicate_page", { pageId: page.id }, "/pages/duplicate"],
    ["copy_page_to_space", { pageId: page.id, spaceId }, "/pages/duplicate"],
    [
      "move_page",
      { pageId: page.id, position: "a00000", parentPageId: null },
      "/pages/move",
    ],
    [
      "move_page_to_space",
      { pageId: page.id, spaceId },
      "/pages/move-to-space",
    ],
    ["get_space", { spaceId }, "/spaces/info"],
    ["list_spaces", {}, "/spaces"],
    ["create_space", { name: "Docs", slug: "docs" }, "/spaces/create"],
    ["update_space", { spaceId, description: "Updated" }, "/spaces/update"],
    ["get_comments", { pageId: page.id }, "/comments"],
    ["create_comment", { pageId: page.id, text: "Hello" }, "/comments/create"],
    ["update_comment", { commentId, text: "Updated" }, "/comments/update"],
    ["search_attachments", { query: "image" }, "/search-attachments"],
    ["list_workspace_members", {}, "/workspace/members"],
    ["get_current_user", {}, "/users/me"],
  ])(
    "%s uses its authenticated backend endpoint",
    async (name, input, path) => {
      const { call, post } = setup();
      expect(await call(name as string, input)).not.toHaveProperty(
        "isError",
        true,
      );
      expect(post).toHaveBeenCalledWith(
        path,
        expect.any(Object),
        expect.any(AbortSignal),
      );
    },
  );

  it("keeps same-space duplication distinct from cross-space copying", async () => {
    const { call, post } = setup();
    await call("duplicate_page", { pageId: page.id });
    expect(post).toHaveBeenLastCalledWith(
      "/pages/duplicate",
      { pageId: page.id },
      expect.any(AbortSignal),
    );
    await call("copy_page_to_space", { pageId: page.id, spaceId });
    expect(post).toHaveBeenLastCalledWith(
      "/pages/duplicate",
      { pageId: page.id, spaceId },
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["update_page", { pageId: page.id }],
    ["update_page", { pageId: page.id, content: "replacement" }],
    [
      "update_page",
      {
        pageId: page.id,
        content: "",
        format: "markdown",
        operation: "replace",
      },
    ],
    [
      "update_page",
      { pageId: page.id, content: {}, format: "json", operation: "replace" },
    ],
    ["move_page", { pageId: page.id }],
    ["move_page", { pageId: page.id, position: "a00000" }],
    [
      "create_comment",
      {
        pageId: page.id,
        content: { type: "doc", content: [{ type: "notARealNode" }] },
      },
    ],
    [
      "create_comment",
      {
        pageId: page.id,
        content: {
          type: "doc",
          content: [{ type: "text", text: "invalid nesting" }],
        },
      },
    ],
    ["list_pages", { limit: 101 }],
    ["search_pages", { query: "x".repeat(201) }],
    ["list_spaces", { adminView: true }],
    ["copy_page_to_space", { pageId: page.id }],
    ["create_comment", { pageId: page.id, text: "  " }],
    [
      "create_comment",
      { pageId: page.id, text: "a", content: { type: "doc", content: [] } },
    ],
  ])("%s rejects invalid input before any request", async (name, input) => {
    const { call, post } = setup();
    expect(await call(name as string, input)).toMatchObject({ isError: true });
    expect(post).not.toHaveBeenCalled();
  });

  it("routes explicit append/prepend/replace content operations unchanged", async () => {
    const { call, post } = setup();
    for (const operation of ["append", "prepend", "replace"]) {
      await call("update_page", {
        pageId: page.id,
        content: "# Heading",
        format: "markdown",
        operation,
      });
      expect(post).toHaveBeenLastCalledWith(
        "/pages/update",
        {
          pageId: page.id,
          content: "# Heading",
          format: "markdown",
          operation,
        },
        expect.any(AbortSignal),
      );
    }
  });

  it("serializes comment text once, preserving empty lines and literal HTML", async () => {
    const { call, post } = setup();
    await call("create_comment", {
      pageId: page.id,
      text: "<b>Hello</b>\n\nWorld",
    });
    const body = post.mock.calls[0][1] as unknown as { content: string };
    expect(JSON.parse(body.content)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<b>Hello</b>" }],
        },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    });
  });

  it("passes filters and pagination to the server and retains cursor metadata", async () => {
    const { call, post } = setup();
    const result = await call("list_pages", {
      spaceId,
      limit: 7,
      cursor: "cursor",
    });
    expect(post).toHaveBeenCalledWith(
      "/pages/recent",
      { spaceId, limit: 7, cursor: "cursor" },
      expect.any(AbortSignal),
    );
    expect(resultData(result)).toMatchObject({
      meta: { nextCursor: "next", hasNextPage: true },
    });
  });

  it("derives child-page space from the authorized parent rather than caller input", async () => {
    const { call, post } = setup();
    await call("list_child_pages", { pageId: page.id });
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/pages/info",
      { pageId: page.id },
      expect.any(AbortSignal),
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/pages/sidebar-pages",
      { pageId: page.id, spaceId, limit: 20 },
      expect.any(AbortSignal),
    );
  });

  it("prevents further requests when identity changes during a lookup", async () => {
    const { call, post, isCurrent } = setup();
    post.mockImplementationOnce(async () => {
      isCurrent.mockReturnValue(false);
      return page;
    });
    expect(await call("list_child_pages", { pageId: page.id })).toMatchObject({
      isError: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("prevents stale handles and cancelled calls from dispatching requests", async () => {
    const { call, post, controller } = setup();
    controller.abort();
    expect(await call("create_page", { spaceId })).toMatchObject({
      isError: true,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("returns permission errors and never refreshes caches after a rejected write", async () => {
    const { call, post, onMutation } = setup();
    post.mockRejectedValueOnce({
      response: { status: 403, data: { message: "Cannot edit this page" } },
    });
    const result = await call("update_page", {
      pageId: page.id,
      title: "Denied",
    });
    expect(result).toMatchObject({ isError: true });
    expect(resultData(result)).toMatchObject({
      error: { code: "FORBIDDEN", message: "Cannot edit this page" },
    });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("reports acknowledged mutations even if UI refresh fails", async () => {
    const { call, onMutation } = setup();
    onMutation.mockRejectedValueOnce(new Error("refresh failed"));
    const result = resultData(
      await call("update_page", { pageId: page.id, title: "New" }),
    );
    expect(result).toMatchObject({ id: page.id, uiRefreshPending: true });
  });

  it("excludes secrets and session settings from identity results", async () => {
    const { call } = setup();
    const result = resultData(await call("get_current_user"));
    expect(result).toEqual({
      user: { id: "user", name: "Alice" },
      workspace: { id: "workspace", name: "Docs" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
