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

Not run yet: `scripts/ats-harness-check.mts`, Linux/macOS, real Claude, real Codex.

## Findings

| ID | Verified | Status | Evidence |
|---|---|---|---|
| AUD-P2-005 quarantine deletes the registry when `rename` fails | code | **FIXED, uncommitted** | `session-store.ts`: a failed archive now throws `RUNTIME_STORE_QUARANTINE_FAILED` and keeps the bytes. New test fails on the old code (`Missing expected rejection`) and passes now; `native-runtime-units` 9/9; `npm run check` clean. |
| AUD-P2-004 unbounded `turn.partial +=` | code | **FIXED, uncommitted** | `claude-adapter.ts` bounds the text at `MAX_TEXT_CHARS` (shared with the event bridge), stops emitting deltas past it and reports one `message-truncated` diagnostic. New test (30,000 deltas) fails on the old adapter (`stoppedEarly: false`, no truncation report) and passes now. Codex adapter streams through the app-server protocol and was not changed; not audited for the same pattern yet. |
| AUD-P1-003 `main` has no required status checks | config | **WORKFLOW DONE (uncommitted until this row's commit); RULESET PENDING (owner)** | `ats-ide-extension.yml` now always reports an `ATS gate` job (change detection via the PR files API; the contract job runs only for relevant paths; the gate fails on failure, cancellation or a wrongly skipped suite). YAML parses; the path regex was checked on 7 sample paths. **Not executed on GitHub yet**: needs the Draft PR run. `.harness/**` is deliberately not a trigger: it is the RedEvent engine and has no suite in CI (see AUD-P3-001). Owner: add `ATS gate` as a required check on ruleset 25504012 after it has run once, and enable "require branches to be up to date". Merging triggers `ats-release.yml` unless the PR has the `sin-release` label. |
| AUD-P1-001 Claude auto-approves some read-only commands | doc | PENDING | Needs a bounded real-Claude reproduction. Claude CLI is not on PATH; the VS Code extension bundles 2.1.319. |
| AUD-P1-002 Codex parity not proven | doc | BLOCKED | Quota resets 2026-11-09 and the owner will run Codex then. No real Codex call is made before. |
| AUD-P1-004 hybrid isolation / two-writer E2E | config | PENDING | Default `tool-allowlist` is not an OS sandbox. |
| AUD-P2-001 `strict:false` | code | PENDING | After Phase 2 freezes the contracts. |
| AUD-P2-002 DoD-08 relative perf | doc | PENDING | |
| AUD-P2-003 question card browser test, NVDA/VoiceOver | doc | PENDING; screen readers BLOCKED (need those environments) | |
| AUD-P2-006 large files, no CI evidence | code | PENDING | |
| AUD-P3-001 engine ownership docs | doc | PENDING | |

## After the fixes (same tree, uncommitted)

`npm run check` exit 0; `npm test` exit 0 (659 tests, 652 pass, 0 fail, 7 skipped; +2 new tests); `check:conformance` exit 0.

## Blocked or owned by the repository owner

- Ruleset `required_status_checks` on `main`: the owner changes it. The workflow side is prepared here.
- Codex real E2E: owner, after 2026-11-09.
- NVDA and VoiceOver matrix, macOS and Linux runs.

## Commits

None yet. Commits and pushes are made only on the owner's explicit request.
