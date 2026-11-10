# Chat Harness upgrade progress

## Scope and baseline

- Date: 2026-11-10. Local branch: `feat/chat-harness-competitive-parity`.
- Baseline: `45d7e833c3dadd552efd10d239d3db9faa6f5af5`, IDE 1.145.2, extension 0.6.0, Node 24.22.1.
- Inputs: the four dated audit, roadmap, scorecard and competitive benchmark files in `F:/armotusitio-ide-plans/ide`.
- Authorization: local implementation, tests and commits only. No push, PR, tags, deployment, workflows or paid calls.
- Existing untracked `PROMPT_CODEX.md` belongs to the user and is excluded from commits.
- This file is the execution checklist required by the prompt.
- Existing Harness stores remain authoritative for runtime tasks.

## Phase checklist

| Phase | State | Evidence and next action |
|---|---|---|
| 0 Baseline and reconciliation | PARTIAL | Four input documents read; checkout matches audited SHA; candidate matrix being reconciled against sources/tests |
| 1 Integrity and security | PARTIAL | Release/gate block passes 42 focused fixtures; permissions/logs under verification |
| 2 Providers, MCP and accounts | TODO | Existing adapters negotiate versions; user MCP/subagent gaps require mediated implementations |
| 3 Context and multimodal | TODO | Extend existing mention broker; preserve exclusions and bounded untrusted context |
| 4 UX and checkpoints | TODO | Reuse chat/session state and existing worktree checkpoints; verify finer recovery and surfaces |
| 5 Debug and autonomy | TODO | Preserve bounded retry/jobs; integrate diagnosis with real evidence |
| 6 Skills and customizations | TODO | Extend existing skill catalog and verify six official extension contract |
| 7 Optional browser/cloud | TODO | Record feasibility decision without remote infrastructure or account access |
| 8 Validation | TODO | Run extension gates once after integration; installed/authenticated/platform evidence separately |

## Constraints and residual evidence

- Authenticated provider calls require explicit quota authorization and are BLOCKED for this run.
- Remote CI cannot run without publishing/dispatch authorization. Local fixtures are separate evidence.
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
- Commit: pending local commit; record SHA in the next block.
