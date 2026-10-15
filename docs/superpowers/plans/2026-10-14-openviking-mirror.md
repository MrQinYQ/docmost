# OpenViking Markdown Mirror Implementation Plan

> **For agentic workers:** Use the approved spec and task ownership below; root owns integration and real acceptance. Track each task with checkbox steps and retain the working tree for review.

**Goal:** Mirror only bound local Markdown pages from confirmed Docmost writes into an optional local or remote OpenViking deployment, preserving spaces and hierarchy.

**Architecture:** Optional HTTP client plus a private per-binding durable outbox. Docmost confirmation activates an exact source snapshot; OpenViking stages and layout changes never replay Docmost mutations. Existing MCP lifecycle and permission/conflict boundaries apply.

**Tech Stack:** Node >=22 built-in fetch/fs/crypto, existing MCP SDK/zod; no ov executable or new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-openviking-mirror.md`

## Global Constraints

- Only explicitly bound MD, max 1,000,000 source bytes; no whole-workspace export.
- OpenViking opt-in; absent, invalid or unreachable optional connection must not prevent Docmost startup or turn successful Docmost writes into errors.
- HTTPS remote or loopback HTTP; private API Key file; no credential printing or model-key access.
- Real MCP process lifecycle; readonly zero OpenViking writes; Docmost conflicts never export unconfirmed local body.
- Exact Docmost space/ancestor layout with UUID identity; safe old-path cleanup restricted to ledger-owned assets.
- No cross-system atomicity/CAS/exactly-once claims; uncertain writes first reconcile.
- Only synthetic local Docmost fixtures and authorized OpenViking test-root writes for acceptance.

## Review Focus

- Initial normal create has random block IDs: use empty-create/bind/conditional-resolve; never ignore IDs.
- Lost ACK and crash between targets: preserve exact snapshot and atomically activate outbox with baseline.
- Page title/space/ancestor changes: verify fresh canonical ancestry and clean only owned old locations.
- Delete subtree includes unregistered/previously trashed pages: prove active managed target subset before mutation, then confirm status transition.
- No local ov, remote server failure, EOF and readonly: independent Docmost success and zero hidden background work.

## Task 1: HTTP connection and OpenViking processing client

Owner: client worker. Create `packages/mcp/src/openviking-config.mjs`, `openviking-client.mjs`, and `test/openviking-client.test.mjs`. Root integrates config/index.

Interfaces: `loadOpenVikingConfig(env)` returns undefined when URL absent, otherwise configuration (safe local error state allowed). `createOpenVikingClient(config,{fetchImpl}={})` returns `{identity(signal),read(uri,signal),write(uri,content,signal),reindex(uri,mode,signal),task(taskId,signal),tasks(uri,signal),remove(uri,{recursive=false}={},signal),list(uri,signal),waitProcessed(signal)}`. Responses normalize identity `{accountId,userId}`, resource read string or undefined for confirmed404, reindex `{taskId}`, task `{status,failedRecords,warnings}`, mutation processing states plus safe error codes. The bounded readonly queue barrier returns sanitized historical counts; past errors do not prove the current binding failed. Do not treat envelope status=ok as processing success. Prefix URL root with fixed `/api/v1` paths; redirects rejected; bounded responses and timeout/cancel handling.

- [x] Write behavior tests for absent URL, HTTPS/loopback, private file, authenticated identity, raw read, byte-exact replace, queued/failed processing, reindex/task errors, 404 vs403, redirects/redaction.
- [x] Run the focused test and observe missing-feature failure.
- [x] Implement config and HTTP adapter with full semantic via vectors-only write plus nonrecursive reindex.
- [x] Run focused tests and report exact command/results to root; do not edit integration files or commit.

## Task 2: Docmost hierarchy mapping

Owner: layout worker. Create `packages/mcp/src/mirror-layout.mjs`, `test/mirror-layout.test.mjs`.

Interface: `resolveMirrorLayout({rootUri,origin,workspaceId,pageId},post)` reads pages/info and spaces/info, returns `{uri,pageDirectory,spaceId,pageId,parentIds,title,ancestors}`. `post(path,body)` is fixed existing Docmost client. Detect inaccessible/missing/trashed/cyclic ancestors, wrong canonical identity, unexpected workspace, unsafe names; max ancestry100. URI includes safe human space/title segments with canonical UUID suffixes, deploy hash/workspace and fixed document.md. `isDescendantLayout(layout,rootId)` checks page/root and canonical ancestor IDs for explicit operation candidate proof.

- [x] Add failing tests for spaces, parent-child hierarchy, same titles, Unicode/slashes/traversal, canonical ID mismatches, cycle, unavailable ancestor, move/rename, and stable page identity.
- [x] Observe failure, implement, run focused tests, and report command/results. No mutations or integration edits.

## Task 3: Durable source snapshots and mirror outbox integration

Owner: root. Modify `sync-store.mjs`, `sync.mjs`; create `mirror.mjs` as focused per-binding protocol state machine and relevant manager tests. Preserve old binding files compatibility.

Interfaces: mirror state is optional binding metadata, pinned OpenViking deployment/identity/root, source snapshot hash and confirmed Docmost revision, URI/layout and prior owned URI, phase/task/error. Snapshot store uses atomic owner-only files with UTF8 byte bound and no symlinks. `createMirror(config,{client,post,store,signal})` exposes per-binding prepare/confirm/process/reconcile/status/control and dispose; root may refine signatures before integration, not client/layout interfaces.

- [x] Reproduce initial mismatch/no export, exact snapshot despite later save, lost Docmost ACK restart, OV offline independent success, queued/unknown task recovery, and identity/URI change blocking.
- [x] Prepare snapshot before Docmost conditional write; confirm/activate with baseline in same binding save; recover pending using live and stored revision, no resend.
- [x] Serialize each page, cancel stale pending body on delete, retain uncertain tasks, require current identity/permission before dispatch.
- [x] Read OV baseline before overwriting, verify exact final body and completed semantic/vector work, cleanup only exact owned old assets after successful new path.
- [x] Run affected manager/store tests and old sync tests once stable.

## Task 4: Lifecycle, explicit structural/delete/restore hooks and MCP controls

Owner: root. Modify `config.mjs`, `index.mjs`, `server.mjs`; add stdio tests.

- [x] Add regression tests for config absent no binary, readonly no writes, OV startup failure no Docmost failure, EOF/SIGTERM/restart, and tool result independently reporting mirror state.
- [x] Connect optional HTTP config without breaking authentication CLI or existing tools. Expose mirror status in get_markdown_sync_status; add retry_openviking_sync only when configured writable.
- [x] Capture managed subtree candidates/ancestor relations before explicit delete/restore; durable operation intent; confirm state transition before OV tasks. Failures after Docmost success stay in separate mirror state.
- [x] Notify bound layout after explicit rename/move; use confirmed local source/body version, preserve fixed-space Docmost guards and reject unrelated web bodies.
- [x] Run focused stdio tests, then package full test/build once.

## Task 5: Chinese installation and real acceptance

Owner: root; documentation may be delegated after contracts stabilize. Update `docs/md-auto-sync.md`, `docs/local-mcp.md`, repository Skill references; add `scripts/local-docmost/acceptance-openviking-sync.mjs`.

- [x] Guide optional local/remote URL, private key setup, reused identity, spaces/hierarchy, no ov installation, absence/offline behavior and parent-summary processing, controls and snapshot retention.
- [x] Verify with synthetic local Docmost stdio/real OpenViking under unique test root: creation, update, hierarchy, rename/move, delete/restore, semantic task+readback+retrieval, conflict, OV unavailable and process stop/restart.
- [x] Clean only test resources, temporary credentials/sources/state and dedicated Docmost sessions; record evidence under ignored local data.
- [x] Independent final code review, fix material issues, run covering tests, package build/full suite and single-package install check. No commit/push until explicitly authorized for this new work.

2026-10-14 verification complete: the latest package build and full suite passed 286/286; a fresh independent single-package installation passed the same 286/286, with identical source and tests. Narrow final review confirmed the earlier parent/child dependency cycle was resolved without weakening unknown DELETE fences. Real acceptance was split: the prior main run passed 17 checks before a null-content fixture error; the fixed unconfigured/offline/privacy group passed 7/7; the latest strict deletion/restore group passed 9/9. This is not a claim of a new single 20/20 run. The final deletion group confirmed both page directories, originals, L0/L1 and all six scoped level 0/1/2 queries absent before restore; four fresh full-processing tasks succeeded. Both latest groups cleaned their own pages, space, sessions and private temporary state; revoked sessions returned 401, and test roots were confirmed exactly absent after queue drain and again at least ten seconds later. Remote HTTPS configuration/request tests passed; real acceptance used loopback OpenViking 0.4.19 only. No commit or push.
