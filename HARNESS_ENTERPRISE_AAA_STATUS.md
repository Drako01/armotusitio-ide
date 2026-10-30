# Harness Enterprise AAA — estado de implementación y checklist

> **Proyecto:** `Drako01/armotusitio-ide`  
> **Rama de trabajo:** `feat/native-harness-enterprise-upgrade` (creada desde `main`)  
> **Fecha de corte:** 2026-10-30  
> **Estado:** desarrollo experimental; **NO certificado para merge ni producción**.

## Resumen ejecutivo

Esta guía documenta el alcance acordado y diferencia **código agregado a la rama** de funcionalidad realmente certificada. Una casilla marcada no significa que el comportamiento haya pasado pruebas reales de extremo a extremo.

**Inventario:** 33 ítems con implementación en código, 6 parciales y 15 pendientes. Son ítems de diferente tamaño y riesgo; no equivalen a un porcentaje técnico de avance.

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
- [~] Declaración de capacidades de Harness externos: lectura de manifiestos, sin handshake ejecutable ni validación de capacidades reales.
- [ ] Unificar el motor Python y el motor nativo detrás de un protocolo ejecutable estable.
- [ ] Eliminar dependencias y convenciones heredadas de RedEvent para portabilidad plena.

### Agentes y autonomía

- [x] Ejecución local de Codex CLI y Claude Code con autorización explícita.
- [x] Roles planner, implementer y reviewer con permisos diferenciados.
- [x] Secuencia plan → implement → review y transporte acotado de handoffs.
- [x] Revisión opcional cruzada entre Codex y Claude.
- [x] Recepción de veredicto explícito del reviewer, con fallo cerrado ante respuestas ambiguas.
- [x] Un ciclo correctivo acotado y re-revisión independiente, autorizado previamente.
- [~] Grafo de dependencias: el workflow de agentes es principalmente secuencial y no constituye todavía un DAG paralelo general.
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
- [~] Defensas frente a prompt injection: algunas comprobaciones existen, sin auditoría adversarial integral.
- [ ] Sandbox OS con políticas efectivas de filesystem, proceso y red: un worktree NO es un límite de seguridad.
- [ ] Pruebas adversariales de exfiltración, symlinks, TOCTOU y escalada de permisos.

### Persistencia y recuperación

- [x] Historial durable de ejecuciones y estados de workflows.
- [x] Locks y rechazo de ejecuciones solapadas del mismo proyecto.
- [x] Cancelación de agentes, workflows y gates.
- [x] Reconciliación explícita de ejecuciones interrumpidas, sin reejecución automática.
- [x] Administración y retiro de worktrees limpios, conservando los modificados.
- [~] Recuperación: detección/registro de estados interrumpidos, sin replay seguro por etapa.
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
- [~] Compatibilidad CLI: diagnóstico de versión, sin negociación completa de flags ni autenticación verificada.
- [ ] Topes monetarios rígidos por proveedor/proyecto y tratamiento de cuotas/rate limiting.
- [ ] Benchmarks cold/warm reales: CPU, RAM, latencia, éxito, tokens, costos y comparación secuencial/paralela.
- [ ] Scheduler adaptativo basado en telemetría de carga y capacidad.

### IDE, observabilidad y calidad

- [x] Comandos para ejecutar agentes, workflows, consultar historial y reconciliar.
- [x] Panel con resumen de estado, métricas de agentes y gates.
- [x] Diagnóstico local de instalaciones Codex/Claude sin invocar modelos.
- [x] Pruebas unitarias y de integración con proveedores simulados incorporadas.
- [x] Definición de workflow CI para Windows, Linux y macOS.
- [~] Observabilidad: datos resumidos disponibles, no tracing distribuido/streaming completo.
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

**Atención al actualizar el checkout:** `node scripts/ats-harness-check.mts --fix` pudo dejar cambios locales en siete archivos. Antes de `git pull --ff-only`, inspeccionar `git status --short`; no descartar modificaciones ajenas ni forzar la rama. Si solo existen diferencias de formato conocidas, guardarlas con `git stash push -m "formatter-local-20261030" -- <rutas>` antes de actualizar, o copiarlas para revisión.

### Cierre de validación local Windows (2026-10-30, 16:06–16:07)

- **Evidencia:** validación local adjunta tras aplicar `harness-local-formatting` sobre `7904850d6b6`: `node scripts/ats-harness-check.mts` **PASS** en las siete etapas, incluido `Focused hygiene`; `npm test --prefix extensions/armotusitio-ide`: **160 PASS, 0 FAIL, 7 SKIP**; `npm run check --prefix extensions/armotusitio-ide`: **PASS**. `git diff --check` sin observaciones.
- **Publicación:** commit `10aa50a1296` (`style(harness): finalize native enterprise formatting`) subido a `feat/native-harness-enterprise-upgrade`, con precommit Husky e higiene de los cinco archivos **PASS**.
- [x] **Incidente de formato e higiene: cerrado en validación local Windows**. Sin errores en la batería ejecutada. Este cierre reemplaza los pendientes de las validaciones del 30/10 anteriores, pero no demuestra una validación CI multiplataforma.
- [ ] **Pendiente para certificación enterprise:** confirmar CI Linux/macOS/Windows, los 7 casos omitidos (según su compatibilidad de plataforma) y pruebas E2E con proveedores reales, incluida autorización, cancelación, límites, recuperación y aislamiento.
- **Notas no bloqueantes:** warnings de `MODULE_TYPELESS_PACKAGE_JSON`, `stripTypeScriptTypes` experimental y configuración npm antigua; no se consideran fallas de las pruebas realizadas.

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

- [ ] Todos los comandos anteriores finalizan con código de salida cero.
- [ ] El workflow CI aparece como **successful** para el último commit de la rama.
- [ ] Build del IDE y empaquetado de extensión completados sin regresiones.
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
