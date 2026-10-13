# Local Docmost MCP design

Build a separately deployable stdio MCP adapter using the user's own Docmost API Token. The adapter calls the deployment's HTTPS `/api` endpoints; Docmost determines workspace identity and permissions from the credential. Never mint tokens, impersonate users, use a shared administrator, or alter license checks.

Current community build lacks `ee/api-key/api-key.service`; API_KEY authentication fails. The adapter can be built and verified against controlled contract fixtures, but real Token acceptance requires a licensed, Token-capable deployment and a credential configured privately by the user. Existing browser WebMCP remains available in the community build.

Expose ten tools: identity, space list/details, document search/list/read/create/update, soft delete and restore. Write content as Markdown or HTML through `/pages/update`, including explicit append/prepend/replace, preserving the server's Yjs chain. Soft delete always supplies `permanentlyDelete: false`; it trashes undeleted descendants. Restore revives all descendants, including earlier deletions, but does not restore shares. Delete/restore require canonical page UUID and authorization for the whole affected subtree. No permanent delete or arbitrary URL/userId tools.

Credentials come from `DOCMOST_API_TOKEN` or a private `DOCMOST_API_TOKEN_FILE`, never command-line values, source, logs, or tool results. Pin the configured URL, reject redirects, require HTTPS except explicitly enabled loopback HTTP, bound request time/response size, honor cancellation, and never automatically retry uncertain writes. Optional read-only mode hides mutating tools.

Deliver `packages/mcp` runnable/bundled package, unit and real stdio-to-controlled-HTTP tests, a portable `skills/docmost-mcp` Skill, and Chinese installation/client configuration/self-test instructions. Leave current WebMCP changes untouched. Do not commit/push or configure the user's clients automatically.
