# Local MCP tool alignment

The user requested alignment with every tool named in the official Docmost MCP guide. This extends the previously delivered local MCP and community-session login; it does not change authentication or the browser WebMCP.

The current official guide names 20 tools, without publishing their input schemas. Match those names and documented operations using audited REST DTOs/controllers/services. Keep recoverable `delete_page` and `restore_page` as two extensions. Normal discovery must expose 22 tools; read-only mode must expose exactly the 10 readers.

1. Add failing stdio-to-local-HTTP contract tests for the 12 missing tools, strict inputs, projections, canonical page IDs, explicit destinations and capability errors.
2. Extend the fixed API whitelist and register child listing, copying/moving, space creation/update, plain-text comments, attachment search and workspace member listing.
3. Preserve community sessions, default create-page space/parent rules, bounded requests, cancellation, secret projection and no automatic write retries. Resolve IDs before moves; never inherit the default space for copying or moving. Describe copy visibility and saved-snapshot limits.
4. Update the Chinese GitHub installation guide and repository Skill to list all tools and source-backed limits. Attachment search needs this fork's endpoint; known missing routes must report `UNSUPPORTED_DEPLOYMENT`, ordinary resource 404s remain `NOT_FOUND`.
5. Run the complete package tests, independently review the change, and verify new tools with real local community sessions and permission roles. Rebuild/test the GitHub sparse-install layout before delivery.
