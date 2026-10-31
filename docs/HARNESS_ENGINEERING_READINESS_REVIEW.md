# Harness nativo y Chat Harness: revisión de readiness de ingeniería

| Campo | Valor |
| --- | --- |
| Repositorio | `Drako01/armotusitio-ide` |
| Rama revisada y destino | `feat/native-chat-harness-enterprise-upgrade` (desde `main` en `d0b02f4d9fa`, release `ats-v1.144.0-r2`) |
| Fecha | 2026-10-31 |
| SHA de código evaluado | Corte principal de auditoría `62ecfba86dc`; ampliación de streaming/modelos `89fbc7df95`; actualización de versión `b0f2a18c0d` (0.6.0). El commit de esta revisión documental es posterior. |
| Entorno de verificación | Windows 11 Pro x64 10.0.26220, Node v24.22.1, Codex CLI 0.160.0, Claude Code 2.1.224 |
| Decisión | **APPROVED WITH CONDITIONS** (ver §10) |

## 1. Alcance y método

Se revisó el Harness nativo de la extensión `extensions/armotusitio-ide` con foco en el Chat Harness conversacional incorporado en esta rama, su integración con el motor (agentes, gates, lock compartido, cuotas, worktrees), el selector de proveedor, el indicador de ArmotuSitio MCP, la persistencia, la seguridad y la experiencia de uso.

Método aplicado, en este orden:

1. Lectura del código y de `HARNESS_ENTERPRISE_AAA_STATUS.md`. Comparación de ramas: `feat/native-harness-enterprise-upgrade` ya está contenida en `main` (squash #35); su única diferencia es la revisión de release anterior (`revision: 1` frente a `2`), así que no había nada que incorporar.
2. Línea base de los gates obligatorios antes de cambiar código.
3. Identificación de defectos, clasificación P0/P1/P2, corrección y test de regresión que reproduce cada escenario, uno por uno.
4. Revisión adversarial independiente del diff completo `main...HEAD`, realizada por un revisor separado sin acceso de escritura. Los siete hallazgos que reportó se corrigieron con un test cada uno.
5. Verificación independiente del commit de remediación (§6.3).
6. Gates del corte auditado y evidencia posterior del PR.

No se modificó el endpoint, el contrato ni la autenticación del MCP (`src/mcp.ts` no tiene cambios en la rama). No se hicieron llamadas reales a modelos de IA en las pruebas automatizadas: los proveedores de los tests son scripts locales controlados.

## 2. Arquitectura evaluada

```text
Webview (resources/chat.ts, markdown.ts)      solo textContent; CSP con nonce; sin estado propio
        |  postMessage (acciones validadas por allowlist en el host)
Host del panel (src/chat.ts)                  sesiones por carpeta, selector de IA, probe MCP real
        |
HarnessChatSession (native-chat-session.ts)   máquina de estados: Enviar = turno de solo lectura;
        |                                     Aprobar = writer sobre el último plan por digest
ChatRuntime (native-integration.ts)           frontera con el motor, inyectada (tests: runtime guionado)
        |
runGuardedAgent                               camino único para todo lanzamiento de agente: Workspace Trust,
        |                                     autoridad de escritura, capacidad, lock compartido, cuota,
        |                                     presupuesto, métricas; gates bajo el mismo lock
executeReviewedAgent / NativeHarness          procesos sin shell, límites de salida y tiempo, scope de solo lectura
```

Decisiones que se mantienen porque son correctas:

- **Separación dominio / sesión / host / vista.** `native-chat.ts` es dominio puro (planes, prompts, persistencia). La sesión no conoce VS Code. El host solo traduce entre la sesión y el webview. Esto permitió probar la sesión con un runtime guionado y la integración con el motor real.
- **Un solo camino protegido.** `runGuardedAgent` reemplazó la secuencia duplicada del comando de agentes; el comando existente y el chat comparten exactamente los mismos controles.
- **Fail-closed.** Una autoridad desconocida o un `.harness/` inseguro conservan la autoridad del proyecto. Un estado persistido inválido se pone en cuarentena, no se repara. Los errores visibles solo exponen códigos `HARNESS_*`.

Deuda de mantenibilidad que se documenta pero **no se refactorizó** (la consigna pedía no reescribir lo que funciona):

- `src/native-integration.ts`: ~900 líneas, mezcla registro de comandos y runtime.
- `src/chat.ts` y otros módulos de UI son TypeScript estilo CommonJS con `strict: false`.

Extraer el runtime del chat a un módulo propio con dependencias inyectadas es el siguiente paso recomendado.

## 3. Hallazgos y remediación

Estado: todos los hallazgos de esta tabla están **corregidos en el SHA final** y cubiertos por un test de regresión, salvo donde se indica.

| ID | Sev. | Hallazgo (causa raíz) | Impacto | Corrección (commit) |
| --- | --- | --- | --- | --- |
| F1 | **P0** | Los guards de almacenamiento privado comparaban `realpath(storage)` con la ruta exacta. VS Code entrega `globalStorageUri.fsPath` con la unidad en minúscula (`c:\`) y `realpath` la devuelve en mayúscula. | En el IDE instalado en Windows, **toda** ejecución nativa (agentes, workflows, turnos de chat, cuota, checkpoints) fallaba con `*_STORAGE_UNSAFE`. Los tests no lo veían porque las carpetas temporales vienen en mayúscula. | `native-path.ts` centraliza la comparación, sin distinguir mayúsculas solo en win32. Los fixtures de integración ahora usan la misma forma de ruta que VS Code: 7 tests fallan sin el fix (`8a98d58`, `156d29d`). |
| F2 | P1 | El diagnóstico de CLIs buscaba flags donde no aparecen: `--max-turns` está oculto en `claude --help` y `--ask-for-approval` es global en Codex. Además, `codex login status` escribe en stderr. | Ambos proveedores se mostraban «incompatibles» y Codex «sin sesión». | Se leen las dos ayudas de Codex, se acepta la flag oculta y se lee stderr (`075dcc9`). Verificado contra los CLIs reales instalados (solo comandos locales, sin prompts). |
| F3 | P1 | La sesión guardaba la actividad antes del bloque `try`. | Un fallo de almacenamiento dejaba el chat en «pensando…» para siempre. | Toda falla posterior al inicio limpia la actividad (`156d29d`). |
| F4 | P1 | Un mensaje nuevo del usuario no invalidaba el plan vigente. | Se podía aprobar un plan basado en requisitos ya cambiados. | El plan queda suspendido hasta que la IA lo confirma o lo revisa; si lo confirma idéntico, conserva su versión. Las tarjetas se ligan al mensaje y no al digest (`2a8c48a`). |
| F5 | P1 | El writer recibía las respuestas del modelo y los avisos locales (resultados de `/comandos` y de MCP). | Inyección de prompts: texto del repositorio o de tarjetas de terceros podía dirigir al agente con permisos de escritura más allá del plan aprobado. | El writer recibe solo el plan aprobado y los requisitos del usuario. Los avisos nunca llegan al proveedor, y los prompts declaran el contenido de archivos y herramientas como datos (`2a8c48a`). |
| F6 | P1 | Las credenciales escritas por el usuario se persistían y se enviaban. | Exposición de secretos en disco y ante el proveedor. | Se redactan antes de guardar y de enviar (`2a8c48a`). |
| F7 | P1 | Tres redactores de secretos divergentes. | La salida de gates conservaba tokens `sk-`/`github_pat`, y la redacción de agentes rompía valores JSON. | Un único `native-redact.ts`, que también cubre GitHub `gh*_`, AWS `AKIA`, Slack y bearer (`3d0a788`). |
| F8 | P1 | Cancelar antes de que existiera el proceso no tenía efecto, y `runGuardedAgent` ignoraba la señal. | El botón «Detener» no detenía, y el writer arrancaba igual. | La cancelación se arma al iniciar la actividad y la señal se verifica antes del spawn, liberando el lock (`2a8c48a`, `6632c6c`). |
| F9 | P1 | No había recuperación tras un cierre del IDE. | No se sabía si una ejecución quedó a medias. | Un marcador pendiente por proceso dueño: al reabrir se avisa una vez, con guía (`git status` y reconciliación del lock) (`2a8c48a`, `6632c6c`). |
| F10 | P1 | Cada evento de progreso reenviaba el historial completo al webview. | 840 KB por evento con 200 mensajes, unos 8 eventos por turno. | Seguimiento por revisión: los eventos sin cambios en el historial pesan 499 B (§7) (`2a8c48a`). |
| F11 | P1 | Accesibilidad: el reloj de actividad estaba dentro de una región `aria-live` (se anunciaba cada segundo), Escape no devolvía el foco y había `role=menu` sin navegación por flechas. | Incumplimiento de WCAG 2.4.3 y 4.1.2, y ruido para lectores de pantalla. | La actividad y el anunciador quedan fuera del log, se anuncian solo cambios de fase, el foco vuelve al disparador y los botones tienen etiqueta (`2a8c48a`, `6632c6c`). |
| F12 | P1 | Errores al preparar la verificación ocurrían fuera del `try`, y editar `AGENTS.md` se trataba como manipulación. | Se perdía el informe del writer y el plan quedaba aplicable dos veces. | Todo el setup queda dentro del bloque protegido. Las ejecuciones registran `agentStatus`, y un writer que terminó bloquea la reaplicación (`6632c6c`). |
| F13 | P1 | Dos ventanas sobre el mismo proyecto: gana la última escritura, y había una carrera en leer-fusionar-escribir. | Pérdida de mensajes. | Fusión por id con reemplazo explícito al resetear y lock exclusivo con limpieza de locks huérfanos. Los errores de lectura fallan en voz alta. El test de carrera falla 3/3 sin el lock (`95c1e9f`, `6632c6c`). |
| F14 | P2 | Cancelar entre el writer y los gates marcaba la verificación como «sin configurar». | Una ejecución no verificada figuraba como exitosa. | Los gates no ejecutados se reportan como cancelados (`6632c6c`). |
| F15 | P2 | Una ventana declaraba interrumpida la ejecución viva de otra. | Aviso falso y borrado del marcador ajeno. | Marcadores por PID con chequeo de vida (`6632c6c`). |
| F16 | P2 | Cambiar rápido de proyecto dejaba el hilo vacío. | Pérdida visual del historial. | Reset del seguimiento cuando no hay chat, y `publishIfSelected` (`6632c6c`). |
| F17 | P2 | Elegir un proveedor no instalado gastaba un intento. | Fricción. | Aviso previo que conserva el texto escrito (`2a8c48a`). |
| F18 | P2 | El estado MCP no se reverificaba con el panel abierto. | Indicador desactualizado. | Reverificación al volver visible si el dato tiene más de 5 minutos (`2a8c48a`). |
| F19 | P2 | Errores sin indicación de qué hacer. | El usuario no sabe el siguiente paso. | Pistas accionables por código: lock, cupo, confianza, configuración cambiada (`2a8c48a`). |
| F20 | P2 | Listeners globales registrados en cada `init`. | Duplicación de handlers. | Registro único (`2a8c48a`). |
| F21 | P2 | Sin streaming. | Sin feedback del contenido mientras el agente trabaja. | **Codex y Claude: implementados.** Codex consume eventos JSONL `item.completed` (`95c1e9f`); Claude utiliza `--output-format stream-json --verbose` y procesa eventos `assistant` y `result` (`89fbc7df95`). Se muestran mensajes intermedios redactados sin persistirlos. Es streaming por eventos/mensajes, no necesariamente por token. La validación autenticada end-to-end sigue incluida en C1. |
| F22 | P2 | La autoridad de escritura solo se verificaba antes del lock. | Ventana TOCTOU si aparece un `.harness/` mientras se espera el lock. | Se re-verifica bajo el lock, justo antes del spawn (`6632c6c`). |
| F23 | P2 | La cancelación y la re-verificación de autoridad ocurrían después de reservar cuota. | Cada cancelación temprana consumía un crédito de 24 h. | Se verifican antes de cuota y presupuesto (`62ecfba`). |
| F24 | P2 | El lock del historial no tenía dueño: la limpieza por antigüedad podía borrar un lock vivo. | Dos escritores simultáneos tras un cierre previo. | El lock contiene `<pid>:<token>`, solo lo borra su dueño y se abandona solo si el proceso dueño murió, con traslado y re-verificación (`62ecfba`). |
| F25 | P2 | Un PID reutilizado mantenía vivo un marcador pendiente ajeno. | La interrupción no se informaba nunca. | Los marcadores vencen a las 6 h (`62ecfba`). |
| F26 | P2 | Una conversación guardada con el formato anterior del marcador se ponía en cuarentena. | Pérdida aparente del historial. | Se normaliza al formato nuevo al leer (`62ecfba`). |

## 4. Threat model (STRIDE y OWASP LLM)

| Amenaza | Vector | Control vigente | Riesgo residual |
| --- | --- | --- | --- |
| **S**poofing de aprobación | Un mensaje del webview aprueba otro plan o una versión vieja | Digest SHA-256 del contenido y la versión, validado en el host contra el último plan; regex `^[a-f0-9]{64}$`; plan suspendido ante requisitos nuevos | Bajo |
| **S**poofing del estado MCP | Clave guardada interpretada como conexión | Estado derivado solo de un handshake real (`initialize` + `tools/list`); los errores reinician la sesión MCP | Bajo |
| **T**ampering del historial o de planes | Edición de `conversation.json` | Planes con digest verificado al cargar; esquema estricto; cuarentena del archivo inválido; permisos `0600`/`0700` | Un atacante con acceso a tu perfil local ya tiene control equivalente |
| **T**ampering de verificaciones | El agente modifica `.ats-harness.json` | Se ejecuta el plan de gates capturado y aprobado (revisión comparada antes del lanzamiento) | Los gates aprobados (`npm test`) ejecutan scripts que el agente pudo modificar: inherente; mitigado por la aprobación explícita |
| **R**epudiation | ¿Quién aprobó qué? | Mensaje «Plan vN aprobado» persistido, ejecución con `agentStatus`, tarea de gates en el historial nativo, métricas y gasto | Sin firma criptográfica de la aprobación (fuera de alcance para un IDE local) |
| **I**nformation disclosure | Secretos en mensajes, salidas o logs | Redactor único sobre la entrada del usuario, la salida de agentes, gates y workflows; MCP sin secretos en el webview (test) | La redacción es heurística: formatos de secreto no contemplados pasan. Los turnos de lectura pueden leer `.env` del repositorio (capacidad del propio CLI) |
| **I**nformation disclosure a terceros | Datos de MCP enviados al modelo | Los avisos locales nunca forman parte del prompt | Bajo |
| **D**enial of service | Salida enorme, procesos colgados, eventos masivos | Límites de bytes y tiempo por proceso; historial acotado (200 mensajes, ~13 KB por prompt); eventos sin historial | Bajo |
| **E**levation of privilege | Prompt injection desde archivos o tarjetas hacia el writer | El writer recibe solo el plan aprobado y la entrada del usuario; los prompts tratan contenido y herramientas como datos; Claude writer sin `Bash`/`Web*`; Codex en `workspace-write`; Workspace Trust; lock | Codex `workspace-write` puede ejecutar comandos dentro de su sandbox. No hay sandbox de SO para el writer en Windows |
| **E**levation: escritores concurrentes | Harness propio del proyecto más writer del IDE | Writers deshabilitados en proyectos híbridos; autoridad re-verificada bajo el lock; el lock compartido serializa escritores del IDE | Un motor externo que no participa del lock puede escribir igual: por eso la ejecución queda deshabilitada |
| Webview injection | Markdown o HTML del modelo | Solo `textContent`; enlaces sin `href`; CSP `default-src 'none'` con nonce; test de navegador con `<script>`, `onerror` y `javascript:` | Bajo |
| TOCTOU, symlinks, path traversal | Directorios de estado o raíz cambiados | `realpath` canónico; `lstat` sin symlinks; guard de autoridad antes del spawn | Bajo |
| Recuperación tras cierre | Lock o marcadores huérfanos | Marcadores por PID; lock con reconciliación explícita existente; lock del store con limpieza tras 30 s | Un PID reutilizado por otro proceso podría ocultar una interrupción hasta que ese proceso termine (muy improbable) |

## 5. Pruebas y cobertura

Los tests nuevos o reforzados en este ciclo cubren el contrato de cada hallazgo:

- **Unitarias y de contrato:**
  - `native-chat.test.mts`: planes, prompts, store, cuarentena, ventanas concurrentes y carrera.
  - `native-chat-session.test.mts`: flujo, invalidación, cancelación temprana y tardía, recuperación, ventanas ajenas, secretos, inyección y revisión.
  - `native-redact.test.mts`, `native-provider-output.test.mts` (streaming Codex y Claude, incluidos eventos parciales y respuesta final), `native-agent-execution.test.mts` (argumentos `stream-json` de Claude) y `native-provider-diagnostics.test.mts` (CLIs reales actuales).
- **Integración con el motor real** (`native-integration.test.mts`): runtime del chat con un proveedor Codex local y controlado, gates reales y lock real. Cubre:
  - Liberación del lock.
  - Invalidación por cambio de verificaciones.
  - Bloqueo en proyectos híbridos.
  - Streaming redactado.
  - Edición de guías.
  - Cancelación previa al spawn sin lanzar el proveedor.
  - Cancelación tardía.
  - Todo con rutas en la forma que entrega VS Code.
- **E2E del panel** (`chat.test.cts`): host y sesión reales con runtime guionado. Cubre:
  - El flujo completo conversar → plan v1 → cambios → v2 → v1 rechazada → v2 ejecutada → progreso → resultado.
  - `/comandos`.
  - Ninguna navegación a Inicio.
  - Payload de progreso sin historial.
  - Proveedor no instalado.
  - Separación entre proyectos.
  - Cambio rápido de proyecto.
- **Accesibilidad, teclado y renderizado seguro en navegador real** (`chat-renderer.test.cts`, Chromium vía playwright-core). Cubre:
  - Radio group con roving tabindex y flechas.
  - `aria-expanded` y devolución del foco con Escape.
  - Aprobación descrita (`aria-describedby`).
  - Enter y Shift+Enter.
  - Regiones vivas fuera del log.
  - Anuncio solo de fases.
  - Salida del modelo inerte (`<script>`, `onerror`, `javascript:`).
  - Sin scroll horizontal a 360 px.

Cobertura medida (`node --test --experimental-test-coverage`, módulos nuevos del chat):

| Módulo | Líneas | Ramas | Funciones |
| --- | --- | --- | --- |
| `src/native-chat.ts` | 98,04% | 89,80% | 86,96% |
| `src/native-chat-session.ts` | 98,35% | 85,40% | 100% |
| `src/chat.ts` | 94,85% | 78,40% | 67,86% |
| `resources/markdown.ts` | 100% | 82,05% | 100% |
| `src/native-redact.ts` | 100% | 100% | 100% |
| `src/native-path.ts` | 100% | 100% | 100% |
| **Total** | **97,40%** | **83,53%** | **83,67%** |

Las líneas de `chat.ts` sin cubrir corresponden a la barra de estado, al participante nativo cuando existe la API de chat y a las acciones que abren comandos de configuración del MCP.

Lo que la cobertura **no** demuestra:
- Respuestas reales de los modelos.
- Uso con lectores de pantalla reales (NVDA, VoiceOver).
- Contraste de color en todos los temas.
- Comportamiento en Linux y macOS.

## 6. Gates y evidencia por revisión

### 6.1 Gates obligatorios

Los resultados de la siguiente tabla pertenecen al **corte inicial de auditoría** `62ecfba86dc`; no deben interpretarse como verificación de los commits posteriores. La ampliación de streaming de Claude y modelos se realizó en `89fbc7df95`, seguida de la actualización de versión en `b0f2a18c0d`. La evidencia más reciente declarada en el PR se diferencia a continuación.

| Gate | Resultado |
| --- | --- |
| `node scripts/ats-harness-check.mts` | **PASS**, 8/8 etapas: TypeScript, recursos del webview, tests de UI y motor (239 tests: 237 pasan, 0 fallan, 2 omitidos), bundle, recursos del paquete, hygiene focalizado, smoke del benchmark del chat y `git diff --check` |
| `npm test --prefix extensions/armotusitio-ide` | **PASS**: 329 tests, 327 pasan, 0 fallan, 2 omitidos |
| `npm run check --prefix extensions/armotusitio-ide` | **PASS** (tsc y verificación de recursos) |
| `git diff --check` | **PASS** |
| `npm run hygiene` (repositorio completo, adicional) | **PASS**, 14.173 archivos |
| ESLint sobre los archivos modificados (adicional) | **PASS** |

Los 2 omitidos son preexistentes y legítimos: el sandbox de kernel requiere Linux con `bwrap` o macOS con `sandbox-exec`, y el smoke real de proveedores requiere habilitación explícita para consumir cuota. Línea base antes de este ciclo: 307 tests (305 pasan, 0 fallan, 2 omitidos); se agregaron 22 tests.

### 6.2 Verificaciones adicionales incorporadas

- `scripts/ats-harness-check.mts` ahora incluye los tests del chat (unitarios, E2E, navegador), el redactor y un **smoke del benchmark del chat**.
- Los fixtures de integración reproducen la forma de ruta de VS Code en Windows: el defecto F1 no puede volver a pasar inadvertido.

### 6.3 Revisiones independientes

1. Revisión adversarial del diff completo: 2 P1 y 5 P2 (F12 a F16, F22 y la ubicación de la región viva de F11). Todos corregidos con un test que reproduce cada escenario.
2. Verificación del commit de remediación: confirmó correctas las siete correcciones, sin deadlocks, y encontró cinco P2 nuevos introducidos por la remediación. Todos se corrigieron en `62ecfba` (F23 a F26 más un JSDoc mal ubicado), y el test de cuota falla con el orden anterior (1 crédito consumido).

### 6.4 Cambios posteriores al corte y evidencia declarada del PR #37

- **Streaming Claude (C3 resuelta a nivel de implementación):** `89fbc7df95` añade `--output-format stream-json --verbose` a la invocación de Claude; `ClaudeEventAccumulator` procesa los mensajes `assistant` y el evento final `result`. `native-provider-output.test.mts` y `native-agent-execution.test.mts` verifican el contrato y los argumentos, y `native-chat-session.test.mts` comprueba que los mensajes parciales se muestran sin persistirse.
- **Selección de modelo y mensajes de límite de proveedor:** incorporados en `89fbc7df95`; un límite real conserva la explicación entregada por el CLI, en vez de fabricar una fecha de restablecimiento.
- **Versión de extensión:** `b0f2a18c0d` eleva la versión a `0.6.0`.
- **Verificaciones indicadas en la descripción del PR #37 para Windows x64 / Node 24.22.1:** `ats-harness-check.mts` **8/8 PASS**; suite completa **331 tests: 329 PASS, 0 FAIL, 2 SKIP**; `npm run check`, `git diff --check`, higiene y ESLint **PASS**. Son resultados **reportados en el PR**, no ejecuciones independientes de esta actualización documental. GitHub Actions permanece deshabilitado.
- **Prueba manual reportada:** Claude respondió en el IDE instalado y Codex informó correctamente que la cuota estaba agotada. **No constituye** la prueba autenticada completa del flujo conversación → plan → aprobación → escritura → gates (C1), ni acredita Linux/macOS (C2).

## 7. Rendimiento medido

`node scripts/ats-chat-benchmark.mts --runs 30`, en proceso, sin proveedor ni red; Windows x64, Node v24.22.1:

| Medida | Mediana | p95 |
| --- | --- | --- |
| Guardar historial de 200 mensajes (444 KB, escritura atómica con fsync y lock) | 7,6 ms | 9,1 ms |
| Cargar y validar historial de 200 mensajes | 1,7 ms | 2,8 ms |
| Construir prompt con 200 mensajes de historial (resultado 12 KB) | 0,016 ms | 0,039 ms |
| Extraer y validar un plan de una respuesta de 17 KB | 0,016 ms | 0,046 ms |
| Overhead de un turno sin tiempo de proveedor (2 guardados y snapshots) | 18,8 ms | 23,9 ms |
| Evento de progreso con historial completo / sin historial | 839.702 B / 499 B | — |

El costo dominante de un turno es el proveedor, entre segundos y minutos. El overhead propio es inferior a 25 ms en p95. Las mediciones previas del verificador completo (`ats-harness-benchmark.mts`) no se repitieron en este ciclo.

## 8. UX/UI, accesibilidad y mantenibilidad

- **Flujo:** todo ocurre en el chat: escribir → respuesta → refinamiento → plan versionado → «Aprobar y ejecutar» → etapas y gates en vivo → resultado → seguir conversando. «Enviar» nunca abre Inicio ni modifica código (test E2E).
- **Estado siempre visible:**
  - El selector Codex / Claude Code muestra el estado local de cada proveedor.
  - El indicador MCP tiene detalle y acciones.
  - Un banner avisa en workspace no confiable o en un proyecto con Harness propio.
- **Errores:** los avisos traen un código estable y el siguiente paso.
- **Accesibilidad:** las verificaciones automatizadas cubren operación por teclado, semántica ARIA y foco. **No se realizó una auditoría manual de WCAG 2.2 AA** con lectores de pantalla ni medición de contraste por tema (condición C6).
- **Mantenibilidad:**
  - Dominio, sesión y vista están separados.
  - Hay un solo camino de lanzamiento de agentes, un solo redactor y un solo helper de rutas.
  - La deuda señalada en §2 queda registrada.

## 9. Compatibilidad multiplataforma efectivamente verificada

| Plataforma | Verificado | Detalle |
| --- | --- | --- |
| Windows 11 x64 | **Sí** | Todos los gates de §6; diagnóstico de CLIs contra Codex 0.160.0 y Claude 2.1.224 reales (solo comandos locales). La prueba manual del chat en la ventana de desarrollo detectó F1 y F2 antes de corregirlos. |
| Linux | **No** | No ejecutado en este ciclo. El código usa `process.platform` y es POSIX-compatible; la cobertura de sandbox `bwrap` existe pero se omite fuera de Linux. |
| macOS | **No** | No ejecutado en este ciclo. |

No se declara certificación multiplataforma.

## 10. Decisión: APPROVED WITH CONDITIONS

**Fundamento.**

- **Sin defectos críticos conocidos.** No quedan defectos P0 ni P1 abiertos en el SHA final.
- **Remediación verificada.** El único P0 encontrado (F1) bloqueaba todo el Harness nativo en el IDE real de Windows; hoy está corregido y protegido por fixtures que reproducen la condición del IDE.
- **Invariantes respaldadas por tests de punta a punta:**
  - Enviar solo conversa, en modo de solo lectura.
  - La ejecución exige la aprobación explícita de la versión exacta y vigente del plan.
  - Los escritores no corren en proyectos con Harness propio.
  - Los fallos son fail-closed.
  - La cancelación es real en todas las fases.
  - El estado se recupera tras un cierre.
- **Revisión independiente:** sus hallazgos están corregidos y re-verificados.

**Por qué no APPROVED.** C3 ya está implementada y cubierta por pruebas automatizadas, pero las condiciones de aceptación **C1 y C2 no tienen evidencia completa**. Por el criterio de revisión acordado, no corresponde elevar la decisión sin esa evidencia. Condiciones y riesgos que permanecen:

- **C1, E2E real del chat: ABIERTA.** Se reportó una respuesta manual de Claude y un mensaje válido de cuota agotada de Codex, pero no hay evidencia de ambos recorridos autenticados completos hasta ejecución y gates. Requisito: smoke manual autenticado en IDE instalado en Windows («Quiero agregar un CRUD de clientes» → conversación → plan → aprobación → escritura → gates → resultado), con cada proveedor por separado, en un proyecto descartable. Para Claude, incluir la visualización de eventos `stream-json` de una sesión real.
- **C2, Linux y macOS: ABIERTA.** Ejecutar `npm test` y `node scripts/ats-harness-check.mts` en ambos sistemas, incluidos los tests de sandbox disponibles. No hay resultados de esas plataformas en la evidencia del PR.
- **C4, coordinación con Harnesses externos.** La ejecución con escritura queda deshabilitada por diseño en proyectos con `.harness/`. Habilitarla requiere un protocolo verificable de escritor único con el motor externo (decisión de producto pendiente: predominio del Harness nativo).
- **C5, aislamiento del writer.** No hay sandbox de SO para el agente implementador en Windows; Codex `workspace-write` puede ejecutar comandos en su sandbox. El riesgo residual se acepta mediante aprobación explícita y Workspace Trust, y debe figurar en la documentación del usuario.
- **C6, accesibilidad manual.** Prueba con NVDA y VoiceOver y medición de contraste en los temas claro, oscuro y de alto contraste.
- **C7, contexto largo.** El prompt incluye unos 13 KB del historial más reciente; las conversaciones largas pierden contexto antiguo (no hay resumen automático).

**C3 (streaming de Claude): RESUELTA en código y tests** mediante `89fbc7df95`. Su ejecución autenticada en la interfaz se validará como parte de C1. Las condiciones C4 a C7 son riesgos y decisiones de producto expresamente documentados; no se declaran resueltas. Solo con **C1 y C2 verificadas**, sin hallazgos nuevos y aceptando formalmente los riesgos residuales, podrá reconsiderarse **APPROVED para uso interno**.
