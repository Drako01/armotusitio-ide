# Chat Harness: one prompt to a verified result

Status of the junior-developer upgrade of the Chat Harness: one Act request should be routed, implemented, verified, corrected
and delivered with evidence, asking only what a real risk requires. Baseline: `main` at `de369ffa3a2` (PRs #105 and #106).

User-facing behaviour is documented in [the chat guide](guia/04-chat-harness.md#un-prompt--resultado-verificado).

## Design

| Concern | Where | Decision |
|---|---|---|
| Intent routing | `src/native-task-router.ts` | Local rules, no model call: `question` (one line only), `simple-edit`, `compound-goal`. In Act every instruction runs: risk is enforced on each action (permissions, command policy, git tools), never by the words of the request. Never changes permissions. |
| Independent review | `HarnessChatSession.independentReview`, `ChatRuntime.review` | After the gates pass, a read-only reviewer (the other provider when usable, via `chooseProvider`) reviews the real diff with the goal team's reviewer contract (`roleInstruction('reviewer')`, `harness-review`). Blocking findings are corrected and verified again, at most `MAX_CORRECTIONS` rounds; an invalid or failed review is reported, never counted as approval. `atsHarness.independentReview = false` turns it off. |
| Goal delivery | `publishDelivery`, `GoalIntegrationDeps.deliveryGitTool` | A `branch-and-pr` charter (inferred when the request mentions the PR or the push) pushes its branch and opens the PR against the branch the user started from, through the structured git tools and the project's permissions. The chat that started the goal receives its end summary. |
| Compound goals from the chat | `ChatRuntime.startGoal` → `GoalIntegration.startFromChat` | Reuses `GoalOrchestrator`, its journal, lease, budget and Definition of Done. The charter is shown in the chat, without a modal; an engine failure falls back to the direct writer with its `HARNESS_*` code; folder, delivery (local branch) and environment (none) are inferred. `atsHarness.actRouting = direct` restores the previous behaviour. |
| Automatic correction | `HarnessChatSession.execute` | implement → verify → classify → correct → verify, bounded by the orchestrator's `MAX_CORRECTIONS` (2). Stops on a repeated failure signature, a correction without changes, or any non-code cause. Task grants persist across corrections; the broker task ends once. |
| Failure classes | `src/native-task-evidence.ts` | `syntax-typecheck`, `test-failure`, `regression` are repairable; `dependency-missing`, `toolchain`, `service-down`, `permission-denied`, `environment`, `unknown` are not. Reuses `classifyFailure` only for unambiguous causes (policy, disk, lockfile). |
| Evidence ledger | `ChatRunSummary.evidence` | One entry per gate the engine executed: command, cwd, status, exit code, timestamps, source (`ide-gate` or `cache`) and plan revision. Gate output stays in the engine log; the correction gets a redacted, bounded tail in memory only. |
| Delivery states | `RunOutcome.assurance` | `completed` carries `verified` only when gates ran and passed; otherwise `unverified`. Older stored runs (no field) keep their label. `skipped`, `cancelled`, `not-run` never become `passed`. |
| Definition of Done | `src/native-dod.ts` | `build-lint` counts only typecheck/lint/format/build gates; stability (three independent runs) is a separate, non-mandatory item that stays `pending` without `stableRuns ≥ 3`. |
| E2E acceptance | `src/native-project-detect.ts` | `test:e2e`/`e2e` scripts become a gate only with `atsHarness.verifyE2e` and a runner already installed in `node_modules/.bin`. Nothing is downloaded. |
| Paused requests | `ChatConversation.suspended` | Queued messages after a failure, a failed provider turn, a goal that did not start and an interrupted turn are kept, persisted and never run by themselves: Resume, Edit or Discard. Windows keep their own entries; a dead window's entries are adopted. |
| Interruptions | `PendingOperation.stage` | The marker records the last stage, so a restart says whether edits may be partial or verification was incomplete. |
| Attachments | `uploadSupport` | Each upload is `image`, `pdf`, `text` or `unsupported`; unsupported files are announced to the user and the agent is told never to claim it read them. |

## Findings

| ID | Priority | State | Implementation | Tests |
|---|---|---|---|---|
| JUN-001 | P0 | DONE | Router + `startFromChat`; trivial edits stay direct | `native-junior-autonomy` (router), `native-junior-session` (J-04/J-20, risky/question) |
| JUN-002 | P0 | DONE | Bounded correction loop with stall detection | `native-junior-session` (J-02, J-14 ×3, J-15, no-changes, cancelled) |
| JUN-003 | P0 | DONE | `assurance`, evidence ledger, renderer labels for applied, verified and functionally accepted | `native-junior-autonomy`, `chat-junior-states` (J-16) |
| JUN-004 | P1 | BLOCKED | Default `agentTransport` stays `structured`; existing fallback warns once when a CLI is incompatible | Changing the default needs an installed build and both authenticated providers |
| JUN-005 | P1 | DONE | Task grants reused by corrections; deny never becomes a grant; broker remains the only authority | `native-junior-session` (J-06/J-15) |
| JUN-006 | P1 | PARTIAL | A failed provider turn keeps the request; gate failures caused by the environment stop with their class; lockfile restore stays in `repair_dependencies` under the command policy | `native-junior-session` (J-08, J-15). Doctor checks still report rather than repair |
| JUN-007 | P1 | ALREADY_FIXED | Writer block reasons (`setting-off`, `engine-no-protocol`, `engine-no-lease`) and the 30 s handshake from #106; no change without a new reproducible failure | Existing `native-engine-*` and `native-chat-session` hybrid tests |
| JUN-008 | P1 | DONE | Goals from the chat with inferred defaults and one charter card; Pause/Stop cards already in the chat; `atsHarness.goal` unchanged | `native-junior-session` (J-04, J-08) |
| JUN-009 | P1 | DONE | Honest `build-lint` and separate stability item | `native-junior-autonomy`, `native-goal-engine` |
| JUN-010 | P1 | PARTIAL | Opt-in local E2E gate and "functional not verified" label | `native-project-detect` (J-17). A real login + CRUD run needs a demo app and a browser runner |
| JUN-011 | P1 | DONE | Suspended requests, stage-aware interruption notice, no automatic replay | `native-junior-session` (J-12, J-13), `chat-junior-states` |
| JUN-012 | P2 | PARTIAL | Attachment readability; token usage stays reported-only; memory stays user-confirmed (`/memoria`) | `native-chat-uploads` (J-19). Memory proposals and automatic read-only reviewers are not added |

## Acceptance cases

Levels: `UNIT`, `INTEGRATION` (session with a scripted runtime), `WEBVIEW` (shipped webview in Chrome). No case below used an
authenticated provider or an installed build.

| Case | Level | Evidence | Result |
|---|---|---|---|
| J-01 CRUD from an empty folder | — | Needs a real provider | BLOCKED (quota) |
| J-02 failing test fixed with one prompt | INTEGRATION | `native-junior-session` | PASS |
| J-03 endpoint with regression test | UNIT | A test that passed before and fails now is a `regression` | PARTIAL (classification only) |
| J-04 Go API + Next frontend | INTEGRATION | Routed to `startGoal` | PASS (fixture) |
| J-05 typecheck error repaired | UNIT | `syntax-typecheck` is repairable | PASS |
| J-06 lockfile install reuses scope | INTEGRATION | Task grant reused by the correction | PASS |
| J-07 new dependency asks | — | Broker and command policy unchanged | Existing tests |
| J-08 provider not signed in | INTEGRATION | Request suspended, notice actionable | PASS |
| J-09 `auto` with incompatible CLI | — | Existing fallback | BLOCKED (installed build) |
| J-10 project Harness cold start | — | #106 | Existing tests |
| J-11 project Harness without lease | — | Fail-closed writer block | Existing tests |
| J-12 interrupted IDE | INTEGRATION | Stage notice, request suspended, no replay | PASS |
| J-13 queue after failure | INTEGRATION/WEBVIEW | Suspended and persisted across restart | PASS |
| J-14 identical failure repeated | INTEGRATION | `stalled`, `budget`, `no-changes` | PASS |
| J-15 sensitive permission denied | INTEGRATION | Deny never granted; environment not repaired | PASS |
| J-16 no detectable gates | INTEGRATION/WEBVIEW | "Aplicada sin verificar" | PASS |
| J-17 local E2E login + CRUD | UNIT | Gate detection only | PARTIAL |
| J-18 two windows + human change | — | Store merge and per-window suspended entries | Existing tests |
| J-19 unreadable attachment | UNIT | `uploadSupport` | PASS |
| J-20 trivial prompt | INTEGRATION | Direct writer, no goal | PASS |
| J-21 confirmed memory | — | `/memoria` | Existing tests |
| J-22 missing child token usage | — | Reported-only usage | Existing tests |

## Known limits

- No authenticated provider, installed build or real browser E2E was run; those remain BLOCKED until quota and an installer are available.
- The correction relies on the agent honouring the prohibition on weakening tests; the run report and review show the diff, but no
  content-level guard rejects a `.skip` added during a correction yet.
- Symlink tests fail on Windows hosts without symlink privilege; they also fail on unmodified modules and pass on Linux CI.
