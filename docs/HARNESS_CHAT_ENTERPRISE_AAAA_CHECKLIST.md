# Harness and Chat Harness: Enterprise AAAA checklist

Single source of progress for `PLAN_IDE.md`. Branch: `fix/harness-delete-dependency-folders` (PR #81, label `sin-release`, never merged by the agent).
Statuses are evidence-only: `DONE` (code and test ran green), `PARTIAL`, `TODO`, `BLOCKED` (needs credentials, quota or a platform), `NOT VERIFIED`, `DECIDED-NOT-TO` (justified).
To continue with another agent: take the first `TODO` of the lowest phase, keep this file updated, commit one closed block at a time.

Existing work this plan builds on (do not redo): #72 (hybrid writer, tools), #75 (account selector), #78 (resilience: engine reason, `/lease`, `/motor`, `@terminal`, jobs, `/skills`), #81 (`delete_path` of a reinstallable `node_modules`). See `HARNESS_CHAT_UPGRADE_CHECKLIST.md` and `HARNESS_TOOL_INVENTORY.md`.

## Standing rule: background execution of long operations (permanent, all phases)

Installs (`pnpm|npm|yarn|bun install`), builds, full test suites and similar long processes MUST run in the background: do not block the session; record job id/PID, log file, state and result; supervise without excessive polling; continue independent work; check the exit code before declaring PASS; handle timeouts, errors and orphans; never run two operations that modify the same resources at once.

| ID | Requirement | Status | Evidence (SHA) |
|---|---|---|---|
| B-1 | Agent work sessions run installs, builds and full suites in the background with a monitor | DONE | Every suite since 2026-11-09 ran with `run_in_background`; latest node 622 tests (615 pass, 0 fail, 7 skipped, exit 0) and browser 130 pass, exit 0, at 327b34f |
| B-2 | Exit code checked before PASS | DONE | Results are quoted from the runner summary and the `exit=` line of each log; no PASS recorded without them |
| B-3 | No concurrent mutation of the same resource | DONE | One suite or install at a time in sessions. Product: `gitQueue` for git, folder lock (B-5) for dependency repairs |
| B-4 | Product: `repair_dependencies` does not block the agent turn | DONE | `repair_dependencies` starts the repair in the background (`RepairTable`), returns `STARTED repair-N`; `repair_status` reads RUNNING/SUCCEEDED/FAILED/CANCELLED and the result, `stop` cancels and stops the install process tree (`runAsJob` + signal); max 2 repairs, stopped when the run ends. Tests `native-dependency-repair.test.mts`, `native-jobs.test.mts` at 327b34f |
| B-5 | Product: cross-process exclusion for installs on one folder | DONE | `native-install-lock.ts`: unique owner id, heartbeat (a live owner never expires, a silent or dead one does), takeover serialised by a mutex with a second staleness check, owner-checked release and heartbeat, corrupt files and reused pids recovered. Tests with real processes (kill, refuse, clean exit) and 20 racers, 6/6 stable in 6 runs at 327b34f |
| W-1 | Welcome screen footer with author credit and link (owner request) | DONE | `src/home.ts`, `home.test.cts` at 401cb75. Visual check: OWNER VALIDATION REQUIRED |
| E6-3 | Dependency-folder deletion re-scans for protected folders after the approval wait | DONE | `native-file-tools.test.mts` plants `.git` during the approval, at 401cb75 |
| V-FLAKE | `native-mcp-bridge` stdio test timed out once (5 s) in the parallel suite | DONE (mitigated, root cause = cold-start latency under load) | Not reproducible in 52 isolated/parallel runs (12 and 40 concurrent copies). Fix: the first request (`initialize`) has a 60 s start budget, later calls keep 5 s, and the error names the method and budget. Full suite 622/615/0 at 327b34f |

## Phase 0: housekeeping

| ID | Prio | Item | Status | Evidence |
| --- | --- | --- | --- | --- |
| H0-1 | P0 | The first #81 commit was published with CRLF and unformatted; restore LF and repo format | DONE | local commit 3a3fe5a; hygiene hook green |
| H0-2 | P1 | Reconcile docs vs code vs tests (matrix, inventory, readiness review) | DONE: inventory row for `repair_dependencies`, checklist and parity matrix reconciled with the code of this PR; no other doc contradicts the implementation (checked by grep for the tools touched) |

## Phase 1: dependency repair (PR #81 hardening)

| ID | Prio | Scenario and risk | Solution | Files | Status | Test and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| D1-1 | P0 | `node_modules` exception skips the inventory, so a nested `.git`/`.armotusitio` or a link leaving the project is no longer refused | Bounded directory-only scan for protected segments and escaping links before deleting a dependency folder | `native-file-tools.ts` | DONE | `native-file-tools.test.mts`: nested `.git` under `.pnpm/.../dep` refused; links not followed (target kept) |
| D1-2 | P1 | Lockfile and ignore check do not prove the folder holds only reproducible data | Refuse when the scan finds a protected path, a nested repository or an over-budget tree; otherwise reinstallable | `native-file-tools.ts` | DONE | scan is directory-only, depth 7, 50k directories, over budget refuses `too-many-entries`; tests above |
| D1-3 | P1 | npm, yarn, bun workspaces: lockfile at the workspace root, not beside `node_modules` | Look for the lockfile in the folder and its ancestors up to the project root | `native-file-tools.ts` | DONE | test: lockfile at root, `apps/web/node_modules` deleted |
| D1-4 | P1 | Agent has no structured way to repair a broken install; it improvises delete and install | DONE: Node: diagnose, in-place reinstall, one approved delete and clean install. Go, Rust, .NET, Python (uv) and PHP: lockfile-exact install again with network backoff, judged by exit code, never deleting caches (`repairOtherEcosystem`, test in `native-dependency-repair.test.mts`) |
| D1-5 | P1 | Concurrent installs or repair while another install runs | DONE: in-process `repairQueue` plus the cross-process install lock (B-5) |
| D1-6 | P2 | Install fails again after deleting the folder (antivirus, store corruption) | Classified error with the concrete cause and next step, no delete loop (two installs at most) | `native-dependency-repair.ts`, `native-failure-class.ts` | DONE | `FAILED [locked-files, change-strategy]` test shows attempts, cause and next step |

## Phase 2: autonomy and recovery

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| A2-1 | P1 | Explicit error classification (auto-recoverable, needs approval, change strategy, security-blocked, unrecoverable) | DONE: `native-failure-class.ts` is applied to every effectful runner tool (run, terminal, job_start, git, files, repair) through `attempt()` in `ats-runner.ts`; failures carry `[kind, class] next step` (unknown cause left unannotated). MCP work tools and the native-session approval path are not annotated (their errors come from the channel) |
| A2-2 | P1 | Bounded retries with backoff, execution budget, loop detection, idempotency for non-idempotent operations | DONE for the runner: `native-call-guard.ts` stops the exact same failing call after 3 in a row (2 min hold, resets per turn epoch or on success; denials never counted); network-only backoff in `repair_dependencies`; command budget already existed. Blind retries of non-idempotent operations are never made by the harness. Tests `native-call-guard.test.mts` (3) |
| A2-3 | P2 | Report cause, attempts made and next step on failure | DONE: failure text = cause + `[kind, class]` + next step (`classifyFailure`); `repair_dependencies` also lists the attempts |

## Phase 3: tool parity (Claude Code / Codex)

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| T3-1 | P1 | Capability matrix per provider from the real implementation (filesystem, terminal, git, dev, context, MCP, skills, multimodal) | DONE: `docs/HARNESS_TOOL_INVENTORY.md` and `docs/NATIVE_CHAT_PARITY_MATRIX.md` cover filesystem, terminal, git, dev secrets, context, MCP, skills and multimodal per provider, with evidence; `repair_dependencies` row added. Codex real-run columns stay BLOCKED (quota) |
| T3-2 | P2 | Gaps found by the matrix | DECIDED-NOT-TO (scope decision, not parity): image input and notebook reads, Codex user-MCP and sub-agents stay NOT IMPLEMENTED and are listed as such in `docs/HARNESS_TOOL_INVENTORY.md`; they are not simulated. Full functional parity with Claude Code/Codex is NOT claimed |

## Phase 4: real interactive terminal (PTY/ConPTY)

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| P4-1 | P2 | Evaluate reusing the VS Code terminal infrastructure for a real TTY (resize, signals, large output, reconnect, secrets never reach the model) | DONE (decision): reuse the VS Code integrated terminal (a real TTY, so resize, signals, scrollback and reconnect are VS Code's own) through `run_in_terminal`; no custom PTY or native dependency is added. The model receives only redacted, bounded output (`native-terminal.test.mts`, `native-terminal-capture.test.mts`: prompt detection, typed input, Ctrl+C, secrets hidden). Visual check in the installed IDE: OWNER VALIDATION REQUIRED |

## Phase 5: sessions and context

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| S5-1 | P2 | Stable run identity, resume after restart, corrupt history, duplicate or out-of-order events, cancel during write | DONE for the goal journal: replay is idempotent (duplicate step/question records ignored), torn last line skipped, unknown ids/answers ignored (test in `native-goal-engine.test.mts`); existing tests cover crash recovery, cancel before start and cancel during a write. Real restart of an installed IDE: OWNER VALIDATION REQUIRED |
| S5-2 | P2 | Claude to Codex handoff carries authorised context only | DONE (existing coverage): `native-runtime.test.mts` S19 (handoff creates a new session that links the previous one and carries no native session id) and `native-chat-session.test.mts` (Continue with another provider lists changed files only; typed secrets never stored or sent) |

## Phase 6: enterprise permissions

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| E6-1 | P1 | Adversarial tests: prompt injection, traversal, symlink races (TOCTOU), escalation, command injection, secret leaks, stale approval | DONE: E6-1a, E6-1b, E6-3, X9-1 (traversal and aliases, symlinks not followed, command injection forms, redaction, stale approval, post-approval re-scan, prompt injection through skills/MCP/mentions in existing tests) |
| E6-1a | P0 | Windows: `delete_path`/`move_path`/Edit floor accepted `.git::$INDEX_ALLOCATION` and deleted the whole `.git` (NTFS alternate data stream); trailing dot/space and 8.3 `GIT~1` are other aliases | DONE: `isWindowsAlias` refuses them (`invalid-path`) in `native-file-tools.ts`; test fails without the fix (9/10) and passes with it (10/10), Windows only. Other floors (`native-command-policy.ts`, MCP) not yet checked for the same aliases: TODO |
| E6-1b | P1 | `isSensitiveGitPath` compared names exactly: `.ssh::$DATA`, `.aws.`, `.kube ` slipped past the git commit floor | DONE: names are canonicalised (stream and trailing dot/space stripped); test `NTFS spellings of a sensitive folder are sensitive too`. `native-command-policy.ts` has no folder-name list, nothing to fix there |
| E6-2 | P2 | Scopes (operation, task, session, project, global low-risk), immediate revocation, concurrent decisions, traceability | DONE (existing coverage + new): scopes once/task/session/project/global-low-risk, revocation and persistence are covered by `native-chat-approvals`, `native-permissions`, `native-permission-scopes`, `native-runner-approval` tests; new test: simultaneous answers to one card, first wins and nothing is remembered twice |

## Phase 7: concurrency and external harnesses

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| C7-1 | P2 | Lease renewal for long runs, foreign locks never released, PID reuse | BLOCKED (external): needs an `ide-writer-renew` command in the project engine protocol, and consumer repos must not be changed. IDE side fails safe: expired lease reported as `leaseLost`, IDE checks still apply. Foreign locks and PID reuse are covered for the dependency lock (B-5) |
| C7-2 | P2 | Two agents on one file, worktrees, several IDE windows | DONE (existing coverage): shared execution fence is exclusive and monotonic across processes (`native-shared-fence`, `native-fence-processes`, `native-cross-engine-fence`), worktree isolation (`native-agent-worktree`, `native-worktree-*`), plus the new cross-process install lock for dependency folders |

## Phase 8: chat UX

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| U8-1 | P2 | Tool timeline, plan, diff inline, apply/review/discard, retry/continue, draft recovery, keyboard and screen-reader access, themes | DONE (existing + new): timeline, plan card, inline diff, apply/revert per file, retry/continue, queue, approval cards, ARIA log/live regions and browser probes in light/dark/reduced-motion already exist (`chat-*.test.cts`); new: unsent draft survives a view reload and is never kept if it looks like a credential or after sending (`chat-draft.test.cts`). Visual check in the installed IDE: OWNER VALIDATION REQUIRED |

## Phase 9: adversarial testing

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| X9-1 | P1 | Reproduce-before-fix tests per area of the matrix in `PLAN_IDE.md` section 12; real E2E only with credentials and quota, else `BLOCKED` | DONE: reproduce-first probes found and fixed 3 real gaps: (1) NTFS alias `.git::$INDEX_ALLOCATION` deleted `.git` (E6-1a); (2) `npx <unknown>` ran a registry package unasked; (3) redactor leaked URL passwords, PEM keys, GitLab/Google/Stripe tokens and `*_access_key`. Also hardened: post-approval re-scan (E6-3), idempotent journal replay. Probed and already safe: 33 hostile command forms, concurrent approval answers, torn journals, prompt injection through skills/MCP/mentions (existing tests in `native-chat-skills`, `native-mcp-bridge`, `native-agent-adversarial`). Real-provider E2E: BLOCKED (credentials/quota), OWNER VALIDATION REQUIRED |

## Phase 10: validation and delivery

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| V10-1 | P1 | Strict typecheck, unit, contract tests, hygiene, workflows, adversarial diff review, PR #81 Actions green | DONE: strict `tsc` clean; node suite 622 tests (615 pass, 0 fail, 7 skipped); browser suite 130 pass; hygiene green on every commit; PR #81 Actions: success on cca3dbf (code at 327b34f) |
| V10-2 | P1 | Final executive summary and verdict (READY / READY WITH CONDITIONS / NOT READY) | VERDICT: READY WITH CONDITIONS. Conditions: (a) Actions green (met on cca3dbf); (b) OWNER VALIDATION REQUIRED: install the build and run a real Claude/Codex session on a corrupt `node_modules` (repair_dependencies), check the welcome footer and chat draft visually, Linux/macOS/WSL runs, second Codex/Claude account; (c) C7-1 lease renewal needs an engine command (external, BLOCKED); (d) non-Node ecosystems are repaired by reinstall only, with no integrity probe; (e) none: the stdio timeout flake was mitigated (V-FLAKE). Merge recommendation: merge after (a) and (b); keep `sin-release` |

## Residual risks and limits (kept current)

- Real Claude and Codex sessions: `NOT VERIFIED` (no quota spent on tests that fixtures can cover).
- Windows, Linux, macOS, WSL: only Windows locally and the CI runners are exercised.
