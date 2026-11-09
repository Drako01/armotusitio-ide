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
| AUD-P1-004 hybrid isolation / two-writer E2E | config | PENDING | Default `tool-allowlist` is not an OS sandbox. |
| AUD-P2-001 `strict:false` | code | PENDING | After Phase 2 freezes the contracts. |
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
- **W3b-3 PENDING** Command Palette commands (add, rename, remove, default, assign, sign in through the official CLI login in a terminal that has the profile directory), selector Provider -> Account -> Model, AI Accounts editor tab, onboarding, nine auth states.
Status: PARTIAL.

### W4 - `/mcp` in the Chat Harness (connect any MCP server like Claude Code)

Requested: typing `/mcp` in the chat manages MCP servers the way Claude Code does. Existing pieces to reuse (not yet audited in detail): the chat already has a slash-command mechanism (`native-chat-commands.test.mts`), `native-mcp-bridge.ts` and the `ats-runner` MCP server. Security: server definitions (command, args, env) are code execution, so adding one must go through the permission broker and Workspace Trust, secrets must stay in SecretStorage and never in project files, and tools of a connected server must be listed per tool in the permission UI. Depends on W1. Status: PENDING (design not started).

### Order

Current Phase 1 items first (P1-004), then W1 inside Phase 1, W3 after the Phase 2 contracts, W2 inventory in Phase 2 and its UI in Phase 5. Each block gets its own commit, tests and a checklist update.

## Next executable step (state for resuming)

1. W1 permissions: add a project/global scope on top of `ApprovalBroker` + `native-permissions` (extend, no second broker), with tests for restart persistence, revocation and project isolation.
2. AUD-P1-004 two-writer/crash E2E, then W3 (profile registry + session identity) and the AI Accounts editor tab, then W4 `/mcp`.
3. Open: Codex adapter streaming bound not audited; `strict:true`; DoD-08; a11y with screen readers (BLOCKED); macOS run (NOT VERIFIED).

## Blocked or owned by the repository owner

- Ruleset `required_status_checks` on `main`: the owner changes it. The workflow side is prepared here.
- Codex real E2E: owner, after 2026-11-09.
- NVDA and VoiceOver matrix, macOS and Linux runs.

## Commits

None yet. Commits and pushes are made only on the owner's explicit request.
