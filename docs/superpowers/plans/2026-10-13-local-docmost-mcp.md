# Local Docmost MCP Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the adapter and independent agents for API audit, stdio acceptance, and documentation.

**Goal:** Ship a local stdio MCP adapter and usage Skill backed by the user's Docmost API Token.

**Architecture:** MCP clients launch a local Node process; it calls fixed Docmost REST paths with Bearer authentication. Existing server permission and collaboration chains remain authoritative.

**Tech Stack:** Node >=22, installed MCP server SDK 2.3.1, Zod 4.3.6, esbuild 0.28.1, node:test.

**Spec:** ../specs/2026-10-13-local-docmost-mcp.md

## Global Constraints

Publication update: the user explicitly authorized committing and pushing this work to the fork on 2026-10-13. Earlier no-push statements below record the implementation and acceptance phases before that authorization.

- No license bypass, token minting, cookie fallback, shared administrator, or caller userId.
- HTTPS by default; explicit loopback HTTP for local tests only; no redirects.
- Soft delete only; content updates use `/pages/update` with explicit operation.
- No real Token provided: report controlled fixture validation separately from live acceptance.
- Work in the existing user-approved repository; preserve uncommitted work; no commit/push.

## Review Focus

- Redirects or malformed base URLs must not send the credential to another destination.
- Token file errors, upstream echo/errors, and stdio diagnostics must not expose credentials.
- Failed/time-out writes must not be silently retried or claimed rolled back.
- Extra identity/destructive parameters must be rejected before dispatch.
- Empty API success responses and wrapped payloads must map correctly; read-only startup must hide writes.

### Task 1: Configuration and HTTP adapter

Files: `packages/mcp/src/config.mjs`, `api.mjs`, `test/api.test.mjs`, `package.json`, `build.mjs`.

- [x] Add failing node:test coverage for credentials, URL restrictions, HTTPS, Token-file mode, response envelopes, redirects, errors, response bounds and cancellation.
- [x] Implement `loadConfig(env)` and `createApiClient(config, fetchImpl)` with fixed JSON POST, no retries and sanitized failures.
- [x] Run tests to green and build standalone ESM bundle.

### Task 2: Tools and stdio acceptance

Files: `packages/mcp/src/server.mjs`, `index.mjs`, `test/stdio.test.mjs`.

- [x] Expose ten strict-schema tools, field projections, explicit content operation, soft delete and read-only mode.
- [x] Test initialize/discovery/tool calls through an actual spawned stdio process against a controlled HTTP fixture; verify all ten tools, both body operations, 401/403, no userId, no permanent delete, cancellation/unknown write handling, stdout protocol cleanliness, EOF exit.
- [x] Build and run package tests. No real Token acceptance claim.

### Task 3: Skill, deployment instructions and review

Files: `skills/docmost-mcp/**`, `docs/local-mcp.md`.

- [x] Write and validate scoped Skill and Chinese token/license, installation, Claude Code/Codex configuration, usage and troubleshooting guide.
- [x] Verify pack contents, no embedded credentials, local CLI check, and fresh independent review of new package/docs.
- [x] Record final evidence and open the user guide. Leave all changes uncommitted.

## Final evidence

- `pnpm --filter @docmost/local-mcp test`: build succeeded, 21/21 tests passed (8 config/HTTP and 13 spawned stdio tests against synthetic upstream).
- Independent review found two P2 issues: delete/restore must accept UUID, and restoration cascades through all descendants including earlier deletions. Both fixed with RED-to-GREEN tests; documentation and Skill synchronized. No remaining review findings.
- `npm pack`: nine files, source/build/license only; no credentials. Extracted outside the repository, installed production dependencies, and passed 13/13 stdio tests using that extracted entry.
- Skill quick_validate and `git diff --check`: passed. Original local Docmost supervisor still running/ready.
- Actual Token/target deployment acceptance remains unperformed: user supplied no Token and community backend lacks the EE API Key service. No license bypass, browser-cookie fallback, client registration, global Skill installation, commit or push.

## User requirement amendment: defaults and GitHub onboarding

User clarified deployment-root configuration, private Token acquisition/storage guidance, a required default creation space, optional default parent page, and an Agent-readable Chinese GitHub installation path without publishing to npm.

- [x] Require `DOCMOST_DEFAULT_SPACE_ID` UUID in normal stdio startup and `--check`; accept optional `DOCMOST_DEFAULT_PARENT_PAGE_ID` UUID. Permit unconfigured space only for read-only bootstrap `--list-spaces [--cursor value]`.
- [x] Omitted create space uses the default. Omitted parent inherits the configured parent only in the default space; `parentPageId: null` explicitly creates at root. Explicit space/parent overrides remain available. Include effective defaults in identity output.
- [x] Extend `--check` to verify accessible default space and parent-space consistency. Never read or echo the private Token into Agent context.
- [x] Verify new behavior RED-to-GREEN and the documented standalone npm install/build path in an isolated sparse repository layout.
- [x] Rewrite Chinese guide and Skill setup reference for GitHub clone, domain/Token/default selection, client registration, Skill installation and read-only acceptance. Remote installation availability remains pending until the user authorizes publishing the uncommitted files to GitHub.

### Amendment verification

- `pnpm --filter @docmost/local-mcp test`: 33/33 passed (10 configuration/HTTP tests, 23 real stdio/CLI cases against synthetic local API). New configuration and creation cases were observed failing before implementation. UUID case normalization also verified RED-to-GREEN.
- Standalone GitHub-layout installation: repository root retains package.json/workspaces and pnpm-workspace.yaml, with only packages/mcp present; `npm install --workspaces=false` installed five dependencies and `npm run --workspaces=false build` succeeded. Final source passed the same 33/33 tests from this isolated layout. No npm publish or pack step required.
- Fresh independent review found no remaining material defects. Skill validation and shell/JSON/TOML examples passed; installation guide preserves existing client configuration and handles users who know only a parent-page title or URL.
- Remote GitHub installation has not been validated: these files remain uncommitted/unpushed. Actual Token acceptance remains unperformed. Existing local browser WebMCP and Docmost environment were not changed by this amendment.
