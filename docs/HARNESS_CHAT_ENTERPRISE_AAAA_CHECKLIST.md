# Harness and Chat Harness: Enterprise AAAA checklist

Single source of progress for `PLAN_IDE.md`. Branch: `fix/harness-delete-dependency-folders` (PR #81, label `sin-release`, never merged by the agent).
Statuses are evidence-only: `DONE` (code and test ran green), `PARTIAL`, `TODO`, `BLOCKED` (needs credentials, quota or a platform), `NOT VERIFIED`, `DECIDED-NOT-TO` (justified).
Commits are local until the user pushes. To continue with another agent: take the first `TODO` of the lowest phase, keep this file updated, commit one closed block at a time.

Existing work this plan builds on (do not redo): #72 (hybrid writer, tools), #75 (account selector), #78 (resilience: engine reason, `/lease`, `/motor`, `@terminal`, jobs, `/skills`), #81 (`delete_path` of a reinstallable `node_modules`). See `HARNESS_CHAT_UPGRADE_CHECKLIST.md` and `HARNESS_TOOL_INVENTORY.md`.

## Phase 0: housekeeping

| ID | Prio | Item | Status | Evidence |
| --- | --- | --- | --- | --- |
| H0-1 | P0 | The first #81 commit was published with CRLF and unformatted; restore LF and repo format | DONE | local commit 3a3fe5a; hygiene hook green |
| H0-2 | P1 | Reconcile docs vs code vs tests (matrix, inventory, readiness review) | TODO | |

## Phase 1: dependency repair (PR #81 hardening)

| ID | Prio | Scenario and risk | Solution | Files | Status | Test and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| D1-1 | P0 | `node_modules` exception skips the inventory, so a nested `.git`/`.armotusitio` or a link leaving the project is no longer refused | Bounded directory-only scan for protected segments and escaping links before deleting a dependency folder | `native-file-tools.ts` | DONE | `native-file-tools.test.mts`: nested `.git` under `.pnpm/.../dep` refused; links not followed (target kept) |
| D1-2 | P1 | Lockfile and ignore check do not prove the folder holds only reproducible data | Refuse when the scan finds a protected path, a nested repository or an over-budget tree; otherwise reinstallable | `native-file-tools.ts` | DONE | scan is directory-only, depth 7, 50k directories, over budget refuses `too-many-entries`; tests above |
| D1-3 | P1 | npm, yarn, bun workspaces: lockfile at the workspace root, not beside `node_modules` | Look for the lockfile in the folder and its ancestors up to the project root | `native-file-tools.ts` | DONE | test: lockfile at root, `apps/web/node_modules` deleted |
| D1-4 | P1 | Agent has no structured way to repair a broken install; it improvises delete and install | `repair_dependencies` tool: detect manager, diagnose, minimal repair, verify, report | `native-dependency-repair.ts`, `ats-runner.ts`, `native-agent-contract.ts` | DONE (node) | `native-dependency-repair.test.mts` 10/10: healthy untouched, in-place reinstall, one clean reinstall, no deletion after policy/disk-full, refused deletion reported, network backoff, no lockfile blocked. Non-node ecosystems: TODO |
| D1-5 | P1 | Concurrent installs or repair while another install runs | One repair at a time per run (queue in the runner); cross-process exclusion is not done | `ats-runner.ts` | PARTIAL | in-process only; another IDE window can still install at the same time |
| D1-6 | P2 | Install fails again after deleting the folder (antivirus, store corruption) | Classified error with the concrete cause and next step, no delete loop (two installs at most) | `native-dependency-repair.ts`, `native-failure-class.ts` | DONE | `FAILED [locked-files, change-strategy]` test shows attempts, cause and next step |

## Phase 2: autonomy and recovery

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| A2-1 | P1 | Explicit error classification (auto-recoverable, needs approval, change strategy, security-blocked, unrecoverable) | PARTIAL: `native-failure-class.ts` exists and is used by `repair_dependencies`; not yet wired into `run`, `delete_path`, git or MCP results |
| A2-2 | P1 | Bounded retries with backoff, execution budget, loop detection, idempotency for non-idempotent operations | TODO |
| A2-3 | P2 | Report cause, attempts made and next step on failure | TODO |

## Phase 3: tool parity (Claude Code / Codex)

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| T3-1 | P1 | Capability matrix per provider from the real implementation (filesystem, terminal, git, dev, context, MCP, skills, multimodal) | TODO |
| T3-2 | P2 | Fill gaps found by the matrix; document real limits instead of simulating tools | TODO |

## Phase 4: real interactive terminal (PTY/ConPTY)

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| P4-1 | P2 | Evaluate reusing the VS Code terminal infrastructure for a real TTY (resize, signals, large output, reconnect, secrets never reach the model) | TODO |

## Phase 5: sessions and context

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| S5-1 | P2 | Stable run identity, resume after restart, corrupt history, duplicate or out-of-order events, cancel during write | TODO |
| S5-2 | P2 | Claude to Codex handoff carries authorised context only | TODO |

## Phase 6: enterprise permissions

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| E6-1 | P1 | Adversarial tests: prompt injection, traversal, symlink races (TOCTOU), escalation, command injection, secret leaks, stale approval | TODO |
| E6-2 | P2 | Scopes (operation, task, session, project, global low-risk), immediate revocation, concurrent decisions, traceability | TODO |

## Phase 7: concurrency and external harnesses

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| C7-1 | P2 | Lease renewal for long runs (needs an engine `ide-writer-renew`), foreign locks never released, PID reuse | TODO |
| C7-2 | P2 | Two agents on one file, worktrees, several IDE windows | TODO |

## Phase 8: chat UX

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| U8-1 | P2 | Tool timeline, plan, diff inline, apply/review/discard, retry/continue, draft recovery, keyboard and screen-reader access, themes | TODO |

## Phase 9: adversarial testing

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| X9-1 | P1 | Reproduce-before-fix tests per area of the matrix in `PLAN_IDE.md` section 12; real E2E only with credentials and quota, else `BLOCKED` | TODO |

## Phase 10: validation and delivery

| ID | Prio | Item | Status |
| --- | --- | --- | --- |
| V10-1 | P1 | Strict typecheck, unit, contract tests, hygiene, workflows, adversarial diff review, PR #81 Actions green | TODO |
| V10-2 | P1 | Final executive summary and verdict (READY / READY WITH CONDITIONS / NOT READY) | TODO |

## Residual risks and limits (kept current)

- Real Claude and Codex sessions: `NOT VERIFIED` (no quota spent on tests that fixtures can cover).
- Windows, Linux, macOS, WSL: only Windows locally and the CI runners are exercised.
