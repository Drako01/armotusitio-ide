# Harness Enterprise AAA — estado de implementación y checklist

> **Proyecto:** `Drako01/armotusitio-ide`  
> **Rama de trabajo:** `feat/native-harness-enterprise-upgrade` (creada desde `main`)  
> **Fecha de corte:** 2026-10-30  
> **Estado:** desarrollo experimental; **NO certificado para merge ni producción**.

## Resumen ejecutivo

Esta guía documenta el alcance acordado y diferencia **código agregado a la rama** de funcionalidad realmente certificada. Una casilla marcada no significa que el comportamiento haya pasado pruebas reales de extremo a extremo.

**Inventario funcional:** 34 ítems implementados en código, 5 parciales y 15 pendientes (54 ítems de distinto tamaño y riesgo; no representan un porcentaje técnico de certificación). **Última validación automatizada local Windows aportada:** 190 tests aprobados, 0 fallidos, 1 omitido (191 total), con TypeScript, bundle, recursos e higiene en PASS, sobre el commit previo a la mejora de recuperación de historial completo. Esto no equivale a CI multiplataforma ni a E2E completo.

**Calificación:** no asignar una nueva nota 1–10 ni declarar nivel AAA hasta disponer de pruebas reproducibles y resultados E2E. El 70% mencionado en el seguimiento conversacional fue una apreciación de cobertura, **no** una medición auditada.

**Leyenda:**

- `[x]` Implementado en código de esta rama (aún por validar).
- `[~]` Parcial, requiere ampliación.
- `[ ]` Pendiente.

## Checklist por áreas

### Arquitectura y runtime nativo

- [x] Integración de controles nativos del Harness en el IDE.
- [x] Detección de proyectos y prioridad del Harness propio frente al motor nativo.
- [x] Contrato declarativo de capacidades versionado (v2).
- [~] Capacidades externas: lectura de manifiesto v2 y handshake **ejecutable, explícito y con nonce** agregado. Sigue faltando demostrar los comportamientos auto-reportados contra motores externos reales; no se conceden permisos por el handshake.
- [ ] Unificar el motor Python y el motor nativo detrás de un protocolo ejecutable estable.
- [ ] Eliminar dependencias y convenciones heredadas de RedEvent para portabilidad plena.

### Agentes y autonomía

- [x] Ejecución local de Codex CLI y Claude Code con autorización explícita.
- [x] Roles planner, implementer y reviewer con permisos diferenciados.
- [x] Secuencia plan → implement → review y transporte acotado de handoffs.
- [x] Revisión opcional cruzada entre Codex y Claude.
- [x] Recepción de veredicto explícito del reviewer, con fallo cerrado ante respuestas ambiguas.
- [x] Un ciclo correctivo acotado y re-revisión independiente, autorizado previamente.
- [x] DAG acotado de agentes: lectores independientes en olas concurrentes (hasta dos), escritores exclusivos y cobertura de revisión de implementers; el camino plan → implement → review conserva su ciclo correctivo.
- [ ] Planificación adaptativa y coordinación de agentes ejecutados simultáneamente.
- [ ] Generación dinámica de agentes y distribución de tareas según capacidades, costo y carga.

### Seguridad y aislamiento

- [x] Lanzamiento de procesos sin shell intermedio y con entorno acotado.
- [x] Perfiles de permisos de lectura/escritura para proveedores.
- [x] Worktree Git separado como modalidad recomendada de workflow.
- [x] Capturas de estado para detectar modificaciones en tareas de solo lectura.
- [x] Escaneo de archivos sensibles anidados y sin seguir enlaces simbólicos.
- [x] Límites temporales, de captura de salida y concurrencia.
- [x] Validación de veredictos de revisión e identificación de handoffs como datos no confiables.
- [~] Defensas ante prompt injection: encapsulado de handoffs, revisión explícita, límites de permisos y nueva batería adversarial automatizada; aún falta red-team integral contra proveedores reales y aislamiento OS.
- [ ] Sandbox OS con políticas efectivas de filesystem, proceso y red: un worktree NO es un límite de seguridad.
- [ ] Pruebas adversariales de exfiltración, symlinks, TOCTOU y escalada de permisos.

### Persistencia y recuperación

- [x] Historial durable de ejecuciones y estados de workflows.
- [x] Locks y rechazo de ejecuciones solapadas del mismo proyecto.
- [x] Cancelación de agentes, workflows y gates.
- [x] Reconciliación explícita de ejecuciones interrumpidas, sin reejecución automática.
- [x] Administración y retiro de worktrees limpios, conservando los modificados.
- [~] Recuperación: reconciliación más reinicio explícito con aprobación renovada, nuevo ID y rechazo si comenzó un writer. La reanudación granular desde checkpoints con escrituras previas permanece pendiente.
- [ ] Integración transaccional de cambios, gestión automática de conflictos y rollback validado.
- [ ] Reanudación granular de tareas desde checkpoints seguros.

### Performance, recursos y costos

- [x] Gates de verificación con concurrencia de hasta cuatro, solo con parallelSafe explícito.
- [x] Declaración de recursos compartidos para evitar colisiones entre gates.
- [x] Backpressure: máximo dos operaciones de proveedor activas/pendientes por ventana.
- [x] Duración global acotada del workflow y timeout por agente.
- [x] Duración, tasa de éxito y percentil 95 basados en ejecuciones registradas.
- [x] Lectura estructurada de tokens reportados por Codex/Claude.
- [x] Costo estimado reportado por proveedor cuando existe; no equipararlo a facturación.
- [~] Compatibilidad CLI: ahora inspección acotada de versión, flags declarados por `--help` y sesión local de login; falta certificar compatibilidad del protocolo real y autenticación efectiva con ejecución E2E.
- [ ] Topes monetarios rígidos por proveedor/proyecto y tratamiento de cuotas/rate limiting.
- [ ] Benchmarks cold/warm reales: CPU, RAM, latencia, éxito, tokens, costos y comparación secuencial/paralela.
- [ ] Scheduler adaptativo basado en telemetría de carga y capacidad.

### IDE, observabilidad y calidad

- [x] Comandos para ejecutar agentes, workflows, consultar historial y reconciliar.
- [x] Panel con resumen de estado, métricas de agentes y gates.
- [x] Diagnóstico local de instalaciones Codex/Claude sin invocar modelos.
- [x] Pruebas unitarias y de integración con proveedores simulados incorporadas.
- [x] Definición de workflow CI para Windows, Linux y macOS.
- [~] Observabilidad: eventos de ciclo de vida y avance de bytes sin contenido, emitidos y persistidos de forma acotada; faltan trazas distribuidas completas y validación E2E de streaming.
- [ ] Streaming estructurado del ciclo de vida completo y trazas accionables en el IDE.
- [ ] E2E con Codex y Claude autenticados, cubriendo permisos, cancelación y recuperación.
- [ ] Compilación, tests e instaladores validados en los tres sistemas operativos.
- [ ] CI exitoso sobre el SHA exacto a integrar.

## Pendientes críticos priorizados

| Prioridad | Trabajo | Condición de aceptación |
|---|---|---|
| **P0** | CI reproducible y E2E | Typecheck, tests e integración con CLI reales aprobados sobre un mismo SHA, además de builds de extensión/IDE. |
| **P0** | Sandbox fuerte | Acceso a archivos, procesos y red denegado por controles del sistema, no únicamente por instrucciones al modelo o worktrees. |
| **P1** | Contrato ejecutable común | Motor nativo y motores de proyecto operan mediante un protocolo versionado, con semántica de cancelación, evidencia y capacidades. |
| **P1** | Integración transaccional | Cambios revisados se aplican con protección contra conflictos; rollback y recuperación demostrables. |
| **P1** | DAG y orquestación adaptativa | Dependencias, paralelismo seguro, límites de recursos, compensación y reanudación E2E. |
| **P2** | Presupuestos IA | Límites verificables de costo, tokens, cuotas y tiempos antes/durante las invocaciones. |
| **P2** | Tracing/UX | Eventos estructurados y progreso legible por proyecto, agente, gate y ejecución. |
| **P2** | Benchmarks | Baseline con experimentos repetibles e indicadores observados de rendimiento y éxito. |
| **P2** | Portabilidad | Políticas y documentación independientes de RedEvent; pruebas en proyectos Node, Go y PHP. |

## Incidente de validación local (2026-10-30)

**Evidencia aportada:** `harness-validation-20261030-154253.log`, ejecutado en Windows `win32/x64`, Node `v24.22.1`, npm `11.6.2`, commit base `49a17187bf2`.

| Comando | Resultado observado en ese log | Diagnóstico |
|---|---|---|
| `node scripts/ats-harness-check.mts` | **FAIL** | Tres archivos de test bloqueados por el parser TypeScript; higiene de estilo con 1332 errores. TypeScript, recursos y bundle informaron PASS. |
| `npm test --prefix extensions/armotusitio-ide` | **FAIL**: 155/163 passed, 3 failed, 5 skipped | Las fallas de `native-agent-corrective`, `native-agent-workflow` y `native-integration` comparten la misma causa de importación de `native-agent-workflow.ts`. |
| `npm run check --prefix extensions/armotusitio-ide` | **PASS** | Typecheck y validación de recursos completados; no implica que higiene y tests estén aprobados. |

### Correcciones publicadas en esta rama después de ese log

- [x] **Compatibilidad Node strip-only:** sustituida la parameter property `constructor(private readonly root: string, private readonly storage: string)` por campos declarados e inicialización explícita. El cambio busca eliminar `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` de las tres suites afectadas.
- [x] **Higiene de código:** normalizados encabezados de copyright e indentación por tabulaciones en los archivos nativos y tests afectados; escapados caracteres Unicode que reportaba el chequeo de recursos; retirados los dos casts `as any` reportados.
- [ ] **Validación posterior a las correcciones:** **PENDIENTE**. No se han ejecutado de nuevo en el equipo Windows del operador los tres comandos, ni existe evidencia de CI verde sobre los commits de corrección. Es posible que aparezcan errores adicionales al desbloquear los imports.

**Criterio:** nunca cambiar las casillas pendientes a completadas solo porque la corrección fue commiteada. Repetir el script y adjuntar el nuevo `.log`, incluyendo todos los exit codes.

### Segunda validación Windows (2026-10-30, 15:51)

- **Commit probado:** `fab25dcb9dc`.
- **Tests de extensión:** **160 PASS / 0 FAIL / 7 SKIP**; TypeScript y recursos: PASS.
- **Validación focalizada:** falla únicamente `Focused hygiene`, con **10 incidencias**: cinco archivos pendientes del formateador oficial y cinco advertencias de `@stylistic/member-delimiter-style` en tres archivos.
- **Remediación posterior:** se sustituyeron los miembros de interfaces con separadores no admitidos, en `native-agent-execution.ts`, `native-agent-worktree.ts` y `native-agent-scope.ts`. Estas correcciones **no están incluidas en el log original**.
- **Formateo restante:** para garantizar el formato exacto exigido por `build/lib/formatter.ts` sin desactivar reglas de higiene, el verificador ofrece ahora `--fix` como modo **explícitamente modificador del árbol de trabajo**. No se ejecuta automáticamente y el cambio local debe inspeccionarse antes de confirmarlo.
- [ ] **Pendiente:** ejecutar localmente `node scripts/ats-harness-check.mts --fix` una vez, revisar `git diff`, ejecutar los tres comandos originales sin `--fix` y subir nuevo log. No se declara el check verde hasta disponer de evidencia.

### Tercera validación Windows (2026-10-30, 15:59)

- **Commit validado:** `472b9afed30`.
- **Suite principal:** 160 PASS, 0 FAIL, 7 SKIP, exit 0.
- **TypeScript y recursos:** PASS, exit 0.
- **Chequeo focalizado:** FAIL exclusivamente en `Focused hygiene`: 19 advertencias por falta de `;` en los miembros de tres interfaces (`native-agent-execution.ts`, `native-agent-worktree.ts`, `native-agent-scope.ts`).
- [x] **Corrección publicada tras el log:** los 19 miembros de interfaces multilinea vuelven a terminar en punto y coma conforme a `@stylistic/member-delimiter-style`. No se modificó lógica de agentes.
- [ ] **Pendiente de verificación:** repetir los tres comandos para observar si `Focused hygiene` queda verde. Los warnings `MODULE_TYPELESS_PACKAGE_JSON`, Node experimental y configuraciones npm no son el motivo de fallo actual.

**Atención al actualizar el checkout:** `node scripts/ats-harness-check.mts --fix` pudo dejar cambios locales en siete archivos. Antes de `git fetch origin feat/native-harness-enterprise-upgrade\ngit merge --ff-only FETCH_HEAD`, inspeccionar `git status --short`; no descartar modificaciones ajenas ni forzar la rama. Si solo existen diferencias de formato conocidas, guardarlas con `git stash push -m "formatter-local-20261030" -- <rutas>` antes de actualizar, o copiarlas para revisión.

### Cierre de validación local Windows (2026-10-30, 16:06–16:07)

- **Evidencia:** validación local adjunta tras aplicar `harness-local-formatting` sobre `7904850d6b6`: `node scripts/ats-harness-check.mts` **PASS** en las siete etapas, incluido `Focused hygiene`; `npm test --prefix extensions/armotusitio-ide`: **160 PASS, 0 FAIL, 7 SKIP**; `npm run check --prefix extensions/armotusitio-ide`: **PASS**. `git diff --check` sin observaciones.
- **Publicación:** commit `10aa50a1296` (`style(harness): finalize native enterprise formatting`) subido a `feat/native-harness-enterprise-upgrade`, con precommit Husky e higiene de los cinco archivos **PASS**.
- [x] **Incidente de formato e higiene: cerrado en validación local Windows**. Sin errores en la batería ejecutada. Este cierre reemplaza los pendientes de las validaciones del 30/10 anteriores, pero no demuestra una validación CI multiplataforma.
- [ ] **Pendiente para certificación enterprise:** confirmar CI Linux/macOS/Windows, los 7 casos omitidos (según su compatibilidad de plataforma) y pruebas E2E con proveedores reales, incluida autorización, cancelación, límites, recuperación y aislamiento.
- **Notas no bloqueantes:** warnings de `MODULE_TYPELESS_PACKAGE_JSON`, `stripTypeScriptTypes` experimental y configuración npm antigua; no se consideran fallas de las pruebas realizadas.

## Ampliación de las seis áreas previamente parciales (validación automatizada local completada)

**Rama:** `feat/native-harness-enterprise-upgrade`. Esta entrega agrega código para **las seis áreas** y suites de regresión. El resultado actualizado es **173 PASS / 0 FAIL / 9 SKIP** en Windows, sobre el árbol local con formato oficial que se confirmó como `18f35f8d374`. La validación anterior de 160 PASS queda como antecedente histórico, no como evidencia vigente.

- **Contrato externo:** `probeProjectHandshake` ejecuta la entrada reconocida del Harness del proyecto solo tras autorización explícita, con nonce, timeout, límites de respuesta y comprobación contra capacidades declaradas. El contrato continúa *fail closed*: los datos auto-reportados no habilitan ejecución automática.
- **DAG real:** nueva ejecución en olas para agentes independientes de solo lectura, con escritores exclusivos, dependencias topológicas y validación de reviewer posterior a cada escritor. Ruta secuencial conservada para workflows tradicionales.
- **Seguridad adversarial:** nueva suite de handoffs hostiles, veredictos falsificados, argumentos de CLI y dependencias; comprobación de campos de trazas persistidas. No es auditoría de sandbox OS.
- **Recuperación:** API `restartInterrupted` permite reiniciar un flujo interrumpido tras nueva autorización **únicamente** si ningún implementer empezó; rechaza escrituras inciertas y conserva historial anterior.
- **CLIs:** `--version`, `--help`, `login status` / `auth status` con respuestas `unknown` donde no hay certeza. `modelAuthenticated` sigue en `false` hasta un smoke test de modelo autenticado.
- **Observabilidad:** eventos estructurados, progreso por bytes, persistencia sin prompts ni datos sensibles y actualización del panel desde el ciclo de vida.

**Matriz de pruebas y limitaciones:** [`docs/native-harness-six-partial-validation.md`](docs/native-harness-six-partial-validation.md).

- [x] Ejecutados los tres comandos sobre el árbol de trabajo final antes de confirmar el commit `18f35f8d374`; verificador completo PASS, pruebas 173/0/9 y typecheck/recursos PASS. Precommit Husky confirmó higiene de los cuatro archivos stageados. Para atribuir evidencia al SHA final inmutable todavía corresponde repetir en checkout limpio o verificar CI.
- [ ] CI Windows/Linux/macOS y pruebas E2E de CLI reales.
- [ ] Evidencia adicional para cerrar las cinco áreas que siguen siendo parciales, sin reducir el nivel de seguridad ni relajar checks.

### Primera validación de la ampliación (Windows, 2026-10-30 17:18 ART)

- **Suite de extensión:** 173 PASS, 0 FAIL, 9 SKIP; `npm run check`: PASS.
- **Verificador focalizado:** TypeScript, recursos, renderer, bundle y diff whitespace: PASS. `Focused hygiene`: un único error ESLint `curly` por `else for` en `native-agent-workflow.ts`, línea 357.
- [x] **Corrección publicada:** el fallback secuencial ahora utiliza un bloque `else { ... }`; sin modificaciones del flujo de decisiones. **Pendiente de nueva prueba**.
- **Formato incorporado posteriormente:** los tres archivos y `native-agent-workflow.ts` se formatearon y publicaron en `18f35f8d374`; la nota anterior documenta el incidente previo, no un trabajo actualmente pendiente.
- [x] Reejecución local realizada con el árbol actualizado: higiene verde, typecheck y pruebas en verde. Evidencia y commit de formato detallados en el cierre siguiente.

### Cierre de la ampliación: validación Windows y publicación (2026-10-30, 17:23 ART)

**Evidencia del operador:** log `Texto pegado(20261030-202342).txt`, Windows `win32/x64`, Node `v24.22.1`.

| Control | Resultado observado |
|---|---|
| `node scripts/ats-harness-check.mts --fix` | PASS; el formateador ajustó `native-agent-workflow.ts` |
| `node scripts/ats-harness-check.mts` (sin `--fix`) | **PASS**: TypeScript, webview, UI/renderer, bundle, recursos nativos, `Focused hygiene` y `Diff whitespace` |
| `npm test --prefix extensions/armotusitio-ide` | **173 PASS, 0 FAIL, 9 SKIP** (182 tests en total) |
| `npm run check --prefix extensions/armotusitio-ide` | **PASS**: TypeScript y recursos |
| `git diff --check` y `git diff --cached --check` | **PASS**: sin errores informados |
| Husky precommit | **PASS**: cuatro archivos analizados por higiene |
| Commit y push | **PASS**: `18f35f8d374`, `style(harness): finalize six-area enterprise formatting`, publicado en `feat/native-harness-enterprise-upgrade` |

- [x] **Bloqueo local de formato/higiene: cerrado.** No quedan fallas en la batería local ejecutada sobre el árbol que se publicó.
- [x] **Commit de formato publicado.** Cuatro archivos, 89 inserciones y 81 eliminaciones declaradas por Git; no se incluyó `script_test.log`.
- [ ] **CI sobre el SHA `18f35f8d374`**: no confirmado en esta evidencia. Hay que verificar los jobs de Windows, Linux y macOS y sus tests E2E simulados que Windows omite.
- [ ] **E2E con Codex/Claude autenticados**, permisos y aislamiento OS, recuperación con escrituras, portabilidad, benchmarks y empaquetado completo del IDE: aún sin certificación.

**Interpretación:** los 9 SKIP son omisiones explícitas de tests según plataforma, no 9 fallos; sí constituyen cobertura pendiente en Windows. Los warnings de Node sobre TypeScript experimental y `MODULE_TYPELESS_PACKAGE_JSON` no bloquearon este cierre. La ejecución se hizo **antes** del commit final de formato: la prueba no demuestra por sí sola que GitHub CI pasó en ese SHA exacto.

### Iteración siguiente: CI verificable, fixtures Windows y presupuesto de llamadas (pendiente de pruebas)

**Implementación publicada después de la validación local de 173 PASS.** Los resultados históricos **NO** validan estos commits nuevos. No cambiar las casillas de certificación hasta aportar los nuevos logs.

- **CI (Windows/Linux/macOS):** workflow de contratos ampliado con verificación del SHA real, `pipefail`, captura de logs por sistema operativo, artefactos de diagnóstico y resumen de resultados; el workflow continúa sin invocar modelos ni instaladores. La existencia del workflow **no** equivale a una ejecución exitosa en GitHub Actions.
- **E2E sintéticos portables:** nueva fixture Node `test/native-fake-provider.mts`, compatible con el mecanismo de resolución de CLI de Windows sin shell. Se habilitaron pruebas antes omitidas en Windows: DAG de lectores concurrentes, workflow secuencial, ciclo correctivo, transporte CLI, detección de modificación en rol read-only, uso estructurado, progreso y diagnóstico local.
- **Pruebas read-only más fieles:** trazas temporales de los ejecutables sintéticos fuera del árbol del proyecto para evitar que el propio instrumento de test altere el estado de solo lectura durante su ejecución. La fixture no constituye sandbox del SO.
- **Límite de costo por invocaciones:** `MAX_WORKFLOW_PROVIDER_CALLS = 5`, igual al máximo autorizado actualmente por el diálogo de workflow del IDE; un plan de más de cinco llamadas se rechaza **antes** de crear locks o ejecutar proveedores. Un ciclo correctivo no puede superar ese límite. No confundir este máximo de llamadas con un presupuesto monetario rígido, todavía pendiente.
- **Cobertura de higiene:** el script incluye la nueva fixture y las suites modificadas en el formateador y el lint enfocados.

- [ ] **Nueva validación local sobre la presente iteración:** `node scripts/ats-harness-check.mts --fix`, verificador sin `--fix`, `npm test --prefix extensions/armotusitio-ide`, `npm run check --prefix extensions/armotusitio-ide`, `git diff --check`. Repetir después del commit local de formato si fuera necesario.
- [ ] **Validación CI sobre SHA final:** confirmar tres jobs y revisar artifacts, incluidos tests que ya no se omiten en Windows.
- [ ] **Conservar sin reclasificar:** sandbox OS, recuperación transaccional, protocolo común Python/Node, presupuestos monetarios, benchmark e instaladores siguen pendientes.

### Verificación local de fixtures multiplataforma (2026-10-30, 17:34 ART)

**Evidencia aportada por el operador:** log `Texto pegado(20261030-203500).txt` en Windows `win32/x64`, Node `v24.22.1`; rama `feat/native-harness-enterprise-upgrade` actualizada antes de ejecutar.

| Gate | Resultado |
|---|---|
| `node scripts/ats-harness-check.mts --fix` | **PASS** en todos los gates, incluidos formato e higiene |
| `node scripts/ats-harness-check.mts` | **PASS**: TypeScript, recursos, UI/renderer, bundle, paquete nativo, higiene y diff |
| `npm test --prefix extensions/armotusitio-ide` | **182 PASS, 0 FAIL, 1 SKIP** (183 tests) |
| `npm run check --prefix extensions/armotusitio-ide` | **PASS** |
| `git diff --check` | Sin observaciones |
| `git status --short` | Sin archivos rastreados modificados; `script_test.log` permanece sin seguimiento |

- [x] **Validación local Windows de esta iteración:** cerrada. Las ocho pruebas adicionales antes omitidas fueron ejecutadas y aprobaron, incluidas concurrencia DAG, ejecución simulada, ciclo correctivo, detección de escrituras de solo lectura, progreso y diagnóstico CLI.
- [ ] **Prueba de symlink sensible en Windows:** sigue omitida mediante condición de plataforma; corresponde verificarla en Linux/macOS y evaluar permisos para Windows.
- [ ] **GitHub Actions multiplataforma del último SHA:** sin evidencia de jobs verdes en la fuente consultada. No equiparar YAML definido con ejecución CI exitosa.
- [ ] **E2E de modelos reales y sandbox OS:** no ejecutados por esta batería; siguen siendo bloqueantes para certificación enterprise AAA.

**Nota:** la evidencia demuestra funcionamiento de proveedores *simulados*, no autenticación, permisos de proveedor ni contención efectiva del sistema operativo.

### Iteración E2E con proveedores reales: runner opt-in (pendiente de validación)

- [x] **Código incorporado:** `scripts/ats-harness-real-provider-smoke.mts` implementa una prueba de una sola invocación con `codex` o `claude`, exigencia de `--acknowledge-real-model-call`, terminal interactiva, confirmación `RUN`, timeout de 90 segundos, revisión `read-only` y proyecto Git descartable. El resultado comunica únicamente metadatos agregados; no guarda prompts, respuestas ni credenciales. Un scope violation conserva el directorio temporal para auditoría.
- [x] **Pruebas de consentimiento sin consumo:** `native-real-smoke.test.mts` verifica rechazo de argumentos incompletos y ayuda que no invoca al proveedor.
- [x] **CI y checks actualizados en código:** el archivo y pruebas están incluidos en el scope de CI y los checks locales; el checkout CI dispone del script importado por el test. El CI automático NO ejecuta modelos ni solicita autenticación.
- [ ] **Validación local del nuevo commit:** ejecutar `node scripts/ats-harness-check.mts --fix` (inspeccionar diff), `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide`, `npm run check --prefix extensions/armotusitio-ide` y `git diff --check`. Los anteriores 182 PASS no validan este cambio.
- [ ] **Smoke real controlado:** a decisión del operador, tras revisar `docs/native-harness-six-partial-validation.md`. Puede consumir cuota; no es requisito de los tests automáticos.
- [ ] **CI Linux/macOS/Windows del último SHA:** todavía sin evidencia verificada. 
- [ ] **Sandbox OS real:** sin implementar. Las restricciones de modelo y verificación Git no equivalen a aislamiento de procesos, filesystem y red.

### Validación Windows del smoke opt-in y negativa de consentimiento (2026-10-30, 17:39–17:40 ART)

**Evidencia del operador:** `Texto pegado(20261030-204012).txt` y transcripción de la ejecución manual. Sistema `win32/x64`, Node `v24.22.1`, rama `feat/native-harness-enterprise-upgrade`.

| Validación | Resultado observado |
|---|---|
| `node scripts/ats-harness-check.mts --fix` | **PASS**, incluidas pruebas, formato, bundle, higiene y diff |
| `node scripts/ats-harness-check.mts` | **PASS** en sus siete controles sin `--fix` |
| `npm test --prefix extensions/armotusitio-ide` | **184 PASS / 0 FAIL / 1 SKIP** (185 tests) |
| `npm run check --prefix extensions/armotusitio-ide` | **PASS** |
| `git status --short` | Solo `script_test.log` sin seguimiento; sin cambios rastreados |
| Smoke Codex con respuesta `hola` | **Rechazado correctamente**: `HARNESS_REAL_SMOKE_NOT_APPROVED`, antes de invocar modelo |

- [x] **Validación automatizada local del runner de consentimiento:** cerrada; los tests nuevos de argumentos obligatorios y help pasaron.
- [x] **Rechazo de consentimiento incorrecto:** demostrado manualmente al ingresar `hola`, distinto de la confirmación literal requerida `RUN`.
- [ ] **E2E autenticado Codex:** no ejecutado; la prueba se detuvo deliberadamente antes de invocar el modelo. Para realizarla se requiere una nueva ejecución y escribir `RUN` conscientemente (puede consumir cuota).
- [ ] **E2E autenticado Claude:** no ejecutado.
- [ ] **CI de Windows, Linux y macOS sobre el SHA final:** sin evidencia confirmada de éxito.
- [ ] **Sandbox OS, recuperación transaccional, protocolo común de motores e instaladores:** mantienen sus bloqueos de certificación.

**Alcance:** 184 pruebas locales aprobadas y un bloqueo de consentimiento correctamente aplicado **no** acreditan una invocación autenticada real de Codex ni seguridad OS. El test de symlink sensible permanece omitido en Windows.

### Primer smoke real Codex: rechazo temprano y remediación de argumentos (2026-10-30)

**Evidencia suministrada:** tras la confirmación literal `RUN`, `ats-harness-real-provider-smoke.mts --provider codex` reportó `status=failed` en 299 ms, `scopeVerified=true`, `scopeViolation=false`, `responseTruncated=false` y `tokenUsageReported=false`.

- [x] **Invocación del runner con consentimiento correcto:** ejecutada. No equivale a sesión de modelo completada.
- [ ] **Smoke real Codex exitoso:** **NO** demostrado. El error no incluye diagnóstico del CLI ni prueba de autenticación; un fallo casi inmediato es compatible con incompatibilidad de flags.
- [x] **Corrección de compatibilidad en código:** se trasladó el flag global `--ask-for-approval never` antes del subcomando `exec`, manteniendo `--sandbox read-only/workspace-write`, `--ephemeral`, `--json` y el resto de restricciones. Las pruebas de argumentos y seguridad se actualizaron.
- [x] **Diagnóstico agregado:** el smoke ahora informa `exitCode` y `failureCategory` con categorías fijas, sin imprimir texto crudo de Codex/Claude, prompts o credenciales.
- [ ] **Nueva verificación local:** repetir los checks y luego, opcionalmente, el smoke con confirmación `RUN`. Puede consumir cuota; no habilitar automáticamente.
- [ ] **Prueba real Claude, CI multiplataforma y sandbox OS:** sin evidencia de cierre.

**Causa probable, aún no certificada:** las versiones recientes de Codex admiten `--ask-for-approval` como argumento global **antes** de `exec`, pero pueden rechazarlo cuando se coloca después del subcomando. No declarar la hipótesis confirmada sin salida diagnóstica o smoke exitoso.

### Primer E2E Codex autenticado: PASS; higiene de test corregida (2026-10-30, 17:44 ART)

**Evidencia del operador:** `Texto pegado(20261030-204436).txt` (validación automatizada Windows) y transcripción de `ats-harness-real-provider-smoke.mts --provider codex` con autorización interactiva `RUN`.

- [x] **Smoke real Codex autenticado completado**: `passed=true`, `status=passed`, `exitCode=0`, duración **27.864 ms**, `scopeVerified=true`, `scopeViolation=false`, `responseTruncated=false`, `tokenUsageReported=true`. Confirma una única ejecución real de solo lectura y revisión explícita sobre fixture Git temporal; **no certifica** un workflow completo con escritura, permisos OS, cancelación o recuperación.
- [x] **Pruebas automatizadas locales:** `npm test --prefix extensions/armotusitio-ide`: **185 PASS, 0 FAIL, 1 SKIP** (186 tests); TypeScript, renderer, bundle y recursos PASS.
- [x] **Incidente de higiene identificado y corregido en código:** `Focused hygiene` marcaba un literal de comillas dobles en `native-real-smoke.test.mts`, línea 33, regla `local/code-no-unexternalized-strings`. Se sustituyó por un literal de fixture compatible sin alterar la clasificación funcional. Cambio publicado en `ff799d97b283`.
- [ ] **Verificación posterior al fix de higiene:** volver a ejecutar `node scripts/ats-harness-check.mts` y los checks regulares sobre el nuevo commit. No declarar higiene final PASS antes de obtener nuevo log.
- [ ] **Smoke real Claude y CI Windows/Linux/macOS:** pendientes. El test de enlaces simbólicos sensibles permanece omitido en Windows.
- [ ] **Seguridad OS, recuperación transaccional y protocolo común de motores:** aún no certificados.

### CI local limpio; smoke Claude bloqueado por descubrimiento de CLI (2026-10-30, 17:47 ART)

**Evidencia del operador:** `Texto pegado(20261030-204745).txt` y transcripción de una ejecución manual de Claude autorizada con `RUN`.

- [x] **Validación automatizada local Windows:** verificador sin `--fix` con todos los gates en PASS (TypeScript, recursos, UI/renderer, bundle, empaquetado, higiene, diff). Suite completa: **185 PASS / 0 FAIL / 1 SKIP** de 186 tests; `npm run check` PASS.
- [x] **Codex real, modo read-only:** PASS con evidencia registrada en la iteración precedente.
- [ ] **Claude E2E real:** la resolución de ejecutable devolvió `HARNESS_EXECUTABLE_UNAVAILABLE`; no llegó a invocar Claude, no demuestra fallo de autenticación ni de modelo.
- [ ] **Determinar si Claude Code está instalado y accesible:** comprobar `command -v claude`, `where.exe claude`, `claude --version`, y, en caso de instalación npm, el directorio del paquete `@anthropic-ai/claude-code/cli.js` en PATH. El resolver Windows soporta `claude.exe` y el entry point JavaScript de npm; no ejecuta shims `.cmd` ni comandos arbitrarios.
- [ ] **CI Linux/macOS/Windows del SHA actual, aislamiento OS, recuperación transaccional y protocolo común de motores:** siguen sin certificación.

**Decisión:** no instalar Claude ni modificar PATH automáticamente sin evidencia del entorno; no relajar el `shell:false` ni las restricciones del ejecutor para ocultar un fallo de descubrimiento.

### Claude Code instalado; corrección del resolver npm en Windows (2026-10-30)

**Evidencia del operador:** `command -v claude` y `where.exe claude` encontraron el shim global npm en `C:\\Users\\addis\\AppData\\Roaming\\npm`; `claude --version` reportó **2.1.224** y `npm list -g @anthropic-ai/claude-code --depth=0` confirmó el paquete.

- [x] **CLI de Claude instalada y accesible por la terminal:** demostrado. El anterior `HARNESS_EXECUTABLE_UNAVAILABLE` indica un problema de detección en el Harness, no instalación ausente.
- [x] **Compatibilidad Windows npm añadida:** resolver ahora prueba `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (binario nativo) y conserva `cli.js` como fallback de versiones anteriores, sin utilizar `.cmd`, `.ps1`, shell ni `exec` arbitrario.
- [x] **Pruebas añadidas:** layout npm, precedencia de binario nativo, fallback JS. Integradas en la batería y CI multiplataforma.
- [ ] **Nueva validación local:** verificar TypeScript, higiene y suites en Windows, y comprobar el smoke de Claude en el mismo entorno. Ningún resultado anterior certifica esta corrección recién publicada.
- [ ] **E2E Claude autenticado, CI multiplataforma y sandbox OS:** pendientes.

### Claude Code: ejecución alcanzada, E2E bloqueado por cuota (2026-10-30, 17:51 ART)

**Evidencia:** log `Texto pegado(20261030-205153).txt` y resultado del smoke manual: proveedor `claude`, `status=failed`, `exitCode=1`, `failureCategory=provider-failed`, `scopeVerified=true`, `scopeViolation=false`, `responseTruncated=false`, duración 15.328 ms y `tokenUsageReported=true`. El operador confirma que actualmente **no dispone de tokens/cuota de Claude**.

- [x] **Detección y lanzamiento de Claude CLI:** resueltos; desapareció `HARNESS_EXECUTABLE_UNAVAILABLE`.
- [ ] **E2E Claude exitoso:** pendiente por disponibilidad de cuota; el mensaje genérico `provider-failed` no demuestra por sí solo que la cuota sea la causa exacta. No repetir llamadas reales hasta contar con cuota.
- [x] **Validación local Windows del último cambio de resolución:** `npm test --prefix extensions/armotusitio-ide` **188 PASS, 0 FAIL, 1 SKIP** de 189; `ats-harness-check.mts --fix` y sin `--fix` con todos los gates PASS (incluida higiene), `npm run check` PASS; sin cambios rastreados, `script_test.log` sin seguimiento.
- [ ] **Próximo foco independiente de cuota:** CI multiplataforma, fixtures de error/limitación del proveedor sin red, aislamiento OS, recuperación transaccional y protocolo de motores.

### Estado durable estrictamente tipado y rechazo de datos no autorizados (iteración pendiente de retest)

- [x] **Control de seguridad incorporado:** el lector del historial de workflows ahora valida una allowlist de campos tanto en el registro raíz como en cada paso, además de la allowlist ya existente para eventos. Verifica fechas, códigos de salida, duraciones y resultado final de verificación. Se rechazan metadatos desconocidos, incluidos posibles prompts, respuestas del proveedor o credenciales inyectados en JSON de estado.
- [x] **Regresión sin modelos:** test que escribe estados contaminados al archivo privado, comprueba fallo cerrado y ausencia de reescritura, y verifica que el estado legítimo continúa siendo legible. Incluye rechazos de campos desconocidos, fechas inválidas, duración negativa, códigos de salida no numéricos y estado de verificación desconocido.
- [ ] **Nueva ejecución de tests:** la batería previa de 188 PASS no contiene esta nueva prueba. Repetir `ats-harness-check.mts --fix` / sin `--fix`, suite npm, `npm run check` y `git diff --check`.
- [ ] **No certificado aún:** CI Windows/Linux/macOS y protección transaccional del filesystem; la allowlist endurece la persistencia, **no constituye rollback ni sandbox OS**.

### Corrección de prueba intermitente DAG en Windows (2026-10-30, 17:59 ART)

**Evidencia:** log `Texto pegado(20261030-205933).txt`, Node 24.22.1 / win32. En la primera ejecución de `ats-harness-check.mts --fix`, el test `workflow launches two independent read-only providers before exclusive implementer` falló al no observar solapamiento bajo temporización fija de 80 ms. En la ejecución posterior sin `--fix` el mismo test aprobó, y `npm test` informó **189 PASS, 0 FAIL y 1 SKIP** de 190; todos los demás gates (TypeScript, bundle, higiene y recursos) pasaron.

- [x] **Causa del falso negativo en el fixture identificada:** el test exigía orden de arranque/fin entre procesos mediante `setTimeout(80)`, aunque el arranque de subprocesos puede retrasarse bajo carga del runner. Ese orden no era un contrato fiable.
- [x] **Corrección del test implementada:** ambos lectores registran su inicio y esperan mediante una barrera explícita (máximo cinco segundos) hasta que ambos estén ejecutándose, antes de finalizar. El escritor sigue debiendo comenzar **después** del final de los dos lectores. Si los lectores no se solapan realmente, el test falla cerrado por timeout.
- [ ] **Retest del cambio:** el último commit del fixture todavía debe validarse localmente y en CI; no interpretar el PASS previo como evidencia de la barrera nueva.
- [ ] **Certificación CI multiplataforma:** la consulta de ejecuciones de la rama no mostró runs; la ausencia de runs requiere investigar registro/activación del workflow, no implica éxito.

### Validación DAG estable en Windows; endurecimiento de CI sin proveedores (2026-10-30, 18:01 ART)

**Evidencia recibida:** `Texto pegado(20261030-210153).txt` sobre commit `45a599c0a7a`. Test DAG aislado **5 PASS / 0 FAIL**; verificador enfocado todos los gates PASS; suite completa **189 PASS / 0 FAIL / 1 SKIP** de 190; `npm run check` PASS, sin modificaciones rastreadas (solo `script_test.log` untracked).

- [x] **Regresión de concurrencia con barrera:** validada localmente en Windows.
- [x] **Workflow CI actualizado:** verifica que el sparse checkout contiene fuente, fixture fake, test DAG y smoke offline, y repite el test DAG tres veces por sistema operativo para detectar intermitencia. No llama modelos ni requiere cuota.
- [ ] **Confirmar ejecución efectiva del workflow en GitHub Actions** sobre el SHA actual y los tres runners `ubuntu-latest`, `windows-latest`, `macos-latest`. No atribuir PASS de CI a los tests locales.
- [ ] **CI como gate de PR**: futura integración según política de ramas, tras demostrar runs reales.
- [ ] **Sandbox OS y recuperación transaccional de archivos**: pendientes; ninguna prueba de barrera o CI sustituye aislamiento efectivo.

### Redis opcional y política Local First (decisión 2026-10-30)

- [x] **Decisión arquitectónica:** Redis es una capacidad **opcional**, no una dependencia del IDE. El Harness debe funcionar íntegramente sin Redis ni Docker.
- [ ] **Adaptador futuro, condicionado a necesidad demostrada:** detectar Redis únicamente en un endpoint configurado y permitido; utilizarlo para colas, coordinación o eventos solo cuando aporte valor.
- [ ] **Fallback seguro:** ante indisponibilidad inicial, seguir con coordinación local. Ante pérdida de Redis con trabajos distribuidos activos, no sustituir locks ni reejecutar tareas de forma silenciosa: bloquear y reconciliar explícitamente.
- [ ] **Pruebas:** ejecución sin Redis, Redis disponible, caída durante operaciones, recuperación y separación entre instancias. No iniciar contenedores ni instalar Redis automáticamente.
- [x] **Validación sin GitHub Actions:** el responsable descarta Actions por consumo. Se retiró el workflow específico del Harness de esta rama. Los controles deben seguir ejecutándose localmente.

### Recuperación de estados antiguos fuera de la vista de historial (pendiente de retest)

- [x] La vista de historial conserva un límite de 40 entradas recientes para el IDE.
- [x] `reconcile()` ahora lee hasta el máximo interno de 500 registros almacenados antes de liberar locks y marcar interrupciones; un workflow antiguo no queda excluido por el límite de visualización.
- [x] Nueva prueba offline con 41 registros: el workflow más antiguo está oculto para la UI y debe reconciliarse igualmente.
- [ ] Repetir tests locales y verificar el commit `6f5040690035`. Los 190 PASS reportados son anteriores a esta modificación.

## Validación local obligatoria

Desde la raíz del repositorio, con las dependencias instaladas:

```bash
git fetch origin
git switch feat/native-harness-enterprise-upgrade
git pull --ff-only

node scripts/ats-harness-check.mts
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
```

Después, validar manualmente en el IDE: arranque y apertura de proyectos con/sin Harness propio; autorización de Codex/Claude; workflow aislado; un ciclo correctivo; gates configurados; cancelación; cierre inesperado/reconciliación; historial; métricas; y limpieza de worktrees sin pérdida de cambios.

**Importante:** `npm test` y el check focalizado incluyen proveedores simulados, no demuestran funcionamiento de proveedores autenticados. Para una prueba real se requieren CLIs instaladas y configuradas en la máquina del operador.

### Criterios de salida para la rama

- [x] Los tres comandos locales finalizaron satisfactoriamente en el árbol de trabajo final de Windows; confirmar por separado el SHA exacto mediante CI o checkout limpio.
- [ ] El workflow CI aparece como **successful** para el último commit de la rama (actualmente `18f35f8d374`; sin evidencia verificada).
- [ ] Build **completo del IDE** y empaquetado de distribución validados; el bundle y chequeo de recursos de la extensión **sí** pasaron localmente.
- [ ] Pruebas de permiso de lectura/escritura, aislamiento y secretos aprobadas.
- [ ] E2E real plan → implement → review → gate funciona con Codex y Claude.
- [ ] Cancelación, bloqueo, recuperación, y conservación de modificaciones comprobados.
- [ ] Benchmark reproducible contra la versión base registrado.
- [ ] Revisión del diff, dependencias, políticas y riesgos antes de crear o fusionar un PR.

## Límites y advertencias actuales

1. **Git worktree no es sandbox.** Aísla el checkout, pero no restringe necesariamente red, archivos externos ni otros procesos.
2. **Las métricas de costo son parciales.** Se registran solo cuando el proveedor informa uso y/o estimaciones; no constituyen contabilidad completa ni autorización de gasto.
3. **La reconciliación no reanuda por sí sola.** Marca trabajo interrumpido para inspección y evita reejecutar operaciones potencialmente no idempotentes.
4. **Dos motores siguen coexistiendo.** La prioridad del Harness del proyecto se conserva, pero el protocolo común ejecutable aún no está terminado.
5. **Las pruebas faltantes son bloqueantes.** La existencia de suites y de un YAML de CI no prueba que hayan ejecutado satisfactoriamente.

## Referencias dentro del repositorio

- [`docs/native-harness-enterprise-upgrade.md`](docs/native-harness-enterprise-upgrade.md): registro técnico de entregas y pendientes.
- [`extensions/armotusitio-ide/README.md`](extensions/armotusitio-ide/README.md): comandos y uso del Harness nativo.
- [`extensions/armotusitio-ide/src/native-agent-workflow.ts`](extensions/armotusitio-ide/src/native-agent-workflow.ts): orquestación de agentes.
- [`extensions/armotusitio-ide/src/native-agent-execution.ts`](extensions/armotusitio-ide/src/native-agent-execution.ts): ejecución de proveedores.
- [`extensions/armotusitio-ide/src/native-agent-worktree.ts`](extensions/armotusitio-ide/src/native-agent-worktree.ts): aislamiento Git.
- [`extensions/armotusitio-ide/src/native-engine-contract.ts`](extensions/armotusitio-ide/src/native-engine-contract.ts): contrato declarativo.
- [`.github/workflows/ats-harness-enterprise-validation.yml`](.github/workflows/ats-harness-enterprise-validation.yml): definición de CI multiplataforma.

## Política de integración

**No modificar `main`, no hacer merge, no desplegar ni afirmar certificación AAA** hasta completar los criterios de salida. Registrar los errores que aparezcan en la validación local y corregirlos en esta misma rama, con tests de regresión.
