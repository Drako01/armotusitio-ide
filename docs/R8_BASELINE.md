# r8 baseline and frozen acceptance scenarios

Recorded on 2026-11-07, before any r8 code change. This document freezes the targets: scenarios, tasks and faults below are not edited after implementation starts (rule 1 of the r8 Definition of Done). Results live in [R8_TEST_EVIDENCE.md](R8_TEST_EVIDENCE.md).

## 1. Starting point

| Item | Value | How it was obtained |
|---|---|---|
| r7 effective commit | `91d5d772ec2` (PR #69, squash-merged into `main`) | `git log --oneline -1 origin/main` |
| r8 branch | `feat/r8-native-runtime`, created from `91d5d772ec2` | `git checkout -b` |
| OS | Windows 11 Pro 10.0.26320, x64 | environment |
| Node.js | v24.22.1 | `node --version` |
| Claude Code CLI | 2.1.316, native installer at `~/.local/bin/claude.exe` (not on `PATH`; the IDE resolves it, r7) | `claude.exe --version` |
| Codex CLI | codex-cli 0.166.0 (npm shim) | `codex --version` |
| Codex auth | ChatGPT login, plan `plus` | `codex login status`, `account/updated` notification |
| Claude auth | claude.ai subscription login through the CLI (no API key on this machine) | r7 real call `WP9_MARKER_42` |
| Shells | PowerShell 7, Git Bash / MSYS2 ucrt64 | environment |

## 2. Protocol discovery (no tokens consumed)

### Codex `app-server`

- `codex app-server generate-ts` and `generate-json-schema` produce the bindings of the installed version: 97 root types and 664 `v2` types. The IDE vendors the closure it uses (see R8_ARCHITECTURE.md §4) and pins the generator version.
- Live handshake: `initialize` (with `capabilities.experimentalApi: true`) answered in 727 ms with `userAgent .../0.166.0`, `platformFamily: windows`; `thread/list` and `model/list` answered without a model call.
- Client requests used by r8: `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt`.
- Server-initiated requests handled by r8: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` (experimental), `mcpServer/elicitation/request`. Legacy `execCommandApproval` / `applyPatchApproval` are v1 and are declined.
- Notifications consumed: `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `thread/status/changed`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `error`, `serverRequest/resolved`.

### Claude Code CLI 2.1.316

- `--print --input-format stream-json --output-format stream-json --verbose`: one process receives several user messages on stdin (bidirectional streaming input).
- `--include-partial-messages`: token-level deltas.
- `--session-id <uuid>` (new session with a known id), `--resume <id>`, `--fork-session`.
- `--permission-prompts host` + `--permission-prompt-tool <mcp tool>`: every permission prompt is answered by the IDE (r7 pilot).
- `--permission-mode` accepts `default`, `manual`, `plan`, `acceptEdits`, `dontAsk`, `auto` and `bypassPermissions`. r8 uses `default` (writer) and `plan` (conversation) and never `bypassPermissions`.
- Claude Agent SDK (route B): **not used**. There is no Anthropic API key on this machine, and the SDK must not reuse a claude.ai subscription login in a third-party product without Anthropic's authorization. Route A (the installed CLI) covers the contract.

## 3. Capability matrix of the installed versions

`supported`: documented and probed. `experimental`: offered by the protocol behind an experimental flag. `unavailable`: not offered by the installed version.

| Capability | Claude CLI 2.1.316 | Codex 0.166.0 app-server |
|---|---|---|
| Persistent bidirectional session | supported (stream-json in/out) | supported (JSON-RPC over stdio) |
| Token streaming | supported (`--include-partial-messages`) | supported (`item/agentMessage/delta`) |
| Resume by id after restart | supported (`--resume`) | supported (`thread/resume`) |
| Fork | supported (`--fork-session`) | supported (`thread/fork`) |
| Interrupt a running turn | supported by stopping the process; the session stays resumable | supported (`turn/interrupt`) |
| Steer a running turn | unavailable (input waits for the next turn) | supported (`turn/steer`) |
| Host-answered approvals | supported (`--permission-prompt-tool`) | supported (server requests) |
| Agent questions to the user | supported (`AskUserQuestion` through the permission prompt) | experimental (`item/tool/requestUserInput`) |
| Incremental command output | unavailable (result only) | supported (`item/commandExecution/outputDelta`) |
| MCP tools | supported (`--mcp-config --strict-mcp-config`) | supported (`config.mcp_servers`) |
| Reported usage / limits | usage per turn | `thread/tokenUsage/updated`, `account/rateLimits/updated` |

## 4. r7 results reused (not re-run unless affected)

| Suite | r7 result |
|---|---|
| Extension suite (`npm test`) | 631 tests: 624 pass, 0 fail, 7 skip |
| Conformance (`npm run check:conformance`) | 120 tests: 119 pass, 1 skip (symlinks need privileges on Windows) |
| Release script tests | 15/15 |
| Typecheck, ESLint, hygiene | clean |
| Real Claude native pilot | 1 call, approval card answered "once", command ran (`WP9_MARKER_42`) |

## 5. Performance baseline (DoD-08)

Procedure: `node extensions/armotusitio-ide/test/native-event-bench.mts structured 5000` (5,000 Claude stream-json events plus 5,000 Codex events, half text and half tool lifecycle). It measures the IDE's own time per event in the r7 structured parsers, on this machine with no other load. It ran three times:

| Run | events | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| 1 | 10,004 | 0.003 | 0.005 | 1.435 |
| 2 | 10,004 | 0.003 | 0.006 | 1.426 |
| 3 | 10,004 | 0.003 | 0.005 | 1.631 |

The comparable operation for the r8 native path is the same corpus through the native parsing path (adapter, event bridge, chat hooks), run with the same command and the `native` argument. A second comparable operation, "time from send to first event" on a follow-up turn, is measured against fake providers that run as real processes, for both transports.

## 6. Frozen scenarios

### 6.1 Conformance scenarios S01–S20 (plan §WP9)

These are the 20 scenarios of the plan, unchanged. A scenario that needs a real provider is run against the real CLI. Scenarios that need fault injection use protocol-faithful fake providers, run as real child processes.

### 6.2 Autonomy tasks A01–A10 (DoD-06)

Each task runs in a fresh temporary git fixture: a small Node project with `node --test` tests and a `check` script. The prompt is a single user message. "Without intervention" means no message after the first; approval cards answered by policy or by the scripted user count as legitimate authorizations. A task passes when its objective check passes after the run.

| ID | Task | Objective check |
|---|---|---|
| A01 | Fix the failing unit test in `src/math.js` | `node --test` exits 0 |
| A02 | Add `slugify(text)` to `src/text.js` with tests | new test file exists and `node --test` exits 0 |
| A03 | Rename `src/util.js` to `src/strings.js` and update every import | old file gone, `node --test` exits 0 |
| A04 | Make `npm run check` pass (a script that rejects `var`) | `npm run check` exits 0 |
| A05 | Add a `--verbose` flag to `bin/cli.js` and document it in README | `node bin/cli.js --verbose` prints `verbose`, README mentions it |
| A06 | Answer which function formats currency, read-only | answer names `formatCurrency`, tree unchanged |
| A07 | Create branch `feat/greeting`, commit the change with a conventional message | branch exists, HEAD message matches `^feat` |
| A08 | Count `TODO` lines across `src` and write the number to `todo-count.txt` | file holds the right number |
| A09 | Run `npm run build` (fails without `--prod`), diagnose and make it pass | `npm run build -- --prod` or the fixed script exits 0 |
| A10 | Delete the obsolete `src/legacy.js` and its test with the IDE tools, keep tests green | files gone, `node --test` exits 0 |

### 6.3 Recoverable faults R01–R10 (DoD-07)

"Resolved automatically" means that the next user action succeeds without manual cleanup, and that no non-idempotent operation runs twice.

| ID | Fault | Expected recovery |
|---|---|---|
| R01 | Provider process dies mid-turn | turn marked `lost`; the next send resumes the native session |
| R02 | IDE restart while the session is idle | session reopened by its native id, context preserved |
| R03 | IDE restart while streaming | turn reported as interrupted (connection lost), never replayed; session resumable |
| R04 | IDE restart while awaiting approval | pending approval denied, no phantom grant; session resumable |
| R05 | Malformed or unknown line from the provider | bounded diagnostic; the session continues |
| R06 | Provider exits during the handshake | one automatic retry, then `failed` with an actionable message |
| R07 | Provider stops answering a request | request timeout, process restarted, session resumed |
| R08 | Stored native id is unknown or expired | new session with an explicit handoff notice; no invented history |
| R09 | Corrupt session registry | registry quarantined, chat history intact, new sessions work |
| R10 | Incompatible CLI or protocol version | clear message and safe fallback to `structured` |

### 6.4 Critical capabilities for parity (DoD-12)

C01 multi-turn session · C02 token streaming · C03 tool lifecycle events · C04 approvals answered in the chat (once, task, session, always, deny) · C05 cancellation · C06 resume after IDE restart · C07 agent question answered in the chat · C08 file edits with diff and rollback · C09 terminal commands with exit code · C10 git structured tools · C11 MCP tools · C12 provider switch with handoff · C13 project-Harness delegation · C14 multiroot isolation · C15 usage reported only when the provider reports it.

### 6.5 Exclusions declared before implementation (`N/A`)

| Item | Reason |
|---|---|
| Claude Agent SDK (route B) | No API key; subscription login must not be reused in a third-party SDK product. Route A covers the contract. |
| Opening a real pull request on GitHub inside E2E | External, outward-facing action on a real account. Branch, commit and push run against a local bare remote. PR upsert keeps its contract tests with a fake `gh`. |
| 100 consecutive runs against real providers (DoD-09) | Quota cost. The 100-run stability batch uses protocol-faithful fake providers run as real processes. Real providers are covered by the per-provider E2E runs. |
| Claude incremental command output | Not offered by the CLI (result only). |
| Claude mid-turn steering | Not offered by the CLI. Messages queue for the next turn, as in r7. |
