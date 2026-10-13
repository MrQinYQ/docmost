import { z } from "zod";
import {
  commentDocument,
  editorDocument,
  validatedCommentDocument,
} from "./content";
import type {
  MutationKind,
  ToolDependencies,
  ToolResult,
  WebMcpTool,
} from "./types";

const id = z.string().trim().min(1).max(128);
const uuid = z.uuid();
const limit = z.number().int().min(1).max(100).default(20);
const pagination = { limit, cursor: z.string().min(1).max(4096).optional() };
const format = z.enum(["markdown", "html", "json"]);
const content = z.union([
  z.string().min(1).max(1000000),
  z.record(z.string(), z.json()),
]);
const search = {
  query: z.string().trim().min(1).max(200),
  spaceId: uuid.optional(),
  creatorId: uuid.optional(),
  limit,
  offset: z.number().int().min(0).max(1000000).default(0),
};
const commentInput = {
  text: z.string().min(1).max(1000000).optional(),
  content: z.record(z.string(), z.json()).optional(),
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected response from Docmost.");
  return value as Record<string, unknown>;
}

function pick(value: unknown, keys: string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function pageResult(value: unknown) {
  const source = record(value);
  return {
    ...pick(source, [
      "id",
      "slugId",
      "title",
      "icon",
      "parentPageId",
      "spaceId",
      "position",
      "content",
      "createdAt",
      "updatedAt",
      "hasChildren",
      "isBase",
      "permissions",
    ]),
    ...(source.space
      ? { space: pick(source.space, ["id", "name", "slug"]) }
      : {}),
  };
}

function spaceResult(value: unknown) {
  const source = record(value);
  return {
    ...pick(source, [
      "id",
      "name",
      "slug",
      "description",
      "createdAt",
      "updatedAt",
      "userRole",
    ]),
    ...(source.membership
      ? { membership: pick(source.membership, ["userId", "role"]) }
      : {}),
  };
}

function commentResult(value: unknown) {
  const source = record(value);
  return {
    ...pick(source, [
      "id",
      "pageId",
      "content",
      "parentCommentId",
      "type",
      "createdAt",
      "editedAt",
      "resolvedAt",
    ]),
    ...(source.creator
      ? { creator: pick(source.creator, ["id", "name"]) }
      : {}),
  };
}

function memberResult(value: unknown) {
  return pick(value, ["id", "name", "email", "role", "avatarUrl"]);
}

function listResult(value: unknown, project: (value: unknown) => unknown) {
  const source = record(value);
  if (!Array.isArray(source.items))
    throw new Error("Unexpected list response from Docmost.");
  return {
    items: source.items.map(project),
    ...(source.meta
      ? {
          meta: pick(source.meta, [
            "limit",
            "hasNextPage",
            "hasPrevPage",
            "nextCursor",
            "prevCursor",
          ]),
        }
      : {}),
  };
}

function result(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (text.length > 2000000)
    throw new Error(
      "Result exceeds 2 million characters. Request fewer items or a smaller content format.",
    );
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): ToolResult {
  const response = (
    error as { response?: { status?: number; data?: { message?: unknown } } }
  )?.response;
  const status = response?.status;
  const message = response?.data?.message;
  let detail =
    "Docmost request failed. A failed write response does not guarantee the write was rolled back; read the resource before retrying.";
  if (error instanceof z.ZodError)
    detail = error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
  else if (typeof message === "string") detail = message;
  else if (Array.isArray(message))
    detail = message.filter((item) => typeof item === "string").join("; ");
  else if (error instanceof Error && !status && !("isAxiosError" in error))
    detail = error.message;
  const code =
    status === 403
      ? "FORBIDDEN"
      : status === 401
        ? "UNAUTHENTICATED"
        : status === 404
          ? "NOT_FOUND"
          : error instanceof z.ZodError
            ? "INVALID_INPUT"
            : "REQUEST_FAILED";
  return {
    ...result({ error: { code, message: detail.slice(0, 2000) } }),
    isError: true,
  };
}

function formattedBody(input: Record<string, unknown>) {
  if (input.content === undefined) return input;
  const selectedFormat = input.format ?? "markdown";
  if (selectedFormat !== "json" && typeof input.content !== "string")
    throw new Error("Markdown and HTML content must be strings.");
  return {
    ...input,
    format: selectedFormat,
    content:
      selectedFormat === "json" ? editorDocument(input.content) : input.content,
  };
}

function serializedComment(input: Record<string, unknown>) {
  if ((input.text === undefined) === (input.content === undefined))
    throw new Error("Provide exactly one of text or content.");
  if (typeof input.text === "string" && !input.text.trim())
    throw new Error("Comment text cannot be blank.");
  const { text, content: json, ...rest } = input;
  return {
    ...rest,
    content: JSON.stringify(
      text !== undefined
        ? commentDocument(text as string)
        : validatedCommentDocument(json),
    ),
  };
}

export function createDocmostTools(deps: ToolDependencies): WebMcpTool[] {
  function define<S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    readOnly: boolean,
    run: (
      input: z.output<S>,
      post: ToolDependencies["post"],
    ) => Promise<unknown>,
  ): WebMcpTool {
    return {
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<
        string,
        unknown
      >,
      annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
      async execute(raw, options) {
        const signal = options?.signal
          ? AbortSignal.any([deps.signal, options.signal])
          : deps.signal;
        function assertCurrent() {
          if (signal.aborted || !deps.isCurrent())
            throw new Error(
              "This Docmost session is no longer active. Rediscover tools in the current workspace. An in-flight write may already have completed; verify it before retrying.",
            );
        }
        const post: ToolDependencies["post"] = (path, body) => {
          assertCurrent();
          return deps.post(path, body, signal);
        };
        try {
          assertCurrent();
          const input = schema.parse(raw);
          if (!readOnly) await deps.beforeMutation?.(name, record(input));
          const data = await run(input, post);
          assertCurrent();
          return result(data);
        } catch (error) {
          return errorResult(error);
        }
      },
    };
  }

  async function mutated(
    kind: MutationKind,
    raw: unknown,
    project: (value: unknown) => Record<string, unknown>,
  ) {
    const data = record(raw);
    if (!deps.isCurrent() || deps.signal.aborted) return project(data);
    try {
      await deps.onMutation(kind, data);
    } catch {
      return { ...project(data), uiRefreshPending: true };
    }
    return project(data);
  }

  return [
    define(
      "search_pages",
      "Search accessible pages by keyword. Filters and limit/offset are applied by the server.",
      z.strictObject({
        ...search,
        titleOnly: z.boolean().optional(),
        labelIds: z.array(uuid).max(100).optional(),
      }),
      true,
      async (input, post) => {
        const source = record(await post("/search", input, deps.signal));
        if (!Array.isArray(source.items))
          throw new Error("Unexpected search response.");
        return {
          items: source.items.map((item) => ({
            ...pageResult(item),
            ...pick(item, ["highlight", "matchedText", "rank"]),
          })),
          limit: input.limit,
          offset: input.offset,
        };
      },
    ),
    define(
      "get_page",
      "Get an accessible page's content and metadata. Default content format is Markdown; json returns editor JSON.",
      z.strictObject({ pageId: id, format: format.default("markdown") }),
      true,
      async (input, post) =>
        pageResult(await post("/pages/info", input, deps.signal)),
    ),
    define(
      "create_page",
      "Create a page in a writable space, optionally under a parent. Content supports Markdown (default), HTML, or editor JSON.",
      z.strictObject({
        spaceId: uuid,
        title: z.string().max(10000).optional(),
        parentPageId: id.optional(),
        content: content.optional(),
        format: format.optional(),
      }),
      false,
      async (input, post) =>
        mutated(
          "page",
          await post("/pages/create", formattedBody(input), deps.signal),
          pageResult,
        ),
    ),
    define(
      "update_page",
      "Update title or content. Content requires an explicit append, prepend, or replace operation; replace overwrites the entire body. Writes use the existing collaborative editor service.",
      z.strictObject({
        pageId: id,
        title: z.string().max(10000).optional(),
        content: content.optional(),
        format: format.optional(),
        operation: z.enum(["append", "prepend", "replace"]).optional(),
      }),
      false,
      async (input, post) => {
        if (input.title === undefined && input.content === undefined)
          throw new Error("Provide a title or content to update.");
        if (input.content !== undefined && !input.operation)
          throw new Error("Content updates require an explicit operation.");
        if (
          input.content === undefined &&
          (input.format !== undefined || input.operation !== undefined)
        )
          throw new Error("format and operation require content.");
        return mutated(
          "page",
          await post("/pages/update", formattedBody(input), deps.signal),
          pageResult,
        );
      },
    ),
    define(
      "list_pages",
      "List recent accessible pages, optionally in a space. Use nextCursor to request the next page.",
      z.strictObject({ spaceId: uuid.optional(), ...pagination }),
      true,
      async (input, post) =>
        listResult(await post("/pages/recent", input, deps.signal), pageResult),
    ),
    define(
      "list_child_pages",
      "List direct accessible child pages. The parent determines the space. Use nextCursor for more children.",
      z.strictObject({ pageId: id, ...pagination }),
      true,
      async (input, post) => {
        const parent = record(
          await post("/pages/info", { pageId: input.pageId }, deps.signal),
        );
        return listResult(
          await post(
            "/pages/sidebar-pages",
            { ...input, pageId: parent.id, spaceId: parent.spaceId },
            deps.signal,
          ),
          pageResult,
        );
      },
    ),
    define(
      "duplicate_page",
      "Duplicate a page within its current space, including its descendants as supported by Docmost.",
      z.strictObject({ pageId: id }),
      false,
      async (input, post) =>
        mutated(
          "page",
          await post("/pages/duplicate", input, deps.signal),
          pageResult,
        ),
    ),
    define(
      "copy_page_to_space",
      "Copy a page and its descendants into a destination space you can edit.",
      z.strictObject({ pageId: id, spaceId: uuid }),
      false,
      async (input, post) =>
        mutated(
          "page",
          await post("/pages/duplicate", input, deps.signal),
          pageResult,
        ),
    ),
    define(
      "move_page",
      "Move a page to a position or parent within its space. position is a Docmost ordering token (5–12 characters), not an integer index. Always supply parentPageId: keep the existing parent for reordering, or null to move to the root.",
      z.strictObject({
        pageId: id,
        position: z.string().min(5).max(12),
        parentPageId: id.nullable(),
      }),
      false,
      async (input, post) => {
        await post("/pages/move", input, deps.signal);
        return mutated("pageMove", { success: true, ...input }, record);
      },
    ),
    define(
      "move_page_to_space",
      "Move a page and its descendants to another space. Both source and destination permissions apply.",
      z.strictObject({ pageId: id, spaceId: uuid }),
      false,
      async (input, post) => {
        await post("/pages/move-to-space", input, deps.signal);
        return mutated("pageMove", { success: true, ...input }, record);
      },
    ),
    define(
      "get_space",
      "Get details of a space accessible to the current user.",
      z.strictObject({ spaceId: uuid }),
      true,
      async (input, post) =>
        spaceResult(await post("/spaces/info", input, deps.signal)),
    ),
    define(
      "list_spaces",
      "List the current user's accessible spaces. Supports server-side name search and cursor pagination.",
      z.strictObject({ ...pagination, query: z.string().max(200).optional() }),
      true,
      async (input, post) =>
        listResult(await post("/spaces", input, deps.signal), spaceResult),
    ),
    define(
      "create_space",
      "Create a space. name and slug must be 2–100 characters; slug starts with a letter or digit and may contain hyphens and underscores.",
      z.strictObject({
        name: z.string().trim().min(2).max(100),
        slug: z
          .string()
          .min(2)
          .max(100)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
        description: z.string().max(100000).optional(),
      }),
      false,
      async (input, post) =>
        mutated(
          "space",
          await post("/spaces/create", input, deps.signal),
          spaceResult,
        ),
    ),
    define(
      "update_space",
      "Update a space's name or description with current user permissions.",
      z.strictObject({
        spaceId: uuid,
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().max(100000).optional(),
      }),
      false,
      async (input, post) => {
        if (input.name === undefined && input.description === undefined)
          throw new Error("Provide a name or description to update.");
        return mutated(
          "space",
          await post("/spaces/update", input, deps.signal),
          spaceResult,
        );
      },
    ),
    define(
      "get_comments",
      "List comments on an accessible page, with cursor pagination.",
      z.strictObject({ pageId: id, ...pagination }),
      true,
      async (input, post) =>
        listResult(await post("/comments", input, deps.signal), commentResult),
    ),
    define(
      "create_comment",
      "Add a page comment or reply. Provide exactly one of plain text or editor JSON content. Plain text preserves newlines and is never interpreted as HTML.",
      z.strictObject({
        pageId: id,
        parentCommentId: uuid.optional(),
        ...commentInput,
      }),
      false,
      async (input, post) =>
        mutated(
          "comment",
          await post("/comments/create", serializedComment(input), deps.signal),
          commentResult,
        ),
    ),
    define(
      "update_comment",
      "Edit an existing comment with current user permissions. Provide exactly one of plain text or editor JSON content.",
      z.strictObject({ commentId: uuid, ...commentInput }),
      false,
      async (input, post) =>
        mutated(
          "comment",
          await post("/comments/update", serializedComment(input), deps.signal),
          commentResult,
        ),
    ),
    define(
      "search_attachments",
      "Search accessible workspace file attachments by keyword, with optional space and creator filters and server-side limit/offset.",
      z.strictObject(search),
      true,
      async (input, post) => {
        const source = record(
          await post("/search-attachments", input, deps.signal),
        );
        if (!Array.isArray(source.items))
          throw new Error("Unexpected attachment search response.");
        return {
          items: source.items.map((item) => {
            const attachment = record(item);
            return {
              ...pick(attachment, [
                "id",
                "fileName",
                "pageId",
                "creatorId",
                "createdAt",
                "updatedAt",
                "highlight",
                "rank",
              ]),
              ...(attachment.space
                ? { space: spaceResult(attachment.space) }
                : {}),
              ...(attachment.page
                ? { page: pick(attachment.page, ["id", "title", "slugId"]) }
                : {}),
            };
          }),
          limit: input.limit,
          offset: input.offset,
        };
      },
    ),
    define(
      "list_workspace_members",
      "List members of the current workspace, with server-side name search and cursor pagination.",
      z.strictObject({ ...pagination, query: z.string().max(200).optional() }),
      true,
      async (input, post) =>
        listResult(
          await post("/workspace/members", input, deps.signal),
          memberResult,
        ),
    ),
    define(
      "get_current_user",
      "Get current user and workspace identity. Does not return tokens, license keys, or private account settings.",
      z.strictObject({}),
      true,
      async (_input, post) => {
        const source = record(await post("/users/me", {}, deps.signal));
        return {
          user: memberResult(source.user),
          workspace: pick(source.workspace, ["id", "name", "hostname"]),
        };
      },
    ),
  ];
}
