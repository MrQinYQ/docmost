# Community session implementation plan

User approved the email/password personal-session scheme. Existing implementation is in the working repository; preserve unrelated `.vscode` settings and the running Docmost environment. The user previously authorized pushing this MCP delivery and then approved this corrective personal-session scheme; publish the verified follow-up to the same fork.

- [x] Session credential module and meaningful RED-to-GREEN tests: cookie parsing, token kind, identity/current-session verification, private bound files, expiry, atomic write and logout.
- [x] Hidden local-terminal email/password prompts and input/restoration tests; reject non-TTY and Ctrl+C without exposing input.
- [x] Wire explicit auth mode into configuration, API error hints and CLI login/logout while retaining existing key mode/defaults. Password never reaches MCP tools.
- [x] Update Chinese GitHub guide and repository Skill setup for community session mode; clearly identify unsupported MFA/SSO and old non-revocable sessions.
- [x] Run complete MCP tests and live local community acceptance without displaying fixture credentials, then obtain independent review and repair important findings. Publish the verified corrective implementation to the previously authorized fork.

## Verification and review

- Package build and full suite: 79/79 passed; isolated GitHub single-package layout passed the same suite. Original API-Key behavior retained.
- Hidden terminal module: fake-TTY tests plus real PTY; complete real CLI login used only synthetic local acceptance accounts and never printed their password or credential.
- Real local community service: reader read/denials, writer stdio default creation/append/read/trash, logout/replay 401; dedicated sessions revoked and temporary credentials removed.
- Independent source and onboarding reviews completed. Important stale-logout race fixed with locked expected-session comparison; core and two-process CLI regressions RED-to-GREEN. Additional runtime expiry and old non-revocable-session diagnostics verified RED-to-GREEN.
- Skill validation and documentation examples passed. No company credentials, global client/Skill settings, or company deployment changed. Production acceptance requires the user's own private terminal login.
