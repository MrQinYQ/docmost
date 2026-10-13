# Docmost WebMCP design

Date: 2026-10-13
Status: Approved, implemented and accepted against the real local Docmost/PostgreSQL/Redis instance with authenticated roles and two browser sessions (see the implementation plan and local acceptance guide).

## Outcome and scope

Expose all 20 tools listed in the official Docmost MCP documentation through the logged-in Docmost web application. Codex's in-app browser must be able to discover and invoke them using its WebMCP capability. The user approved this direction in chat. This implementation belongs to the fork and reuses community backend functionality; it does not depend on the unavailable enterprise MCP submodule.

Sources: https://docmost.com/docs/user-guide/mcp and https://github.com/webmachinelearning/webmcp . Tool names and documented capabilities are matched; official enterprise parameter schemas are unavailable, so this fork defines and documents its own schemas.

No remote MCP server, OAuth provider, API key implementation, deletion tools, uploads, or new permission-management features are included.

## Architecture

Add a focused `apps/client/src/features/webmcp` feature containing tool definitions, validation and business adapters, browser registration, and a lifecycle component. Mount the component inside the authenticated application's UserProvider. Existing Axios services continue to send same-origin requests with session cookies. Backend guards remain authoritative; no tool accepts a workspace override or credentials.

Feature-detect the browser's supported WebMCP registration API and verify its actual contract before coding the registration adapter. The current specification is evolving; do not infer compatibility solely from an API name. Unsupported browsers continue to work normally without registering tools. Do not install a speculative polyfill or expose an ad hoc global tool runner as a substitute for browser acceptance.

Register tools only after authenticated user/workspace initialization. Unregister on logout, layout unmount, or identity/workspace changes. In-flight calls capture the original identity and must not execute against a newly selected workspace. Cleanup must also handle registration completing after unmount and React development remounts. Tools are independent of the current route within the authenticated app; public shares and login pages do not register them.

## Tool mapping

Endpoint paths below are relative to `/api` and use existing session-authenticated POST routes.

| Tool | Existing endpoint | Contract |
| --- | --- | --- |
| search_pages | /search | Keyword search with supported server-side filters. |
| get_page | /pages/info | Read a page by ID, with supported content format. |
| create_page | /pages/create | Space ID, optional parent/title, optional formatted content. |
| update_page | /pages/update | Page ID, optional title, optional formatted content and operation. |
| list_pages | /pages/recent | Recent pages filtered by space, with backend pagination. |
| list_child_pages | /pages/sidebar-pages | Parent page and its space, with backend pagination. Resolve the parent's space server-side if needed. |
| duplicate_page | /pages/duplicate | Page ID only: copy inside the original space. |
| copy_page_to_space | /pages/duplicate | Page ID plus required destination space ID. |
| move_page | /pages/move | Page ID, valid ordering position, explicitly required nullable parent ID. Omission in the backend moves a nested page to the root. |
| move_page_to_space | /pages/move-to-space | Page ID and destination space ID. |
| get_space | /spaces/info | Space ID. |
| list_spaces | /spaces | Accessible spaces with backend pagination. |
| create_space | /spaces/create | Name and supported optional metadata. |
| update_space | /spaces/update | Space ID and supported name/description changes. |
| get_comments | /comments | Page ID and backend pagination. |
| create_comment | /comments/create | Page ID, comment content, optional parent-comment ID. |
| update_comment | /comments/update | Comment ID and content. |
| search_attachments | /search-attachments | Keyword and supported server-side filters. |
| list_workspace_members | /workspace/members | Current workspace members with backend pagination. |
| get_current_user | /users/me | Explicitly selected user/workspace identity fields; never serialize credentials or internal session secrets. |

During implementation, inspect each route's DTO and permission checks before finalizing its schema. Frontend interfaces alone are insufficient: for example, the frontend move interface has optional position, but the backend DTO requires a position token of 5–12 characters. No unsupported filters are simulated by fetching and filtering locally.

## Content and collaboration

Page content supports the backend's `markdown`, `html`, and `json` formats. For update content, always submit an explicit `append`, `prepend`, or `replace` operation and format. Require callers to select the operation whenever content is supplied, so accidental whole-document replacement is not implicit. Title-only edits remain valid; empty updates are rejected.

The existing page service routes content writes through `CollaborationGateway.handleYjsEvent('updatePageContent', ...)`. Preserve that path; do not directly overwrite stored content or reset the active editor's Yjs document. Confirm how completion and immediate reads behave, and test changes arriving in an already-open editor.

Comments use serialized editor JSON in the existing backend DTO (`IsJSON`), not arbitrary Markdown. Provide a documented plain-text input converted to a minimal editor document, plus validated editor JSON where appropriate. Preserve newlines and prevent ambiguous double encoding. Page and comment JSON must be checked against the actual existing editor contract.

## Validation, results and UI consistency

Each tool supplies a description and JSON input schema. Runtime validation rejects malformed input before sending requests; JSON schema and runtime validators share a definition where practical. Apply supported pagination bounds and preserve next-cursor metadata. Mark read tools as read-only using annotations actually supported by the registration API.

Return bounded structured results suitable for agents, including useful identifiers and existing page URLs where available. Select response fields rather than returning arbitrary user objects. Return explicit success for endpoints with no body. Convert validation, permission, missing-resource and network failures into the browser API's supported tool-error representation. Do not claim a write succeeded until the backend acknowledged it; do not automatically retry writes after an ambiguous network failure.

After successful mutations, invalidate affected React Query caches (page details/sidebar/recent, spaces, comments). Reuse current query-key conventions. Update active UI state where invalidation alone is insufficient, especially titles and moved pages. Backend authorization errors must propagate, never become empty successful results.

## Verification and acceptance

1. Tests cover all 20 tool names and distinct endpoint mappings, including same-space duplication versus cross-space copying.
2. Test invalid input, pagination, content conversion, explicit content operations, and server errors without relying only on tests that mirror the registration table.
3. Test registration lifecycle, unsupported browsers, logout/workspace changes and late registration cleanup.
4. Run client type checking, relevant tests and build; run affected backend checks if backend changes become necessary.
5. Use Codex's real browser `webmcp.fetchTools()` to discover all 20 tools on a logged-in local instance, then invoke each with representative input against disposable local fixtures.
6. Verify backend read/write permission enforcement with a restricted user, and verify page-content changes in the active collaborative editor.
7. Report automated checks and actual browser evidence separately. If local services or a supported browser runtime are unavailable, report the exact missing acceptance evidence rather than claiming end-to-end completion.

## Execution constraints

The current checkout is clean and points to `MrQinYQ/docmost`. Dependencies are not installed in the root at inspection time. Inspect available runtimes and local service configuration without printing secrets before arranging verification. Preserve the user's checkout for review; do not commit or push without explicit authorization. No subagents are required by this design.
