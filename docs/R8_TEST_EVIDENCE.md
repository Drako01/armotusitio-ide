# r8 test evidence

Environment: Windows 11, Node 24.22.1, Claude Code 2.1.316 (claude.ai subscription), Codex 0.166.0 (ChatGPT Plus). Branch `feat/r8-native-runtime`. Raw results live in `docs/r8-evidence/`: `real-e2e*.json` holds one JSON object per scenario, and `real-e2e.log` is the first run.

## Commands

| Suite | Command | Result |
|---|---|---|
| Runtime contract (fake providers run as real processes, both adapters) | `node --test --test-concurrency=1 test/native-runtime.test.mts` | 32/32 PASS |
| Runtime units (bridge, JSON-RPC, store, broker, policy, junction) | `node --test test/native-runtime-units.test.mts` | 8/8 PASS |
| Full extension suite (r7 + r8) | `npm test` | 654 tests: 644 pass, 7 skip; 3 regressions fixed and their suites re-run green |
| Affected suites after the last fixes | `node --test test/native-runner-approval.test.mts test/native-git-tools.test.mts test/native-chat-conformance.test.mts test/native-git-delivery.test.mts` | 48/48 PASS |
| Typecheck and resources | `npm run check` | PASS |
| Hygiene and ESLint | pre-commit hook | PASS (after formatting the generated protocol file) |
| Real E2E (opt-in, spends quota) | `node test/native-real-e2e.mts --provider claude\|codex\|both --acknowledge-real-model-call [--only IDs] --out <file>` | see below |
| Event latency (DoD-08) | `node test/native-event-bench.mts structured\|native 5000` | see below |

## Real E2E: Claude Code (route A, installed CLI)

The first run (`real-e2e-run1.json`) found five real defects. All five were fixed, and only the affected scenarios were run again (`run2` to `run4`):

1. **Native sessions were not resumable.** `CLAUDE_CODE_SKIP_PROMPT_HISTORY` prevented storing the session. Affected E02 and E07.
2. **The user's Claude settings could approve tools without the IDE being asked.** Fixed with `--setting-sources ''`. This was a security finding (E03).
3. **"Esta sesión" on a git card was treated as a denial.** The runner held an empty local rule hint while the extension held the real rule. Affected E09 and A07; the fix is in `native-approval.ts`.
4. **Test oracles.** E06 expected English only, while Claude answered «Azul». A07's fixture lacked the GitHub-shaped origin that the git tools require.
5. **The runner read the user's real permission rules in E2E.** The harness now isolates them, as the IDE intends.

Final status per scenario:

| ID | Criteria | Status | Run |
|---|---|---|---|
| E01 two turns, one session, streaming | S01 C01 C02 | PASS | 1 |
| E02 IDE restart, resume by id, context recalled | S03 C06 | PASS | 2 |
| E03 card, user denies, agent continues | S05 S06 C04 | PASS | 4 |
| E04 tool lifecycle and output | S08 C03 C09 | PASS | 1 |
| E05 "esta sesión" covers the second identical run (1 card, 2 runs) | S05 C04 | PASS | 3 |
| E06 agent question answered in the chat | S07 C07 | PASS | 2 |
| E07 cancel a streaming turn, session continues | S09 C05 | PASS | 2 |
| E08 file created, diff, discarded | S11 C08 | PASS | 1 |
| E09 branch, commit and push through structured git tools | S12 C10 | PASS | 3 |
| E10 IDE MCP tool (`ats-runner run`) | S16 C11 | PASS | 1 |
| A01–A10 autonomy tasks | DoD-06 | 10/10 PASS | A01–A06 and A08 in run 1; A09–A10 in run 2 (after the provider's 5-hour limit reset); A07 in run 4 |

Caveat: E01, E04, E08, E10 and A01–A06 ran before fixes 1–3. Those fixes change resume, settings isolation and git answers, and none of these scenarios depends on them.

Known provider behavior: Claude auto-approves commands it considers read-only (for example `docker ps`) without consulting the permission prompt tool. The IDE cannot see those calls. They still appear in the timeline as tool events.

## Real E2E: Codex app-server

All 20 scenarios: **BLOCKED (external)**. The account hit its usage limit ("try again at Nov 9th, 2026 7:27 PM"). The probe shows the transport working against the real server: `initialize`, `thread/start` (durable thread id), `turn/start`, then the provider's error. The adapter now reports this as `RUNTIME_RATE_LIMITED`. Re-run `--provider codex` once the limit resets.

## Fault and recovery scenarios (fake providers as real processes, both adapters)

| ID | Test | Result |
|---|---|---|
| R01 crash mid-turn: lost, not replayed, next turn resumes | runtime contract | PASS ×2 |
| R02 restart idle: resume | runtime contract | PASS ×2 |
| R03/R04 IDE dies awaiting approval: lost, no grant, next turn works | runtime contract | PASS ×2 |
| R05 malformed line: diagnostic | runtime contract | PASS ×2 |
| R06 start dies once: one retry | runtime contract | PASS ×2 |
| R07 request timeout: rejected, recoverable | units (json-rpc) | PASS |
| R08 unknown native id: new session and notice, no invented history | runtime contract | PASS ×2 |
| R09 corrupt registry quarantined; newer schema refused | units (store) | PASS |
| R10 incompatible CLI: structured fallback with reason | runtime contract S20 | PASS |
| DoD-09: 100 consecutive turns, no loss, no stuck state, no orphan process | runtime contract | PASS ×2 |
| S15 two roots, two chats isolated | runtime contract | PASS |
| S17 junction or symlink escape and untrusted workspace denied without a card | units | PASS |
| S18 200 deltas ordered, bridge bounded | runtime contract | PASS ×2 |
| S19 provider switch: new session with handoff | runtime contract | PASS |

## Performance (DoD-08)

Same machine and corpus: 10,004 events, half text and half tool lifecycle. Three runs each.

| Path | p50 ms | p95 ms | max ms |
|---|---|---|---|
| r7 structured (baseline) | 0.003 | 0.005–0.006 | 1.43–1.63 |
| r8 native (parse, normalize, bridge, steps) | 0.008–0.009 | 0.017–0.019 | 1.41–1.56 |

The absolute criterion (≤ 200 ms p95) is met by four orders of magnitude. The relative criterion (≤ 10% regression) is **not met**: +13 µs per event, or +260%. See R8_IMPLEMENTATION_STATUS.md.
