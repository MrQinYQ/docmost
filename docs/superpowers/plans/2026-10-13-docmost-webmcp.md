# Docmost WebMCP Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox syntax.

**Goal:** Expose the 20 documented Docmost MCP tools to browser agents.

**Architecture:** A typed, validated tool factory calls the existing authenticated HTTP endpoints. A browser adapter manages registration, and an authenticated React component manages identity and query-cache synchronization.

**Tech Stack:** TypeScript, React, Zod 4, Axios, React Query, Vitest, native WebMCP.

**Spec:** ../specs/2026-10-13-docmost-webmcp-design.md

## Global Constraints

- All 20 official tool names; fork-owned parameter schemas.
- Existing backend authorization and collaboration path; no enterprise module dependency.
- Register only in the authenticated app. Abort on identity changes and unmount.
- Unsupported browsers retain normal functionality. No production polyfill.
- Explicit content operation for updates. Server-side filters and pagination.
- Preserve changes for review; no commit, push, deployment or production data mutations.
- Execution in the existing user-selected fork checkout, inline. The user explicitly requested implementation after approving the design.

## Review Focus

- Async registration completing after cleanup must not leak tools or remove a newer registration.
- Identity changing during a parent-page lookup must prevent the subsequent request.
- A successful mutation followed by a cache refresh failure must still report the acknowledged write accurately.
- Comment newlines and empty paragraphs must survive plain-text conversion.
- The active page's title and sidebar tree must reflect tool writes without resetting collaborative content.

### Task 1: Tool contracts and HTTP adapters

**Files:** Create `apps/client/src/features/webmcp/{types.ts,content.ts,tools.ts,tools.test.ts}`.

**Interfaces:** `createDocmostTools(deps: ToolDependencies): WebMcpTool[]`; dependencies include an abort-aware `post(path, body, signal)`, `isCurrent()`, `signal`, and `onMutation(kind, result)`.

- [x] Write tests for the 20-tool catalog, all distinct HTTP mappings, invalid parameters, duplication versus copying, content operations, comment conversion, pagination, identity changes and server errors.
- [x] Run tools tests; observed missing implementation (RED), then specific invalid-input regressions (RED).
- [x] Implement strict schemas and safe selected result fields. Map child listing through parent-page lookup. Check identity before every HTTP request and before returning results. Reject updates without a change.
- [x] Run the feature tests; PASS.

### Task 2: Native registration lifecycle

**Files:** Create `apps/client/src/features/webmcp/{registration.ts,registration.test.ts}`.

**Interfaces:** `registerDocmostTools(context, tools): { ready: Promise<void>; dispose(): void }`; `getModelContext(document, navigator)` feature-detects supported registration variants.

- [x] Write tests for unsupported API, registration, cleanup, partial failures, delayed registration, repeated setup/cleanup, and preserving unrelated tools.
- [x] Run registration tests; observed missing implementation (RED).
- [x] Implement abort-signal registration for the current Document API and named unregistration for the earlier Navigator API, with serialized registration per context.
- [x] Run registration tests; PASS.

### Task 3: Authenticated integration and UI synchronization

**Files:** Create `apps/client/src/features/webmcp/{webmcp-provider.tsx,cache.ts,cache.test.ts,webmcp-provider.test.tsx}`; modify `apps/client/src/features/user/user-provider.tsx`.

**Interfaces:** `WebMcpProvider({ userId, workspaceId })` mounts only after fresh authenticated user data; `syncToolMutation(queryClient, kind, result)` updates existing page and space keys, invalidates list keys, and updates the page tree model.

- [x] Write cache and provider tests for identity lifetime, current-page aliases, sidebar changes and comment invalidation.
- [x] Run missing-cache tests and tree/editor regressions; observed RED. Provider lifecycle tests ran GREEN after integration (no separate provider RED run).
- [x] Implement the lifecycle component and targeted cache synchronization, then mount it in the existing UserProvider.
- [x] Run the feature suite; initial 65 tests PASS, recheck expanded it to 71 PASS.

### Task 4: Verification and usage documentation

**Files:** Create `docs/webmcp.md`; update this plan with outcomes.

- [x] Run feature tests, client TypeScript check, client test suite, client build and changed-file lint. Record pre-existing failures separately.
- [x] Inspect local PostgreSQL/Redis/runtime availability without printing secrets; no configured local services available. Use temporary PostgreSQL and disposable HTTP fixtures.
- [x] Discover the tool catalog using the real Codex browser WebMCP capability and exercise all tools with disposable fixtures. Record actual service availability and unresolved acceptance gaps precisely.
- [x] Review the complete diff and run `git diff --check`. Document schemas, content operations, supported registration APIs and the browser-session requirement.
- [x] Full Docmost service acceptance with session cookies, restricted accounts and two-session edits in the running collaborative editor. See the subsequent local-environment acceptance record below.

## Execution ledger

- Ruling: Execute inline in the current fork checkout after explicit user direction; no worktree creation or commits. This keeps the requested changes directly reviewable here.
- Initial environment: Node v24.19.0; package install started from the existing lockfile. Docker CLI not on PATH; no `.env` file in the checkout.
- Task 1: complete. Input-schema default optionality regression observed RED then GREEN. All 20 official names and mappings covered.
- Task 2: complete. Native browser Document signal registration verified; fixture-session termination left no tools.
- Task 3: complete. Cache aliases, already-loaded sidebar branches and editor pre-mutation guards verified in tests.
- Ruling: Add community `/api/search-attachments` because the existing frontend service referred to an absent backend route. Search filenames and existing extracted text, preserving inherited page permissions before pagination. No extraction pipeline added; new uploaded PDFs without extracted text are searched by filename.
- Ruling: Require explicit nullable `parentPageId` for `move_page`. Backend omission reparents to root, so optional input would silently relocate nested pages.
- Ruling: Use temporary PGlite and disposable HTTP fixtures for acceptance evidence because no full local services are available. These prove SQL permission behavior and native WebMCP transport respectively; they do not establish live collaborative-editor acceptance.
- Final independent review: three P2 findings (lazy sidebar structure, omitted parent, comment schema), all fixed with observed failing regressions then GREEN. No minor findings deferred.
- Final verification: full client suite 21 files / 302 tests PASS; feature subset 65 PASS; new server suite 5 PASS; temporary PostgreSQL integration 10 cases PASS. Client/server TypeScript checks, client production build, changed-file client/server lint and diff whitespace check PASS. Existing build warning for large chunks remains.
- Verification setup: built editor-ext/base-formula workspace packages before type checking. The installed locked query ESLint plugin lacked its build artifact; rebuilt it from its installed packaged source to use the unchanged lint configuration. Package versions and lockfile unchanged.
- Execution completed with uncommitted source and documentation changes retained for review. Remaining acceptance gap is the full running-service check listed above.

## Recheck after the reported network interruption

- Disk files and dependency artifacts were intact. Fresh initial reruns reproduced the original 302 client / 5 server test results, PostgreSQL checks and both type/build/lint checks.
- A second independent audit found three additional P2 boundary issues, now fixed: partial insertion into an unloaded sidebar branch, continued registration during a pending logout, and treating the collaborative handshake as proof of no outgoing changes.
- New regressions failed before the fixes, then passed. Unloaded branches retain lazy-fetch state; current-user identity reset synchronously revokes registrations and aborts calls; active-body guards read the current Hocuspocus provider's pending-change state.
- Active-page duplication/copy also checks current editor content against the stored JSON before dispatch, because a Hocuspocus ACK precedes debounced database persistence. This is an async pre-mutation guard and never rewrites the source document to force saving.
- Final recheck: 21 client files / 308 tests PASS, feature subset 71 PASS, server suite 5 PASS, PostgreSQL integration 10 cases PASS. Client/server type checks, client build, changed-file lint and whitespace checks PASS.
- Native Codex browser rediscovered all 20 tools and called all 20 successfully against disposable HTTP fixtures after the fixes. Ending the fixture session again returned no tools. Evidence: `docmost-webmcp-recheck.jpg` in this chat's visualization directory.
- Full running-service acceptance remains outstanding. The recheck did not use production data and did not add configured PostgreSQL/Redis services, commit or push changes.

## Real local-environment acceptance

- User subsequently requested full local setup and acceptance. Installed PostgreSQL 18.6 and Redis 8.10.2 through Homebrew; Node 24.19.0 was already available. Services run under this checkout's `data/local-docmost`, on loopback ports 3000 / 55432 / 56379; no global Homebrew login services were enabled.
- `scripts/local-docmost/start.mjs` generates a private local `.env` only when absent, enforces the dedicated database profile, starts services, optionally builds code, lets the real production bootstrap apply migrations, and supports status/stop. Supervisor relative-argv recognition and bounded shutdown were corrected and self-tested.
- `scripts/local-docmost/acceptance-api.mjs` creates three real users through setup/invitation APIs, uploads real TXT files, configures space roles, and builds local-only restriction SQL fixtures. Test mail recipients are blocked; credentials are private ignored files, never emitted in evidence.
- Real authenticated API acceptance: 17 cases / 71 requests / zero failures, including permission/ancestor enforcement, filtered lists/search/attachments, direct download denial, comment ownership, Yjs-backed content persistence, copy/move and logout replay denial. Repeated successfully after a complete stop/rebuild/restart.
- Real native WebMCP acceptance: all 20 tools invoked successfully as admin against http://127.0.0.1:3000. Reader browser completed 9 role/denial/filter checks, and rejected writes left original content unchanged. Actual logout removed all tools.
- Real two-browser acceptance: Codex in-app browser as admin and native Chrome as writer. Writer UI typing and admin WebMCP append converged on both screens; a later admin UI edit reached writer. Database reads and a full service restart preserved all three distinct text markers.
- Immediate active-page duplication rejected before the debounced database save; duplication succeeded after persistence. Previously unloaded sidebar branches fetched old and new children without omissions.
- Real response inspection revealed the effective space role is in `membership.role`; selected tool outputs now preserve that actual membership field. Its regression failed before the projection fix, then passed; real reader response returned `reader` after rebuilding.
- Final automated client suite: 309 tests PASS; client typecheck/lint/build PASS. Runtime and API helper self-tests PASS. No product backend changes were needed during full-service acceptance.
- Evidence lives in ignored `data/local-docmost`: `api-acceptance-latest.json`, `native-webmcp-acceptance.json`, `native-reader-acceptance.json`, `collaboration-save-guard.json`, `restart-acceptance.json`. The Chinese reproducible procedure is `docs/webmcp-local-acceptance.md`.
- The instance is left running for the user's manual tests. Work is uncommitted/unpushed. An unrelated `.vscode/settings.json` appeared during the session and was left untouched.
