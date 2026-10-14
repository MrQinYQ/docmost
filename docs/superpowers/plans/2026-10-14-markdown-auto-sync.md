# Markdown auto sync implementation plan

> **For agentic workers:** Use scoped parallel workers and TDD; the root owns integration and final acceptance. Complete affected checks and independently review before delivery.

**Goal:** Save explicitly bound MD files to Docmost while MCP runs, and pause rather than overwrite a changed live page.

**Architecture:** A configured local sync manager owns private binding state, per-page leases and queued file changes. Two guarded server routes expose a live revision/preview and compare-and-replace in the owner Ydoc. The MCP entry starts/stops the manager with stdio lifecycle and optionally registers four extension controls.

**Tech stack:** Node22+, existing MCP SDK/zod, NestJS, Tiptap/Yjs/Hocuspocus/Redis. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-markdown-auto-sync.md`

## Global constraints

- Opt-in source/state absolute paths; state outside source; no watch/uploads without configuration or in read-only mode.
- Source UTF-8 `.md`, regular non-symlink file, <=1,000,000 bytes; debounce1000ms.
- Private state0700/0600, fixed origin/user/workspace/page/space; no bodies/credentials in state.
- Conditional live-Ydoc update only; unsupported servers never fall back to unconditional replacement.
- No write retries after an uncertain result; pending intent persisted before dispatch; EOF/signals stop the manager.
- Existing 22 tools remain unchanged without sync config; configured normal mode adds four tools, configured read-only adds status only.

## Review focus

- Atomic-save rename and UTF-8 truncation never upload incomplete/escaped content.
- Browser changes not yet in DB still cause live CAS conflict.
- State/identity/path substitutions and duplicate processes cannot retarget an upload.
- Shutdown during pending I/O cannot schedule new work or forget an uncertain mutation.
- Lost acknowledgements and persistence errors cannot cause blind retries or false success.

## Task1 — conditional service (server worker)

Files: new page sync DTO/revision utility and focused specs; page controller/service, collaboration handler/gateway/persistence extension as needed.

- [x] Add failing tests for live revision, deterministic preview, stale CAS/no mutation, permissions, simultaneous same-base updates and failed persistence.
- [x] Implement `pages/sync-state`/`pages/sync-update` exactly as the spec, using Redis-owner events and local dispatch; pinned space/workspace plus one-transaction hierarchy guard.
- [x] Verify focused25/25, real Redis owner1/1, Nest build and full regressions (450pass,15unchangedDIstubfail,1opt-in skip).

## Task2 — manager/storage (local worker)

Files: `packages/mcp/src/sync.mjs`, optional focused `sync-store.mjs`/`sync-files.mjs`, and `test/sync*.test.mjs`.

Consumes config `{origin,readOnly,syncRoot,syncStateDir}` and API `{post(path,body,signal,mutation)}`. Produces `createMarkdownSync(config,{api,debounceMs?,scanMs?})` returning manager with async `start()`, `close()`, `bind({filePath,pageId,enabled=true})`, `status({bindingId?}={})`, `control({bindingId,action})`, `resolve({bindingId,expectedRevision})`. Startup errors are safe status, not protocol stdout; controls await initialization. Status is read-only and must not trigger uploading.

- [x] Add failing tests for positive saves, atomic-save rename, queuing, paused/conflict/pending handling, restart, confinement/private state, identity/space/lease and close cancellation.
- [x] Implement private state + source access + manager against the fixed service protocol.
- [x] Verify38/38 real filesystem tests with controlled API; independently fix/verify live status observation and old-context unbind.

## Task3 — MCP integration (root and independent test worker)

Files: config/index/server/API plus new `test/sync-stdio.test.mjs`; Chinese docs and Skill refs.

- [x] Add failing integration tests for opt-in configuration, 22/26 and 10/11 discovery, strict control schemas, lifecycle EOF/signals and read-only behavior.
- [x] Add config validation, sync endpoints/status mappings, start/stop wiring and optional tools; preserve old CLI/auth/default behavior.
- [x] Update setup/control/conflict/self-test guidance, including server deployment requirements.
- [x] Complete MCP152/152 and sparse-install152/152, backend checks and independent review; all3 identified P2 addressed with regression tests.

## Task4 — live acceptance (root)

- [x] Build/restart isolated localhost server, reuse synthetic accounts only, create independent temporary pages/files/sessions.
- [x] Real stdio/personal-session/WebSocket/PostgreSQL/Redis31/31 checks passed, including live unpersisted conflict and explicit merged resolution.
- [x] Trash4 test pages/delete1 temporary space, revoke3 sessions and confirm401 replay, close connections/delete temporary files; concise ignored evidence and reproducible script/guide delivered.
