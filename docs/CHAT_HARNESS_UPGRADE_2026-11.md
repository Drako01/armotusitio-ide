# Chat Harness: upgrade de compatibilidad Codex y paridad (noviembre 2026)

Rama: `feat/chat-harness-codex-parity-upgrade`, creada desde `main` (`4d29fbcc39b`) para un único PR.
Punto de partida: el candidato del PR #86 (VS Code 1.146.0, Codex CLI 0.166.0 validado) y sus documentos
de evidencia. Este documento es la fuente de verdad del upgrade: estados, evidencia y límites.

Estados: `DONE` (código y pruebas en verde localmente), `VERIFIED` (además, comprobado contra el binario o
servicio real sin consumir cuota de modelo), `PARTIAL`, `TODO`, `BLOCKED` (requiere credenciales, cuota,
infraestructura o un binario instalado que no existe en este equipo).

## 1. Auditoría inicial: qué cambió en Codex desde el candidato

Comparación hecha contra el CLI real, sin llamadas al modelo: `codex app-server generate-ts` y
`codex features list` de **0.166.0** (instalado) y **0.169.0** (publicado el 2026-11-13, descargado a un
directorio temporal), más la referencia oficial de configuración.

| Hallazgo | Impacto en el candidato | Estado |
|---|---|---|
| El adaptador exigía el mismo `major.minor` que los bindings generados (0.166). Codex publica semanalmente: con 0.167 o posterior el chat caía al canal estructurado y avisaba «versión incompatible». | Cualquier actualización del CLI degradaba la experiencia. | DONE |
| `approval_policy = "untrusted"` está retirada en la documentación oficial («Codex no longer supports…»); en el código fuente queda como marcador interno de proyectos no confiables. El adaptador la enviaba para todo rol escritor. | Política obsoleta con comportamiento no documentado a futuro. | VERIFIED |
| Protocolo 0.166 → 0.169: cambios **aditivos**: `humanCommand` como tipo de aprobación, `inferenceHookDenied` como error, `AgentMessageModeration`, `contentTokenCount` y la capability `requiredHumanApproval`. | Sin ruptura; el cliente debe tratar `humanCommand` como decisión única. | DONE |
| `features.multi_agent` pasó a `deprecated` en 0.169; el servidor indica usar `[agents].enabled = false` para apagar las herramientas de subagentes. `agents.enabled` también es aceptado por 0.166 (`codex -c agents.enabled=false features list`). | El apagado explícito de hijos dependía de una clave en desuso. | VERIFIED |
| `thread/start` acepta `untrusted`, `on-request` y `granular` en ambas versiones (sonda local con hilo efímero). | Confirma que el cambio de política no rompe el handshake. | VERIFIED |

## 2. Checklist maestro

### P0: compatibilidad y estabilidad del runtime

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P0-1 | Bindings regenerados desde Codex 0.169.0; `generate-codex-protocol.mts` acepta `CODEX_BIN` para generar desde un binario concreto | DONE | `src/runtime/codex-protocol.generated.ts` (diff aditivo), `CODEX_PROTOCOL_VERSION = "0.169.0"` |
| P0-2 | Compatibilidad por rango: piso `CODEX_MIN_SUPPORTED_VERSION = 0.166.0`; un CLI más nuevo que lo validado sigue nativo y avisa una vez; uno más viejo cae al canal estructurado con el motivo | DONE | `codexCompatibility`, `compareVersions` en `codex-adapter.ts`; tests `native-runtime-units` (rango) y `native-runtime` S20 (0.150 degrada, 0.199 sigue nativo) |
| P0-3 | Escritores con `on-request` (política documentada); `untrusted` nunca se envía | DONE | S21: ninguna sesión guardada con `untrusted` |
| P0-4 | `humanCommand`: decisión única; un veredicto «esta sesión» del IDE se acota a ese comando | DONE | S21 (`decision=accept`; control con `RUN` → `acceptForSession`) |
| P0-5 | Errores tipados de turno (`codexErrorInfo`) → códigos estables `RUNTIME_RATE_LIMITED`, `RUNTIME_CONTEXT_EXCEEDED`, `RUNTIME_UNAUTHENTICATED`, `RUNTIME_PROVIDER_UNAVAILABLE`, `RUNTIME_MODEL_UNAVAILABLE`, `RUNTIME_POLICY_BLOCKED`, con pista de recuperación en el chat | DONE | `codexTurnError`, catálogo `native-error-catalog.ts`, `failureNotice`; tests unitarios y S21 (`contextWindowExceeded`) |
| P0-6 | Hijos apagados también con `agents.enabled=false` | DONE | `readonlyCodexSubagentOverrides`; tests de guard y de invocación |
| P0-7 | Claude Code: sin cambios de contrato; solo se agrega la medición del primer token | DONE | Suite completa (§4) |
| P0-8 | Inicio, streaming, herramientas, aprobaciones, cancelación y reanudación con proveedor **real autenticado** | BLOCKED | Requiere cuota autorizada; no se consumió ninguna llamada al modelo |

### P1: memoria y contexto

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P1-1 | La memoria compactada conserva por corrida: archivos editados (de los pasos observados por el IDE), gates fallidos, descartes, reversiones y continuaciones. Nunca prosa del modelo. | DONE | `runRecord` en `native-chat-memory.ts`; test «a compacted run keeps what later turns need» |
| P1-2 | Sin repetición de contexto al proveedor: las sesiones nativas reciben solo el texto nuevo; el canal estructurado reenvía historia acotada por presupuesto | DONE (ya existía) | `buildConversationInstruction`, `nativeTurn(... fresh ...)` |
| P1-3 | Selección por relevancia, aislamiento por proyecto y resistencia a inyección | DONE (ya existía) | Índice híbrido acotado; memoria por `root`; «never authorizes execution» |

### P1: multiagentes

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P1-4 | Recibos de consumo de hilos hijos de Codex: `thread/tokenUsage/updated` de hilos nombrados por `collabAgentToolCall` o `subAgentActivity` se suman al turno (`childThreads`, `childInputTokens`, `childOutputTokens`); hilos ajenos se ignoran | DONE | Adaptador; fake con dos reportes por hijo y un hilo extraño; test de guard (opt-in) |
| P1-5 | Bloqueo de presupuestos no verificables (`HARNESS_DELEGATION_BUDGET_UNVERIFIED`) | DONE, se mantiene | El gate no se relaja hasta que una corrida real confirme que el servidor emite al cliente los recibos de los hijos |
| P1-6 | Límites de concurrencia y profundidad, cancelación y reaping | DONE (ya existía) | `CodexChildGuard`, tests de guard |

### P1: checkpoints y objetivos en el chat

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P1-7 | `/checkpoints` lista los checkpoints granulares (turno, herramienta, archivos) y `/checkpoints restaurar ID` restaura por el **mismo** camino que el comando de la paleta: confirmación modal, fence compartido y lease del proyecto | DONE | `runCheckpointsCommand`; `restoreToolCheckpoint` extraído en `native-integration.ts`; test de comandos |
| P1-8 | `/objetivos` lista los objetivos autónomos de la ventana con estado y preguntas pendientes; `/objetivos pausar ID` y `/objetivos detener ID` actúan en el próximo punto seguro | DONE | `GoalIntegration.list` y `control`; test de comandos |
| P1-9 | Vista unificada en el webview del chat (progreso, responsables, etapas) | PARTIAL | Expuesta por comandos y por la actividad existente; el rediseño del webview exige un candidato instalado para validar visual y accesibilidad |

### P1: UX, MCP y multimodalidad

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P1-10 | Errores con próximo paso y código visible | DONE | `failureNotice` con `recoveryHint` |
| P1-11 | Consumo real: `/costo` agrega subagentes informados y primer token | DONE | `native-chat-commands.ts` |
| P1-12 | MCP stdio, HTTP y legacy SSE; imágenes, PDF y notebooks | DONE (PR #86), sin cambios | Suites existentes en la corrida completa |
| P1-13 | Timeline, colapsables, ARIA, teclado | DONE (PR #86), sin cambios | Webview con regiones ARIA y `<details>`; certificación en IDE instalado BLOCKED |

### P2: rendimiento y observabilidad

| ID | Ítem | Estado | Evidencia |
|---|---|---|---|
| P2-1 | Latencia hasta el primer token medida por turno en ambos adaptadores (`firstTokenMs`), expuesta en el resultado y en `/costo` | DONE | `codex-adapter.ts`, `claude-adapter.ts`, `outcomeOf`; test de guard (`firstTokenMs >= 0`) |
| P2-2 | Medición con proveedor real | BLOCKED | Cuota |

### P3: opcionales

| ID | Ítem | Estado |
|---|---|---|
| P3-1 | Navegador interactivo, delegación remota o cloud | BLOCKED (decisión ADR vigente: requieren servicio y autorización; nada instalado ni habilitado) |

## 3. Brechas cerradas frente a Codex

- El IDE sigue a Codex en su cadencia semanal sin perder el transporte nativo ni fingir compatibilidad:
  rango validado y aviso explícito cuando el CLI es más nuevo que los bindings.
- Política de aprobación alineada con la referencia oficial (`on-request`) y soporte del flujo
  `humanCommand` con decisión única.
- Los errores de Codex llegan tipados al usuario con una acción concreta, no como prosa del proveedor.
- Contabilidad de hijos: cuando el servidor emite recibos por hilo, se suman al turno; cuando no, el
  presupuesto sigue bloqueado. Nunca se estima.
- Checkpoints por herramienta y objetivos autónomos operables desde el chat, además de la paleta.

## 4. Validación local

Windows 11, Node 24.22.1, `extensions/armotusitio-ide`, sobre el último commit de código de la rama.
Son resultados locales: no existe CI remoto para estos commits y no se interpretan como PASS de CI.

| Gate | Resultado |
|---|---|
| `npm run check` (tsc estricto ×2, recursos, índice de skills) | PASS |
| `npm run compile` | PASS |
| `npm run check:native-package` | PASS |
| ESLint de los archivos tocados | PASS (0 errores) |
| Hygiene (hook de pre-commit) en cada commit | PASS |
| `npm test` completo (`--test-concurrency=4`) | 894 tests: 881 PASS, 1 FAIL, 12 SKIP (plataforma), 94 s |

El único FAIL fue `provider invocation holds command arguments fixed regardless of hostile instructions`:
el test filtraba las claves `multi_agent` pero no la nueva `agents.enabled=false`. Se corrigió el filtro y
se agregó la aserción de que la clave está presente; la suite `native-agent-adversarial` se volvió a
ejecutar aislada: 4/4 PASS. Ningún otro archivo cambió después de la corrida completa, por lo que el resto
de la evidencia sigue vigente. El fallo intermitente de Windows documentado en el PR #86 (`R06` de Claude)
no apareció en esta corrida.

Sondas sin modelo ejecutadas contra los binarios reales: `codex --version`, `codex features list`,
`codex app-server generate-ts` y un `thread/start` efímero con `untrusted`, `on-request` y `granular`
en 0.166.0 y 0.169.0 (ambos aceptan las tres). Llamadas reales al modelo: **0**.

## 5. Límites y bloqueos externos

- Ninguna llamada real a Claude ni a Codex: todo lo verificado sobre protocolo usa el binario real sin
  modelo (`generate-ts`, `features list`, `thread/start` efímero) o fakes fieles al protocolo.
- No existe un build instalado del SHA de esta rama: capturas, accesibilidad con lector de pantalla y
  recuperación en IDE instalado quedan pendientes, como en el PR #86.
- Los recibos de hilos hijos se implementaron según el contrato del protocolo; que el servidor los emita
  al cliente padre debe confirmarse con una corrida autenticada antes de relajar el gate de presupuesto.
- `cargo` no está en PATH: pruebas Rust no ejecutadas.
