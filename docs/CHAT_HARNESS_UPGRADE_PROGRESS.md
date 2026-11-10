# Chat Harness upgrade progress

## Scope and baseline

- Date: 2026-11-10. Local branch: `feat/chat-harness-competitive-parity`.
- Baseline: `45d7e833c3dadd552efd10d239d3db9faa6f5af5`, IDE 1.145.2, extension 0.6.0, Node 24.22.1.
- Inputs: the four dated audit, roadmap, scorecard and competitive benchmark files in `F:/armotusitio-ide-plans/ide`.
- Updated authorization: push this branch and open a Draft PR after checks; release automatically after its merge.
- No manual workflow dispatch, merge, release publication or paid model calls during development.
- Existing untracked `PROMPT_CODEX.md` and `probato-review.md` belong to the user and are excluded from commits.
- This file is the execution checklist required by the prompt.
- Existing Harness stores remain authoritative for runtime tasks.

## Phase checklist

| Phase | State | Evidence and next action |
|---|---|---|
| 0 Baseline and reconciliation | DONE | Four documents and 25-dimension candidate matrix reconciled |
| 1 Integrity and security | DONE | Release/gate/permissions/private logs verified locally |
| 2 Providers, MCP and accounts | PARTIAL | Stdio MCP and isolated Claude roles verified; unsupported provider paths fail closed |
| 3 Context and multimodal | PARTIAL | Hybrid index/editor/folder/diff/image bridge verified; unsupported formats remain disabled |
| 4 UX and checkpoints | PARTIAL | Shared three surfaces, searchable sessions and per-file revert; finer attribution not claimed |
| 5 Debug and autonomy | DONE | Diagnostic planning, existing bounded jobs/retries and budgeted delegation verified |
| 6 Skills and customizations | DONE | Native skills, six actual VSIX pins, native section, author/company metadata |
| 7 Optional browser/cloud | BLOCKED | ADR decision recorded: requires separate service/authority |
| 8 Validation | PARTIAL | Local gates completed; authenticated/final installed/other OS evidence remains separate |

## Constraints and residual evidence

- Authenticated provider calls require explicit quota authorization and are BLOCKED for this run.
- PR CI is authorized by the requested Draft PR. Local fixtures remain separate evidence.
- Windows installed product, Linux/macOS/WSL, visual/a11y and actual VSIX artifacts require their own evidence.
- A missing implementation is TODO or PARTIAL, never BLOCKED merely because it takes substantial work.
- Full competitive parity and a numeric chat score cannot be claimed from compilation or mocks.

## Completed blocks and local commits

### Protected release and CI inputs

- DONE: release preparation only validates reviewed metadata; stale revision requires a metadata-only PR.
- DONE: prepare job has read-only contents; no direct commit or push to protected main.
- DONE: trusted-base change classifier covers packaging inputs, renames and complete API pagination.
- DONE: API/parse/count failures and unknown classifications fail closed; first rollout runs all contracts.
- Files: `scripts/ats-release-ci*`, `scripts/ats-ci-changes*`, `.github/workflows/ats-{release,ide-extension}.yml`.
- Tests: `node --test scripts/ats-release-ci.test.mts scripts/ats-ci-changes.test.mts`: 42 PASS.
- Review: intended diff checked for policy bypass, source mutation, stale revision and API truncation.
- BLOCKED: remote protected-branch rehearsal and signed installers need remote authorization.
- Matching publication receipts also require an authorized release.
- Rollback: disable automatic publishing; build manually from reviewed immutable source, preserve existing tags.
- Commit: `36b21290a27` (`fix(ci): require reviewed releases and cover packaging inputs`).

### Context and Claude command files

- DONE: `@file:line-line`, `@selection`, `@diagnostics` and enclosing `@symbol` use the existing mention broker.
- DONE: editor content is resolved lazily after project, secret and ignored-path checks, then bounded and redacted.
- DONE: flat `.claude/commands/*.md` participates in the existing digest-checked skill catalog, below project skills.
- Files: `chat.ts`, `native-chat-mention-syntax.ts`, `native-chat-mentions.ts`, `native-project-skills.ts` and tests.
- Tests: focused mention/skills suites: 35 PASS, 1 platform SKIP; extension `check`: PASS.
- Review: range limits, ADS, untrusted data blocks, editor version and skill digest invalidation checked.
- PARTIAL: no media, folder/diff context or incremental hybrid retrieval yet.
- Commit: `df4a75f5fcd` (`feat(chat): add editor references and Claude command skills`).

### Permission serialization and private logs

- DONE: read-modify-write of user permissions re-reads under the existing interprocess file lock.
- DONE: unsafe schema, links and oversize files fail closed; atomic replacement uses mode 0600.
- DONE: stdout/stderr have independent UTF-8 decoders and bounded streaming redactors before persistence.
- DONE: observers and agent results receive sanitized records; disk failures report `logError` without changing exit.
- Files: `native-permissions.ts`, `native-command-runner.ts`, `native-redact.ts` and four test/fixture files.
- Red: old concurrent grant/revoke fixture failed with `EEXIST` from colliding temporary files.
- Green: 50 rounds with two real child processes passed without lost grants or resurrected revocations.
- Tests: permissions suite PASS; runner/policy/jobs/terminal 29 PASS; logs/redactor 6 PASS; focused ESLint PASS.
- Windows cancellation tests required sandbox escalation for `taskkill` of verified fixture processes.
- Review: secret fragmentation, ANSI, UTF-8, truncated multiline/PEM EOF and log-close handling checked.
- Limit: secret redaction is heuristic; private file modes do not establish Windows ACL isolation.
- Commit: `19eaad7dc28` (`fix(harness): serialize grants and redact persisted command output`).

### Shared chat surfaces

- DONE: sidebar `atsHarness.chat` and central editor share renderer, session map, approval pipeline and store.
- DONE: expand/sidebar actions retain the same conversation and mirror filtered project-scoped drafts.
- DONE: history revisions and completion responses are tracked per surface, without duplicate chat services.
- Files: `chat.ts`, `native-chat-draft.ts`, chat resources, extension manifest and host/browser fixtures.
- Tests: host/draft 29 PASS; new browser draft test PASS; three affected renderer regressions fixed and PASS.
- Tests: responsive chat at widths 320/520/1100 PASS; TypeScript/resources/ten native skills check PASS.
- Review: untrusted webview actions, project scope, credential-filtered drafts and disposable ownership checked.
- PARTIAL: installed product, screen reader and 10k-event virtualization are not verified by browser fixtures.
- Commit: `63c6eb01843` (`feat(chat): share sidebar and editor conversations`).

### Current integration and user steering

- Canonical entry is the status-bar Chat Harness (`atsIde.chat`), confirmed by the user screenshot.
- The user also requested equivalent behavior in the standard chat: `@harness` now uses the same session/receiver.
- Pending reviewed blocks: Codex stdio MCP broker, bounded read-only delegation, incremental context and image input.
- Image input has four passing local validation/protocol tests, zero real model calls.
- Context benchmark: `.artifacts/chat-harness-upgrade/context-benchmark.json` includes source hashes and three runs.
- Added scope: full VS Code 1.145.3 delta at `dcd3ad6e368fbe19d03f37054a40dbaf40d676f4`.
- Added scope: Orquestivo 0.2.0, Saturivo 0.3.1, Vestigivo 0.2.0 with actual VSIX hashes.
- Added scope: native Extensions sidebar section ArmoTuSitio, showing the six official extensions.
- Review input: `probato-review.md`; three diagnostics fixed and two synthetic-canary alerts verified.

### Final integration evidence

- Upstream/official extensions commit: `a83de96f131`.
- PR: [Draft 86](https://github.com/Drako01/armotusitio-ide/pull/86), base main; no merge performed.
- Remote release workflow active, Actions enabled, signing-secret presence confirmed without reading its value.
- New release identity: `ats-v1.145.3-r1`; automatic merge trigger preserved, no release dispatched now.
- Author metadata: Alejandro Daniel Di Stefano; company ArmoTuSitio.com.ar; upstream notices preserved.
- Full client/extensions/Copilot build PASS; Node 836 PASS/14 pending; Electron 1314 PASS/14 pending.
- Client typecheck PASS after four affected compatibility-test fixes.
- Extension suite ran once: 844 tests, 829 PASS, 3 FAIL, 12 SKIP; all three failures corrected and retested.
- Corrections: project-scoped draft fixture, recovery hints for new codes, event-driven steering fixture.
- Targeted rerun: draft/error catalog 2 PASS; steering 1 PASS. No full-suite repetition.
- Final extension check, compile and native package gates PASS.
- MCP/delegation final 26 PASS; ordinary agent regressions 15 PASS; no real model calls.
- Context/media targeted 8 PASS; chat/history integration 72 PASS; six VSIX packaging checks PASS.
- Logs: `.harness/runtime/competitive-*.log`, `upstream-1453-*.log`, `finish-runtime-reviewed-final.log`.
- Markdown checker PASS for new reports; README retains preexisting long-line debt to preserve repository prose style.
- The parity report identifies checkpoint, unsupported transport/media and installed-acceptance limits.
- Runtime/documentation commit: `2226364e371`; remaining untracked prompt/review inputs are intentionally excluded.


### Continuation: mediated HTTP MCP

- IMPLEMENTED_VERIFIED: user MCP HTTP JSON and bounded SSE responses now use the existing IDE broker.
- Files: `native-user-mcp-http.ts`, `native-user-mcp.ts` and both user-MCP fixture suites.
- Security: HTTPS or explicit loopback HTTP, no redirects/cookies, endpoint-only authorization headers.
- Safety: 256 KiB response cap, request deadlines, cancellation, session cleanup, no tool retries.
- Credentials stay in the host; returned authorization values and bare bearer tokens are redacted.
- Live configuration is rechecked after approval; removed/disabled servers cannot dispatch tools.
- Compatibility limit: server-initiated SSE data messages fail closed; no sampling/elicitation or legacy SSE endpoint.
- Validation: extension typecheck/resources, focused ESLint, compile and native-package checks PASS.
- Compile initially hit sandbox Access Denied on generated dist files; authorized escalation passed.
- Focused final MCP suites: 21 PASS, exit 0; log `.harness/runtime/continuation-http-focused.log`.
- Full integration attempt did not complete: four existing Git fixture suites stalled under the sandbox.
- S1 live RedEvent failed in that attempt; no full-suite PASS is claimed.
- Supervised cancellation verified npm/test ancestry before stopping that owned tree.
- `taskkill` stopped npm, runner and all four test workers, but denied some fixture descendants.
- Denied descendant PIDs at cancellation: 45652, 48768, 46928; do not kill later without rechecking ownership.
- Evidence: `.harness/runtime/continuation-http-integration.log`; remaining full gate deferred to PR CI.
- Review: final diff inspected for credential leaks, redirect bypass, revocation races and cleanup ownership.
- No unresolved correctness finding in the HTTP block; full integration remains an explicit evidence gap.
- Initial remote evidence: `d90f45f91097`, run `42887356224`, Linux/Windows contracts and ATS gate PASS.
- PR #86 was open and non-Draft on arrival; restored to Draft as requested.
- No real model calls, release dispatch, merge or tags.
- Commit: this continuation commit (`feat(mcp): mediate user HTTP tools through IDE permissions`).

### Next work after this bounded continuation

- PARTIAL: native Codex children still disabled; prove isolation, inherited permissions, budget and cancellation.
- PARTIAL: image picker works; paste/drag, PDF and notebook extraction remain to implement.
- PARTIAL: guarded per-run restore exists; attributed per-tool/turn snapshots remain to implement.
- PARTIAL: final installed Windows keyboard/a11y/recovery and six-extension acceptance remain unverified.
- BLOCKED: authenticated provider E2E and provider timings require specific quota authorization.
- BLOCKED: cargo is absent from PATH and the default user cargo location; Rust tests remain unexecuted.
- Optional browser/cloud still require separate isolation/service authority; no new infrastructure provisioned.
- Resume from this checklist and the same branch/PR; preserve untracked prompt and review inputs.
- User reported only 10% session tokens remaining; prioritize coherent reviewed delivery over new broad work.


### Run 42889638708 remediation — HTTP MCP recovery hints

- Source run: https://github.com/Drako01/armotusitio-ide/actions/runs/42889638708, PR #86, `87afbebd41c72503e318134594ac69e3e526bdb0`.
- OBSERVED: Linux `contract` and Windows `contract-windows` each ran 853 tests: 839 PASS, 1 FAIL, 13 SKIP. The `ATS gate` failed as designed because both contracts failed.
- Root cause: `native-error-catalog.test.mts` detected new MCP HTTP codes without explicit recovery guidance: `HARNESS_MCP_HTTP_URL`, `HARNESS_MCP_HTTP_HEADERS`, `HARNESS_MCP_HTTP_STATUS`.
- FIX: add separate actionable recovery hints for endpoint validation, authorization header validation, and HTTP error responses; avoid token disclosure and unsafe automatic repetition of potentially effective writes.
- TEST: preserve the complete `HARNESS_*` source-code catalog check and add targeted assertions for three distinct MCP HTTP hints.
- Commits: `ffb6b24694d` (runtime hints), `6c9f675aa32` (regression test).
- CI status at authoring: PENDING/NOT VERIFIED for new head; previous run is FAIL, not reclassified as PASS.
- No changes to workflow gates, provider credentials, feature flags, `main`, release or tags. No authenticated model calls.
- Next: verify the CI for the exact candidate SHA on Linux and Windows, retain 13 platform SKIPs as SKIP, and only then reassess merge readiness.


### Continuation 2026-11-10: local document attachment handoff

- OWNER: Alejandro Daniel Di Stefano, ArmoTuSitio.com.ar; retain upstream Microsoft notices and custom author metadata.
- Local source: user-provided console logs. The 51 KiB staged patch on F:/PR86-local-changes.patch.txt is **not in the remote PR** and **not attached to the current conversation**. Never claim document implementation has landed before integrating it.
- LOCAL EVIDENCE: extension compile PASS; TypeScript/resource check PASS; native package resource checks PASS after changing the worker path to .mjs.
- LOCAL EVIDENCE: 859 extension tests, 841 PASS, 6 FAIL, 12 SKIP. Three failures in native-chat-attachments.test.mts (HARNESS_DOCUMENT_WORKER_FAILED, notebook/PDF extraction); one catalog failure (nine missing hints); two runtime failures (Claude R06 startup retry and Codex W3 profile separation).
- LOCAL EVIDENCE: precommit hygiene FAIL with 13 unexpected Unicode characters in esbuild.mts, src/chat.ts and src/native-chat-commands.ts; formatting of native-chat-attachments.ts was fixed locally. No Husky bypass authorized.
- REMOTE FIX: 14 attachment/document/PDF/notebook recovery hints (d1f3949355c) and focused regression (a4055e6ccf1) landed independently of the unavailable local patch.
- REQUIRED: receive and integrate staged patch, reconcile newer remote head without dropping user changes, eliminate Unicode hygiene failures, verify ESM worker/PDF.js, run focused tests then full Linux/Windows contracts.
- Codex native subagents: TODO; demonstrate inherited deny/trust, read-only isolation, aggregate budget and cancellation/reaping. Claude remains tool-free isolated role fallback, not provider-native children.
- Multimodal paste/drop and document extraction: PARTIAL locally, not merged remotely; preview, consent, MIME/size validation and hostile document fixtures remain to verify.
- Per-turn/per-tool checkpoints: TODO; require ownership attribution, bounded persistence, conflict detection and granular restoration preserving newer human changes.
- MCP legacy SSE/server-initiated requests: TODO; preserve request-response HTTP JSON/SSE and deny unapproved sampling, roots or elicitation.
- Installed Windows x64 keyboard/screen-reader/recovery/six extensions: BLOCKED BY INSTALLED CANDIDATE EVIDENCE, not equivalent to browser fixture PASS.
- Authenticated E2E and real-provider benchmarks: BLOCKED BY EXPLICIT QUOTA AUTHORIZATION; no paid model calls.
- Rust cargo test: BLOCKED BY LOCAL CARGO TOOLCHAIN; absence is not a PASS.
- Optional browser/cloud: NOT ENABLED; require separate authority and isolation.
- CI must be checked on the exact post-integration SHA, not earlier green candidates.
- PR remains Draft; no merge, tags or release.


### Session handoff — 2026-11-10 (after 51 commits)

- Current authoritative continuation document: [PR86_SESSION_HANDOFF_2026-11-10.md](PR86_SESSION_HANDOFF_2026-11-10.md). The earlier phase checklist is historical evidence, **not proof that later tasks are closed**.
- Reference head before this handoff: `10ce38ad0a83dbdcb0372afb828ec7e215d53484` (51 PR commits). CI run [42902553247](https://github.com/Drako01/armotusitio-ide/actions/runs/42902553247): Linux FAIL, Windows FAIL, ATS gate FAIL.
- Reproduced blockers: `native-chat-attachments.test.mts` PDF returned `HARNESS_DOCUMENT_INVALID`; `native-user-mcp-legacy-sse.test.mts` server-initiated roots/list denial counted 0 instead of 1. Fix and rerun.
- IMPLEMENTED BUT NOT ACCEPTED: media clipboard/drop, isolated PDF/notebook extraction, opt-in legacy SSE, HTTP server-message handling, Codex draft option for read-only child threads.
- REMAINING IMPLEMENTATION: complete native Codex child execution permissions, budget/cancellation, safe per-turn/per-tool checkpoints and granular restore, README/screenshots and full integration.
- REMAINING EVIDENCE: complete CI on final SHA, precommit/VSIX, installed Windows/a11y/six extensions; real-provider quota authorization and cargo availability are explicit external blockers.
- Existing local stash remains the user's backup; this PR implementation was rebuilt remotely. Preserve author Alejandro Daniel Di Stefano — ArmoTuSitio.com.ar and upstream notices.
- Do not mark the PR ready to merge, undraft, merge or release until complete acceptance evidence exists.
