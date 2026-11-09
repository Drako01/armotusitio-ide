# AI accounts, permissions and MCP servers in the Chat Harness

## AI accounts

Several accounts per provider (Claude Code, OpenAI Codex), each with its own private directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) under the IDE's storage, so credentials, settings and sessions never mix. The IDE never asks for or stores a password or token: sign-in is the provider's own `claude auth login` / `codex login`, opened in a terminal that carries only that profile's directory.

- **Add**: Command Palette `ArmoTuSitio: Agregar cuenta de IA`, or `Agregar cuenta` in the AI Accounts tab. Steps: provider, alias, isolated directory, official sign-in, automatic verification when the terminal closes, then the offer to use the account in this workspace (with a retry if no session was detected).
- **Choose**: the chat selector is Provider, Account, Model. The choice applies to new runs. If the conversation started with another account, the chat says so ("this conversation continues with X; the next message will use Y"). A model list and default come from the selected account's own settings.
- **Resolution**: workspace assignment, then the provider default, then the IDE's own session. A failed login is never replaced by another account.
- **Manage**: tab `AI Accounts` (`atsHarness.accounts.open`) or `ArmoTuSitio: Cuentas de IA`. In a window with several folders a picker chooses which folder the screen manages.
- **States** (text + icon, never color alone): authenticated, no session, unknown, CLI unavailable, connection failed, connecting. `expired` and `reauthentication required` are not reported because the CLIs do not expose them.
- The multi-agent workflow runs its providers under the project's assigned account too.

## Permissions

Answers on an approval card: once, this task, this session, this project, and (only for inspection commands such as `docker ps`, `terraform version`, `kubectl version`) all projects. Manage and revoke with `/permisos` in the chat or `ArmoTuSitio: Permisos`. Temporary grants are revoked when the permission preset, the Codex sandbox or the chat mode changes. Rule grammar in `native-permissions-types.ts`, including `mcp:<server>/<tool>` and `web:<host>`.

## MCP servers (`/mcp`)

```
/mcp                                        list servers (and the Work Management tools when connected)
/mcp add NAME URL|COMMAND [ARGS] [--token] [--env VAR ...]
/mcp remove NAME     /mcp enable NAME     /mcp disable NAME
```

- Remote servers need `https://` (plain `http://` only for localhost). Local servers are a command with arguments, never run through a shell.
- Remote servers with OAuth: `/mcp add NAME URL --oauth` signs in in your browser (discovery, dynamic client registration, PKCE S256, loopback redirect); tokens live only in secret storage and are renewed before each run. A server that cannot renew is left out and `/mcp` says it needs a new sign-in. Servers without dynamic registration need `--token`.
- Secrets are never typed in the chat: `--token` and `--env VAR` open a masked prompt and are kept in the IDE's secret storage.
- Adding a server needs one modal confirmation that shows the exact command or URL. Every tool call still asks (`mcp:<server>/<tool>` rules can allow a specific tool).
- Today only Claude Code conversations use these servers, from the next conversation (`Empezar de nuevo`).

## UX self-assessment (evidence only)

No composite score is claimed. Measured: all states have text and icon; keyboard focus survives redraws; 360 px has no overflow; dark and light renders (`docs/r8-evidence/accounts/`); cross-window storage is locked. NOT VERIFIED: screenshots of the compiled IDE, high-contrast themes, NVDA/VoiceOver, macOS, real second accounts of each provider, and Codex for MCP.
