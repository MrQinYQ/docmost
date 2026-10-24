# Multi-project Git Publishing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; the user already approved the scheme and requested implementation. Work in the current checkout without creating a worktree.

**Goal:** Remove per-project MCP Git configuration while preserving existing associations and conflict safeguards.

**Architecture:** A repository-reader registry resolves explicit per-call context or the legacy default. Git publication scopes all operations to stable commonDir identity; synchronization recovery reads each binding's own repository. Service-level state enables tools independently of knowledge provider or a fixed Git root.

**Tech Stack:** Existing Node/Git/MCP SDK and node:test; no new runtime dependency.

**Spec:** ../specs/2026-10-24-multi-project-git-design.md

## Global Constraints

- Current checkout, no worktree, no actual project commit/push; preserve legacy records in place.
- repositoryRoot is detected by Skill, not manually configured by end users or inferred from the MCP process cwd.
- Same ledger and page leases; explicit cross-repository batch IDs fail before any write.
- Fixed committed Markdown, CAS and branch conflicts remain mandatory; optional knowledge failure stays independent.
- Preserve old default-root calls and all MD/page sources. No ov CLI or business-document mutations.

## Review Focus

1. Two repositories share identical branch names, initial commits and document paths: commonDir scopes selection. Task 1 regression.
2. Linked worktree changes invocation root: stable repository identity prevents duplicate source enrollment. Task 1 regression.
3. Old records without Git configuration after restart: bindingId/pageId and pending recovery remain unchanged. Task 1 regression.
4. Explicit bindingIds mix projects: reject entire request before the first upload, including stale IDs. Task 1 regression.
5. A repository disappears or changes identity: unrelated projects stay usable; retry uses confirmed Git data. Task 1 regression.

### Task 1: Repository routing, persistence compatibility and stdio

Files: new packages/mcp/src/git-repositories.mjs; modify git-publication.mjs, sync.mjs, server.mjs, index.mjs; tests git-multi-project.test.mjs, git-stdio.test.mjs.

Interfaces: registry.open(root), registry.forBinding(binding, root?); manager methods retain old names plus optional repositoryRoot on bind/publish/status/resolve. Snapshot exposes repository root and stable id. Existing state schema is retained.

- [x] Add real Git fixture regressions for the five review inputs, missing context, root/state separation and rootless stdio discovery. Run and observe missing behavior failures.
- [x] Implement registry and source dispatch; keep identity/lease/CAS gates. Load Git records without a fixed configured root and isolate invalid repositories by binding.
- [x] Register tools with service state, including provider=none; validate context path before I/O. Run focused Git and legacy MD/page checks; fix affected failures.

### Task 2: Automatic Skill discovery and installation guidance

Files: inspect-git.mjs + helper tests; git-delivery Skill/reference; docmost-mcp setup/tool-contract; docs/git-delivery.md and local-mcp.md.

- [x] Reproduce inspection from a project subdirectory; test detected canonical root without changing index/files. Implement upward discovery.
- [x] Teach Skill to pass detected root on each relevant call, filter associations, and avoid per-project config edits/restarts. State once-only private storage and legacy compatibility.
- [x] Validate Skill and run a fresh independent behavior scenario using two temporary projects on one synthetic connection.

### Task 3: Real acceptance and final review

Files: scripts/local-docmost/acceptance-git-delivery.mjs; private reports under ignored data/local-docmost.

- [x] Use one rootless stdio process/state for two same-named files on two distinct pages. Verify sequential/concurrent publication isolation, restart of old records, and preserved CAS/branch behavior.
- [x] Verify personal/shared complete-original knowledge sync with actual service; no ov. Clean test pages, mirror namespaces, sessions and private session files.
- [x] Run complete MCP suite/build, installed Skill validation and diff checks. Perform one independent final review; reproduce and fix material findings in one pass, then final full suite.
- [x] Install same-version Skill guidance with backup; leave project changes uncommitted and report exact evidence and boundaries.

Final review amendment: add persisted directory-instance fingerprint and enrolled tree prefix. Early records without identity are retained but paused until explicit trusted-source confirm-repository; no content-based claim of physical identity. See spec and execution ledger.

Validation: final MCP suite/build 418/418, installed Skills validated and source-equal; live final core 8/8 plus personal/shared knowledge run 9/9, both reports zero failures and complete cleanup. Runtime install copy backed up and updated, config/credentials/ledger preserved.
