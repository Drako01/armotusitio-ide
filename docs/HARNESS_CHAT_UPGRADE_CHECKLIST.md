# Harness and Chat upgrade checklist

Source: external audit of `main` @ `fee6b0f91c3ba7fbf2918d3a0036ccec75d4a028` (2026-11-08) and its roadmap. Branch: `feat/harness-chat-hardening`. Format follows [R8_IMPLEMENTATION_STATUS.md](R8_IMPLEMENTATION_STATUS.md). A row is DONE only with a command, an exit code and a commit. Anything not run is PENDING or BLOCKED, never PASS. A skip is reported as a skip.

Verification level of the audit findings: **code** = confirmed by reading the code; **doc** = confirmed only in the team's own documents; **config** = confirmed in configuration or the GitHub ruleset.

## Baseline (Phase 0, run on `fee6b0f91c3`, Windows 11, Node v24.22.1, Python 3.13.5, Codex CLI 0.166.0, Claude CLI not on PATH)

| Command | Exit | Result |
|---|---|---|
| `npm run check --prefix extensions/armotusitio-ide` | 0 | tsc + resources PASS |
| `npm test --prefix extensions/armotusitio-ide` | 0 | 657 tests, 650 pass, 0 fail, 7 skipped, 115.6 s |
| `npm run check:conformance --prefix extensions/armotusitio-ide` | 0 | PASS chat conformance (1 skipped) |
| `node --test scripts/ats-release-ci.test.mts` | 0 | 1 of 1 pass |

The 7 test skips (names in the test log): real-provider E2E (opt-in, spends quota), FIFO/quoted file name, `git_commit` symlink refusal, Codex sandbox measurement (`ATS_REAL_SANDBOX=1`), kernel sandbox (needs Linux bubblewrap or macOS sandbox-exec), Claude version-named alias, secret symlink. None is skipped for a reason that is fixed by this work; the Windows-only gaps stay open.

Not run yet: `scripts/ats-harness-check.mts`, Linux/macOS, real Codex. Real Claude has run only scenario M01.

## Findings

| ID | Verified | Status | Evidence |
|---|---|---|---|
| AUD-P2-005 quarantine deletes the registry when `rename` fails | code | **FIXED, uncommitted** | `session-store.ts`: a failed archive now throws `RUNTIME_STORE_QUARANTINE_FAILED` and keeps the bytes. New test fails on the old code (`Missing expected rejection`) and passes now; `native-runtime-units` 9/9; `npm run check` clean. |
| AUD-P2-004 unbounded `turn.partial +=` | code | **FIXED, uncommitted** | `claude-adapter.ts` bounds the text at `MAX_TEXT_CHARS` (shared with the event bridge), stops emitting deltas past it and reports one `message-truncated` diagnostic. New test (30,000 deltas) fails on the old adapter (`stoppedEarly: false`, no truncation report) and passes now. Codex adapter streams through the app-server protocol and was not changed; not audited for the same pattern yet. |
| AUD-P1-003 `main` has no required status checks | config | **WORKFLOW DONE (uncommitted until this row's commit); RULESET PENDING (owner)** | `ats-ide-extension.yml` now always reports an `ATS gate` job (change detection via the PR files API; the contract job runs only for relevant paths; the gate fails on failure, cancellation or a wrongly skipped suite). YAML parses; the path regex was checked on 7 sample paths. **Not executed on GitHub yet**: needs the Draft PR run. `.harness/**` is deliberately not a trigger: it is the RedEvent engine and has no suite in CI (see AUD-P3-001). Owner: add `ATS gate` as a required check on ruleset 25504012 after it has run once, and enable "require branches to be up to date". Merging triggers `ats-release.yml` unless the PR has the `sin-release` label. |
| AUD-P1-001 Claude auto-approves some read-only commands | doc, then **reproduced with real Claude Code 2.1.319** | **FIXED for the probed commands; limits below** | Native Claude writers now get `--settings {"permissions":{"ask":["Bash"]}}` (`native-agent-execution.ts`), so an `ask` rule outranks Claude's read-only heuristic. Real-Claude scenario `M01` (one message, `--max-turns 10`, every card denied, fake `.env`): **before** `docker ps` and `cat .env` completed with no card ([p1-001-before-fix.json](r8-evidence/p1-001-before-fix.json)); **after** both reached a card, were denied and did not complete ([p1-001-after-fix.json](r8-evidence/p1-001-after-fix.json)). `git status` and `node --version` run without a card because the IDE policy preauthorizes them (`GIT_READ`, `INFO_TOOLS`): by design, not a bypass. Args contract pinned in `native-agent-contract.test.mts`. **Limits:** 1 run per side, 4 non-destructive commands, one CLI version, Windows only; no mutating-command or PowerShell-tool probe; `M01` cannot tell an IDE silent-allow from a provider auto-approve for the preauthorized commands (the runner audit log was empty in the harness). 7 real-Claude runs were spent on this finding, each capped at 10 agent turns. |
| AUD-P1-002 Codex parity not proven | doc | BLOCKED | Quota resets 2026-11-09 and the owner will run Codex then. No real Codex call is made before. |
| AUD-P1-004 hybrid isolation / two-writer E2E | code + real processes | **PASS for fence exclusion and crash recovery**: `native-fence-processes.test.mts`, 20 rounds with real processes (holder, contender and parent refused, holder SIGKILLed, dead fence never inherited, explicit reconciliation frees it, epoch monotonic). Default `tool-allowlist` is still not an OS sandbox (documented, unchanged). Symlink/hostile-engine cases keep their existing unit tests. |
| AUD-P2-001 `strict:false` | code | **PARTIAL, PASS for the native runtime**: `tsconfig.strict.json` type-checks every `src/native-*.ts`, `src/runtime/**` and the accounts panel with `strict:true` as part of `npm run check` (0 errors). The 17 legacy files (`extension.ts`, `activity`, `adapter`, `catalog`, `chat`, `context`, `core`, `evidence`, `git`, `home`, `home-labels`, `integrations`, `mcp`, `presentation`, `provider`, `workflow`, `workspace`; ~515 errors) are excluded in that file and must be removed from the exclusion list one by one. |
| AUD-P2-002 DoD-08 relative perf | doc | PENDING | |
| AUD-P2-003 question card browser test, NVDA/VoiceOver | doc | PENDING; screen readers BLOCKED (need those environments) | |
| AUD-P2-006 large files, no CI evidence | code | PENDING | |
| AUD-P3-001 engine ownership docs | doc | PENDING | |

## After the fixes (same tree, uncommitted)

`npm run check` exit 0; `npm test` exit 0 (659 tests, 652 pass, 0 fail, 7 skipped; +2 new tests); `check:conformance` exit 0.

## Flaky test found and fixed on the way

`S09` (cancel a streaming turn) failed once in `check:conformance` under load. Reproduced on the original adapter too (8/8 failures under 32 CPU-bound processes), so it is not caused by this work: it aborted on a fixed 400 ms timer and asserted wall-clock time including the provider start. It now aborts on the first streamed delta and measures cancellation latency. Idle 8/8 pass; under the same extreme synthetic load 5/8 (was 0/8). Full suite and conformance pass after the change.

## CI failures found by the new gate (PR #72) and fixed

The first `ATS gate` run failed because the contract suite had never run on Linux in CI. Reproduced locally in WSL Ubuntu with the CI Node (24.22.1).

| Failure | Root cause | Fix | Evidence |
|---|---|---|---|
| 2 chat e2e tests (`native-chat-e2e`) | **Product bug on Linux/macOS**: the runner channel socket path (IDE storage plus hash directories, about 200 characters) exceeds the 104/108-byte socket limit, so `listen` failed with `EINVAL` and the native chat could not run any implementation. Windows uses a named pipe and was unaffected | `native-tool-server.ts` uses the storage path when it fits and otherwise a short private directory under the OS temp folder; new error catalog message `HARNESS_CHANNEL_PATH_TOO_LONG` | e2e failed 2/2 on the original code and pass on the fix (WSL); new `native-tool-server.test.mts` red on original, green on Windows and Linux |
| `required writer isolation` test | Hidden environment dependency: it needed a real Claude on the machine (`~/.local/bin`) | The test installs a fake `claude` | passes on Windows and Linux |
| `native-claude-toolchain` could not load | Static `import 'esbuild'` in a Windows-only fixture; CI does not install `extensions/` dependencies | Dynamic import inside the Windows-only branch | Windows still runs it (pass); Linux skips it as designed |

Full suites after the fixes: Windows `npm test` 660 tests, 653 pass, 0 fail, 7 skipped; Linux (WSL, Node 24.22.1) 660 tests, 646 pass, 0 fail, 14 skipped; Windows `check:conformance` 161 pass, 0 fail. Two more Linux-only test fragilities surfaced and were fixed: the ephemeral-environment test depended on the OS ephemeral port range (first port now injectable) and the chat panel test raced a late write during cleanup (retrying removal). **GitHub CI on PR #72 at 15c6b2a5d43: `changes`, `contract` and `ATS gate` all success.** The owner has already added `ATS gate` as a required check; "require branches to be up to date" is still unchecked.

## Added scope requested during the work (same branch and Draft PR #72, separate commits)

Nothing in this section is implemented yet unless a row says so. Impact was assessed against the code on this branch.

### W0 - Empty-editor watermark is the ArmoTuSitio A

DONE in `d056b89`. The four `letterpress-*.svg` files now draw the A of `extensions/armotusitio-ide/resources/ats.svg`. Rendered and inspected for dark and light (browser preview of the SVGs); **the two high-contrast variants were not rendered**, and the change was not seen inside a built IDE (needs a build of the fork).

### W1 - Persistent permissions (once / session / project / global) and a management screen

What already exists (verified): `ApprovalAnswer = once | task | session | always | deny`; `ApprovalBroker` (per project chat, shared by both providers, audited, revocable, session grants expire after 8 h); `always` is stored in `~/.armotusitio/permissions.json` under the project key and `.armotusitio/permissions.json` in the project is a second layer; exact-rule requirement and `NoRememberReason` (dependency, irreversible, publication, inexact) already keep risky operations to "once".
Gaps: no **global** scope (the user layer is keyed per project), no management UI (list, revoke, audit), no automatic invalidation when the security context changes beyond the existing project-permissions digest.
Design rule: extend `ApprovalBroker` and `native-permissions`; no second broker. A global grant is allowed only for explicitly allow-listed low-risk rules and can never cover destructive operations, secrets, privilege elevation or high-risk commands.
Depends on: Phase 1 (policy is the single source of decision).
Acceptance: project grants survive an IDE restart; a global grant works only for its listed rules; revocation applies to the next operation; both providers see identical verdicts; unauthorized operations fail closed. Tests: unit (broker/store), integration (restart, two projects), E2E (card -> persist -> restart).
Progress (block W1a, commit see PR): **DONE** the `global` answer on the approval card, only for exact rules of inspection commands (allowlist in `native-permissions.ts`, `globalRuleAllowed`), host-enforced, persisted in the existing user permissions file (global lists), revocable with `/permisos quitar`. Files: `native-permissions(.types).ts`, `native-approval.ts`, `native-chat-session.ts`, `native-integration.ts`, `runtime/contracts.ts`, `chat.ts`, `resources/chat.ts`. Tests: `native-permission-scopes.test.mts` (allowlist, card flag, restart persistence, project isolation, immediate revocation) and the browser card test; related suites 38/38 and 33/33 pass. Project scope (`always`) and session/task/once already existed.
**Still PENDING in W1:** management screen (list, revoke, audit) inside the chat; automatic invalidation of grants when the security context changes beyond the existing project-permissions digest; E2E restart through the real chat; both providers sharing the verdict is covered by the existing contract suite but not re-run for `global`.
Status: PARTIAL.

### W2 - Chat tool gaps versus Claude Code and Codex

Needs an inventory first (files: read, search, create, edit, delete, move; terminal; git; diagnostics/tests/lint/build; workspace and dependency inspection; long-running processes; cancel/recover/resume; chat history). Some exist (file tools, git tools, `ats-runner run`, journal/recovery). The gap list is produced from the code, not from this paragraph.
Constraint: every tool goes through the existing authorization, validation and audit path (`approve` tool and policy).
Status: PENDING (inventory not started).

### W3 - AI profile manager (several accounts per provider)

Detailed spec: `F:\armotusitio-ide-plans\harness-ide\UPGRADE_cHAT.md` (owner-provided). It adds, on top of the points below: an **AI Accounts** screen as an editor tab (not the sidebar), a Provider -> Account -> Model popover in the chat (models only from verified provider capabilities), a guided onboarding that starts the official login without capturing passwords or tokens, nine authentication states distinguishable without color, assignment precedence (workspace profile, then provider default, then ask; never silently fall back to another account), stable profile ids independent of aliases, multi-root and multi-window handling, Command Palette integration, WCAG 2.2 AA, and real screenshots from the built app. It asks for a self-assessed UX score of at least 95/100; that score is reported only for dimensions that have evidence, and unmeasured dimensions are listed as NOT VERIFIED, not counted. Real screenshots of the running IDE need a build of the fork (NOT VERIFIED until built).

Current state (verified): no profile concept. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are only read to list models and diagnostics, and `CODEX_HOME` is passed through the toolchain environment. Sessions are keyed by provider, root and conversation (`SessionIdentity`), so the account is not part of a session identity yet.
Plan: a profile registry (alias, provider, state; default global plus per-workspace assignment, persisted outside the repository), one private config directory per profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), the profile id added to `SessionIdentity` and to the session-store key (schema migration, never overwriting a newer schema), a Provider -> Account -> Model selector in the chat, and account changes applied only to new turns.
Rules: no token copying, no credentials in the repository or project files, no automatic rotation to avoid quotas. Provider limits (where each CLI really keeps credentials on Windows, macOS and Linux) must be verified before isolation is declared.
**BLOCKED / NOT VERIFIED until the owner authenticates a second Claude Code account and a second Codex account in their own profile directories**: this session cannot complete an interactive login. Real two-account checks stay BLOCKED; the isolation logic itself can be tested with fake CLIs.
Depends on: Phase 2 (session contracts frozen) and W1 (grants must not widen on account change).
Progress:
- **W3a DONE** - `src/native-profiles.ts` (`ProfileRegistry`): profiles by stable uuid, alias rules (unique per provider, 1-40 chars), add/rename/remove (removing deletes the private directory and every default or assignment that pointed at it), provider default plus workspace assignment (key = `projectKey(root)`), resolution workspace -> default -> none without ever consulting authentication, durable cross-window storage (lock + atomic write; a damaged file is reported as `HARNESS_PROFILES_UNSAFE` and never overwritten), per-profile environment that strips `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` from the IDE environment and sets only its own directory, auth state from the provider CLI (`authenticated`, `not-authenticated`, `unknown`, `cli-unavailable`). Tests: `native-profiles.test.mts` (5) plus the catalog test, all pass.
- **Provider limits verified on this machine (Windows 11, no model call):** `claude auth status` with an empty `CLAUDE_CONFIG_DIR` reports `loggedIn: false` while the default shows logged in (Claude Code 2.1.319); `codex login status` with an empty `CODEX_HOME` reports "Not logged in" (Codex CLI 0.166.0) and warns that helper binaries must not live under the temp directory, so profile directories live in IDE storage. **NOT VERIFIED:** macOS (Claude may use the Keychain there) and Linux; two real accounts per provider.
- **W3b-1 DONE** `SessionIdentity.profileId` is part of `sessionKey` only when present (same key as before without a profile, so no store migration is needed; another profile is another session and an active session keeps its own identity), `NativeChatTransport` resolves the profile (workspace, then default) and passes it to the environment builder, which uses `ProfileRegistry.environment` and **throws `HARNESS_PROFILE_NOT_FOUND`** instead of falling back to another account. Test: session key legacy compatibility and isolation (`native-runtime-units`). Wiring in `native-integration.ts` verified by typecheck only (no integration test yet).
- **W3b-2 DONE** the default `structured` transport (chat runs through `runGuardedAgent`) also runs under the project's profile: `executeReviewedAgent` takes an optional environment transform. Test: a fake CLI sees the profile's `CODEX_HOME` and no inherited `OPENAI_API_KEY`, while a run without a profile still sees the IDE's. **Not covered:** the multi-agent workflow engine (`native-agent-workflow.ts`, two call sites) still uses the IDE's own login.
- **W3b-3a DONE** Command Palette: `ArmoTuSitio: Agregar cuenta de IA` and `ArmoTuSitio: Cuentas de IA` (`src/native-profile-commands.ts`, declared in `package.json`). Add provider + alias, then sign in through the provider's **own** login (`claude auth login` / `codex login`) in a terminal that has only that profile directory and every other credential variable unset; no password or token is ever asked for or captured. Manage: list with auth state (text plus icon), sign in or renew, set provider default, use in this workspace, unassign, rename, delete (modal confirmation). Tests: `native-profile-commands.test.mts` (add -> sign-in terminal environment, label distinctness). **Not run:** the commands inside a real IDE (needs a build).
- **W3b-3b-1 DONE** chat selector Provider -> **Account** -> Model: an account `<select>` next to the provider switch (IDE account, each profile with its real login state in words, "Administrar cuentas..." that opens the manage command without changing the selection). Host (`chat.ts`): `refreshAccounts` (profiles + `authState`, on open and after account actions, not on every publish), action `account` validated (provider, profile exists and belongs to the provider) then assigns or unassigns for the project; action `accounts` runs `atsHarness.accounts.manage`. A new choice applies to new runs only (session key includes the profile). Browser test `chat-account-selector.test.cts` passes; existing card/chat/renderer/accessibility webview tests 33/33. **Not yet:** the "next run uses X, this session uses Y" banner, draft warning, models filtered by account, real-IDE screenshots.
- **W3b-3b-2 DONE** AI Accounts editor tab: command `ArmoTuSitio: AI Accounts` opens a webview panel in the central editor (`src/accounts-panel.ts`, `resources/accounts.ts`, `resources/accounts.css`, esbuild entry `accounts`). Strict CSP with nonce, text nodes only, closed set of operations on a profile id (sign in, default, use here, stop using here, rename, delete) validated in the host, which reuses the same actions and confirmations as the Command Palette (`profileActions`). Provider sections with account cards (alias, default and workspace badges, state as symbol + word, associated workspaces), empty state, refresh with busy state, focus restored after redraw, no horizontal overflow at 360 px with a very long alias (CSS applied: the first version of the probe had its own CSP blocking the CSS and proved nothing; fixed). Browser tests `accounts-webview.test.cts` (2) pass. **Visual evidence:** [dark](r8-evidence/accounts/accounts-dark.png) and [light](r8-evidence/accounts/accounts-light.png), rendered from the shipped webview HTML, script and CSS in headless Chromium with sample data and theme tokens; **they are not captures of the running IDE** (needs a build) and high contrast was not rendered. Visual review found and fixed missing CSS fallbacks (font, borders, destructive color) and an ambiguous button label.
- **W3 contract evidence (fake CLIs, both providers):** in `native-runtime.test.mts`, two sessions of the same provider under profiles `personal` and `work` run concurrently; each answer shows its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, each keeps its own context across turns, none sees the other directory, the keys differ and the same profile maps to the same key. This is **PASS for the IDE side with fake CLIs**; **BLOCKED / NOT VERIFIED with two real Claude accounts and two real Codex accounts** (needs the owner to sign a second account of each in a profile).
- **W3b-3b PENDING (remaining)** guided onboarding with progress and recovery, the nine visual states (today six, PASS by test: authenticated, not authenticated, unknown, CLI unavailable, connection failed (status command threw or timed out), connecting (sign-in terminal open, cleared on close); `expired` and `reauthentication-required` are NOT detectable from the CLI status output, so they are not faked; `active-session` still missing), multi-root assignment UI, banner "this conversation continues with X; the next message will use Y" (DONE, PASS by webview test; host records the account at send, cleared on reset), draft-loss warning on switching (N/A by design: switching only changes the assignment, the composer draft is never touched).
Status: PARTIAL.

### W4 - `/mcp` in the Chat Harness (connect any MCP server like Claude Code)

Requested: typing `/mcp` in the chat manages MCP servers the way Claude Code does. Existing pieces to reuse (not yet audited in detail): the chat already has a slash-command mechanism (`native-chat-commands.test.mts`), `native-mcp-bridge.ts` and the `ats-runner` MCP server. Security: server definitions (command, args, env) are code execution, so adding one must go through the permission broker and Workspace Trust, secrets must stay in SecretStorage and never in project files, and tools of a connected server must be listed per tool in the permission UI. Depends on W1. Status: PENDING (design not started).

### Order

Current Phase 1 items first (P1-004), then W1 inside Phase 1, W3 after the Phase 2 contracts, W2 inventory in Phase 2 and its UI in Phase 5. Each block gets its own commit, tests and a checklist update.

## Next executable step (state for resuming, updated after the AI Accounts block)

Done on this branch (see the sections above for evidence): P2-004, P2-005, P1-001 (probed commands), P1-003 workflow, Linux channel fix, hermetic tests, W1a global permission scope, W3a registry, W3b-1/2 profile identity and environment for native and structured transports, W3b-3a Command Palette accounts, W3b-3b-1 chat account selector, W3b-3b-2 AI Accounts editor tab, fake-CLI proof of two independent accounts per provider.

Next, in this order:
1. **W3 onboarding and states:** guided add flow (provider, alias, isolated environment, official login, verify, scope, confirm) with progress and recovery; add `active-session` and, if a run reports an auth error, `reauthentication-required` (done: `connection-failed`, `connecting`); models per account; multi-root assignment picker in the screen; README/docs; (workflow engine now runs providers under the project's profile: DONE, PASS by test in `native-agent-dag.test.mts`).
2. **W1 remainder:** permissions management screen (list, revoke, audit) inside the chat or as a tab sharing the accounts panel pattern; invalidate grants on security-context change; E2E restart through the real chat.
3. **W4 `/mcp`:** the chat already has a `/mcp` command for the ArmotuSitio integration only. Needed: store server definitions per user/project (secrets in SecretStorage), per-server trust consent through the permission broker, inject into the Claude `--mcp-config` (today `--strict-mcp-config` allows only `ats-runner`) and into Codex config, allow `mcp` tool calls per tool in `decideProviderCall` (today every `mcp` call from a provider is denied as `tool-unavailable`), `/mcp list|add|remove|status`.
4. **W2 tool inventory** versus Claude Code and Codex, then close the gaps through the central approval path.
5. **AUD-P1-004:** two-writer and crash E2E (20 consecutive cancel/crash runs), then `strict:true`, DoD-08, Codex streaming bound audit.
6. **Owner actions:** Codex real runs (after quota reset), second real account per provider to unblock the real two-account checks, "Require branches to be up to date" in the ruleset, `sin-release` label before merge if no release is wanted.

## Blocked or owned by the repository owner

- Ruleset `required_status_checks` on `main`: the owner changes it. The workflow side is prepared here.
- Codex real E2E: owner, after 2026-11-09.
- NVDA and VoiceOver matrix, macOS and Linux runs.

## Commits

None yet. Commits and pushes are made only on the owner's explicit request.

## W4 `/mcp` (user-added MCP servers) - status

- **DONE, PASS:** `/mcp`, `/mcp add NAME URL|COMMAND [--token] [--env VAR]`, `/mcp remove|enable|disable NAME` in the Chat Harness (`native-mcp-command.ts`). Definitions in private IDE storage (`native-mcp-servers.ts`, shared locked-JSON helper with profiles); tokens and env values only in `SecretStorage`, typed through a masked prompt, never echoed or stored in the file. One modal confirmation shows exactly what will run or be contacted. Unit tests: `native-mcp-servers`, `native-mcp-command`.
- **Per-call consent:** new permission kind `mcp` (`mcp:<server>/<tool>` rules, default `ask`, `readonly` denies, no preset allows). Claude's `mcp__server__tool` calls reach `approve`; unknown servers stay `tool-unavailable`. Test: `native-approve-tool.test.mts`.
- **Real Claude 2.1.319, scenario M02 PASS** (`docs/r8-evidence/w4-mcp-real-claude.json`): the denied call never ran (marker empty), the allowed call ran, both produced an `mcp` card.
- **Limits:** only Claude Code uses the servers (Codex wiring NOT IMPLEMENTED, needs Codex quota to verify); a server is used from the next conversation (Empezar de nuevo); http servers with OAuth flows are not supported (bearer token only).
