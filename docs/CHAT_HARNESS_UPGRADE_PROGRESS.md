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
