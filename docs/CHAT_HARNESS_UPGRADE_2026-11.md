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
| P1-9 | Objetivos en el webview del chat: tarjetas con proyecto, objetivo, estado, preguntas pendientes y Pausar/Detener (misma gramática visual que las aprobaciones) | DONE (visual en IDE instalado: BLOCKED) | `renderGoals` en `resources/chat.ts`, `goals` en el estado y acción `goal` en `src/chat.ts`; test de navegador `chat-goals-card.test.cts` (texto del modelo inerte, botones deshabilitados según estado) |

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

## 6. Cierre de hallazgos de la auditoría (2026-11-13, tarde)

Commit `091de302c12` sobre `1b109072b56` (commit del propietario con los literales de `native-chat-commands.ts` y la latencia del camino de implementación).

| Hallazgo | Estado | Evidencia |
|---|---|---|
| Literales con escape roto (`versi00f3n`, `2026 y`, …) en adapter, comandos e integración | DONE | 29 literales corregidos; test `native-source-encoding.test.mts` recorre `src/**` y falla ante cualquier escape sin barra (2 PASS) |
| Latencia al primer token en ambos modos | DONE | Camino one-shot mide el primer byte de salida (`firstTokenMs`); `noteUsage` recibe la métrica en conversación e implementación; tests: `native-agent-execution` (one-shot) y `native-chat-session` «latency of the last turn… both modes» (321 / 654 / ausente) |
| Memoria compactada: las solicitudes históricas desplazaban registros | DONE | `renderMemory` reserva 2 KiB para registros y 1 KiB para solicitudes, más nuevos primero, render cronológico, determinista; test de saturación (25 solicitudes largas + 15 corridas: 15 registros conservados, ≤ 4 KiB) |
| Recibos tardíos de hijos de turnos anteriores | DONE (defecto reproducido y corregido) | El fake emite un recibo tardío (`LATE_CHILD`); antes se atribuía al turno actual. `childThreads` se vacía por turno; test de guard: turno sin hijos → `childThreads` ausente, `inputTokens` 10 |
| Integración visual Goals y Chat | DONE (certificación instalada BLOCKED) | Ver P1-9 |
| Rendimiento/observabilidad | DONE en lo acotado | Test de saturación de memoria y test de aislamiento de recibos son deterministas y reproducibles; sin llamadas a proveedores |

Pruebas focalizadas ejecutadas tras los cambios: `native-chat-memory`, `native-codex-subagents-guard`, `native-source-encoding`, `native-agent-execution`, `native-chat-session`, `native-chat-commands`, `chat-goals-card` y `chat-approval-card` (navegador real): **todas PASS**; `tsc` estricto PASS; hygiene PASS en el commit. La suite completa no se repitió: los 881 PASS previos siguen vigentes para los módulos no tocados.

## 7. Pendientes para otra sesión

- BLOCKED por cuota: E2E autenticado Claude/Codex (un turno mínimo por proveedor bastaría para confirmar `humanCommand`, errores tipados y recibos de hijos; sin eso el gate `HARNESS_DELEGATION_BUDGET_UNVERIFIED` se mantiene).
- BLOCKED por binario: capturas, accesibilidad con lector de pantalla y revisión visual de las tarjetas de objetivos en un IDE instalado del SHA final.
- BLOCKED por toolchain: tests Rust (`cargo`).
- Opcional: refrescar la lista de objetivos en el webview cuando un objetivo termina sin otra publicación de estado (hoy se actualiza con cualquier publicación o al pulsar un control).
- Antes del PR: correr `npm test` completo sobre el SHA final una sola vez y revisar el CI de Linux/Windows.

## 8. Continuación del prompt Claude Code (2026-11-13)

Fuente única de reanudación: este checklist. Rama obligatoria `feat/chat-harness-codex-parity-upgrade`, PR #97. Base local y remota confirmada: `2c23ddeaf37ecf04ef65a0ba5091ef6c0868b563`, árbol inicialmente limpio. GitHub confirmó éxito del workflow ATS IDE Extension, corrida `43484785459`, sobre esa base; no valida los cambios locales siguientes. No hacer push, merge ni release sin nueva autorización.

Autoridad del checkout comprobada con `codex-harness.mjs context`: modo global, sin comandos de Harness local registrados. Aplican `AGENTS.md` y `.github/copilot-instructions.md` del IDE; la copia RedEvent de `.harness` no define el proceso activo de este repositorio.

| Paquete | Estado | Archivos / evidencia | Próximo paso |
|---|---|---|---|
| Observabilidad por proveedor y caché | PARTIAL | `native-agent-metrics.ts`, test: 4/4 PASS; conserva ausencia de datos como null, rechaza sumas fuera de enteros seguros | Integrar panel y revisar diff antes del commit |
| Especialistas configurables y mapa | PARTIAL, implementación en curso | `native-agent-profiles.ts`, `native-agent-delegation.ts`, `native-integration.ts`, `resources/home.ts`; reutiliza workflow/DAG existente | Terminar pruebas focalizadas y commit |
| Puente Claude | PARTIAL, implementación en curso | `native-claude-integrations.ts`, comandos y `chat.ts`; descubrimiento acotado, deshabilitado por defecto, permisos y digest | Terminar integración segura UserPromptSubmit y pruebas |
| Memoria de proyecto | PARTIAL, implementación en curso | Reutiliza `DecisionLog` en `native-decisions.ts`, comandos y `native-chat-session.ts`; no crea otro almacén equivalente | Terminar corrección/borrado y selección de contexto con pruebas |
| Proveedores autenticados y presupuesto de hijos | BLOCKED | Cuota no autorizada; se mantiene `HARNESS_DELEGATION_BUDGET_UNVERIFIED` | Requiere autorización y evidencia real |
| Browser/remoto, capturas instaladas y lectores de pantalla | BLOCKED | Sin servicio autorizado ni candidato instalado del SHA final | Mantener límites explícitos |
| CI del futuro SHA final | BLOCKED hasta autorización de push | El CI verde de la base no se atribuye a cambios locales | Revisar Linux/Windows después del push autorizado |

Referencias oficiales contrastadas: [hooks](https://code.claude.com/docs/en/hooks), [Agent Teams](https://code.claude.com/docs/en/agent-teams) y [plugins](https://code.claude.com/docs/en/plugins). Agent Teams es experimental; no se declara equivalencia completa con sesiones autónomas de Claude. Configuraciones externas nunca otorgan autoridad y se conserva `--setting-sources ''`.

### Registro incremental de commits

Los SHA se agregan inmediatamente después de cada commit; el registro actualizado queda en disco y se incluye en el siguiente paquete. No repetir checks verdes mientras sus entradas relevantes no cambien.

### Continuidad y reglas aprendidas

- En PowerShell, pasar directorio y `-g` a `rg`: los globs incrustados en una ruta no se expanden como en Bash.
- Consultar el checklist nombrado por el PR antes de usar checklists antiguos de otras ramas.
- Reutilizar `DecisionLog` para memoria confirmada; no duplicarlo con otro almacén de decisiones.
- Antes de cada commit TypeScript, usar `node build/lib/formatter.ts --replace <archivos>`: ESLint no cubre el formatter de hygiene. Primer intento de commit detenido por formato, sin omitir el hook. El checker Markdown solo informa LEN001; se conserva la regla local de no cortar párrafos a ancho fijo.
