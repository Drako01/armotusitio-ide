# Chat Harness candidate evidence

## Candidate

VS Code 1.145.3 (`dcd3ad6e368fbe19d03f37054a40dbaf40d676f4`), ArmotuSitio revision 1.
The four supplied 2026-11-10 documents are the baseline; this records implementation evidence rather than a new audit.
The status-bar Chat Harness, sidebar and native `@harness` share session, tools and permissions.

## Capability matrix

| Benchmark dimension | Status | Evidence or limit |
|---|---|---|
| 01 Conversation and editing | IMPLEMENTED_VERIFIED | Shared participant/host/session fixtures |
| 02 Streaming and timeline | IMPLEMENTED_VERIFIED | Native process fixtures; authenticated smoke BLOCKED |
| 03 Approved plans | IMPLEMENTED_VERIFIED | Version/digest/conformance regressions |
| 04 Per-file diff/revert | IMPLEMENTED_VERIFIED | Existing guarded subset restore and post-run hashes |
| 05 Restart/fork/handoff | IMPLEMENTED_VERIFIED | Runtime fixtures; archive/resume; real reboot not verified |
| 06 Agent/Ask/Plan/Debug | IMPLEMENTED_VERIFIED | Existing modes and read-only diagnostic plan workflow |
| 07 Permission scopes | IMPLEMENTED_VERIFIED | Lock, 50 competing-process rounds, denial precedence |
| 08 Multiple accounts | IMPLEMENTED_VERIFIED | Isolated profiles, pinned environment, cache regression |
| 09 Terminal/Git | IMPLEMENTED_VERIFIED | Command/jobs/terminal/Git fixture gates |
| 10 Skills/commands | IMPLEMENTED_VERIFIED | Ten native skills and digest-checked Claude command files |
| 11 Claude user MCP | IMPLEMENTED_VERIFIED | Existing broker/fixtures; live service not re-run |
| 12 Codex user MCP | PARTIAL | Mediated stdio verified; HTTP unsupported |
| 13 Dynamic subagents | PARTIAL | Claude tool-free roles; Codex disabled without proven child isolation |
| 14 Multimodal | PARTIAL | PNG/JPEG picker/preview/consent/protocol; no paste/PDF/notebook bridge |
| 15 Editor context | IMPLEMENTED_VERIFIED | Selection/symbols/diagnostics/ranges/terminal/folder/tracked diff |
| 16 Incremental retrieval | IMPLEMENTED_VERIFIED | Bounded lexical/symbol index; fixture benchmark against rg |
| 17 Searchable conversations | IMPLEMENTED_VERIFIED | Archive/search/resume/shared surfaces |
| 18 Queue/steering | IMPLEMENTED_VERIFIED | Existing safe-point queue/provider contracts |
| 19 Fine checkpoints | PARTIAL | Per-run/per-file guarded restore; no arbitrary per-tool snapshots |
| 20 Interactive browser | BLOCKED | Optional origin/credential isolation not exposed |
| 21 Local background | IMPLEMENTED_VERIFIED | Existing job supervision/cancellation/recovery fixtures |
| 22 Remote delegation | BLOCKED | Optional service and code-export approval absent |
| 23 Governance/trust | IMPLEMENTED_VERIFIED | Trust/fences/serialized permissions/private output/mediated tools |
| 24 Cost/quota | IMPLEMENTED_VERIFIED | Reported-use accounting/parent-reserved child budget |
| 25 Branding/six extensions | IMPLEMENTED_VERIFIED | Six actual VSIX identities/hashes/native section tests |

Verified means named local contracts, never authenticated production or final installed-release proof.
The competitor comparison remains the supplied dated baseline; no universal parity or model-quality claim is made.

## Acceptance boundaries

- CH-01–07, CH-09–10, CH-14–18 and CH-21–24 have relevant local negative/regression fixtures.
- CH-08 verifies Codex stdio discovery, mediated invocation and revocation; HTTP remains unsupported.
- CH-11 verifies image bounds, consent cancellation, mutation, expiry and protocol bytes without local journal storage.
- CH-12–13 retain collision checks and explicit discard confirmation; fine snapshot attribution remains partial.
- CH-19–20 have responsive/native tests and six VSIX checks, without installed-app accessibility certification.
- CH-25 and authenticated login/quota/reboot flows remain BLOCKED: real model quota was not authorized.
- WebFetch approval is the IDE boundary; provider DNS/redirect execution is not certified by these fixtures.

## Release and optional-service decision

GitHub confirmed the release workflow active and Actions enabled. Candidate release: `ats-v1.145.3-r1` after merge.
Preparation validates reviewed metadata with read-only permissions and never pushes to main.
Builds consume an immutable selected SHA; signing and artifact checks remain mandatory.
Rollback uses reviewed source and existing controls, without rewriting tags or bypassing protections.

Browser/cloud ADR decision: requires approval/service. No browser-profile reuse, code export or paid service was added.
Official extensions remain independent; the native pane reads the same six IDs as the build manifest.

## Probato disposition

- Delegation observer: bounded failure count/code; exceptions cannot control execution.
- Termination failure: bounded diagnostic callback/warning and owned-process cancellation.
- MCP discovery: per-server bounded codes; failure cannot remove local tools.
- Two suspected secrets: synthetic canaries, tested absent from schemas and returned results.
- Probato ran no checks; executed runtime fixtures provide the verification evidence.

## Evidence and residual work

- Upstream: full 73-path delta, 68 exact upstream blobs and five intentional fork customizations before pane additions.
- Build client/extensions/Copilot PASS; Node 836 PASS/14 platform pending; Electron 1314 PASS/14 pending.
- Six VSIX: published SHA-256, internal identity/version, engines and entrypoints checked.
- Benchmark: `.artifacts/chat-harness-upgrade/context-benchmark.json`, three samples per 50/500/2000-file fixture.
- Source hashes bind measurements; later type-only module cleanup is not a new timing measurement.
- Provider-first-token and installed-UI latency were not measured. Rust checks BLOCKED because cargo is unavailable.
- Dev-host screenshot: `output/playwright/chat-harness-dev/03-pre-reload.png`, predating final source reload.
- Final installer, macOS/WSL, screen reader and authenticated acceptance remain NOT VERIFIED.
- Original-plan residuals: Codex HTTP MCP/native children, paste/drag/PDF/notebooks and attributed per-tool checkpoints.
- Optional browser/cloud remains separate. The Draft PR does not present these limits as completed work.
