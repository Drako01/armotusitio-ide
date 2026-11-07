# r8 implementation status

r7 base: `91d5d772ec2`. Branch: `feat/r8-native-runtime`. Evidence for every row is in [R8_TEST_EVIDENCE.md](R8_TEST_EVIDENCE.md) and the design in [R8_ARCHITECTURE.md](R8_ARCHITECTURE.md).

**Global result: NOT PASS (10/14).** DoD-02, DoD-04 and DoD-12 are blocked for Codex because its account quota is exhausted until 2026-11-09; once it resets, rerun `node test/native-real-e2e.mts --provider codex --acknowledge-real-model-call`. DoD-08 fails its relative criterion.

| DoD | Criterion | Status | Evidence / reason |
|---|---|---|---|
| DoD-01 | Common contracts; provider change does not touch the chat core | PASS | `src/runtime/contracts.ts`. The chat sees only `AgentExecution`. Both adapters pass the same contract suite. |
| DoD-02 | ≥10 real E2E per provider | **BLOCKED** (Codex) | Claude: 10/10 E scenarios. Codex: usage limit until 2026-11-09. Its transport is verified up to the provider error. |
| DoD-03 | 10/10 continuity | PASS | Real Claude E02. Fake-provider runs, both adapters: R01, R02, R03/R04, R08, and resume after a role switch. |
| DoD-04 | Critical flows through both providers | **BLOCKED** (Codex real) | Terminal, files, git and MCP: real Claude E04/E08/E09/E10. Codex covered with fake providers only. |
| DoD-05 | Once, task, session, always, deny, persist, revoke, expire; zero unauthorized | PASS | Broker unit test (scopes, expiry, revoke, audit). Runtime contract (deny, once, floor). Real E03 and E05. r7 suites for "always". A bug where "session" was treated as a denial on git cards was found and fixed. |
| DoD-06 | ≥9/10 autonomy tasks | PASS | A01–A10: 10/10 with Claude. |
| DoD-07 | ≥9/10 recoverable faults; no duplicates | PASS | R01–R10: 10/10. The journal never replays a lost turn. |
| DoD-08 | ≤200 ms p95 and ≤10% regression | **FAIL** | p95 0.018 ms (absolute: pass), but +260% (+13 µs) per event against r7. |
| DoD-09 | 100 consecutive runs | PASS | 100 turns per adapter with fake providers, no orphan processes. Real-provider ×100 excluded beforehand (quota). |
| DoD-10 | Security tests | PASS | Junction, traversal, untrusted workspace, floor, scope isolation and redaction pass. Claude settings isolation (`--setting-sources ''`) was added after the E2E found the gap. |
| DoD-11 | No r7 regressions | PASS | 654-test suite. 3 regressions found and fixed; the affected suites pass again. |
| DoD-12 | Parity matrix in both providers | **BLOCKED** (Codex) | See NATIVE_CHAT_PARITY_MATRIX.md. |
| DoD-13 | Typecheck, lint, hygiene, tests | PASS | `npm run check`, the pre-commit hygiene hook and the suites above. |
| DoD-14 | One PR with commits, docs, matrix, evidence | PASS | This PR, with incremental commits per WP. |

## Not done in this iteration

- **S13:** a native session against RedEvent (read-only) was not run. Delegation is unchanged from r7, whose live RedEvent check passed.
- **S14:** the IDE Harness gates were not re-run under the native transport. The verification pipeline is shared and unchanged.
- **UI:** there is no browser test for the question card. The approval-card browser test passes with the new risk line.
- **Documentation:** the main README restructure and an automated release workflow were requested in the same session and are pending.
