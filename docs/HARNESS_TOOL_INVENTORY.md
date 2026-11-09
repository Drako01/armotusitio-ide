# Chat Harness tool inventory (W2)

Compared with Claude Code and Codex CLI, as seen from the Chat Harness (native transport, branch `feat/harness-chat-hardening`). "Mediated" means every use reaches the IDE policy and, when needed, an approval card. Status uses PASS / WARN / NOT IMPLEMENTED / NOT VERIFIED; evidence is a test or a real-provider run.

| Capability | Claude Code | Codex CLI | Harness with Claude | Harness with Codex | Status and evidence |
|---|---|---|---|---|---|
| Read, Glob, Grep, LS | yes | via shell/read | allowed inside the project (`approve` checks the path) | provider sandbox | PASS `native-approve-tool.test.mts` |
| Edit, MultiEdit, Write, NotebookEdit | yes | `apply_patch` | mediated per edit rule (`edit:`), floor protects `.git` and secrets | `file_change` approvals mediated | PASS unit; real Claude E2E in `docs/r8-evidence` |
| Shell (Bash) | yes, auto-approves some read-only commands | yes | every call reaches the IDE policy (`ask` rule outranks Claude's own heuristic) | command approvals mediated | PASS, real Claude M01 (AUD-P1-001) |
| Background shell, KillShell | yes | no | denied (`POLICY_DENIED: background`) | not exposed | NOT IMPLEMENTED by design: background processes outlive the IDE's control |
| Questions to the user (`AskUserQuestion`) | yes | `requestUserInput` | card in the chat | card in the chat | PASS |
| Task list (`TodoWrite`) | yes | plan items | allowed | plan events | PASS |
| Web search | yes | yes | opt-in per project (`WebSearch`) | provider decides | PASS (existing setting) |
| **Web fetch** | yes | no | **asks per host** (`web:<host>` rules, public https hosts only, private names and IPs refused) | not exposed | PASS unit `native-approve-tool.test.mts`; real Claude M03 `docs/r8-evidence/w2-webfetch-real-claude.json` |
| **User MCP servers** | `claude mcp`, `/mcp` | `codex mcp` | **`/mcp add|remove|enable|disable`, per-call card** (`mcp:<server>/<tool>` rules) | **NOT IMPLEMENTED** (needs Codex quota to verify) | PASS unit; real Claude M02 `docs/r8-evidence/w4-mcp-real-claude.json` |
| Git (branch, commit, push, PR, fetch) | via shell | via shell | structured tools with their own cards, protected branches | same tools through the runner | PASS (existing) |
| Delete and move files | via shell | via shell | structured `delete_path`, `move_path` with `edit:` rules | same | PASS (existing) |
| Development secrets | env | env | keychain-backed, redacted | same | PASS (existing) |
| Work Management (ArmoTuSitio MCP) | n/a | n/a | tools through the runner | same | PASS (existing) |
| Sub-agents (`Task`) | yes | no | denied (`tool-unavailable`) | n/a | NOT IMPLEMENTED: the Harness has its own multi-agent workflow with plan, review and fences |
| Skills and custom slash commands | yes | prompts | not exposed | not exposed | NOT IMPLEMENTED |
| Image input, notebooks read | yes | images | not exposed | not exposed | NOT IMPLEMENTED |
| Multiple accounts per provider | one config dir | one `CODEX_HOME` | AI Accounts (isolated config directory per profile, workspace assignment) | same | PASS registry/identity/UI; real second account BLOCKED (needs the owner's second login) |
| Persistent permissions | settings files | config | once / task / session / project / global (inspection commands only) + revoke | same broker | PASS |

## Rules the inventory adds

- `web:<host>` and `mcp:<server>/<tool>` follow the existing grammar (`*` wildcard, deny beats ask beats allow, a project file cannot grant itself `allow`).
- Presets: `readonly` denies both kinds; `dev` and `trusted` ask. Nothing allows them without a rule.
- A user-added MCP server runs with the user's permissions outside the Harness sandbox. Adding one needs an explicit modal confirmation that shows the exact command or URL.

## Not verified

Codex behavior for any row above beyond what existing Codex tests cover, and every row on macOS.
