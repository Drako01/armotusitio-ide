# Harness Enterprise AAA — estado de implementación y checklist

> **Proyecto:** `Drako01/armotusitio-ide`  
> **Rama de trabajo:** `feat/native-harness-enterprise-upgrade` (creada desde `main`)
> **Fecha de corte:** 2026-10-30
> **Estado:** desarrollo experimental; **NO certificado para merge ni producción**.

## Resumen ejecutivo

Esta guía documenta el alcance acordado y diferencia **código agregado a la rama** de funcionalidad realmente certificada. Una casilla marcada no significa que el comportamiento haya pasado pruebas reales de extremo a extremo.

**Inventario funcional histórico (línea base anterior a los lotes incrementales):** 34 ítems implementados en código, 5 parciales y 15 pendientes. Este inventario es histórico y no representa el conteo vigente. **Última validación automatizada local Windows aportada:** suite completa de extensión **241 PASS, 0 FAIL, 1 SKIP** (242 total), sobre la rama en `fd6f1d98dec`, 2026-10-30 a las 19:19 ART; el verificador focalizado completó sus siete gates en PASS con **144 PASS, 0 FAIL, 1 SKIP** en el subconjunto de tests. El benchmark offline sobre Windows x64, Node v24.22.1 midió 3 ejecuciones exitosas del verificador, con mediana de **9923 ms**. **No certifica AAA, E2E con proveedores reales, aislamiento del sistema operativo, compilación completa del IDE ni portabilidad Windows/Linux/macOS.** Los lotes más recientes quedan detallados cronológicamente abajo.

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
- [x] Suite local offline para el motor nativo en Windows; el workflow experimental de GitHub Actions se retiró por decisión del responsable, sin cambiar los otros workflows.
- [~] Observabilidad: eventos de ciclo de vida y avance de bytes sin contenido, emitidos y persistidos de forma acotada; faltan trazas distribuidas completas y validación E2E de streaming.
- [ ] Streaming estructurado del ciclo de vida completo y trazas accionables en el IDE.
- [ ] E2E con Codex y Claude autenticados, cubriendo permisos, cancelación y recuperación.
- [ ] Compilación, tests e instaladores validados en los tres sistemas operativos.
- [ ] Validación local trazable sobre el SHA exacto a integrar; Linux/macOS quedan pendientes en ambientes locales/VM, sin GitHub Actions.

## Pendientes críticos priorizados

| Prioridad | Trabajo | Condición de aceptación |
| --- | --- | --- |
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
| --- | --- | --- |
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
| --- | --- |
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
| --- | --- |
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
| --- | --- |
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

### Recuperación de estados antiguos fuera de la vista de historial (validado Windows)

- [x] La vista de historial conserva un límite de 40 entradas recientes para el IDE.
- [x] `reconcile()` ahora lee hasta el máximo interno de 500 registros almacenados antes de liberar locks y marcar interrupciones; un workflow antiguo no queda excluido por el límite de visualización.
- [x] Nueva prueba offline con 41 registros: el workflow más antiguo está oculto para la UI y debe reconciliarse igualmente.
- [ ] Repetir tests locales y verificar el commit `6f5040690035`. Los 190 PASS reportados son anteriores a esta modificación.

### Recuperación segura: liberar lock después de persistir estados (validado Windows)

- [x] **Orden de reconciliación reforzado:** `reconcile()` mantiene el lock obsoleto hasta finalizar todos los `atomicWrite` de los workflows interrumpidos. Ante errores de persistencia, conserva el lock en lugar de permitir nuevas escrituras.
- [x] **Regresión offline añadida:** comprobar que, tras una recuperación satisfactoria, el lock se elimina y los estados pasan a `interrupted`.
- [ ] **Validación local posterior:** correr el verificador, suite completa y check TypeScript; el último log del operador (**191 PASS / 0 FAIL / 1 SKIP**) es anterior a estos dos commits.
- [ ] **Sigue pendiente:** journal transaccional real, recuperación ante fallas de disco a mitad de una serie de registros, y sandbox OS. No confundir esta protección de lock con rollback transaccional completo.

### Lote P0: integridad de locks, estado y worktrees (2026-10-30; validado Windows)

- [x] **Estado terminal durable antes de desbloquear:** `NativeAgentWorkflow.start()` solo retira `execution.lock` cuando se confirmó la persistencia del registro final. Ante un fallo de escritura, retiene el lock para reconciliación explícita. Nueva prueba simula que el archivo de estado deja de ser escribible y verifica que un segundo writer queda bloqueado.
- [x] **Vinculación archivo–workflow:** `readHistory()` rechaza cualquier registro cuyo `id` no coincida exactamente con el nombre de archivo. `reconcile()` no podrá escribir sobre un registro distinto al inspeccionado. Nueva prueba de identidad alterada y conservación de evidencia.
- [x] **Limpieza de worktrees:** `removeCleanAgentWorktree()` valida formato del ID, nombre de directorio esperado y `git-common-dir` compartido con el repositorio raíz antes de ejecutar `git worktree remove`. Nueva prueba de descriptor falsificado.
- [x] **Retest Windows:** workflow 12/12, worktree 1/1, suite 194 PASS / 0 FAIL / 1 SKIP, TypeScript, recursos, bundle, higiene y diff PASS (log 2026-10-30 21:23 ART).
- [ ] **Aún no implementado:** journal transaccional, merge/rollback reversible, aislamiento filesystem/proceso/red a nivel OS, pruebas adversariales E2E; los controles aquí agregados no justifican declararlos completos.

### Lote P0 siguiente: estados de proyectos y persistencia reforzada (2026-10-30; validado Windows)

- [x] `restartInterrupted()` busca en los hasta 500 registros válidos almacenados, no solo en los 40 visibles en la UI; conserva aprobación renovada y prohibición de repetir escritores inciertos.
- [x] `reconcile()` rechaza registros cuyo `projectKey` no coincide con el proyecto local antes de alterar locks o estados.
- [x] `atomicWrite()` ejecuta `FileHandle.sync()` sobre el estado temporal antes del rename atómico; reduce pérdidas por buffer pendiente pero no garantiza atomicidad entre varios registros ni durabilidad del directorio en todos los sistemas operativos.
- [x] Dos nuevas pruebas offline verifican rechazo de registros ajenos y búsqueda de ejecuciones antiguas.
- [x] **Ronda de pruebas Windows:** suite **196 PASS / 0 FAIL / 1 SKIP**, check local TypeScript, UI, bundle, recursos, higiene y diff PASS (2026-10-30, 21:26 UTC).
- [ ] **P0 pendiente:** journal multioperación, fencing efectivo de locks ante concurrencia entre procesos, sandbox OS, integración/reversión de cambios y pruebas adversariales.

### Lote P0: seguridad del directorio de estado y propiedad de locks (2026-10-30; retest pendiente)

- [x] **Almacenamiento seguro:** `NativeAgentWorkflow` comprueba que el directorio de estado es un directorio real, no un enlace simbólico/junction ni una ruta no canónica, antes de leer historial o crear locks. Dos pruebas offline cubren symlink/junction y archivo ordinario.
- [x] **Protección de lock durante reconciliación:** conserva el contenido e identidad `dev/ino` del lock examinado y vuelve a contrastarlos antes de retirarlo. Si cambia, falla cerrado con `HARNESS_WORKFLOW_LOCK_CHANGED`. Esto **no es un fencing atómico** y no elimina completamente una carrera TOCTOU.
- [x] **Propiedad del lock terminal:** al finalizar un workflow, solo elimina `execution.lock` si pertenece al `record.id` y PID actuales, sin ser un symlink. Una prueba simula que otro proceso reemplaza su contenido y verifica que el lock queda intacto.
- [ ] **Retest de esta iteración:** ejecutar pruebas locales enfocadas, suite completa, TypeScript, recursos, higiene y revisar `git diff --check`. El último **196 PASS / 0 FAIL / 1 SKIP** es anterior a estas modificaciones.
- [ ] **P0 pendiente:** fencing OS/IPC con exclusión efectiva durante toda la reconciliación, journal transaccional multioperación, sandbox OS y rollback seguro. No declarar AAA antes de cubrirlos.

### Interoperabilidad híbrida con Harness de proyecto y skills (2026-10-30; primer lote validado Windows)

**Política deseada:** el IDE actúa como orquestador preferente de agentes y ofrece controles de seguridad, mientras que el proyecto conserva sus skills, reglas, contratos, gates y herramientas. No deben ejecutarse dos escritores concurrentes ni reemplazarse el Harness del proyecto sin un protocolo de coordinación verificable.

- [x] **Descubrimiento seguro:** catálogo local de `.agents/skills/*/SKILL.md` y `.claude/skills/*/SKILL.md`, lectura acotada a 64 KiB por skill, validación de directorios reales, rechazo de archivos enlazados y digest SHA-256 para detectar cambios. Alias `.claude/skills` enlazado a `.agents/skills` se ignora sin seguirlo.
- [x] **Agentes IDE read-only en proyectos externos:** revisión nativa y ejecución individual planner/reviewer habilitadas con consentimiento explícito y selección opcional de una skill; se comprueba el digest antes y después de la autorización, y se proporciona al agente su ruta relativa y digest, sin volcar ni truncar el contenido dentro del prompt. Las tareas/gates nativos siguen sin sustituir el estado del Harness del proyecto.
- [x] **Prevención de doble escritor:** los implementadores nativos quedan bloqueados mientras haya un Harness de proyecto; no se permite escribir sin coordinación de locks entre motores.
- [x] **Seguridad de autoridad:** paths de Harness inseguros mantienen bloqueo, incluso al intentar operación híbrida. No se ejecuta un motor externo durante el descubrimiento.
- [x] **Regresión de higiene:** retirados los dos `throw` de liberación de locks; la propagación de `HARNESS_WORKFLOW_LOCK_CHANGED` se realiza después del `finally` externo. Pendiente de comprobación local del gate `no-unsafe-finally`.
- [x] **Pruebas incorporadas:** descubrimiento de skills, cambio de digest, alias Claude, límite de tamaño, revisión híbrida sin creación de tareas nativas y rechazo de implementadores híbridos antes de invocar proveedores.
- [x] **Retest Windows primer lote:** 204 PASS/0 FAIL/1 SKIP; TypeScript, webview, bundle, recursos, higiene y diff PASS. El registro corresponde al SHA `80d7a7bb867`.
- [ ] **Fase híbrida de escritura:** protocolo ejecutable bidireccional con gates delegados, locks compartidos, control de concurrencia y E2E sobre RedEvent. El soporte actual **no certifica** prioridad completa del IDE ni integración de ejecutores de proyectos.
- [~] **Skills más extensas:** catálogo admite hasta 64 KiB por skill, referencias por digest y selección múltiple de hasta ocho skills. Pendiente la carga supervisada de archivos superiores a 64 KiB y pruebas E2E de aplicación de convenciones.

### Iteración P0/P1: skills híbridas y autorización consistente (2026-10-30; retest consolidado pendiente)

- [x] El log local de Windows sobre `80d7a7bb867` certifica **204 PASS / 0 FAIL / 1 SKIP**, con TypeScript, bundle, recursos, higiene y `diff --check` en PASS. Esa es la última base realmente validada.
- [x] Se verifica el directorio padre `.agents`/`.claude` al descubrir skills, impidiendo que un symlink padre esconda contenido externo. Nueva regresión con carpeta fuera del workspace.
- [x] El inicio de un agente vuelve a comprobar la autoridad del proyecto *después* de solicitar consentimiento: si aparece un Harness propio, no se inicia un implementador nativo; si cambia el tipo de autoridad o aparecen rutas inseguras, falla cerrado. Nueva regresión de cambio durante confirmación.
- [x] Selector múltiple para **hasta ocho skills** del proyecto por agente nativo de lectura, con referencias relativas, digest SHA-256 y revalidación de todos los archivos antes de iniciar el proveedor. No copia el contenido al prompt ni lo ejecuta como instrucciones privilegiadas.
- [x] Regresiones offline para alteración de skill durante la confirmación y rechazo de más de ocho skills. No se hace ninguna llamada real a Codex ni Claude.
- [ ] **Retest del lote:** pruebas de skills, integración, workflow, verificador local, suite global, TypeScript e higiene. Hasta disponer de un nuevo log, no contar los tests nuevos como PASS.
- [ ] **Interoperabilidad completa aún pendiente:** adaptar la ejecución de gates del proyecto, handshake con permisos, fencing interproceso y exclusividad de escritores, sandbox OS y E2E mixto sobre RedEvent. Los implementadores del IDE siguen bloqueados en proyectos con Harness propio.

### Lote P1: compatibilidad con directorios Codex y selección segura (2026-10-30; validado Windows)

- [x] **Detección de `.codex/skills`:** reconocimiento de `SKILL.md` por carpeta, igual que `.agents/skills` y `.claude/skills`, sin ejecutar contenido ni procesos del proyecto. El directorio `.codex` por sí solo **no** se interpreta como Harness independiente.
- [x] **Prioridad determinista ante skills duplicadas:** `.agents/skills` > `.codex/skills` > `.claude/skills`. Cada nombre se publica una sola vez; el orden no concede autoridad ni sobrescribe archivos.
- [x] **Skills en proyectos sin Harness:** catálogo y selector disponibles para agentes nativos también cuando existe únicamente `.codex` o `.agents` y no hay `.harness`.
- [x] **Seguridad y límites conservados:** no seguir directorios de skills de Codex que sean symlinks/junctions, validar padres canónicos, máximo 64 KiB por archivo y hasta ocho skills seleccionadas.
- [x] **Protección del selector múltiple:** rechazo de elementos duplicados, no declarados o de más de ocho elementos antes de iniciar proveedores.
- [x] **Regresiones añadidas:** Codex-only, prioridades cruzadas, enlaces hacia fuera del proyecto, revisión nativa sin Harness y selección duplicada.
- [x] **Validación local completada:** **213 PASS / 0 FAIL / 1 SKIP** sobre `b50999ec592`, con todos los gates locales en PASS.
- [ ] **Interoperabilidad completa:** pendiente protocolo de control compartido, fencing de escrituras, delegación de gates y pruebas reales multi-Harness. Las skills se consumen como convenciones, nunca como permiso para ejecutar arbitrariamente.

### Lote P1: inventario de convenciones de proyecto (2026-10-30; validado Windows)

- [x] Descubrimiento **read-only** de `AGENTS.md`, `CLAUDE.md`, `.codex/AGENTS.md` y `.github/copilot-instructions.md`, con límites por archivo de 64 KiB, hashes SHA-256 y rutas relativas canónicas.
- [x] El catálogo no expone contenido de instrucciones en la revisión visual: únicamente rutas, tamaño y digest. No interpreta archivos de proyecto como autorizaciones de ejecución ni ejecuta sus comandos.
- [x] La ejecución nativa incorpora referencias a los documentos existentes en la instrucción revisable, y exige revalidar **todo el inventario** después de la aprobación y antes de lanzar un proveedor. Si aparece, desaparece o cambia un documento durante el consentimiento, devuelve `HARNESS_PROJECT_GUIDANCE_CHANGED`.
- [x] Rechazo de documentos y directorios padres enlazados mediante symlinks/junctions, archivos no regulares y archivos superiores al límite. No se siguen rutas externas.
- [x] Pruebas offline nuevas de inventario, mutación de contenido, tamaños máximos, symlinks, preview de metadatos y cancelación de lanzamiento ante cambios.
- [x] Registro de `native-project-guidance.ts` y su suite en formato, higiene, tests focalizados y verificación local.
- [x] **Retest Windows:** incluidos en la suite 220 PASS / 0 FAIL / 1 SKIP, TypeScript, bundle, higiene y diff PASS, sobre `66d57bea921`.
- [ ] **No implementado:** interoperabilidad ejecutable plena entre motores, exclusión distribuida de escritores, journal multioperación, sandbox OS y ejecución autónoma de gates externos. Ningún metadato de convenciones puede habilitar estas capacidades.

### Lote P1: comparación de capacidades sin elevación de permisos (2026-10-30; validado Windows)

- [x] `verifiedNativeCapabilities()` expone la lista real declarada por el motor IDE, independiente de que el proyecto abierto disponga de Harness propio.
- [x] `compareHybridCapabilities()` devuelve intersección, capacidades exclusivas del IDE y capacidades reportadas solo por el proyecto; rechaza nombres desconocidos y duplicados.
- [x] El handshake explícito muestra esta comparación para preparar el futuro routing de gates. **El resultado nunca activa ejecución externa**: `executionGranted: false`.
- [x] Pruebas offline de solapamiento, funcionalidad externa sin attestation, rechazo de manifiestos inválidos y renderizado del handshake real sin autorización de ejecución.
- [ ] **Pendiente:** protocolo de ejecución de gates con contratos firmes, locks compartidos/fencing y tests E2E reales. No usar los reportes de capacidades como sustituto de implementación validada.
- [x] **Retest Windows:** comparación de capacidades y UI de handshake validadas dentro de los 220 PASS sobre `66d57bea921`.

### Lote P0/P1: catálogo seguro de gates externos y handshake estable (2026-10-30; validado Windows)

- [x] **Capacidades endurecidas:** `.harness/manifests/ide-capabilities.json` exige rutas padre canónicas sin symlinks, lectura real acotada a 16 KiB y campos exactos de schema v2. Los campos desconocidos no amplían autoridad.
- [x] **Descubrimiento declarativo de gates:** `.harness/manifests/ide-gates.json` admite únicamente `schemaVersion: 1` y `gates` con `id`, `dependsOn` y `resources`; hasta 32 gates, identificadores limitados, máximo 8 recursos por gate y 16 KiB totales. Rechaza comandos, rutas ejecutables, dependencias ausentes y ciclos.
- [x] **Sin ejecución implícita:** `readProjectGateCatalog()` solo lee metadatos y SHA-256, devuelve `executionEnabled: false`. El catálogo aparece en el handshake voluntario del proyecto; nunca se interpretan capacidades o DAG como autorización.
- [x] **Scheduler preventivo:** `planProjectGateWaves()` construye olas deterministas con máximo de concurrencia configurable (1–8), respeta dependencias y evita simultaneidad sobre recursos compartidos. El handshake muestra `simulatedGateWaves`; es una simulación local y no ejecuta procesos.
- [x] **Snapshot para integración futura:** `validateProjectGateCatalog()` comprueba que el digest aprobado todavía coincide. El handshake también vuelve a validar la declaración de capacidades después de ejecutar el probe, rechazando cambios de manifiesto.
- [x] **Regresiones offline:** validación estricta de manifest de capacidades y directorios enlazados, catálogo DAG, ciclos, comandos inyectados, dependencias ausentes, alteración de digest, olas limitadas por recursos/concurrencia, UI read-only y mutación durante handshake.
- [x] **Gates de calidad:** módulo y pruebas del catálogo añadidos al verificador `ats-harness-check.mts`, incluyendo formato, TypeScript, suite enfocada e higiene.
- [x] **Retest Windows:** todos los gates locales PASS, suite 227 PASS / 0 FAIL / 1 SKIP sobre `5799f281773`, incluida simulación de olas y regresiones del handshake.
- [ ] **Delegación de gates de proyecto:** requiere negociar un contrato ejecutable y explícito, permisos, límites de procesos y locks compartidos. Este catálogo no ejecuta un solo gate y no certifica coexistencia de escritores.
- [ ] **P0 restantes:** journal transaccional entre registros, fencing de locks interproceso, sandbox OS, control de red y rollback sin pérdida de datos.

**Formato del catálogo opcional (no crea ni habilita gates):**

```json
{
  "schemaVersion": 1,
  "gates": [
    { "id": "lint", "dependsOn": [], "resources": ["cpu"] },
    { "id": "tests", "dependsOn": ["lint"], "resources": ["db"] }
  ]
}
```

### Lote P0: guard de reconciliación y write-ahead intent por registro (2026-10-30; retest pendiente)

- [x] `NativeAgentWorkflow.reconcile()` obtiene un guard exclusivo `reconcile.guard` mediante `open('wx')` y `fsync` antes de inspeccionar estados; dos reconciliadores simultáneos no pueden participar. `start()` comprueba el guard antes y después de reservar `execution.lock`, sin ejecutar agentes durante una recuperación activa.
- [x] El guard comprueba identidad de dispositivo/inodo y contenido antes de eliminarse. Si fue reemplazado, no se retira. Un guard persistente tras cierre abrupto requiere revisión manual; no se presume autorización por PID obsoleto.
- [x] **Journal de intención de un solo registro:** antes de reemplazar cada JSON de estado, persiste `<workflow-id>.json.intent` con únicamente ID, versión, timestamp, digest previo y digest esperado; `fsync` precede al `rename`. Una escritura fallida deja la intención y bloquea nuevos workflows.
- [x] **Recuperación conservadora:** bajo el guard exclusivo, se permite retirar un journal pendiente solamente cuando el estado escrito coincide con el digest esperado y es un `WorkflowRecord` válido del mismo proyecto. Si el estado está incompleto, falta, no coincide o es ajeno, se conserva y no se reejecutan proveedores.
- [x] **Diagnóstico operativo:** `pendingJournalIds()` permite ver los IDs pendientes. El historial del IDE presenta `recovery-required` para trabajo incierto o `write-in-progress` para transiciones de workflows locales activos, sin exponer contenido de prompts, rutas absolutas ni archivos inciertos.
- [x] **Regresiones offline incorporadas:** concurrencia/guard, preservación de guard ajeno, recuperación de intento confirmado, bloqueo de escritura no confirmada, rechazo de journal de proyecto ajeno, ciclo normal de journal sin proveedores, detección correcta de sidecars `.json.intent` y diagnóstico desde la UI.
- [ ] **Validación local pendiente:** la evidencia confirmada de 227 PASS es previa a este lote. Repetir el verificador focal, suite y TypeScript en un checkout del SHA final.
- [ ] **Límites pendientes:** no hay garantía de durabilidad de directorio universal, journal atómico multi-registro, fencing coordinado con el motor externo ni rollback del filesystem. La detección de reemplazos entre verificación y eliminación sigue sujeta a carreras OS/TOCTOU. **No certificar aún recuperación transaccional completa.**

### Lote P1: preparación de delegación y validación estricta de scheduling (2026-10-30; retest pendiente)

- [x] `assessHybridGateReadiness()` explicita bloqueos al habilitar gates: falta de capacidad declarada, catálogo ausente, fencing sin demostrar, protocolo ejecutable sin demostrar y sandbox OS sin demostrar.
- [x] El handshake muestra `gateReadiness` pero mantiene `executionEnabled: false` incluso si el catálogo y el DAG son correctos.
- [x] `planProjectGateWaves()` revalida íntegramente también los catálogos suministrados desde memoria: nombres, recursos, duplicados, campos extra y dependencias, sin asumir que pasaron por el lector seguro de JSON.
- [x] Nuevas pruebas offline e integración de diagnóstico y rechazo de catálogo adulterado; los módulos nuevos se añadieron al verificador local.
- [ ] Queda pendiente un protocolo de delegación *real* que coopere con los locks y permisos del proyecto, además de E2E mixto validado con RedEvent. La simulación de waves no significa ejecución automática.

### Corrección de higiene tras retest Windows (2026-10-30)

- [x] Log local sobre `a35c656f523`: **237 PASS, 0 FAIL, 1 SKIP**, TypeScript, UI, bundle, recursos y diff en PASS.
- [x] Causa del único gate fallido: caracteres acentuados literales en dos mensajes de `native-integration.ts` (regla `no-unexpected-multiline`/Unicode del verificador). Se sustituyeron por escapes `\\u` manteniendo el texto de la interfaz.
- [ ] Retest de `node scripts/ats-harness-check.mts` sobre `7c2f44881140`; todavía no afirmar higiene PASS sobre ese SHA.


### Lote de endurecimiento del protocolo híbrido (2026-10-30; pendiente de retest)

- [x] **Handshake estricto:** la respuesta JSON del motor externo se rechaza si contiene campos distintos de `schemaVersion`, `nonce` y `capabilities`. Un proyecto no puede introducir `executionGranted` u otro campo de autorización en la respuesta sin disparar `HARNESS_HANDSHAKE_INVALID`.
- [x] **Planificador defensivo:** `planProjectGateWaves()` rechaza catálogos de memoria con campos inesperados o digest SHA-256 de formato inválido, antes de calcular olas. Mantiene `executionEnabled: false` y nunca invoca procesos externos.
- [x] **Regresiones agregadas:** respuesta del handshake con nonce válido y elevación de autoridad simulada; catálogo adulterado con digest inválido y campo `executionGranted`.
- [ ] **Validación local de este lote pendiente:** ejecutar `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide` y `npm run check --prefix extensions/armotusitio-ide` sobre el SHA publicado. No inferir PASS por las pruebas anteriores.
- [ ] **Sin cambio en los bloqueos críticos:** siguen pendientes fencing compartido, delegación ejecutable, sandbox OS, rollback transaccional y E2E mixto con RedEvent/Codex/Claude.

**Evidencia aportada por el operador antes de este lote:** log del 30/10/2026 22:10 sobre `baca931b2ca`: verificador focalizado 140 PASS / 0 FAIL / 1 SKIP y siete etapas PASS (TypeScript, webview, renderer, bundle, recursos, higiene, diff). La cifra de 140 corresponde al subconjunto del verificador, no debe presentarse como la suite completa de la extensión.

### Retest Windows del protocolo híbrido y corrección final de higiene (2026-10-30)

- [x] **Evidencia aportada:** sobre `7c67107a7fb`, el verificador focalizado ejecutó 142 tests: **141 PASS, 0 FAIL, 1 SKIP**; TypeScript, recursos, renderer, bundle, empaquetado de recursos y diff PASS.
- [x] **Suite completa de extensión:** **238 PASS, 0 FAIL, 1 SKIP** (239 total). `npm run check --prefix extensions/armotusitio-ide` finalizó sin error.
- [x] **Causa del único gate fallido:** `Focused hygiene` señaló `local/code-no-dangerous-type-assertions` en `test/native-project-gates.test.mts`, línea 121, por un `as never` nuevo en el fixture adversarial.
- [x] **Corrección publicada:** el caso adversarial conserva el campo no autorizado sin forzar el tipo con `as never`. Commit `97d9bc453e5f9bae54493e1edd247c4d4f38a297`.
- [ ] **Retest obligatorio del SHA corregido:** verificar `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide`, `npm run check --prefix extensions/armotusitio-ide` y `git diff --check`; aún no existe log para ese commit.
- [ ] **Cierre enterprise AAA pendiente:** protocolo de ejecución externa coordinado y interoperable, sandbox OS probado, fences compartidos, rollback y checkpoints transaccionales, E2E con ambos proveedores autenticados, builds reales Windows/Linux/macOS y benchmarks reproducibles. Ninguna suite offline sustituye estos criterios de aceptación.

### Evidencia de cierre Windows sobre la corrección de higiene (2026-10-30)

- [x] Log recibido en la conversación: **238 PASS, 0 FAIL, 1 SKIP** (239 total) en `npm test --prefix extensions/armotusitio-ide`.
- [x] `node scripts/ats-harness-check.mts`: siete gates **PASS**, incluido `Focused hygiene`, sin errores; subconjunto de 141 PASS / 0 FAIL / 1 SKIP. `npm run check --prefix extensions/armotusitio-ide` completado sin fallas y `git diff --check` sin salida.
- [ ] Este log es **anterior** al benchmark P2 agregado después; no acredita los commits del nuevo lote ni constituye E2E real del IDE.

### Lote P2: benchmark reproducible offline (2026-10-30; validación pendiente)

- [x] Nuevo `scripts/ats-harness-benchmark.mts` ejecuta localmente únicamente `check` o `test`, entre 1 y 10 repeticiones explícitas; sin agente, despliegue, publicación ni red de proveedor. Registra tiempos reales wall-clock y tasas observadas de éxito/fallo sin inventar CPU, RAM, precios ni mejora porcentual.
- [x] Resumen con mínimo, mediana, p95 y máximo por ejecución; todas las mediciones fallidas aparecen como muestras y generan exit code de fallo.
- [x] Nueva suite `native-benchmark.test.mts` cubre muestras válidas/invalidas, rechazo de comandos arbitrarios y `--help` sin ejecución. Integrada en tests focalizados, formateo e higiene de `ats-harness-check.mts`.
- [ ] El benchmark **no** equivale a comparación cold/warm de motores ni cuantifica consumo CPU/RAM/tokens, costos o throughput de proveedores reales. Requiere baseline fija, hardware controlado y repetición en sistemas operativos elegidos.
- [ ] Retest de la rama tras este lote y revisión del formato oficial. Ejecutar `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide` y `npm run check --prefix extensions/armotusitio-ide`. No cambiar casillas globales de certificación hasta contar con evidencia.

Ejemplo local voluntario: `node scripts/ats-harness-benchmark.mts --command check --runs 3`. El resultado JSON se imprime en terminal; no se guarda información del proyecto ni se ejecutan CLIs de IA.

### Lote P0: integridad del entrypoint en handshake externo (2026-10-30; retest pendiente)

- [x] `probeProjectHandshake()` fija un digest SHA-256 del entrypoint real `.harness/core.mjs` antes de invocarlo y vuelve a comprobarlo al finalizar, antes de aceptar capacidades. Se limita el tamaño leído a 16 MiB y se exige archivo regular, canónico y no enlazado.
- [x] La modificación del entrypoint durante el handshake genera `HARNESS_HANDSHAKE_ENTRY_CHANGED` y no concede permisos. Se agregó un caso offline donde el propio proceso altera su script tras iniciarse.
- [ ] **Sin attestation de sandbox ni protección OS ante TOCTOU:** un digest anterior/posterior no impide mutaciones entre ambas comprobaciones o escrituras fuera del proyecto. Los ejecutores externos siguen sin autorización de escritura del IDE.
- [ ] Validación local completa de estos cambios sobre el SHA publicado y pruebas E2E posteriores.


### Cierre de validación Windows del benchmark e integridad (2026-10-30, 19:20 ART)

- [x] **Evidencia del operador sobre `fd6f1d98dec`:** `npm test --prefix extensions/armotusitio-ide` ejecutó **242 pruebas: 241 PASS, 0 FAIL, 1 SKIP**. Incluye las pruebas de integridad del entrypoint y benchmark offline.
- [x] **Verificador focalizado:** 145 pruebas (144 PASS, 0 FAIL, 1 SKIP), con **7/7 gates PASS**: TypeScript, webview, renderer, bundle, recursos nativos, higiene y diff whitespace.
- [x] **Check adicional:** `npm run check --prefix extensions/armotusitio-ide` pasó y `git diff --check` no reportó diferencias.
- [x] **Baseline local offline**, Windows x64, Node v24.22.1, `--command check --runs 3`: 3 PASS, 0 FAIL; tiempos reales wall de 10035 ms, 9749 ms y 9923 ms. Mínimo **9749 ms**, mediana **9923 ms**, p95 observado **10035 ms**. No son métricas del IDE completo ni de proveedores IA.
- [ ] **Certificación AAA:** siguen pendientes sandbox OS efectivo, protocolo común con escritura y fencing interproceso, rollback y reanudación segura, cuotas monetarias rígidas, E2E real de ambos proveedores, build completo del IDE en Windows/Linux/macOS y auditoría de seguridad.


### Lote coordinado P0/P1: interop, fencing, aislamiento y rollback (2026-10-30; retest obligatorio)

- [x] **Interoperabilidad de lectura opt-in:** `native-engine-interop.ts` consulta `ide-status --ide-protocol 2 --nonce` sobre el runner Node del proyecto **solo tras autorización explícita**, manifiesto v2 y handshake válido. Rechaza respuestas sobredimensionadas, campos no permitidos, nonce falsificado y `executionEnabled: true`. Publicado como comando `atsHarness.nativeProjectStatus`. Este contrato necesita implementación compatible en cada proyecto; ninguna tarea externa puede ejecutarse por medio del adaptador.
- [x] **Fencing común entre rutas del IDE:** `native-shared-fence.ts` implementa creación exclusiva `wx`, propietario y token aleatorio, epoch monotónico persistido, control de identidad dev/ino y comprobaciones de integridad antes de liberar. Lo utilizan tareas `NativeHarness`, workflows `NativeAgentWorkflow` y agentes directos. La validación anidada de gates utiliza una lease prestada del workflow para evitar deadlock. El almacenamiento de coordinación está en el directorio por proyecto del IDE, no en el código fuente.
- [~] **Fencing con Harnesses externos:** el formato está preparado para participación entre procesos, pero **el motor del proyecto aún NO adopta el lock/epoch ni verifica el token antes de escribir**. Debe conservarse el bloqueo `HARNESS_HYBRID_WRITER_UNAVAILABLE`; no anunciar escritores híbridos seguros. Un proceso que ignore el protocolo puede seguir escribiendo.
- [x] **Sandbox offline Linux opcional:** gates con `sandbox: "linux-offline-readonly"` solicitan el binario fijo `bubblewrap`, deshabilitan red con `--unshare-all`, restringen el workspace a una montura read-only y eliminan variables de entorno antes del proceso. Ante plataforma, ejecutable o herramienta incompatibles, el gate falla sin caer en ejecución sin sandbox.
- [~] **Sandbox universal / agentes:** no hay backend Windows/macOS certificado, ni sandbox OS de proveedores autenticados que requieran red. El sandbox Linux agregado no sustituye pruebas de escape, políticas por syscall, ni garantías contra procesos externos no cooperativos.
- [x] **Checkpoint y rollback acotados:** `native-worktree-checkpoint.ts` toma un checkpoint solo de un Git worktree limpio y administrado; lo vincula al checkout y HEAD original mediante hashes. El workflow crea ese checkpoint bajo la lease antes del primer agente. `atsHarness.nativeWorktreeRollback` requiere confirmación destructiva y limita `git reset --hard` más `git clean -fd` al worktree validado. Un `.rollback.intent` impide reintentos automáticos tras fallos.
- [~] **Transacciones generales y recuperación:** rollback limitado a worktree *no equivale* a merge transaccional, resolución automática de conflictos, rollback del checkout principal ni reanudación fina de writers interrumpidos. Persisten estados inciertos para reparación explícita.
- [x] **Pruebas agregadas al gate local:** `native-engine-interop.test.mts`, `native-shared-fence.test.mts`, `native-cross-engine-fence.test.mts`, `native-os-sandbox.test.mts` y `native-worktree-checkpoint.test.mts` cubren rechazo de autoridad falsa, exclusión entre rutas, política de aislamiento y recuperación con consentimiento.
- [ ] **Retest de ESTE lote** en Windows: `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide`, `npm run check --prefix extensions/armotusitio-ide`, `git diff --check`. La evidencia Windows anterior (241 PASS) es de `fd6f1d98dec` y no valida estos commits.
- [ ] **Aceptación restante:** compatibilidad real del adaptador con el Harness externo, adopción de fences por ambos motores, Linux bwrap y host Windows/macOS aislados de verdad, red-team exfiltración/symlinks/TOCTOU, recovery después de crash y E2E de instaladores. Las pruebas autenticadas de Claude quedan aplazadas por decisión del usuario.

**Advertencia operacional:** ninguna implementación de este lote habilita automáticamente escritura híbrida, ejecución de comandos externos de terceros, deployments, releases o merge a `main`. El acceso a estado externo siempre ejecuta código del proyecto y no está aislado a nivel OS; requiere consentimiento informado del operador.

### Validación Windows de lote P0/P1 y reparación de higiene (2026-10-30; retest pendiente)

- [x] **Suite completa en `f369b0f384f`:** 253 tests (252 PASS, 0 FAIL, 1 SKIP). TypeScript, webview, bridge/renderer, bundle, recursos y diff whitespace en PASS. El verificador focalizado ejecutó 156 pruebas (155 PASS, 0 FAIL, 1 SKIP).
- [x] **Único gate fallido en el log recibido:** `Focused hygiene` por formato de `extensions/armotusitio-ide/src/native-harness.ts`. El contenido funcional y los tests no fallaron. Se corrigió exclusivamente la disposición del objeto de respuesta de error del sandbox con el formato TypeScript esperado en commit `7800707625224aaaf8154449349d83c3ba68544c`.
- [x] **MCP ArmoTuSitio preservado:** `extensions/armotusitio-ide/src/mcp.ts` y `extensions/armotusitio-ide/extension.ts` conservan exactamente los mismos blobs en `main` y la rama experimental. `package.json` conserva la definición del proveedor `atsIde.armotusitioMcp` y la preferencia `atsHarness.mcp.enabled`. Las pruebas existentes de handshake, autenticación, permisos y cancelación del MCP están en PASS.
- [ ] **Retest del commit corregido y este documento:** repetir `node scripts/ats-harness-check.mts`, `npm test --prefix extensions/armotusitio-ide`, `npm run check --prefix extensions/armotusitio-ide` y `git diff --check` en Windows. No atribuir resultados verdes a commits posteriores a `f369b0f384f` hasta contar con un nuevo log.
- [ ] **Warnings informativos del runtime:** los avisos `MODULE_TYPELESS_PACKAGE_JSON` y `ExperimentalWarning: stripTypeScriptTypes` no constituyeron fallos. No se cambió `package.json` a ESM porque el entrypoint de la extensión utiliza CommonJS y una migración aislada podría romper la activación y el MCP.

### Corrección de carrera de cancelación en Windows (2026-10-30; nuevo retest pendiente)

- [x] **Evidencia en `213e21246bf`:** `node scripts/ats-harness-check.mts` obtuvo los **7/7 gates en PASS** (156 tests focalizados: 155 PASS, 0 FAIL, 1 SKIP). `npm run check --prefix extensions/armotusitio-ide` y `git diff --check` finalizaron correctamente.
- [x] **Suite completa en el mismo SHA:** 253 tests; **251 PASS, 1 FAIL, 1 SKIP**. El único fallo fue `native-harness.test.mts`: `concurrent attempts cannot both obtain execution lock`, en la aserción final `assert.notEqual(status, 'passed')`. El subproceso de 2 segundos podía terminar mientras se esperaba el rechazo del segundo intento, antes de que `cancel()` se ejecutara; es una condición de carrera de la prueba bajo carga.
- [x] **Corrección en la rama:** el fixture de contención mantiene un gate activo hasta su cancelación; espera la señal real de inicio antes del segundo intento, garantiza `cancel()` y drena el subproceso también cuando una aserción falla. El motor `NativeHarness` revisa el aborto y Workspace Trust antes de persistir un `passed` terminal.
- [x] **MCP intacto:** no se modifica `mcp.ts`, `extension.ts` ni la configuración del proveedor `atsIde.armotusitioMcp`; las pruebas MCP están en PASS.
- [ ] **Pendiente:** reejecutar los controles focalizados y los 253 tests completos sobre el nuevo HEAD. No se considera verde el nuevo SHA hasta disponer de ese resultado. Los warnings de detección ESM y Node TS experimental no son fallos ni justifican cambiar la extensión CommonJS.

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

- [ ] Los tres comandos locales finalizan satisfactoriamente sobre el HEAD de trabajo final en Windows. En `213e21246bf` el focalizado y el check pasaron, pero la suite completa tuvo 1 fallo de concurrencia; corrección posterior pendiente de retest.
- [ ] Reproducir los checks en un checkout limpio del SHA final; no se exige GitHub Actions.
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
- El workflow experimental de GitHub Actions del Harness se eliminó de esta rama; la política vigente es validación local sin Actions.

## Política de integración

**No modificar `main`, no hacer merge, no desplegar ni afirmar certificación AAA** hasta completar los criterios de salida. Registrar los errores que aparezcan en la validación local y corregirlos en esta misma rama, con tests de regresión.
