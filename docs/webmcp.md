# Docmost WebMCP

This fork exposes all 20 tools documented by [Docmost](https://docmost.com/docs/user-guide/mcp) through the authenticated web application. Open Docmost in a browser with WebMCP support and sign in. A browser agent such as Codex's in-app browser can discover and invoke the tools in that document.

This is a frontend integration with existing session-authenticated APIs. It is independent of the enterprise remote `/mcp` service and its license-gated workspace switch. No API key or additional OAuth provider is needed for browser calls. Backend space/page permissions still apply.

## Browser support and lifecycle

The registration adapter supports the current `document.modelContext.registerTool(tool, { signal })` proposal, and the earlier `navigator.modelContext.registerTool` / `unregisterTool` API. Tools are registered only after successful authenticated user initialization and a matching application session identity. Clearing that identity at logout immediately aborts calls and removes tools, even before the logout HTTP request finishes. Tools are also removed on workspace/user change or application unmount. Browsers without either supported API use the application normally without tools. There is no production polyfill.

The browser agent's tool handles belong to the current document and registrations. Rediscover them after navigation or a session change. Codex may append a registration identifier to the displayed tool name; use the names returned by its discovery interface.

## Inputs

Parameters use camelCase and follow this fork's backend contracts. These schemas are not claimed to reproduce private enterprise MCP parameter schemas. All tools reject unknown parameters.

`limit` defaults to 20 and accepts integers from 1 to 100. Cursor lists return the backend `meta.nextCursor` and `meta.hasNextPage`; pass the cursor to the same list tool. Keyword searches accept `limit` and `offset` (default 0, maximum 1,000,000). Search keywords are 1–200 characters after trimming. Filters are applied on the server.

| Tool | Required inputs | Optional inputs |
| --- | --- | --- |
| `search_pages` | `query` | `spaceId`, `creatorId`, `labelIds`, `titleOnly`, `limit`, `offset` |
| `get_page` | `pageId` | `format` (default `markdown`) |
| `create_page` | `spaceId` | `title`, `parentPageId`, `content`, `format` |
| `update_page` | `pageId` and at least `title` or `content` | `format`, `operation` (required with content) |
| `list_pages` | — | `spaceId`, `limit`, `cursor` |
| `list_child_pages` | `pageId` | `limit`, `cursor` |
| `duplicate_page` | `pageId` | — |
| `copy_page_to_space` | `pageId`, destination `spaceId` | — |
| `move_page` | `pageId`, `position`, `parentPageId` | — |
| `move_page_to_space` | `pageId`, destination `spaceId` | — |
| `get_space` | `spaceId` | — |
| `list_spaces` | — | `query`, `limit`, `cursor` |
| `create_space` | `name`, `slug` | `description` |
| `update_space` | `spaceId` and at least `name` or `description` | — |
| `get_comments` | `pageId` | `limit`, `cursor` |
| `create_comment` | `pageId` and exactly one of `text` or `content` | `parentCommentId` |
| `update_comment` | `commentId` and exactly one of `text` or `content` | — |
| `search_attachments` | `query` | `spaceId`, `creatorId`, `limit`, `offset` |
| `list_workspace_members` | — | `query`, `limit`, `cursor` |
| `get_current_user` | — | — |

Space, creator, label, comment and parent-comment IDs must be UUIDs. Page inputs accept IDs/slug IDs where the existing page endpoint supports them. Child-page listing first reads the authorized parent to determine its canonical ID and space.

### Content writes

Page `format` accepts `markdown`, `html`, or `json`, defaulting to Markdown when content is provided. JSON may be an editor document object or its serialized JSON string. Empty string content is rejected because the backend would otherwise skip it; use `{ "type": "doc", "content": [] }` with `format: "json"` and `operation: "replace"` to clear a body.

Content updates must explicitly select `append`, `prepend`, or `replace`. `replace` replaces the entire body. Writes go through the backend's existing Yjs collaboration service; they do not directly overwrite stored editor content. The tool blocks page mutations while the active title has an unsaved draft, and blocks active-body mutations/copies while the collaborative editor is disconnected, has not completed synchronization, or has pending outgoing changes. The initial synchronization handshake is checked separately from Hocuspocus's `hasUnsyncedChanges`.

Before duplicating or copying the active editor, the tool also compares its current document with `/pages/info` in JSON format. Hocuspocus's server acknowledgement may precede the debounced database save. If the documents differ, the copy is rejected until saving finishes, so the tool does not silently copy an older stored body. Copies of descendants and concurrent remote edits retain the existing backend's stored-snapshot semantics.

For comments, `text` is plain text: HTML is literal text and newlines become paragraphs. `content` is an editor JSON object validated against the comment editor's StarterKit, Link and Mention schema before being serialized for the backend. Unsupported page-only nodes and invalid nesting are rejected.

### Moving pages

`position` is a valid Docmost fractional-ordering token, 5–12 characters, not an integer index. The backend validates the token. Always specify `parentPageId`: use the current parent to reorder within it, another page ID to reparent within the same space, or `null` to move to the root. Cross-space moves use `move_page_to_space`.

### Results and failures

Results use a text-content envelope containing JSON. Read tools carry `readOnlyHint`; results containing workspace content carry `untrustedContentHint`. Results select relevant resource fields and exclude credentials, license keys and internal account settings. Individual string inputs are bounded and serialized tool results are limited to two million characters.

Failures return `isError: true` and an error code/message. Permission failures propagate; they are not represented as empty successful lists. Writes are not automatically retried. An interrupted request may already have changed the resource: read its state before retrying. A successful write followed by a UI cache refresh failure returns the resource result with `uiRefreshPending: true`.

Page and space aliases, list caches, comments and already-loaded sidebar branches are synchronized after acknowledged writes. Moved page metadata is read back to reconcile the sidebar without dropping its loaded descendants. A branch that already has children but has never been loaded remains empty locally until expansion fetches its full child list; a new node must not turn it into a partial list that suppresses that fetch.

## Community attachment search

The frontend previously referenced `/api/search-attachments`, but this checkout did not contain that backend route. The fork adds it to the search module. It searches file names and existing extracted attachment text; it does not add a PDF/text-extraction pipeline. Deleted uploads, deleted pages and pages under deleted ancestors are excluded, as are non-file attachments such as chat files and avatars.

A single PostgreSQL query scopes candidates to the authenticated workspace and live space membership, then checks every restricted ancestor against direct or group page permissions before applying limit/offset. Keyword values are parameterized and LIKE wildcards escaped. The endpoint returns resource metadata without storage paths or extracted private text.

## Verification

Run from the repository root after installing dependencies and building the workspace packages:

```sh
pnpm --filter @docmost/editor-ext build
pnpm --filter @docmost/base-formula build
pnpm --filter client test
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter server exec tsc --noEmit -p tsconfig.build.json
pnpm --filter server test --runInBand --runTestsByPath src/core/search/attachment-search.spec.ts
```

Optional real-PostgreSQL integration checks run with a temporary PGlite installation, outside the application's dependency graph:

```sh
npm install --prefix /private/tmp/docmost-webmcp-qa --no-audit --no-fund --ignore-scripts @electric-sql/pglite
cd apps/server
node -r ./node_modules/ts-node/register -r ./node_modules/tsconfig-paths/register test/webmcp/attachment-search.sql-test.cjs
```

Set `WEBMCP_QA_MODULES` to another temporary `node_modules` directory if desired. The integration test uses an ephemeral in-memory PostgreSQL database and no production data.

### Evidence from 2026-10-13

- Native Codex browser discovery found all 20 registered tools. Each tool executed successfully against disposable HTTP fixtures using the production factory and registration adapter. Ending that fixture session removed every tool.
- PostgreSQL execution checks verified inherited restrictions, group grants, membership/workspace isolation, revocation, deleted resources, pagination, creator/space filters, wildcard escaping and existing extracted-text search.
- Feature and full-client automated tests, both application type checks and the client production build passed during implementation; final counts are recorded in the implementation plan.
- The initial disposable-fixture checks were followed by full local-service acceptance: real PostgreSQL/Redis, 17 authenticated API cases, all 20 native WebMCP tools, 9 reader permission checks and two real browser sessions. UI/agent edits converged and survived database reads and a complete service restart. See [the local acceptance guide](webmcp-local-acceptance.md) for accounts, evidence and reproducible steps.
- The locked ESLint query plugin package lacked its declared build artifact. Its installed packaged source was rebuilt locally to run the unchanged ESLint configuration; no dependency version or repository lint rule was changed.
