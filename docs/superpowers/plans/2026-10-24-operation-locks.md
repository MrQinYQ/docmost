# Operation-scoped Sync Locks Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. User chose release-at-completion; continue in current checkout without a new worktree.

**Goal:** No idle page ownership; release on successful, failed and cancelled work while preserving cross-process ledger consistency.
**Architecture:** Shared-state operation mutex, fresh ledger under mutex, async-local work scope spanning server hooks and remote writes; page leases acquired lazily and released in finally.
**Tech Stack:** Existing Node 22+, filesystem and node:test; no runtime dependency or daemon.
**Spec:** ../specs/2026-10-24-operation-locks-design.md

## Global Constraints

- Current checkout; no commit/push, business writes, credential changes or new worktree.
- Preserve explicit MD watching, CAS, Git conflicts, pending intents and knowledge tasks.
- No locks while idle; success/error/cancel release in finally. Read-only status does not own page locks.
- Shared state writes serialize and reload durable records; live/unknown legacy owners are never reclaimed.

## Review Focus

1. Two idle managers and two real stdio processes must publish sequentially using the newest ledger, without duplicate upload. Task 2.
2. A process crashes while owning operation and page locks: unique dead tickets and legacy page leases recover safely; live owners remain protected. Task 1.
3. A tool has before/write/after hooks: scope covers the remote mutation and cancellation; metadata cannot escape early. Task 2.
4. Pending acknowledgement and remote knowledge tasks survive release and another process resumes without replay. Task 2.
5. Two enabled MD watchers observe one save: refresh after mutex and release, exactly one Docmost upload. Task 2.

### Task 1: Durable finite work mutex and lease release

Files: sync-store.mjs, new sync-work.mjs, test/operation-locks.test.mjs.
Interfaces: store.acquireOperation(signal)/releaseOperation(ticket); createSyncWork({getStore,refresh,signal,readOnly}) -> run(fn), acquire(binding), idle(), detach(fn).
- [x] Write idle/reuse/failure/dead-owner/live-owner/cancellation regressions and observe RED.
- [x] Implement unique participants ordered by ticket/nonce, dead PID handling and bounded wait; page reclaim only inside operation mutex.
- [x] Implement reentrant async-local work scopes; finally releases owned pages then operation ticket. Focused tests green.

### Task 2: Runtime integration and batch acceptance

Files: sync.mjs, git-publication.mjs, server.mjs, affected stdio/manager tests, Skill/docs, real acceptance script.
- [x] Route direct methods and server hooks through finite work, reload ledger before writes, keep cached runtime queues/watchers while replacing stored fields. Background callbacks detach from prior scope.
- [x] Remove idle lease guards; lazily acquire pages for actual work, constrain polling to pending work. Read-only refresh never locks.
- [x] Add two-process and duplicate-watcher tests, preserve unknown-write/CAS/knowledge tests, update obsolete lifetime-lock assertions.
- [x] Update guides; run full MCP suite/build and real local Docmost multi-instance acceptance. One final independent review; one material-fix pass and final checks.
- [x] Back up and update installed code/Skills without changing config/credentials/state; report remaining old-runtime reconnect requirement.

Validation: final npm test 430/430, no failures/skips; real final core 9/9 plus full personal/shared knowledge 11/11, both clean. Two independent review findings reproduced and fixed; installed runtime/Skills backed up, validated and source-equal. Own local test supervisor stopped. Existing old client processes need a normal reconnect to load new code; no business connections were terminated.
