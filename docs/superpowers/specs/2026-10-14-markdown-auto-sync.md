# Markdown auto sync

The user approved local Markdown → Docmost auto sync, following the actual MCP process lifetime, pausing on conflicts, with real local acceptance. The process must not remain as an independent daemon. No AI/model calls are needed for saves.

## Scope and configuration

Opt in with `DOCMOST_SYNC_ROOT` (an existing absolute directory) and `DOCMOST_SYNC_STATE_DIR` (an absolute private directory outside the source root). Without both, existing 22 tools and startup behavior remain unchanged. `DOCMOST_READ_ONLY=1` never uploads. Node >=22; use built-in filesystem/crypto APIs and the existing SDK/zod only.

Only explicitly bound relative `.md` files may be read/uploaded. Reject absolute paths, traversal, symlinks and non-regular files; enforce a 1,000,000-byte UTF-8 source bound and refuse blank content. Bindings pin origin, authenticated user/workspace, canonical page UUID and space UUID. Default creation settings never retarget a binding. Keep metadata/state in owner-owned private storage (directories 0700, files 0600), not Markdown front matter or source files; never save credentials or whole document bodies in sync state.

Binding records current local and remote baselines without an initial upload. With `enabled=true` the next saved content is authorized to replace the whole bound page body. Only body is synchronized; deleting/renaming/temporarily emptying the file does not delete or clear the remote page. Pictures/attachments and reverse synchronization are outside this release.

## Service protocol and conflict safety

`POST /api/pages/sync-state`: `{pageId, content?: Markdown}` → `{pageId,spaceId,workspaceId,revision,persistedRevision,proposedRevision?}`. Current revision comes from the live owner Ydoc, not the DB snapshot; persisted revision independently comes from stored content. The optional proposed revision uses the same deterministic Markdown/editor normalization as replacement. View permission and active same-workspace page required.

`POST /api/pages/sync-update`: `{pageId,content: Markdown,expectedRevision,expectedSpaceId,expectedWorkspaceId}`. Check edit permission and fixed target context, then compare revision inside the owner's synchronous Ydoc transaction before replacing. Hold the source space hierarchy guard shared with page moves through validation/CAS/durability verification, and re-read active page/context under that guard. A preview→space move or owner-load→space move must reject before applying content. Conflict returns HTTP409 and never applies sync changes or updates sync metadata. Return verified live/persisted revisions on success; failed durability verification returns an unconfirmed error. Preserve Redis-owner routing and no-Redis dispatch. Stable hashes preserve semantic attributes; Markdown-generated IDs must be deterministic. No license changes, database replacement, or credential impersonation.

A server without these endpoints is unsupported for automatic uploads. Never fall back to `/pages/update` after a capability error. Atomic revision comparison protects changes already received by the document owner; it cannot order messages that have not arrived at the server or prevent subsequent authorized browser edits.

## Runtime and recovery

Debounce save events by 1000ms and serialize work for each binding. Watch parent directories so atomic editor saves remain detectable, with a bounded periodic file check as fallback. Load/check existing baselines on startup; do not blindly replay. A local-only change can upload after live remote validation. Remote changes pause with `CONFLICT`; changed identity/space, missing file, permission/expiry, unsupported service or invalid local data block uploads with actionable state.

Persist a pending intent before sending any mutation: local hash, expected revision, proposed revision. On success, read back and advance baselines only when live and persisted revision confirm the target. A timeout, cancellation, network error or unconfirmed persistence must not automatically resend. Reconcile pending state using its proposed revision; otherwise pause as unconfirmed or conflicted. Do not confuse byte differences after Markdown/editor round trips with remote conflicts.

Use one lease per target page under shared state storage; another process cannot upload the same binding concurrently. Do not steal live locks; report stale-lock recovery explicitly rather than silently deleting an uncertain lease. SIGINT/SIGTERM/stdin EOF stop new scheduling, abort requests, persist pending state and release owned leases. Normal shutdown leaves no background children/timers. An already dispatched write may complete.

## MCP controls

When configured, add local extension tools: `bind_markdown` (`filePath,pageId,enabled=true`), `get_markdown_sync_status` (`bindingId?`), `set_markdown_sync` (`bindingId,action=pause|resume|unbind`), `resolve_markdown_sync` (`bindingId,expectedRevision`). List status is cached; a single-binding status queries current live/persisted revisions as `currentRevision/currentPersistedRevision`, preserving baseline and never uploading. Resume does not reset a conflicting baseline. Resolve explicitly accepts/merges local content against the caller's observed current revision and resumes only after a conditional verified write. Unbind may acquire the old target's free local lease to remove metadata even after identity/root changes, without remote writes or source reads; real lease occupation still blocks it. Read-only mode exposes status only. Status excludes bodies/credentials and reports concrete state, target IDs and safe error codes.

## Acceptance

Verify real stdio sessions on isolated loopback Docmost: bind, normal save, rapid/atomic saves, live browser/Yjs conflict before DB persistence, pause/resume, explicit resolution, reader403, unsupported deployment, duplicate-process lease, EOF/termination stopping updates, restart reconciliation and no residual sessions/files. Use synthetic local accounts; never write company documents. Update Chinese GitHub installation/self-test and the portable Skill.
