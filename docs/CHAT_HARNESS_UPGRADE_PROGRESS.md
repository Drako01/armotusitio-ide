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


### Continuación 2026-11-10 — corrección de regresiones Linux/Windows (sesión actual)

- **Commit publicado:** `12988b4175eaf29c0f669311168c03a0f4ce1ebb` (`fix(chat): preserve SSE denials and restore canvas-free PDF extraction`). SHA anterior observado: `6b5843e3a48c206da8b5c0e01c1a52466f11e075`.
- **Evidencia base:** GitHub Actions [run 42902553247](https://github.com/Drako01/armotusitio-ide/actions/runs/42902553247): contratos Linux FAIL y Windows FAIL por `HARNESS_DOCUMENT_INVALID` en el fixture PDF y `roots/list` denials `0 !== 1` en legacy SSE. ATS gate FAIL. Logs de ambos jobs inspeccionados.
- **Código implementado, verificación pendiente:** `native-user-mcp-legacy-sse.ts` ahora espera los POST de denegación de solicitudes iniciadas por servidor antes de cerrar la conexión (con timeout existente). Se conserva el rechazo de `roots/list`, sin grants implícitos ni ampliar herramientas. Test regresivo ajustado para exigir denegación antes de salir de `tools()`.
- **Código implementado, verificación pendiente:** parser PDF.js fijado provisionalmente a `4.7.76` para evitar la importación de canvas nativo fallida en runners limpios; worker con scripting desactivado. El log anterior registró `Cannot load "@napi-rs/canvas"`. **AÚN REQUIERE** validar instalación y extracción real en ambos SO y completar/verificar integridad y metadatos de `package-lock.json` mediante npm; este cambio no es todavía un candidato aceptado.
- **CI del commit 12988b4:** [run 42907078946](https://github.com/Drako01/armotusitio-ide/actions/runs/42907078946). Última observación: `changes` PASS; `contract` Linux y `contract-windows` en ejecución; ATS gate sin resultado. No declarar los fallos anteriores corregidos hasta obtener evidencia del SHA exacto.
- **Inspección funcional:** se confirmó que `nativeSubagents` está validado en el draft de Codex, pero no conectado al workflow nativo completo; `native-agent-delegation.ts` implementa un *fallback* Claude read-only, explícitamente distinto de subagentes nativos Codex. `native-run-diff.ts` y la integración de chat permiten descarte por corrida/archivo, pero no snapshots atribuidos por turno/herramienta.
- **Abierto — implementación:** subagentes Codex realmente integrados (autoridad heredada, presupuesto acumulado, cancelación de descendientes); checkpoints por turno/herramienta con restauración granular y preservación de ediciones humanas; cierre E2E de imágenes, documentos y MCP; README principal y capturas auténticas.
- **Abierto — aceptación:** nuevo CI Linux/Windows + ATS gate en verde sobre SHA final, TypeScript/compile/VSIX/Husky, pruebas instaladas Windows/a11y/seis extensiones, Rust donde haya cargo. Tests reales Codex/Claude y benchmarks autenticados continúan BLOQUEADOS sin autorización explícita de cuota; no se hicieron llamadas pagas.
- **Políticas respetadas:** PR #86 permanece Draft; no merge, release, tag, modificación a `main` ni bypass de Husky. Autoría Alejandro Daniel Di Stefano / ArmoTuSitio.com.ar y avisos upstream preservados.
- **Próxima acción inmediata:** observar CI, corregir los nuevos fallos (incluyendo lockfile si aparece), luego continuar las fases funcionales. Reconciliar este apartado con el checklist histórico sin marcar PARTIAL como DONE.


### PR86 — implementación posterior al primer handoff (2026-11-10)

- Base al comenzar esta continuación: `6b5843e3a48c206da8b5c0e01c1a52466f11e075`; primer run rojo observado: [42902553247](https://github.com/Drako01/armotusitio-ide/actions/runs/42902553247).
- `12988b4` FIX: esperar respuestas de denegación a solicitudes MCP iniciadas por servidor antes del cierre de SSE; fijar PDF.js a versión 4.7.76, compatible con extracción de texto sin canvas nativo. Aún debe pasar CI real.
- `dc92d47` DOCS: actualización inicial del checklist con evidencia y bloqueos.
- `3ff6e67` FEAT: selector explícito de subagentes Codex (planner/reviewer; máximo dos, profundidad uno), reserva preventiva de llamadas; denegación bajo presupuesto rígido de tokens/USD sin medición por hijo; lockfile PDF con SHA-512 comprobado.
- `79a7ea4` FIX: deshacer por corrida falla cerrado con hashes ausentes, rutas inseguras, links, archivos grandes y modificaciones humanas posteriores; tests adversariales agregados.
- `290f6de` FEAT: almacenamiento privado acotado de snapshots por herramienta con confirmación y restauración conservadora.
- `a0334ad` FEAT: integración del journal por herramienta en implementaciones del chat, comando `atsHarness.nativeChatToolRestore`, tests y README de la extensión.
- `025b90b` FIX: no seguir enlaces simbólicos al leer snapshots y no atribuir cambios si se inicia otra herramienta antes de capturarlos.
- **Estado real:** esos commits se publicaron, pero todavía no hay evidencia de suite final completa verde. Los runs intermedios fueron cancelados automáticamente por commits nuevos (`cancel-in-progress`); no reinterpretarlos como regresiones o PASS.
- **Pendientes funcionales/aceptación:** consolidar E2E instalado multimodal/MCP/PDF, probar CLI real Codex/Claude con aprobación de cuota, verificar subprocesos hijos y contabilidad, README + capturas auténticas, Rust donde exista cargo, package VSIX y precommit/Husky; CI exacto Linux/Windows/ATS gate.
- **Nuevo hallazgo de alcance:** snapshots por herramienta solo se crean cuando el orden es verificablemente secuencial; simultaneidad o ediciones preexistentes se rechazan y se mantiene el descarte por corrida. No afirmar reversión granular universal.
- **Autoría, protecciones y límites:** Alejandro Daniel Di Stefano / ArmoTuSitio.com.ar; PR Draft, sin tocar `main`, sin merge, tags, release ni consumo autenticado.


### CI verificado para SHA `6b5b08ede94fbe67a9c7abada5ac1174a06d2a0e` — 2026-11-10

- [GitHub Actions 42910325497](https://github.com/Drako01/armotusitio-ide/actions/runs/42910325497): `changes` PASS, `contract` Linux FAIL, `contract-windows` FAIL, `ATS gate` FAIL. **814 PASS / 6 FAIL / 12 SKIP** en cada runner (no es candidato mergeable).
- **Dos fallos anteriores cerrados por test:** extracción real PDF.js sobre fixture local PASS Linux/Windows y denegación de solicitudes `roots/list` legacy SSE PASS Linux/Windows; esto no reemplaza pruebas de IDE instalado.
- **Seis fallos actuales, reproducidos en ambos runners:** (1) test Codex esperaba flags anteriores sin `agents.max_depth=1`; (2-5) cuatro archivos de test abortan al importar `native-chat-tool-checkpoints.ts` porque Node strip-only no admite constructor parameter properties; (6) falta guía para `HARNESS_DELEGATION_BUDGET_UNVERIFIED` en catálogo de errores.
- **Corrección de esta ronda:** reemplazar parameter properties por constructor explícito; actualizar aserción de flags Codex sin relajar límites; agregar guía de recuperación para presupuesto y códigos de checkpoint. **Resultado posterior: PENDIENTE de CI del nuevo SHA**.
- **Aceptación aún pendiente:** CI completo, VSIX instalado, accesibilidad, seis extensiones, capturas reales, aislamiento/cancelación E2E y proveedores autenticados (sin autorización de cuota). PR sigue Draft; sin merge ni release.


### Optimización del timeout MCP legacy SSE — 2026-11-10

- En [run 42910325497](https://github.com/Drako01/armotusitio-ide/actions/runs/42910325497), el test negativo de SSE sin endpoint tomó aproximadamente **303.7 segundos** por runner, pese a una ventana de descubrimiento de 50 ms. El resultado era PASS pero la limpieza de streams bloqueaba el CI.
- Se acotó la obtención de headers y el cierre del reader SSE para que los peers que nunca terminan un stream no bloqueen el test ni el IDE durante minutos; se mantiene el aborto de la sesión y la denegación de permisos.
- Se agregó aserción explícita de tiempo al test de timeout. **Pendiente de validar** en Linux/Windows; no se declara PASS hasta el nuevo workflow.


### Candidato verde anterior a integración final de Codex — 2026-11-10

- **SHA evaluado:** `f8dffb0780c0b207720ea8ea521482b380f16f3d` — [run 42913039996](https://github.com/Drako01/armotusitio-ide/actions/runs/42913039996). Contratos Linux **PASS**, contratos Windows **PASS**, ATS gate **PASS**. Los dos errores originales PDF/MCP y las seis regresiones del journal quedaron resueltos por pruebas en ambos runners. Esta evidencia aplica **solo al SHA indicado**, no a commits posteriores.
- **Bloque nuevo de esta revisión:** se conecta la opción explícita `atsHarness.codexReadOnlySubagents` de ámbito aplicación a las sesiones persistentes Codex de solo lectura; no se inyecta `ats-runner` MCP en esas sesiones; sin web, sin writer y sin full-access. Solo cuando la persona lo habilita; los límites heredados son dos hijos y profundidad V1 uno. Se fuerza `features.multi_agent_v2=false` porque la versión V2 de Codex no respeta `agents.max_depth`, según el código/configuración del proveedor. La interrupción detiene el árbol supervisado; faltan pruebas reales de aislamiento de la CLI instalada.
- **Nuevas pruebas/gates:** tests de CLI arguments, aislamiento de roles y rechazo de permiso no válido sin consumir tokens; el CI ejecutará adicionalmente `compile` y `check:native-package` en Linux y Windows, además de sus contratos previos.
- **Estado del bloque nuevo:** IMPLEMENTADO PERO NO VALIDADO; requiere CI completo sobre el siguiente SHA. No equivale a validar proveedores autenticados, VSIX instalado, accesibilidad ni seis extensiones. Presupuestos estrictos de tokens/USD siguen rechazando subagentes por falta de recibos agregados por hijo.
- Mantener PR #86 **Draft**, `main` intacto, sin release, sin merge ni cuota consumida.


### Corrección CI del empaquetado — 2026-11-10

- **Fallo reproducido:** [ATS IDE Extension 42913973674](https://github.com/Drako01/armotusitio-ide/actions/runs/42913973674), SHA `9637c1df3f3a37a2f48aa97ba9a588f1afecb47a`: `contract` Linux y `contract-windows` FAIL antes de los tests, durante `npm run compile`; `ATS gate` FAIL. Error exacto: `ERR_MODULE_NOT_FOUND: Cannot find package 'esbuild' imported from extensions/esbuild-extension-common.mts`.
- **Causa raíz:** `npm ci` del root y de `extensions/armotusitio-ide` no instala la dependencia compartida de `extensions/package.json`, donde `esbuild@0.28.1` está fijado por `extensions/package-lock.json`. No es un error de TypeScript ni del proveedor Codex.
- **Corrección implementada (pendiente de validar en nuevo CI):** `.github/workflows/ats-ide-extension.yml` instala `npm ci --prefix extensions --ignore-scripts --no-audit --no-fund` en ambos runners antes de compilar; mantiene `check`, `compile`, `check:native-package`, tests y `ATS gate` activos, sin cambios a permisos ni instalación de paquetes no fijados.
- **Próxima acción:** verificar `compile`, `check:native-package`, contratos y gate para el SHA nuevo en Linux/Windows. No marcar PASS antes de la ejecución remota. El PR sigue Draft; no merge ni release.


### Gate de paquete y límites de cuota — 2026-11-10

- [Run 42913973674](https://github.com/Drako01/armotusitio-ide/actions/runs/42913973674) SHA `9637c1df3f3a37a2f48aa97ba9a588f1afecb47a`: Linux FAIL, Windows FAIL y ATS gate FAIL en compilación por `ERR_MODULE_NOT_FOUND: esbuild`. `npm run check` pasó, pero los contratos no se ejecutaron por el error de entorno.
- Fix CI: instalar `extensions/package-lock.json` (con `esbuild@0.28.1`) mediante `npm ci --prefix extensions --ignore-scripts` en ambos SO antes de compilar, sin tocar protecciones.
- Fix seguridad: el límite `max_concurrent_threads_per_session=2` es de simultaneidad, no de hijos totales; se rechazan subagentes Codex si hay cuota diaria o límites rígidos de tokens/USD sin contabilidad real por hijo. V1 activado con `features.collab=true` y V2 desactivado para que `agents.max_depth=1` sea aplicable.
- Próxima evidencia: CI final del nuevo SHA con compilación, paquete, tests y ATS gate; no declarar PASS sin resultado.


### Consolidación de instalación compartida de dependencias — 2026-11-10

- Se observó un commit concurrente `c6143f7` que añadió el mismo `npm ci --prefix extensions` a Linux/Windows mientras se preparaba el fix `b5dd91f`. El workflow resultante contenía cada instalación dos veces; se deduplicó en la misma rama y se conservó una instalación fijada por lockfile en cada SO.
- El nuevo CI debe validarse sobre el SHA de este commit. No se usa `--force`, no se reescribe historial ni se toca `main`.


### Fix: host mocks sin API inspect — 2026-11-10

- **Base fallida:** [run 42914858122](https://github.com/Drako01/armotusitio-ide/actions/runs/42914858122) sobre `316904e0a73cdc097cbb9c1865d059957bc00180`, contrato Linux FAIL con 11 tests: `Cannot read properties of undefined (reading 'digest')`, `content`, y `getConfiguration(...).inspect is not a function`. Windows aún no concluyó en el instante de este cambio; no se declara PASS.
- **Causa raíz comprobable:** la nueva preferencia de subagentes usa `inspect()` en `native-integration.ts`, pero varios hosts falsos de regresión solo implementan `get()`. El acceso lanzaba `TypeError` antes de ejecutar las rutas normales, causando múltiples fallos en cascada.
- **Corrección:** uso conservador de `inspect?.()` para mantener desactivados los hijos cuando el host no expone la inspección de ámbito. Un proyecto no puede activar la opción por omisión; con la API real se sigue exigiendo `globalValue === true`.
- **Validación:** PENDING para el nuevo SHA; los 11 tests anteriores siguen contados FAIL en el histórico, no se cambia el CI ni se desactivan tests. Próxima acción: comprobar Linux/Windows y `ATS gate` del último SHA.


### Hardening P0: atestación de subagentes nativos (2026-11-10)

- **Baseline CI observado:** SHA `311f495f55291b013e1f8c38242ebb4bb8e79b2e`, [run 42915502467](https://github.com/Drako01/armotusitio-ide/actions/runs/42915502467): `changes`, `contract` Linux, `contract-windows` y `ATS gate` **PASS**; compilación y `check:native-package` en ambos runners PASS. No equivale a probar un IDE instalado.
- **Cambios nuevos (PENDING CI para el SHA siguiente):** `extensions/armotusitio-ide/src/native-agent-execution.ts`, `extensions/armotusitio-ide/src/runtime/codex-adapter.ts`, `extensions/armotusitio-ide/src/native-agent-transport.ts` exigen línea base Git y escaneo sensible completo antes de iniciar subagentes Codex nativos, preservando denegación por defecto; al finalizar no reportan PASS sin huella de solo lectura verificable ni telemetría estructurada del proveedor. Errores de medición o permisos no se silencian.
- **Pruebas sintéticas nuevas (PENDING):** `extensions/armotusitio-ide/test/native-agent-execution.test.mts`, `extensions/armotusitio-ide/test/native-codex-subagents-guard.test.mts` comprueban rechazo antes del spawn en repositorio no auditable y éxito/fallo con/sin uso estructurado del padre. No llaman a proveedores ni consumen cuota.
- **Límites reconocidos:** el escaneo Git es detección complementaria, **no** sandbox de sistema operativo; la telemetría del padre no es recibo granular de sus hijos; con límites de tokens/USD o llamadas diarias la delegación sigue bloqueada. Los E2E reales, interfaz instalada, capturas y accesibilidad siguen pendientes; estado de subagentes **PARTIAL**, no DONE.
- **Siguiente acción:** validar código/contratos Linux y Windows, empaquetado y gate sobre el HEAD resultante; corregir fallos sin desactivar pruebas. PR continúa Draft; no tocar `main`, no publicar releases y no ejecutar modelos autenticados sin autorización.


### Cierre local de fases P0–P5 — 2026-11-10 (sin push)

Punto de partida: `dc88a453bd9` (local = remoto, CI [42916514858](https://github.com/Drako01/armotusitio-ide/actions/runs/42916514858) PASS). Los commits de este bloque son **locales**: no existe CI remoto para ellos y no se interpretan como PASS de CI.

| Fase | Estado | Evidencia local |
|---|---|---|
| P0 Subagentes Codex | PARTIAL (código DONE; proveedor real BLOCKED por cuota) | Commit `6e42a167b82`; suites focalizadas 118 PASS |
| P1 Checkpoints | DONE en código y tests; recuperación en IDE instalado sin evidencia | Commit `9520e8be9b4`; 5 PASS propios, 32 PASS relacionados |
| P2 Multimodal | DONE en código y tests; interfaz instalada sin evidencia | 12 PASS (imágenes y documentos) |
| P3 MCP | DONE en código y tests | 27 PASS (stdio, HTTP JSON/SSE, legacy SSE) |
| P4 Instalación real y UX | BLOCKED | No hay candidato del SHA del PR (ver abajo) |
| P5 README y capturas | README DONE; capturas BLOCKED por P4 | Sin mockups ni capturas sintéticas |

**P0 — hallazgo y corrección.** Verificado contra el binario real **Codex CLI 0.166.0** con `codex features list` (sin llamadas al modelo): `multi_agent` es `stable` y viene en `true`. Las sesiones sin opt-in **no** tenían los hijos apagados; además `features.collab` ya no tiene efecto en esa versión. Corrección: toda invocación Codex sin opt-in pasa `features.multi_agent=false` y `features.multi_agent_v2=false` (solo claves `features.*`, que un CLI viejo ignora; una clave `agents.*` desconocida se rechaza como rol mal formado). Con opt-in: `features.multi_agent=true`, `agents.max_threads=2`, `agents.max_concurrent_threads_per_session=2`, `agents.max_depth=1`. Nuevo `CodexChildGuard` (one-shot y app-server) detiene el árbol de procesos y falla la corrida con `HARNESS_DELEGATION_CHILD_UNEXPECTED`, `_DEPTH` o `_LIMIT` (más de 4 inicios/reanudaciones por turno; el límite de 2 es de simultaneidad). Cambiar la búsqueda web cierra las sesiones abiertas: antes una sesión abierta con hijos podía seguir activa sin pasar por el control de presupuesto. Se corrigió la etiqueta del selector que mostraba `\u00e1` literal.
Archivos: `src/native-codex-subagents.ts`, `src/runtime/codex-adapter.ts`, `src/native-agent-execution.ts`, `src/native-provider-output.ts`, `src/native-integration.ts`, `src/native-error-catalog.ts` y tests `native-codex-subagents-guard`, `native-agent-execution`, `native-agent-adversarial`, `native-runtime-fakes`.
Límite reconocido: no hay recibos de consumo por hijo, así que con cuota diaria o topes de tokens/USD la delegación sigue bloqueada (`HARNESS_DELEGATION_BUDGET_UNVERIFIED`). La herencia real del sandbox en los hijos no se probó: requiere cuota autorizada.

**P1 — hallazgos y corrección.** (1) La lista y la retención ordenaban por nombre de archivo, que es un UUID aleatorio: se podían podar checkpoints recientes; ahora se ordena por fecha del registro. (2) El contenido previo se leía con `git show`, que devuelve el blob normalizado; con `core.autocrlf` restaurar cambiaba los finales de línea. Ahora usa `git cat-file --filters`. (3) Una restauración interrumpida quedaba bloqueada para siempre; ahora una nueva confirmación la reanuda y una edición humana posterior la bloquea entera. (4) Cada registro guarda `turnId` y `sequence` (campos opcionales; los registros anteriores siguen siendo válidos). El descarte por corrida no cambió.
Archivos: `src/native-chat-tool-checkpoints.ts`, `src/native-integration.ts`, `src/native-error-catalog.ts`, `test/native-chat-tool-checkpoints.test.mts`.

**P2 — auditoría sin defectos de código.** Se agregaron pruebas negativas que faltaban: imagen pegada/arrastrada con MIME falso, base64 inválido, bytes truncados o sobrantes, dimensiones excesivas y expiración; worker de documentos que se cuelga (timeout), agota memoria, termina solo o responde fuera de contrato.

**P3 — una corrección.** Una respuesta HTTP JSON mal formada propagaba el error del parser, que cita el cuerpo recibido; ahora se informa solo `HARNESS_MCP_PROTOCOL`. Test `malformed` agregado. Sin cambios de política; todo sigue fail closed.

**Higiene.** El hook Husky falló al tocar archivos con deuda previa (commits anteriores se hicieron sin hook): caracteres no ASCII en `native-error-catalog.ts`, formato en `native-integration.ts` y encabezados no estándar. Se corrigieron en los archivos tocados, sin bypass; la línea de autoría ArmoTuSitio se conservó en un comentario propio bajo el encabezado de Microsoft. Otros 17 archivos conservan ese encabezado no estándar y fallarán el lint cuando se editen.

**P4 — bloqueo comprobado.** Los únicos binarios del equipo (`F:/armotusitio-ide-win32-x64` y la instalación en `%LOCALAPPDATA%/Programs/ArmotuSitio IDE`) son IDE 1.145.2, commit `45d7e833c3d`, anteriores a este PR. No se usaron como evidencia. Las seis extensiones figuran en la carpeta de ese build viejo, lo que **no** prueba instalación ni activación en el candidato del PR. Linux, macOS y WSL: NO EJECUTADO. Procedimiento: publicar la rama, esperar CI verde del SHA final, construir con `scripts/ats-package-windows.mts` desde ese SHA, instalar y seguir `docs/PR86_SCREENSHOT_CAPTURE.md`.

**Validación final local (Windows 11, Node 24.22.1).** `npm run check` PASS; `npm run compile` PASS; `npm run check:native-package` PASS (incluye worker PDF); ESLint de los archivos tocados PASS; Husky/hygiene PASS en cada commit. Suite completa `npm test`: **888 tests, 875 PASS, 1 FAIL, 12 SKIP** (412 s). El FAIL es `a provider that dies while starting is retried once (R06)` del contrato de runtime **Claude** (esperado `completed`, obtenido `failed`). Es intermitente en Windows local: aislado pasó 36/36 en dos corridas y falló 35/36 en una; ya figuraba como fallo local en este checklist y pasó en el CI de `dc88a453bd9`. El adaptador Claude y su proveedor falso no se modificaron. Queda **FAIL abierto (inestable)**, no reclasificado como PASS; hay que confirmarlo en el CI del SHA final. Los 12 SKIP son de plataforma y se conservan.

**Pendiente.** Push de la rama (no autorizado en esta sesión), CI Linux/Windows del SHA final, candidato instalado con capturas y accesibilidad, E2E autenticado de Codex/Claude (cuota), tests Rust (sin `cargo`). El PR sigue Draft: **no está listo para merge**.
