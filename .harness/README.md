# RedEvent Local Harness

Fuente local y autosuficiente de orquestación para Codex y Claude Code. **El host es orquestador: no implementa código
de producto directamente.** La implementación, revisión, auditoría y verificación se delegan como responsabilidades
separadas.

> **¿Primera vez?** Empezá por [INSTRUCTIONS.md](INSTRUCTIONS.md): guía paso a paso de uso diario, recuperación de
> fallas y solución de problemas. Este README es la referencia técnica del diseño.

## Árbol y persistencia

- `manifests/`: dominios, agentes y schemas versionados (`agents.schema.json`, `domains.schema.json`,
  `agent-result.schema.json`, `handoff.schema.json`, `task.schema.json`).
- `agents/`: contratos humanos de agentes, generados desde `manifests/agents.json` (`pnpm harness:agents-doc`);
  `harness:check` falla si están desactualizados.
- `core/` y `cli.py`: motor Python stdlib de configuración, contexto, routing, adapters, lifecycle, scope y
  verificación.
- `lib/`: bootstrap/provisioning Node y shims de compatibilidad RPC hacia Python; `core.mts` conserva la entrada
  anterior.
- `tests/python/`: contratos del core con `unittest`; tests Node conservan bootstrap, transporte y equivalencia de
  comandos.
- `hooks/`: guardia de Claude Code que impide al host escribir código de producto (ver "Guardia del orquestador").
- `context/`: contexto progresivo; nunca dumps indiscriminados del repositorio.
- `tasks/inbox/ → active/ → completed|failed/`: máquina de estados persistente.
- `handoffs/`: transferencias estructuradas entre agentes.
- `state/`: checkpoint mínimo para reanudar en otra sesión o cambiar Codex ↔ Claude.
- `logs/execution|errors|audit|completed/`: trazabilidad del lifecycle.
- `runtime/`: especialistas temporales y artefactos efímeros.

## Lifecycle ejecutable

INGEST → infer/decompose domain → context-manager → specialists → reviewer → security-auditor cuando corresponde →
verifier → logger → completed.

Cada `execute` toma un workspace lock exclusivo (un solo proceso por checkout). Dentro de él, los nodos listos se ejecutan
en orden determinista y de a uno cuando el DAG es una cadena (el plan histórico) o con `HARNESS_MAX_WORKERS=1`; cuando el
plan contiene unidades independientes y hay Git, el [scheduler paralelo](#ejecución-paralela-y-aislamiento) ejecuta las
ramas independientes a la vez, cada una en su propio worktree. Los children multi-dominio independientes se agrupan en olas
y también pueden correr a la vez; los gates finales se repiten siempre sobre el estado combinado. Si reviewer,
security-auditor o verifier fallan, el Harness reactiva implementers y downstream gates hasta `HARNESS_MAX_RETRIES`
(default 2). Un bloqueo sin host configurado queda explícito; un fallo agotado termina en `failed/`.

## Violaciones de scope (latch persistente)

Antes de cada agente de escritura o lectura el Harness guarda una huella (`snapshot`) de todo el árbol: archivos
versionados, no versionados, **ignorados por git** (`.env`, `secrets/`, notas locales; sólo se exceptúan directorios de
artefactos como `dist`, `build`, `.next`, `.turbo`, `coverage`, `.cache` y `.artifacts`) y el estado operacional de
`.harness/`. Al terminar compara. Toda diferencia fuera del scope, cualquier cambio de un agente de sólo lectura,
cualquier toque al estado operacional (`tasks`, `state`, `handoffs`, `logs`) o cualquier escritura que el resultado no
declare es una **violación de scope**. Excepciones: los artefactos de build de TypeScript que **ignora git** y coinciden con
un patrón `*.tsbuildinfo` de `manifests/policies.json` → `generatedArtifacts` (los reescribe cada gate de typecheck/build,
p. ej. `apps/provider-portal/tsconfig.tsbuildinfo`) quedan fuera de la huella; un generado versionado como
`next-env.d.ts` o cualquier otro ignorado no listado (`.env`) sigue contando como escritura. Y los artefactos efímeros que el propio Harness escribe al correr
sus gates (`.harness/runtime/context-index.json`, `.harness/runtime/verify-last.json` y su temporal de escritura atómica `verify-last.json.<hex>.tmp`, `.harness/runtime/output/**`, `.harness/runtime/change-refs/*.json` y `.harness/runtime/progress/<task-id>.json` con su temporal `.<hex>.tmp`) no cuentan como escrituras del agente.

Una violación no se "limpia" abriendo otro intento. Se guarda en la tarea como `scopeViolation` (agente, intento, motivo
y la huella previa de cada archivo afectado) y se audita en `logs/audit/`:

- La tarea termina en `failed/` y `execute` no vuelve a lanzar agentes sobre ella.
- `harness:retry` sólo funciona cuando el workspace volvió **exactamente** al estado previo al intento: un archivo nuevo
  debe borrarse; uno que ya tenía cambios sin commitear debe recuperar ese mismo contenido (no basta volver a
  `HEAD`/index).
- Si la violación tocó estado operacional protegido, no hay recuperación automática: se repara a mano y se crea una
  tarea nueva.
- En un multi, `retry` verifica todos los hijos antes de reabrir cualquiera; nunca deja hijos reabiertos a medias.
- Las huellas de archivos ignorados por git se guardan selladas con HMAC y una sal local (`runtime/fingerprint.salt`, no
  versionada): aunque sea local, el estado operacional puede copiarse o adjuntarse, y un hash simple de un secreto corto
  se podría adivinar. Sin la sal (otra máquina) esos archivos no se pueden verificar y `retry` falla cerrado.
- El Harness nunca restaura ni borra archivos por su cuenta. Los handoffs y auditorías del incidente se conservan.
- Si el proceso muere con un agente corriendo, el baseline se persiste en `runtime/<task>-<agente>-<n>-baseline.json`;
  el siguiente `execute` lo verifica y, si encuentra una escritura ilegal, registra la violación en vez de adoptarla
  como baseline. El trabajo parcial legal se conserva.
- Una tarea no puede pasar a `completed` mientras tenga `scopeViolation`; `harness:check` lo rechaza.
- Los fallos que no violan scope (exit distinto de cero, resultado inválido, gate fallido) conservan los reintentos
  normales de `HARNESS_MAX_RETRIES`.

## Preflight obligatorio, workers automáticos y aprendizaje

El Harness es una herramienta para entregar rápido, no una cadena fija. Antes de crear una tarea:

1. `pnpm harness:preflight -- <dominio|auto> --file <spec>` (no persiste tareas; escribe un recibo en
   `.harness/state/preflight/`). Devuelve `mode`, `ready`, `recommendedWorkers`, `workerRationale`, `plan`, `questions`,
   `warnings` y `lessons`. `mode: direct` significa que la tarea es chica (spec corta, sin `unit:`, plan de una cadena):
   se hace directo, sin la cadena tester→reviewer→security→verifier. Si hay `questions`, el host se las hace al usuario
   y repite con `--answers id=respuesta,...`. `--fix` limpia worktrees huérfanos.
2. `pnpm harness:run` exige un recibo `ready` de menos de 60 minutos para tareas no triviales (omitible con
   `--no-preflight` o `HARNESS_PREFLIGHT=off`, bajo responsabilidad del operador).
3. **Workers automáticos:** sin `HARNESS_MAX_WORKERS`, `execute` dimensiona el pool con el ancho del plan
   (`min(ancho, parallel.autoMaxWorkers)`) y sube `HARNESS_HOST_LIMIT`/`HARNESS_ROLE_LIMITS` si no están definidos. Un solo
   nodo delegado o sin independencia demostrable usa 1 worker. Las variables explícitas siempre mandan. Queda registrado
   en `metrics.workerSizing` (`effective`, `source`, `cleanedWorktrees`).
4. **Sin repetir lo que ya está bien:** un gate autoritativo que ya pasó sobre el mismo HEAD y contenido cambiado se
   reutiliza 6 h (`state/gate-cache.json`); un fallo con firma de `policies.json` `flakyPatterns` se reintenta una vez
   (`retriedFlaky`). `HARNESS_GATE_CACHE=0` lo desactiva.
5. **Limpieza automática:** `execute` elimina worktrees huérfanos (tareas muertas, abortadas o sin lock vivo) antes de
   correr, sin tocar tareas vivas.
6. **Lecciones:** `.harness/lessons/lessons.json` es el catálogo versionado; cada fallo o reintento se registra en
   `.harness/state/lessons-observed.json` (local) y hasta 5 lecciones relevantes por dominio/agente se inyectan en el
   prompt de cada especialista. `pnpm harness:lessons` lista; `pnpm harness:lessons -- add "<título>" "<consejo>"` agrega.
   El id se genera como `<owner>_<timestamp UTC YYYYMMDDHHMMSS>`, con `owner` tomado de `HARNESS_OWNER` (si falta,
   `HARNESS_HOST`; si falta también, `dev`) en minúsculas: cada dev agrega lecciones sin pisar ids de otro.
7. **Pruebas aisladas:** `harness:test` y `HARNESS_IGNORE_ENV_FILE=1` no leen `.harness/.env`.

Los agentes delegados no pueden escribir en `.harness/core/**` ni `.harness/tests/**`: esos cambios los hace el host.

## Optimización integral (verificación incremental, riesgo, checkpoints, flaky, métricas, limpieza)

- **Verificación incremental por defecto** (`pnpm harness:verify`): calcula los gates alcanzados por el diff (dependencias
  transitivas incluidas) y reporta el resto como `SKIPPED_NOT_IMPACTED`, nunca como `PASS`. Escala a verificación completa en
  cambios transversales (workflows, `.harness/**`, infra, migraciones, openapi, auth/RBAC/tenancy, config del workspace) y
  **falla cerrado** (verificación amplia) si el análisis es ambiguo o falla. `--full` sigue disponible.
- **Pipeline proporcional al riesgo** (`core/risk.py`, `policies.json riskPipeline.apply=true`): LOW = implementador + gates
  afectados; MEDIUM = + reviewer; HIGH = + security-auditor y verificaciones obligatorias. Las áreas sensibles
  (auth, RBAC, tenancy, migraciones, secrets, infra) siempre incluyen security-auditor y una clasificación que falla es HIGH.
- **Gates paralelos** (`core/gatedag.py`): DAG de gates, los independientes corren a la vez (`HARNESS_GATE_CONCURRENCY`);
  los que comparten un recurso mutable (node_modules, base, puerto, directorio de salida) se serializan salvo aislamiento.
- **Caché de gates** (`core/gatecache.py`): clave por contenido, versiones de herramientas, entorno permitido y manifiestos;
  solo guarda PASS, con TTL y tamaño acotado. Interfaz `GateCache` con `RemoteCache` opcional (`HARNESS_GATE_CACHE_REMOTE`).
- **Caché Redis local opcional** (`pnpm harness:cache [status|up|down|clear]`): como el Harness corre en tu PC, el servicio
  `redis` de `redevent-local` (`infra/docker/compose.api.yml`, `redis:8-alpine`, solo `127.0.0.1:56379`, sin persistencia,
  256 MB con `allkeys-lru`) guarda resultados de gates entre worktrees y terminales. `harness:cache up` crea el contenedor si
  no existe y lo reutiliza si existe. Si Redis responde se usa detrás de la caché de archivo; si no, el Harness sigue solo con
  la local (un Redis caído cuesta un fallo de caché, nunca un error). Solo guarda PASS, con TTL y hash de integridad verificado
  al leer. Variables: `HARNESS_REDIS_URL` (solo hosts locales) y `HARNESS_REDIS=0` para ignorarlo.
- **Cuarentena de flaky** (`pnpm harness:flaky`): registro por test (tasa de fallos, reintentos, último fallo, dueño y
  vencimiento). Los tests críticos (seguridad, auth, RBAC, tenant, migraciones, integridad) **nunca** se ponen en cuarentena.
  Los de cuarentena se reportan aparte y se rehabilitan solos con evidencia.
- **Reanudación granular** (`pnpm harness:resume <id> [--dry-run] [--reconcile <unidad>]`): checkpoint por unidad
  implementadora; se reutiliza lo válido y solo se rehace lo fallido, interrumpido o con entradas cambiadas. Las unidades con
  efectos externos exigen `--reconcile`.
- **Preflight inteligente** (`pnpm harness:preflight -- --checks-only [--needs db,go]`): herramientas y versiones, DB e2e
  aislada, numeración de migraciones, puertos, disco, proveedor de agentes. Una tarea solo de docs no pide DB ni Docker.
- **Estimación** (`pnpm harness:estimate <dominio> <tarea>`): tiempo, fases, workers, gates, riesgo y confianza con historial
  local; advierte desproporción sin quitar verificaciones obligatorias.
- **Métricas** (`pnpm harness:telemetry [--trend] [--bottlenecks]`): duración por tarea/worker/gate, caché, reintentos,
  reanudaciones, fallos por categoría y tiempo ahorrado, sin secretos ni prompts.
- **Limpieza automática** (`core/retention.py`): al completarse una tarea se borran logs, resultados, semillas, specs,
  handoffs y worktrees y queda un manifiesto mínimo en `.harness/state/manifests/<id>.json`. Las fallidas conservan evidencia
  7 días (`HARNESS_RETENTION_DAYS`); `pnpm harness:hygiene -- --apply-retention` limpia lo vencido y `--retention-report` lo
  lista. `HARNESS_KEEP_ARTIFACTS=1` la desactiva. Solo toca rutas administradas por el Harness.

## Ejecución paralela y aislamiento

El principio es **maximizar el paralelismo útil, no la cantidad de agentes**: una tarea sólo se reparte cuando hay
unidades de trabajo demostrablemente independientes y el beneficio estimado supera el costo de coordinarlas. Todo lo
anterior (cadena de nodos, handoffs, violaciones de scope, gates) sigue vigente; el paralelismo es una capa por encima.

### Identidad: nodo, agente, ejecución

- **Nodo** (`node.id`): clave única y segura para el sistema de archivos dentro de la tarea (`[A-Za-z0-9_-]+`).
- **Agente** (`node.agent`): el contrato de `manifests/agents.json` que ejecuta el nodo. Varias instancias de un mismo
  rol son nodos distintos (`documentation-a`, `documentation-b`). Un nodo con `id != agent` debe declarar `unit`.
- **Ejecución** (`node.runId`, `node.claim`): cada intento recibe un `runId` propio (también en el handoff) y el
  scheduler un `claim` que autoriza a ese intento a escribir estado. Una ejecución cancelada o reencolada cambia el claim:
  su resultado tardío se descarta y queda en `logs/audit` como `late-result-discarded`.
- Los handoffs, baselines y resultados se nombran por **nodo**: `<task>-<node>-<intento>.json`. En tareas históricas
  `node == agent`, así que los nombres no cambian y el handoff sólo agrega `node` cuando difiere.

### Planner

`core/planner.py` (stdlib, determinista, sin red) decide el DAG al crear la tarea. Tres fuentes, visibles en `task.plan`:

- `legacy`: la cadena histórica. Es la salida para tareas pequeñas (riesgo LOW), `HARNESS_PLANNER=off` y cuando nada
  prueba independencia. Estas tareas son idénticas byte a byte a las de antes (sin campo `plan`).
- `directive`: el operador escribe líneas `unit:` en la tarea (o en el archivo de `--file`):

  ```text
  unit: orgs  | agent=backend | owns=apps/api/internal/orgs/** | weight=3
  unit: perms | agent=backend | owns=apps/api/internal/perms/** | weight=2 | after=orgs
  unit: docs  | agent=documentation | owns=docs/api/** | reads=apps/api/** | effects=none
  ```

  Atributos: `agent` (default: el agente del dominio), `owns` (obligatorio: globs de ownership exclusivo), `reads`,
  `after` (dependencias entre unidades), `effects=none|external`, `weight` (estimación relativa, default 1) y
  `timeoutMs` (sólo puede **acortar** el timeout global). Un atributo desconocido, un agente inexistente o de sólo
  lectura, un `owns` fuera del dominio, un ciclo, un id duplicado o más de `maxNodes/2` unidades fallan cerrado.

- `auto`: viñetas (`- Crear \`ruta/\`...`) que mutan rutas en directorios disjuntos del dominio se proponen como
  unidades. Una sola viñeta, viñetas que se pisan, o que sólo consumen archivos existentes, no generan agentes extra.

El planner además: serializa con una arista (y lo deja en `plan.notes`) toda pareja de unidades con ownership solapado o
con `effects=external`; clasifica lecturas (reviewer, security-auditor), escrituras (`kind: write`) y efectos externos
(`kind: external`); estima `sequentialMs`, `parallelMs`, `criticalPathMs` y `speedup` desde los pesos declarados más
`coordinationOverheadMs` por worker adicional, y **declina el paralelismo** (`plan.parallel: false`, las unidades quedan
en cadena) si el speedup estimado es menor que `HARNESS_MIN_SPEEDUP` (default 1.2) o no hay unidades independientes.
`pnpm harness:plan -- <dominio|auto> <tarea>|--file f` muestra el plan sin persistir nada.

### Scheduler

`core/scheduler.py` corre cuando `HARNESS_MAX_WORKERS > 1`, hay un checkout Git y el DAG tiene al menos dos nodos
delegados sin orden entre sí. Si no, se usa el ejecutor secuencial de siempre (fallback explícito).

- **Dependencias**: un nodo sale a ejecución cuando todas sus dependencias están `passed`. Entre los listos se prioriza el
  de mayor camino crítico restante (peso de la cadena que depende de él), con desempate por orden de declaración.
- **Admisión** (`core/budget.py`, un solo presupuesto por proceso, también entre children): máximo de workers activos
  (`HARNESS_MAX_WORKERS`), tope por rol (`HARNESS_ROLE_LIMITS`) y tope por host (`HARNESS_HOST_LIMIT`), más exclusión por
  recurso: nunca dos nodos con ownership solapado, ni dos con efectos externos. Los nodos deterministas
  (context-manager, verifier, logger) corren siempre solos.
- **Backpressure**: un nodo que no cabe espera en cola (`queueMs` por nodo). Un fallo `host-unavailable` o `timeout` baja un
  worker (nunca por debajo de 1) y queda en `logs/audit` como `backpressure`.
- **Timeouts y cancelación**: `HARNESS_AGENT_TIMEOUT_MS` aplica por nodo (y `timeoutMs` del plan lo acorta);
  `HARNESS_TASK_TIMEOUT_MS` (default 0 = sin límite) acota toda la ejecución. La cancelación mata el **árbol completo**: el
  grupo de procesos y, en POSIX, los descendientes que hayan abierto otra sesión; en Windows un Job Object con
  kill-on-close.
- **Fallos**: el nodo fallido se reintenta solo (hasta `HARNESS_MAX_RETRIES`, con un worktree nuevo); los hermanos
  independientes terminan su trabajo; los dependientes quedan `blocked`; la tarea nunca queda `completed` con un nodo no
  `passed`. Exit code 0 del CLI no marca nada como hecho: manda el resultado estructurado validado, el scope y la integración.
- **Lazo correctivo selectivo**: si reviewer/security-auditor/verifier fallan y sus hallazgos citan rutas, sólo se
  reabren los writers cuyo `owns` cubre esas rutas (más sus dependientes y los gates posteriores); sin rutas atribuibles se
  reabren todos, como en el ejecutor secuencial.
- **Nodo solitario**: un nodo que es el único listo mientras nada corre no puede solaparse con otro (la disponibilidad
  sólo cambia al completarse algo), así que corre en el checkout principal con el protocolo secuencial clásico y no paga
  el costo de un worktree. Dentro de una ola de children no se aplica este atajo.

### Worktrees e integración

Los nodos concurrentes nunca escriben en el checkout principal:

1. `core/worktree.py` crea un worktree **detached** en `HARNESS_WORKTREE_DIR` (default: carpeta temporal del sistema, fuera
   del repo, con ruta corta para Windows) en `HEAD`, y le replica el estado sin commitear del checkout (modificados,
   borrados, no versionados). Registra `runtime/worktrees/<nombre>.json` (pid, huella del proceso, base de cada archivo).
2. El agente corre con `cwd` en su worktree; los snapshots y la verificación de scope (`owns` ∩ agente ∩ dominio, rutas
   prohibidas, escrituras no declaradas, estado operacional) se calculan **dentro del worktree**, así que un nodo no puede
   ver ni ser culpado por las escrituras de otro. Una violación ocurre en un entorno desechable: queda como
   `scopeViolation` con `contained: true` (nada que restaurar) y el worktree se conserva.
3. Con el resultado validado, `integrate()` aplica los archivos declarados al checkout principal **todo o nada** bajo un
   lock, y sólo si el contenido actual coincide con la base del worktree (o ya es el nuevo: idempotente). Si no, es un
   **conflicto explícito**: no se aplica ningún archivo, no se pisa nada, el nodo falla con `integration-conflict`, se
   reintenta sobre el estado actualizado y el worktree queda como evidencia. Antes se escribe `runtime/integration/<run>.patch`
   y un journal (`applying` → `applied`/`conflict`). Orden determinista: el ownership exclusivo garantiza que los nodos
   concurrentes tocan archivos disjuntos, de modo que el resultado no depende del orden de término.
4. **Guardia de ventana**: mientras corren nodos concurrentes se compara el checkout principal antes/después; cualquier
   cambio que no sea una integración (p. ej. un agente que escribe por ruta absoluta al checkout) es una violación de scope
   y se detiene la tarea. Los gates del `verifier` corren después sobre el resultado **ya integrado**, bajo el lock de
   integración.
5. Tras `passed` el worktree se elimina (el patch y el journal quedan); si la tarea termina `completed` se limpian los
   restantes. Los de intentos fallidos/cancelados/abandonados se conservan; `pnpm harness:hygiene` los informa y
   `pnpm harness:hygiene -- --prune-worktrees --yes` elimina los de tareas completadas o abortadas.

Claude y Codex reciben el mismo contrato que en modo secuencial, ejecutado desde el worktree: Codex escribe su resultado
en `<worktree>/.harness/runtime/` (`--output-last-message`); Claude lee handoffs y source por ruta absoluta del checkout
principal (`--add-dir` sólo cuando el nodo está aislado) y sigue sin recibir nunca la ruta del archivo de resultado.
`usage` del sobre de Claude se agrega a las métricas; Codex no informa uso y se reporta como `not reported by host`.

### Persistencia y recuperación

- `write_json` de tareas, handoffs y journals es atómico (temporal + `os.replace`) y duradero (`fsync`).
- Los workers persisten a través del scheduler, que fusiona **sólo su propio nodo** y **sólo si el claim sigue vigente**.
- **Ctrl+C / SIGTERM**: se cancela el árbol de procesos de cada worker, los nodos vuelven a `pending` con `interrupted`
  (los intentos quedan contados), los worktrees quedan como evidencia y la tarea sigue `active` y reanudable.
- **Cierre brusco / kill -9**: el siguiente `execute` retoma las integraciones a medias (si el checkout aún coincide con el
  plan las completa; si no, aborta con `inconsistent` sin forzar), marca los worktrees huérfanos como `abandoned` (sin
  borrarlos), termina los agentes huérfanos **sólo si** pid, host, plataforma y huella de proceso coinciden (no se mata
  un pid reutilizado), y reejecuta los nodos interrumpidos. Queda `recovered-abandoned-runs` en `logs/audit`.
- Evidencias anteriores: los nodos históricos no cambian de forma; `verify_interrupted` sigue gobernando los nodos no
  aislados (baseline en el checkout) y los nodos aislados no necesitan baseline (nada tocó el checkout).

### Métricas

`task.metrics` (y `pnpm harness:metrics -- <task-id>`): `mode`, `workers`, `peakConcurrency`, `durationMs`,
`sequentialMs` (suma de tiempos de pared de los nodos), `criticalPathMs`, `speedup`, `queueMs`, `integrationMs`,
`retries`, `conflicts`, `throttled`, `planMs`, tokens agregados (o `not reported by host`) y el detalle por nodo
(`queueMs`, `activeMs`, `wallMs`, `integrationMs`, `attempts`). El ejecutor secuencial también las escribe (`speedup 1`).

### Configuración

| Variable                      | Default                            | Significado                                    |
| ----------------------------- | ---------------------------------- | ---------------------------------------------- |
| `HARNESS_MAX_WORKERS` (1..16) | auto (del plan, tope 8)            | Workers activos; `1` = ejecutor secuencial     |
| `HARNESS_PARALLEL`            | 1                                  | `0` desactiva el paralelismo sin tocar el plan |
| `HARNESS_ROLE_LIMITS`         | 2 por rol                          | `rol=N,rol=N`: tope por rol                    |
| `HARNESS_HOST_LIMIT` (1..16)  | 2                                  | Tope por host (`codex`, `claude`, `custom`)    |
| `HARNESS_PLANNER`             | `auto`                             | `auto`, `directive` (sólo `unit:`) u `off`     |
| `HARNESS_MIN_SPEEDUP`         | 1.2                                | Speedup estimado mínimo para repartir          |
| `HARNESS_WORKTREE_DIR`        | `<tmp>/redevent-harness-wt-<hash>` | Ruta **absoluta** de los worktrees             |
| `HARNESS_TASK_TIMEOUT_MS`     | 0 (sin límite)                     | Tope de pared de toda la ejecución             |

Los límites base (`maxNodes`, `minUnitMs`, `coordinationOverheadMs`, `cancelGraceMs`) están en `manifests/policies.json`
→ `parallel`. Valores inválidos fallan antes de tomar cualquier lock.

### Benchmark reproducible

`pnpm harness:bench [-- --units N --ms M --workers 2,4 --json --out f.json --assert]` ejecuta escenarios `independent`,
`diamond` y `chain` con un host **simulado** (`tests/fixtures/sim-agent.cts`: sin tokens, sin red), primero con
`HARNESS_MAX_WORKERS=1` y luego en paralelo, y mide tiempo de pared externo y la fase de writers. `--assert` (usado por
`verify-enterprise.sh`) falla si el paralelismo no rinde donde debe o cuesta demasiado donde no puede.
`verify-enterprise.sh` lo invoca con `--ms 4000` para que el overhead fijo por unidad de hosts Windows/lentos no domine
la medición; los umbrales no cambian.

### Límites conocidos

- Los worktrees no comparten `node_modules` ni archivos ignorados por Git (`.env`): un agente que necesite dependencias
  instaladas no puede correr sus tests dentro del worktree; los gates autoritativos corren siempre en el checkout
  integrado. Un host que exija dependencias locales debe correr en modo secuencial (`HARNESS_MAX_WORKERS=1`).
- La guardia de ventana detecta escrituras al checkout principal, no lecturas; Claude con `Bash` no tiene sandbox de
  filesystem (como antes). El estado operacional del checkout principal sigue protegido por la guardia del orquestador y
  los snapshots de nodos solitarios.
- Un proceso que se desvincula por completo del árbol (doble fork reparentado a init) puede sobrevivir a la cancelación
  en POSIX; en Windows el Job Object lo cubre. Por eso el orquestador termina huérfanos sólo con huella verificable.
- La identificación de huérfanos tras un cierre brusco está implementada para Linux (`/proc`) y macOS (`ps`); en
  Windows el Job Object con kill-on-close termina el árbol junto con el scheduler.

## Comandos

```bash
pnpm harness:check
pnpm harness:doctor
pnpm harness:index
pnpm harness:changes
pnpm harness:ci-gaps
pnpm harness:ci-gaps -- --strict --json
pnpm harness:hygiene
pnpm harness:hygiene -- --json --stale-days 14
pnpm harness:hygiene -- --quarantine-invalid --yes
pnpm harness:context -- api
pnpm harness:tokens -- --domain api
pnpm harness:run -- api "tarea pequeña"
pnpm harness:run -- auto "tarea que puede abarcar varios dominios"
pnpm harness:run -- auto --file "backoffice(1).txt"
node .harness/bootstrap.mts source <task-id> 0 4000
node .harness/bootstrap.mts path-check repo architect package.json
pnpm harness:execute -- <task-id>
pnpm harness:status -- <task-id>
pnpm harness:list
pnpm harness:progress
pnpm harness:progress -- <task-id> --watch
pnpm harness:plan -- auto --file spec.md
pnpm harness:metrics -- <task-id>
pnpm harness:bench
pnpm harness:bench -- --assert
pnpm harness:hygiene -- --prune-worktrees --yes
pnpm harness:abort -- <task-id> "motivo"
pnpm harness:retry -- <task-id> "cuota/auth restaurada"
pnpm harness:agents-doc
pnpm harness:dispatch
pnpm harness:test
pnpm harness:smoke-host -- codex
pnpm harness:smoke-host -- claude
pnpm harness:verify -- api
pnpm harness:verify -- --full
pnpm harness:verify -- --plan
pnpm harness:verify -- --plan --explain
pnpm harness:verify -- --keep-going
pnpm harness:verify -- --fast
pnpm harness:verify -- --base origin/qa
pnpm harness:report
pnpm harness:run -- pnpm agent-config:check
```

`harness:run <domain|auto> <task>` persiste el plan; `harness:execute` ejecuta el DAG. Con un ejecutable permitido,
`harness:run <command> [args]` ejecuta el runner limitado y muestra exit, duración, tail y referencia del log
sanitizado.
`dispatch` consume `.md/.txt` de inbox y admite `domain: api|backoffice|n8n|infra|docs|repo|auto`.

## Paridad CI ↔ Harness

`pnpm harness:ci-gaps [--strict] [--json]` (módulo `core/cigaps.py`, sólo stdlib, sin parser YAML externo) compara
`.github/workflows/*.yml` con el Harness en ambos sentidos y muestra una fila por elemento con su clasificación y el
workflow/job (`ci.yml:packages`). Lee `run:` simples y bloques `run: |`/`>`, con continuaciones `\`, `&&`, `;`, `|`,
prefijos `VAR=x`, comillas, `cd`, redirecciones y bucles `for` con `dirname` (descubrimiento dinámico de `packages/*`).
`./x.sh` y `bash x.sh` son comandos de verificación (`./x.sh` se normaliza a `bash ./x.sh`).

Un step de CI **cubre** sólo si puede fallar el workflow. Se clasifican `soft` (nunca cubren) los steps con
`continue-on-error: true`, con un comando seguido de `|| true`/`|| :` (todo el statement) o con un `if:` literalmente
falso (`false`, `${{ false }}`, `'false'`); los guards `if: steps.<id>.outputs.present == 'true'` siguen cubriendo.
Si el workflow tiene un job `required`, el job que cubre debe estar en su `needs` (transitivo); si no, la fila
`harness->ci` queda `not-required`.

- **CI → Harness** (`ci->harness`): `domain-gate` (igual a un gate de un dominio habilitado), `targeted` (forma de check
  del grafo de `core/impact.py`), `ci-only` (excepción documentada), `ignored` (setup documentado) o `uncovered`.
- **Harness → CI** (`harness->ci`): cada script estándar (`lint`, `typecheck`, `test`, `test:critical`, `build`) de cada
  workspace JS, cada gate de dominio habilitado y cada app `apps/<x>/` de un dominio habilitado deben ejecutarse en CI
  (`covered`), figurar en `localOnly` (`local-only`) o quedan `uncovered` (`not-required` si sólo los ejecuta un job que
  `required` no espera).
- `--strict` sale con exit 1 si hay filas `uncovered` o `not-required` en cualquier sentido; sin `--strict` siempre informa y sale 0.
  `--json` emite `{rows, summary}` (`summary.uncovered` y `summary.notRequired`).

Las excepciones viven sólo en `manifests/ci-parity.json` (`ignored`, `ciOnly`, `localOnly`; cada entrada con `match` y
`reason` obligatorios, `withFlag` opcional) y su schema `ci-parity.schema.json` lo valida `harness:check`. `match` es un
prefijo de tokens (con `*` por token) del comando normalizado: `pnpm --filter ./D S`/`--dir D S` → `pnpm @D S`,
`node .harness/core.mts X`/`pnpm harness:X` → `harness X`, Go en `working-directory` → `go -C <dir> ...`, `uses owner/action`.
No hay excepciones implícitas en el código: un comando nuevo de CI sin gate, check ni entrada queda `uncovered`.
Las excepciones son acotadas a propósito: `ignored: node -e const*require*process.exit*scripts*` cubre sólo la sonda que lee
`scripts` de un `package.json` (cualquier otro `node -e` es un comando de verificación); el `ciOnly` de `go test` se limita
a `-run=TestSMTP*` y a los E2E de PostgreSQL por nombre; y `localOnly` lista cada modo de `verify-enterprise.sh`
(`--quick`, `--security`, `--full`) por separado. El `ciOnly: node scripts/check-pr-card-refs.mjs` cubre por adelantado
el futuro job `pr-card-refs` (`PR / Card references`) de `ci.yml`: ese script sólo tiene sentido con las variables
`PR_TITLE`/`PR_BODY`/`PR_HEAD_REF`/`PR_BASE_REF` del evento `pull_request` real de GitHub, que no existen fuera de CI;
la lógica pura ya corre en local vía `node --test scripts/check-pr-card-refs.test.mjs` dentro de `verify-enterprise.sh`,
así que `pnpm harness:ci-gaps -- --strict` no lo marcará `uncovered` cuando ese job exista.
El propio `pnpm harness:ci-gaps -- --strict` es gate declarado de los dominios `repo` e `infra` (el job `agent-config` de
`ci.yml` lo ejecuta), sin excepción `ciOnly`/`ignored`.
La integración en `ci.yml` (job `agent-config`) y en `verify-enterprise.sh` ya está hecha. Un step sólo cuenta como cobertura
si puede fallar el job: son `soft` `continue-on-error`, un `if:` literalmente falso, cualquier alternativa `||` que no propague el fallo
(`cmd || exit 1`, `cmd || exit $?` y `cmd || false` son duros, igual que `if ! cmd; then exit 1; fi`), las
condiciones de `if`/`while`, `!`, lo ejecutado tras `set +e` y el lado izquierdo de un pipe sin `shell: bash` ni
`set -o pipefail`. Un job sólo es requerido si está en `needs` de `required` y ese job lee `needs.<job>.result`; el detalle de `not-required` distingue "no está en `needs`" de "su `needs.<job>.result` no se evalúa".

## Progreso en vivo

`pnpm harness:progress [<task-id>] [--watch] [--interval N] [--json]` (módulo `core/progress.py`, sólo stdlib) responde
«¿qué está haciendo el Harness?» mientras `harness:execute` corre. Sin id toma la tarea `active` con lock vivo
(`state/<id>.lock` con PID vivo) o, si no hay, la `active` más reciente; un multi se prefiere a sus children.

- **Vista**: encabezado (id, dominio, título corto tomado de la primera línea de la fuente, barra, porcentaje, pasos
  completos/total, tiempo transcurrido), una línea por nodo del DAG (`✔` passed, `⟳` running, `✖` failed, `⏸` blocked,
  `·` pending) con duración o tiempo corriendo e intento actual/máximo (`HARNESS_MAX_RETRIES + 1`), el último evento
  (handoff o gate) y la causa resumida de un fallo/bloqueo/aborto/violación de scope. En un multi: progreso agregado,
  una sección por child y el paso de gates finales (`gates k/n`).
- **Porcentaje**: cada nodo pesa 1; un nodo `running` aporta `k/n` sólo mientras el verifier (o los gates finales de un
  multi, que cuentan como un paso más) publica gates medibles y el lock está vivo. Nunca pasa de 99% hasta `completed`.
  Los tiempos de nodos terminados se derivan de las marcas `at` de los handoffs, así que son aproximados.
- **Gates**: el proceso que ejecuta escribe `runtime/progress/<task-id>.json` (`node`, `done`, `total`, gate en curso,
  `pid`) con reemplazo atómico y lo borra al terminar los gates. Es efímero (`EPHEMERAL` de `core/snapshot.py`): no cuenta
  como escritura de un agente ni como violación de scope. Un archivo sin lock vivo no se confía.
- **`--watch`** refresca cada `--interval` segundos (default 3, mínimo 0.05) hasta que la tarea termina y sale con 0 si
  quedó `completed`, 1 si `failed` y 3 si quedó `active` sin ejecución viva (bloqueada por un gate omitido, o
  interrumpida; se exige que persista en dos refrescos para no confundir el arranque). En TTY redibuja la pantalla; sin
  TTY imprime un bloque sólo cuando cambia algo (el tiempo transcurrido solo no cuenta). Sin `--watch` imprime una vez y
  sale 0.
- **`--json`** emite la misma información estructurada (`state`: `running|stalled|completed|failed`, `percent`,
  `nodes[]`, `children[]`, `finalGates`, `lastEvent`, `cause`); con `--watch` es un objeto compacto por línea en cada cambio.
- **Sólo lectura**: sobre `tasks/`, `handoffs/` y `state/` nunca toma locks ni escribe; un archivo parcial o en escritura
  se ignora (handoff, contador) o se reintenta en el próximo ciclo (tarea). La única escritura de toda la función es el
  contador de gates de arriba, hecha por `execute`.
- **`harness:execute`** imprime además en stderr una línea compacta cuando un nodo cambia de estado
  (`[harness] 3/7 43% reviewer ⟳`), sin alterar el JSON final de stdout.

## Higiene del estado operacional

`pnpm harness:hygiene [--json] [--stale-days N] [--quarantine-invalid --yes]` (módulo `core/hygiene.py`). Por defecto es
de sólo lectura y reporta, con la acción exacta recomendada: tareas `active` sin actualización en más de N días
(default 7) → `harness:abort`; tareas `active` sin lock vivo (`state/<id>.lock` ausente o de un PID muerto) → `execute`
o `harness:abort`; nodos `running` dentro de tareas `failed` → `harness:retry`; evidencia inválida en `failed/` →
cuarentena; `state/*.json` huérfanos (sin tarea asociada, sólo se informan) y el tamaño de `runtime/`.

`--quarantine-invalid` muestra qué haría (dry-run); con `--yes` mueve a `tasks/legacy/` únicamente la evidencia de
`tasks/failed/` que `load_task` rechaza por formato. Si `legacy/` ya tiene un archivo con el mismo nombre y SHA-256
idéntico, elimina la copia de `failed/`; si difiere, la guarda con sufijo `.<sha8>` sin sobrescribir. Registra un
evento en `logs/audit/` (los candidatos se vuelven a escanear dentro del lock antes de actuar), nunca toca tareas
válidas, handoffs ni logs, y exige `state/workspace.lock` (falla si hay una ejecución viva). `harness:check` conserva su
aviso y ahora recomienda este comando.

Todo el estado operacional (`tasks/`, `handoffs/`, `state/`, `logs/`, `specs/` y `runtime/`) es **local por máquina** y
nunca se versiona; sólo los `.gitkeep` vacíos de cada carpeta esperada están en git (`tasks/{inbox,active,completed,
failed}`, `handoffs`, `state`, `logs/{audit,completed,execution,errors}` y `runtime`). El traspaso Codex ↔ Claude
funciona en la misma máquina, y la evidencia de una entrega vive en el cuerpo del PR.

`harness:check` falla si `git ls-files` (consultado con `git -C <toplevel>`) devuelve algo versionado bajo esas rutas
que no sea uno de esos `.gitkeep` vacíos; un `.gitkeep` en otra ruta o con contenido también es una violación. El gate
se omite **sólo** cuando no hay repositorio git (copias temporales de `harness:test` y smokes); cualquier otro error de
git (código distinto de 0, timeout, ejecutable ausente) falla cerrado. Las lecturas usan `-c safe.directory=<toplevel>`
para no desactivarse por "dubious ownership" (p. ej. Docker como root). El mensaje sugiere `git rm --cached
--ignore-unmatch -- <archivos>` con la lista exacta, o, si son muchos, `git ls-files -z -- <rutas> | grep -zv
'/\.gitkeep$' | xargs -0 git rm --cached --`, que no toca los `.gitkeep`. Así el CI rechaza cualquier PR que vuelva a
versionar estado. `tasks/sources` y `tasks/legacy` no tienen `.gitkeep`: el Harness las crea cuando las necesita.

Los registros históricos inválidos no se reinterpretan como éxito: se preservan bajo `tasks/legacy/` fuera de la máquina
de estados activa. Su README original ya no se versiona; en síntesis: son tareas que no cumplen los invariantes actuales
(p. ej. marcadas `completed` sin estado persistido de algunos nodos), no se interpretan nunca como éxito y no se fabrica
ningún estado al migrarlas.

## Runtime Python sin instalación manual

El primer `pnpm harness:check` detecta Python compatible (3.11–3.14), incluyendo `py -3` en Windows y la opción
`HARNESS_PYTHON`. Omite los App Execution Aliases de Microsoft Store. Si no encuentra un runtime compatible,
provisiona automáticamente CPython **3.13.7**, release **20250918** de
[python-build-standalone de Astral](https://github.com/astral-sh/python-build-standalone/releases/tag/20250918).
Los seis artefactos y SHA-256 están fijados en `manifests/python-runtime.json`; nunca se resuelve una versión dinámica.

El runtime se instala localmente en `runtime/python/`, ignorado por Git, sin pip, cambios en PATH global ni permisos
de administrador. Se valida checksum antes de extraer, tipos/paths/links antes de escribir y contenido instalado
contra el archivo original verificado antes de ejecutar. Un lock evita instalaciones simultáneas y la publicación
del directorio es atómica. Un checksum inválido nunca se ejecuta. El archivo verificado se conserva para comprobar
integridad en usos posteriores; los snapshots también cubren ese runtime durante los especialistas.

Windows x64/arm64 (incluido Git Bash), Linux glibc/WSL x64/arm64 y macOS x64/arm64 tienen metadata de provisioning.
Se necesita HTTPS hacia GitHub y `tar` nativo. En Windows se usa `%SystemRoot%\System32\tar.exe` aunque Git Bash
anteponga su GNU tar en PATH (interpreta `C:\...` como host remoto); sólo si falta se recurre a `tar`. El bootstrap
exporta el intérprete resuelto como `HARNESS_PYTHON` a sus procesos hijos (tests, fixtures y copias temporales sin
`runtime/python`) para que lo reutilicen sin reprovisionar; un `HARNESS_PYTHON` explícito nunca se pisa y `py -3`
no se propaga porque requiere argumentos. Una plataforma o integridad no soportada
falla con diagnóstico accionable. No hay fallback a lógica JS. Los launchers usan `-I -S -B`: aíslan PYTHONPATH,
sitecustomize y paquetes de usuario, y evitan generar bytecode. Para debug avanzado:
`python -I -S -B -X utf8 .harness/cli.py context repo`; la carga directa de `.env` soporta `KEY=VALUE` simple.

La resolución es idéntica para Codex y Claude, y bajo PowerShell o Git Bash: los tres lanzadores de `cli.py`
(`bootstrap.mts`, el hook PreToolUse `hooks/guard-orchestrator.mts` de Claude y el RPC `lib/bridge.mts`) usan el
mismo `resolvePython()`, los mismos flags `-I -S -B -X utf8` y el mismo entorno de `harnessChildEnv(runtime)`;
`runtime.test.mts` falla si un lanzador nuevo arma un env propio. Los especialistas heredan ese `HARNESS_PYTHON`
con `HARNESS_HOST=codex`, `HARNESS_HOST=claude` o `HARNESS_AGENT_COMMAND`; los adapters nunca lo pisan y la
redacción sólo afecta la salida capturada, no el entorno del hijo. `pnpm harness:doctor` (campo `source`) y
`pnpm harness:check` informan el origen del intérprete: `managed` (`runtime/python`), `HARNESS_PYTHON`, `PATH`
(`python3`, `python` o `py -3`) o `direct` si `cli.py` se invocó sin lanzador. Sólo se informa la etiqueta; un
valor desconocido de `HARNESS_PYTHON_SOURCE` nunca se reproduce.

Para actualizar Python, cambiar centralmente versión, artefactos y checksums de la release verificada, probar
provisioning/checksum y retirar el runtime local anterior sólo después de confirmar que no hay una ejecución activa.

`harness:list` resume todas las tareas por estado y nodos. `harness:abort` mueve una tarea activa a `failed/` con el
motivo y un evento de auditoría; en parents multi también cierra children activos para no dejar huérfanos.
`harness:retry` reabre explícitamente una tarea `failed` tras una falla transitoria de auth/cuota, conserva attempts,
handoffs, logs y sources, y sólo devuelve a `pending` nodos fallidos/bloqueados/interrumpidos. Cada `execute` toma
primero `state/workspace.lock` y luego el lock de tarea: ejecuciones distintas no pueden escribir simultáneamente el
mismo checkout (el paralelismo ocurre dentro de una ejecución, en worktrees aislados). Un PID vivo nunca se desaloja; un owner muerto se recupera con release protegido por token. Un lock
creado por otra plataforma u host (por ejemplo Windows vs WSL) no se puede verificar y nunca se recupera solo: se
confirma y se borra a mano. Un dominio con `"enabled": false` en `domains.json` queda documentado y validado pero no es
enrutable.

## Configuración local

Copiá `.harness/.env.example` a `.harness/.env` para definir el host y controles operativos por máquina sin modificar
archivos versionados. `.harness/.env` está ignorado por Git y todos los comandos `pnpm harness:*` que pasan por la CLI
cargan ese archivo antes de inicializar el motor. No requiere `dotenv`: usa `process.loadEnvFile()` de Node.

La precedencia es **entorno del proceso > `.harness/.env` > defaults internos**. Por ejemplo, un desarrollador puede
mantener `HARNESS_HOST=claude` en su archivo local y ejecutar excepcionalmente `HARNESS_HOST=codex pnpm harness:execute
-- <task-id>` sin editarlo. No guardar tokens, claves ni credenciales en este archivo; es configuración operativa, no un
secret store.

## Adaptador de agentes

La ejecución real necesita un host explícito, ya sea mediante `.harness/.env` o la variable del proceso:

```bash
HARNESS_HOST=codex pnpm harness:execute -- <task-id>
HARNESS_HOST=claude pnpm harness:execute -- <task-id>
```

Codex usa `codex exec --sandbox <workspace-write|read-only> --output-schema .harness/manifests/agent-result.schema.json
--output-last-message <runtime/result.json> -` (reviewer y security-auditor en `read-only`). Claude usa `claude -p
--output-format json --json-schema <schema> --permission-mode <acceptEdits|default> --allowedTools <lista>`.
Reviewer/security-auditor además cierran `--tools` al allowlist de lectura, cargan configuración MCP vacía con
`--strict-mcp-config` y deniegan herramientas mutantes y `mcp__*`. En ambos hosts el prompt viaja únicamente por stdin,
nunca en argv. En Windows el launcher pasa sólo argumentos fijos vía PowerShell. Para otro runtime,
`HARNESS_AGENT_COMMAND` acepta un comando con placeholder `{agent}`; `{prompt}` se rechaza. El prompt (JSON con task,
role, contract, context y handoffs) viaja siempre por stdin y también en `HARNESS_AGENT_PROMPT`; nunca se interpola en
la línea de comandos. El orquestador sólo coordina; el prompt delegado limita al especialista al scope recibido.

### Paridad codex ↔ claude

- **Escritura (architect, backend, backoffice, n8n, infra, tester, documentation):** Codex usa sandbox
  `workspace-write`; Claude usa `--permission-mode acceptEdits` con `--allowedTools
Read,Grep,Glob,WebFetch,Edit,MultiEdit,Write,NotebookEdit,Bash`, de modo que la sesión headless (`-p`, sin TTY) no se
  cuelga esperando una confirmación interactiva que nunca llega.
- **Solo lectura (reviewer, security-auditor):** Codex usa sandbox `read-only`; Claude usa `--permission-mode default`,
  `--tools Read,Grep,Glob,WebFetch`, el mismo `--allowedTools`, MCP vacío bajo `--strict-mcp-config` y
  `--disallowedTools Edit,MultiEdit,Write,NotebookEdit,Bash,mcp__*`. La restricción es de CLI y configuración de
  herramientas, no sólo texto de prompt.
- **Salida estructurada:** Codex escribe el JSON final en el archivo de `--output-last-message`, que el propio binario
  Codex sandboxeado escribe de forma autoritativa al terminar. Claude usa salida estructurada nativa con
  `--json-schema`; el Harness exige un sobre terminal exitoso y toma exclusivamente su objeto `structured_output`, que
  vuelve a validar contra `agent-result.schema.json`. El parseo es estricto: un sobre inválido, `is_error: true`,
  ausencia de `structured_output` o un objeto que no cumpla el schema fallan cerrado exactamente igual que una salida de
  Codex malformada; nunca se intenta rescatar JSON desde texto libre.
- **Claude nunca confía en el archivo de resultado.** `HARNESS_RESULT_FILE` sólo se entrega en el entorno del proceso
  Codex (que es quien lo escribe de forma autoritativa vía `--output-last-message`) y del comando de
  `HARNESS_AGENT_COMMAND` operado manualmente; el host `claude` no recibe esa variable en absoluto y la ruta nunca es
  siquiera descubrible para él. Un rol con escritura (Bash/Write bajo `acceptEdits`) podría, si no fuera así, falsificar
  un resultado `passed` escribiendo directamente sobre esa ruta sin reflejar lo que realmente hizo. Para `claude`,
  `executeNode()` toma el resultado exclusivamente del stdout capturado del proceso, nunca del archivo, incluso si ese
  archivo llegara a existir con contenido forjado.
- Los flags de Claude (`-p`, `--output-format`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--model`,
  `--max-turns`) están documentados por Anthropic para Claude Code CLI. El contrato de argv/stdin/env se prueba con un
  ejecutable `claude` simulado en PATH (mismo patrón que el fixture de `codex`); ver "Verificación con binario real"
  para el smoke test contra el CLI instalado.
- **Diferencia de aislamiento (conocida):** Codex ejecuta los roles de escritura dentro de un sandbox `workspace-write`;
  Claude bajo `acceptEdits` conserva `Bash` sin sandbox de filesystem. El alcance de escritura en Claude no es un
  sandbox de filesystem. El Harness compara snapshots antes/después (tracked, untracked, borrados y estado operacional),
  rechaza escrituras reales fuera de scope (incluidos archivos ignorados por git), cambios a estado operacional por
  agentes y archivos modificados que el resultado no declare. Ver "Violaciones de scope". Es detección posterior, no
  prevención; por eso reviewer/security usan herramientas cerradas de sólo lectura y los gates independientes siguen
  siendo obligatorios.

Variables opcionales del host:

- `HARNESS_AGENT_TIMEOUT_MS`: límite de pared por proceso de agente (default 1800000, `0` lo desactiva). Al vencer se
  mata el grupo de procesos completo y el nodo falla con exit 124.
- `HARNESS_CLAUDE_MODEL` y `HARNESS_CLAUDE_MAX_TURNS` (1..200): se reenvían como `--model` y `--max-turns` sólo si están
  definidas; por defecto el argv no cambia.
- `HARNESS_MAX_RETRIES` (0..10, default 2).
- `HARNESS_GATE_TIMEOUT_MS`: timeout por gate (default 600000, rango 1..86400000). Cada gate registra comando, exit,
  duración y un extracto acotado de stdout/stderr en audit.

El resultado es fail-closed: el agente debe devolver el JSON de `agent-result.schema.json` (archivo de resultado para
Codex y para `HARNESS_AGENT_COMMAND`; exclusivamente `structured_output` del sobre de Claude con `--json-schema`). Exit
0 sin JSON válido, o con `status: failed|blocked`, no aprueba el nodo. `harness:execute` devuelve exit code distinto de
cero si la tarea no queda `completed`. Un nodo `running` interrumpido se reanuda en el siguiente `execute` únicamente
tras validar su baseline persistido. Si falta o no puede compararse, se conserva evidencia y se bloquea la recuperación
automática.

## Guardia del orquestador

`.claude/settings.json` registra el hook `PreToolUse` `.harness/hooks/guard-orchestrator.mts` para
`Edit|MultiEdit|Write|NotebookEdit`. El host sólo puede escribir estado operacional bajo
`.harness/{tasks,state,handoffs,logs,runtime}/` (o scratch fuera del repositorio); el runtime Python administrado queda
protegido; un intento sobre archivos de producto devuelve exit 2 con instrucciones para delegar. Los especialistas
lanzados por el Harness llevan `HARNESS_AGENT` en su entorno y quedan exentos (su alcance lo hacen cumplir las reglas de
paths). Para una intervención manual deliberada: `HARNESS_ALLOW_HOST_WRITES=1`. Si el hook no puede leer su entrada,
deniega (falla cerrado). El hook no cubre escrituras por shell y Codex no tiene un mecanismo equivalente verificado: en
Codex la regla sigue siendo instrucción (`AGENTS.md`) más revisión.

## Verificación con binario real

`pnpm harness:smoke-host -- codex` y `pnpm harness:smoke-host -- claude` son los smoke tests acotados contra los CLI
instalados. Se ejecutan en un workspace temporal y registran su resultado real en `logs/audit/`.

## Contexto, skills y tokens

El router indexa únicamente metadata desde `.codex/skills` (canónico) y `.claude/skills` (mirror). `.agents/skills`
(ruta que también lee Codex) es un segundo mirror; `pnpm agent-config:check` exige que ambos sean byte a byte idénticos
al canónico. Carga sólo skills del dominio, como referencias sin contenido. Cada slice contiene task, domain, paths,
excludes, instructions, skills, sources, verification y budget. Si excede el budget la tarea falla antes de persistirse
o delegarse: task, restricciones y skills nunca se truncan.

`harness:check` valida agentes fijos, `agents.json` y `domains.json` contra sus schemas, que los schemas de resultado,
handoff y tarea acepten muestras válidas y rechacen inválidas, referencias de skills y contratos de agente generados.
Los tests propios (`harness:test`) corren en copias temporales aisladas del Harness, sin dejar residuos en el
repositorio, y cubren check, contexto acotado, DAG/state, fail-closed, stdin literal, loop correctivo con feedback,
resume y el contrato de los launchers `codex exec` y `claude -p` mediante ejecutables simulados (`codex`/`claude`) en
PATH, incluyendo el allowlist de herramientas por rol y el fail-closed sobre el sobre `--output-format json`.

Todos los JSON de runtime están en `.prettierignore`: son escritos por máquina y no se reformatean a mano.

## Especificaciones grandes y scope

`run <domain|auto> --file <path>` lee UTF-8 sin pasar el contenido por argv. `dispatch` mantiene `domain:`
y consume el inbox solo después de persistir el plan. Archivo, inbox, multi y tareas de más de 4000 caracteres
guardan una única copia íntegra en `tasks/sources/<id>.txt`, compartida por los children mediante `sourceRef`
con SHA-256. El archivo original de `--file` se conserva. Las tareas pequeñas directas mantienen su texto literal.

Los slices son vistas parciales explícitas con números de línea: priorizan el dominio, su sección Markdown y
restricciones, sin repetir extractos idénticos. No sustituyen la especificación. Antes de implementar el especialista
debe expandir el source e inspeccionar requisitos globales, secciones sin clasificar y detalles de su dominio;
si no puede hacerlo, debe bloquearse. No se autoriza a ignorar requisitos omitidos.

`source <task-id> <offset> <length>` pagina por caracteres; devuelve `nextOffset` y `complete`.
La longitud predeterminada es 4000, el máximo 12000. Cada expansión y ejecución verifica integridad del source.
Su lectura no amplía permisos de escritura. El límite del prompt completo conserva contrato, skills y handoffs;
si excede el budget, falla cerrado sin recortarlos.

El prompt delegado viaja por referencia: cada skill se envía como `name`, `description` y `path` (sin contenido) y
el agente debe leer el `SKILL.md` desde ese path antes de actuar. Los implementadores (incluidos los contratos
efímeros) reciben las skills de su rol en `agents.json` más las del dominio; reviewer, security-auditor y verifier
reciben sólo las de su rol. Cada handoff de dependencia se resume en `agent`, `attempt`, `status`, `files`, `risks`,
`nextAction` y el `path` del registro completo en `.harness/handoffs/`. El texto de la tarea aparece una sola vez,
fuera de `context`.

`auto` busca objetivos de acciones de modificación; consumir API/OpenAPI/RBAC existentes, docs o CI no implica
escribir esos dominios. Sin acciones usa el encabezado inicial. Es una heurística conservadora: inspeccionar el
plan y usar un dominio explícito ante ambigüedades. Los encabezados por dominio mejoran los extractos.

Crear un backoffice completo o solicitar bootstrap agrega un child `repo` con `architect`, que termina antes de
las aplicaciones. Revisa y modifica solo el bootstrap necesario dentro de su scope. No amplía
`apps/backoffice/**`. Un fallo o bloqueo impide iniciar el frontend. Todo multi con `repo` espera ese child.

Los globs son relativos al repositorio con separadores POSIX: `*` cubre un archivo root (incluidos dotfiles),
nunca `/`; `**` cubre descendientes. `repo` cubre `package.json`, `pnpm-workspace.yaml` y `.npmrc`, pero su `*`
no cubre archivos de `apps/`. Dominio y `allowedPaths` se intersectan; exclusiones siempre prevalecen.
`path-check` aplica esa semántica y rechaza absolutos, traversal y symlinks. Los archivos declarados por el agente
se validan con la misma función. No sustituye el sandbox ni detecta escrituras que el agente no declare.

## Agentes temporales

El núcleo fijo es: context-manager, architect, backend, backoffice, n8n, infra, tester, reviewer, security-auditor,
documentation, logger y verifier. Si una necesidad queda fuera del núcleo, se crea un contrato efímero bajo
`runtime/agents/`, con scope, paths, skills, budget y lifetime de una tarea. También puede declararse una especialidad
excepcional con `specialist:<nombre>` en la tarea. Nunca se promociona automáticamente a fijo.

## Handoffs

Cada nodo produce JSON con taskId, domain, agent, status, attempt, changes, files, decisions, risks, verification,
nextAction y timestamp. Esto permite reanudar sin cargar la conversación anterior y mantiene separación entre
implementación y revisión.

## Precedencia

RedEvent local Harness → instrucciones locales → Harness global opcional → defaults. La configuración global complementa
pero no reemplaza reglas locales.

## Gates

`harness:verify -- <domain>` ejecuta los gates del manifest. `harness:verify -- --full` ejecuta Prettier, los tests
propios del Harness y `verify-enterprise.sh --full`. El tooling Enterprise existente continúa siendo autoritativo;
`docker-verify-enterprise.sh` sigue disponible para verificación Docker.

## Entrega PR en RedEvent

Esta regla es local a RedEvent y aplica a toda tarea; no define preferencias globales de servicios.

- Preparar la implementación, los checks locales, la revisión y las actualizaciones autorizadas antes de publicar
  cuando sea posible. Se mantienen los requisitos de tests, revisión, autorización y aislamiento de tenants.
- Vincular la card y el PR mediante la relación nativa exclusivamente por MCP, o por sincronización automática de
  GitHub confirmada por MCP. Verificar por MCP la URL real del PR y la relación nativa; una URL en texto no acredita
  el vínculo. No abrir ni inspeccionar el navegador para vincular o verificar esa relación. Si falta capacidad MCP,
  informar el bloqueo sin fallback UI ni declarar un vínculo inexistente.
- Publicar el PR cierra la tarea con un reporte concreto de URL, vínculo verificado, cambios, checks y bloqueos.
  No esperar aprobación de desarrolladores ni continuar con seguimiento de CI o merge posterior. Si el vínculo no
  pudo verificarse, reportar ese bloqueo explícitamente sin afirmar una entrega completa.
- Los PR cuyo destino sea `qa` deben quedar configurados para auto-merge por defecto (preferir squash) una vez que GitHub confirme los quality gates requeridos, las protecciones de rama y cualquier aprobación exigida. Auto-merge no significa forzar ni adelantar un merge ante checks pendientes o fallidos; nunca usar `--admin` ni bypass.
- El publicador del PR debe solicitar auto-merge por GitHub/MCP cuando el PR apunte a `qa`, y registrar si quedó habilitado o bloqueado. Si la API o la política de GitHub lo impiden, informar el bloqueo; no hacer merge manual como fallback.
- La automatización del repositorio también habilita auto-merge al concluir exitosamente el workflow CI para PR hacia `qa`; esto cubre PR publicados fuera del Harness. Los PR draft no se incorporan automáticamente.
- Los PR con destino `main` conservan merge manual y aprobación humana explícita; no habilitar auto-merge por defecto.
- Los PR publicados por el Harness nombran con formato de clave (`RED-001-<número>`) únicamente la card que cierran;
  sin claves de otras cards en título ni cuerpo. Las dependencias se referencian por nombre (p. ej. "O03" o "la card
  de jobs"), nunca por su clave. La guardia `PR / Card references` de CI (`scripts/check-pr-card-refs.mjs`) lo exige;
  tras el merge, verificar que la automatización del tablero no movió a Done ninguna otra card nombrada por error.

## Aplicaciones declaradas pero no soportadas

`apps/marketplace` y `apps/planner-portal` contienen actualmente documentación placeholder, no aplicaciones
ejecutables con gates propios. Están declaradas como dominios `enabled: false`; una solicitud explícita o
automática de implementación falla cerrado en lugar de caer silenciosamente en `repo`. Se habilitan sólo cuando
exista producto real y verificación específica; `provider-portal` y `sales-portal` ya fueron habilitados con
gates propios (`typecheck`, `lint`, `test:critical`, `build`).

El dominio `workers` ya fue habilitado, pero no para `apps/workers/**`: cubre el runtime PostgreSQL de jobs/outbox
ya implementado en `apps/api/cmd/worker` e `internal/platform/jobs` (RED-001-142), con agente `backend`, gates
propios (`go test`/`go vet`/`go build` acotados a esos paths) más `bash ./verify-enterprise.sh --quick`
(gofmt/lint/test/vet/build), y `dependencies: ["api"]` porque comparte módulo Go, configuración y base de datos con
ese dominio. `apps/workers/**` en sí sigue siendo un placeholder sin producto ni dominio propio, documentado en
`apps/workers/README.md`.

## Smoke con hosts reales

Los fixtures de `harness:test` validan determinísticamente argv, permisos, schema y resultados sin consumir cuota.
`harness:smoke-host -- codex|claude` crea un workspace temporal desechable, ejecuta un writer real, reviewer read-only,
gate y estado final, lo elimina y registra evidencia genuina en `.harness/logs/audit/`. Un error de autenticación o
cuota se registra como `blocked`, nunca como éxito. No se fabrica evidencia: el intento de Codex del 2026-09-29 quedó
preservado como fallido por límite de uso.

## Índice, riesgo y verificación proporcional

`harness:index` descubre ownership, roots, dependencias, contratos, skills, checks y riesgos desde los manifests.
El índice de metadata se guarda en `runtime/context-index.json` y se invalida por SHA-256 de las fuentes acotadas.
No se escanea el árbol de producto para descubrir skills. Cada skill tiene descripción, path, dominios y hash;
el prompt incluye sólo las referencias seleccionadas, y elimina descripciones opcionales antes de fallar por budget.
Los límites efectivos son el mínimo de global, tarea, dominio y rol; la estimación UTF-8 local es conservadora y
no representa tokens facturados. Tarea, scope, contratos y hallazgos nunca se recortan silenciosamente.

`harness:changes` centraliza diff contra `HARNESS_BASE`, staged, unstaged y untracked no ignorados. Un base inválido
falla cerrado. `harness:verify` selecciona dominios/checks desde esos mismos paths; `--plan` sólo describe el plan,
con `validated: false`. Auth/RBAC/tenancy/identity/migrations/OpenAPI elevan el gate API de `--quick` a `--security`.
`--full` conserva el gate global explícito. Una errata documental trivial requiere un especialista y los checks
mínimos; los cambios complejos conservan DAG, revisión y auditoría. Un `specialist:<nombre>` explícito crea un
contrato temporal acotado con identidad determinística; mencionar una tecnología no crea agentes extra.

### Verificación por grafo de dependencias

Cada check del plan es un objeto `{command, tier, reason, requires}`. `core/impact.py` (stdlib, sin red) deriva los
checks `targeted` del grafo y el plan los ejecuta antes de los `authoritative` (gates declarados del dominio o
`fullChecks`), deduplicando por forma canónica (la de `core/cigaps.py`: `pnpm --dir X s` ≡ `pnpm --filter ./X s`, se
conserva el primero y el `reason` anota el duplicado):

- **Workspaces JS** (los globs `<dir>/*` de `pnpm-workspace.yaml`, hoy `apps/*`, `packages/*` y `tooling/*`; sin
  `apps/api`; `apps/*` y `packages/*` si el archivo no existe): arista A→B si A declara a B en `dependencies`,
  `devDependencies` o `peerDependencies`. Afectados = cambiados + dependientes inversos; se corren sus scripts
  `lint`, `typecheck`, `test`, `test:critical`, `build` con `pnpm --filter ./<dir> <script>` (un solo `test` si
  `test:critical` es idéntico). Lockfile, `pnpm-workspace.yaml`, `package.json`/`.npmrc`/`tsconfig*.json` raíz y los
  paquetes de configuración compartida afectan a todos los workspaces.
- **Go** (`apps/api/**`): `go list -deps -test -json` (en memoria, sin redacción del runner: la opción `raw` exige `persist: false`) calcula qué paquetes dependen (también por tests) de los
  paquetes cambiados; los archivos no-Go cuentan como cambio de su paquete. Checks: `gofmt -l` sobre los `.go`
  cambiados (falla si lista algo), `go vet` y `go test` de los paquetes afectados. `go.mod`/`go.sum` o un grafo no
  calculable caen a `./...`, y el `reason` lo declara e incluye la última línea (sanitizada) del stderr de `go list`.
  `go list` hereda el entorno exactamente como el `go test` posterior (incluido el cambio automático de toolchain, p. ej.
  `go.mod` pide 1.26 con Go 1.24 local); sólo agrega `GOPROXY=off` si el entorno no lo define, es decir, el grafo se calcula
  sin red desde el módulo cache y, si eso no alcanza, el fallback a `./...` queda declarado en el `reason`.
- **Infra/agentes**: `.sh` → `bash -n`; `infra/docker/compose*.yml` → `docker compose config --quiet`; workflows →
  `prettier --check` (falla ante YAML inválido); `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.codex/**`, `.agents/**` →
  `pnpm agent-config:check` (también `scripts/check-agent-config-sync.mjs` y `.gitignore`).
- Mover o borrar el `package.json` de un workspace, o tocar un path bajo un directorio de los globs de
  `pnpm-workspace.yaml` sin `package.json` válido, selecciona todos los workspaces (con `reason` explícito).
- Archivos borrados o renombrados cuentan por su path anterior **y** el nuevo: `core/changes.py` usa
  `git diff --no-renames` (base...HEAD, sin stage y con stage).

`verify --plan --explain` muestra `tier` y `reason` de cada check (`--plan --json` es el JSON, por defecto).
`verify` ejecuta, detiene en el primer fallo real salvo `--keep-going`, y `--fast` corre sólo los `targeted` y declara
que no es la verificación autoritativa. `--full --fast` se rechaza. Fuera de `--fast`, los `go vet`/`go test` dirigidos
no se ejecutan cuando el plan ya incluye `verify-enterprise.sh` (que corre `go vet ./...` y `go test ./...`); el plan los
conserva marcados «only with --fast». Con `--fast`, o si `verify-enterprise.sh` no puede ejecutarse en este entorno
(`SKIPPED_ENVIRONMENT`), sí se ejecutan. La misma cobertura (`coveredBy: verify-enterprise.sh`) aplica a los checks JS de
`apps/*` y `packages/*` (no `tooling/*`, que el script no recorre) y a `gofmt -l`. Todo argv derivado de nombres de
archivo usa `--` (o `./`) para que un archivo `-s.sh` no se interprete como opción.

Antes de cada check se comprueban sus `requires` (`shutil.which`; `docker` además `docker info`; `node_modules` es el
directorio raíz instalado y lo exige todo check `pnpm` salvo `harness:*` y `agent-config:check`): si falta una
herramienta el check queda `SKIPPED_ENVIRONMENT`. `golangci-lint` y `govulncheck` no son requisitos previos de
`verify-enterprise.sh`: sus omisiones salen de su reporte estructurado (PARTIAL con los pasos nombrados). Nunca se infiere un hueco de entorno de un exit code o log, con una
única fuente estructurada: tras un exit 0 de `verify-enterprise.sh` el Harness lee su `verification-report.json`
(cada corrida usa su subdirectorio `run-*` dentro de `$REDEVENT_VERIFY_REPORT_DIR` o `.artifacts/verify-enterprise/`); si `summary.skip > 0` el check es
`SKIPPED_ENVIRONMENT` y lista los pasos omitidos (golangci-lint, govulncheck, race, k6, psql…), y si el reporte falta, es
anterior a la corrida, es de otro modo o es inconsistente el check es `FAIL` (cierre en fallo).

Estado final: `PASS` (exit 0), `FAIL` (1), `PARTIAL` (3: sin fallos pero con checks omitidos; **no es éxito**) o `EMPTY`
(4: fuera de `--full` no se ejecutó ningún check —plan vacío, p. ej. cambios ya commiteados, o `--fast` sin checks
`targeted`—; **no es éxito**; el mensaje indica la base usada, o `--base <ref>` si no hubo, para verificar lo commiteado). Exit codes: 0 PASS, 1 FAIL,
2 uso inválido del CLI, 3 PARTIAL, 4 EMPTY, 5 STALE, 6 FAST/no autoritativo.

Base de comparación (`verify` y `verify --plan`): `--base <ref>` > `HARNESS_BASE` > merge-base con `origin/qa` si existe
y `HEAD` no es `qa` > sólo cambios locales; la ref se valida igual que en `core/changes.py` y el plan y el resumen
informan la base usada. Una ref inválida (empieza con `-`), inexistente o sin valor (`verify --base --plan`) es error de
uso (exit 2), no un FAIL. En clones que sólo tienen `origin/qa` se recomienda `--base origin/qa`; si se pide `qa`, no
existe como ref local y sí `refs/remotes/origin/qa`, se usa esta con un aviso explícito en la fuente de la base. La
selección dirigida de JS sólo se amplía a todos los workspaces cuando cambia un `<ws>/package.json` o cuando ese
`package.json` existía en la base (`git cat-file -e <base>:<ws>/package.json`, o en `HEAD` sin base): un README en un
directorio de los globs de `pnpm-workspace.yaml` sin app no selecciona checks JS. `verify <dominio>` registra el dominio pedido y sólo es autoritativo si los dominios ejecutados
cubren los de `verify_plan(None)` para el mismo conjunto de archivos; si no, `report` sale 6. Cada check guarda
`stdoutTail` y `stderrTail` (2000 caracteres, redactados, por stream) y `report` muestra ambos. La huella excluye los
artefactos de `policies.json` → `generatedArtifacts` y se recalcula al terminar: un archivo no excluido alterado durante la
verificación queda en `selfAltered` (el resultado se ve `STALE`). Cada corrida de `verify-enterprise.sh` escribe su reporte
en un subdirectorio propio (`REDEVENT_VERIFY_REPORT_DIR`) y el `git.sha` del reporte debe coincidir con `HEAD`; al iniciar una corrida el Harness conserva sólo los 5
directorios `run-*` más recientes de ese directorio (sin seguir symlinks, sin tocar nada fuera de él ni la corrida en curso); si el
reporte no se puede leer el exit real del proceso se conserva y se agrega `error` (el check queda `FAIL`). El resumen queda
en `runtime/verify-last.json` (efímero) con el `HEAD`, un hash de los paths y contenidos cambiados (sin estado operacional
del Harness) y si fue `--fast`; `harness:report` lo muestra (fallos, omitidos, aprobados) y lo marca `STALE` (exit 5) si el
`HEAD` o los archivos cambiados ya no coinciden, o sale 6 si el último `PASS` fue `--fast` (no autoritativo). En el
lifecycle, `SKIPPED_ENVIRONMENT` bloquea el nodo `verifier` y los gates finales de un multi (cierre en fallo), nunca los
aprueba. `harness:context`/`harness:tokens` sin dominio infieren el dominio con un plan sin checks `targeted` (no ejecutan
`go list`).

Los gates y agentes pasan por el runner con timeout, límite de salida y sanitización anterior a persistir.
Los logs de comandos generales dentro del límite quedan en `runtime/output/`; un overflow descarta streams
incompletos para no filtrar prefijos de secretos y falla con exit 125. Los transcripts de hosts estructurados se omiten;
su resultado se valida en memoria y se conserva sólo como handoff compacto.
Los comandos destructivos y mutaciones Git no autorizadas se deniegan también para gates internos. Las métricas
locales guardan rol, dominio, host, duración, estimación, intento, exit y categoría de fallo, sin telemetría externa.

El baseline de cada intento referencia sus artefactos exactos de resultado/log antes del spawn. Una interrupción
conserva el baseline; una comparación incompleta deja `scopeValidationPending` y bloquea retries automáticos.
Para ese caso, inspeccionar la evidencia manualmente y crear una tarea nueva; nunca adoptar el workspace como
un baseline limpio. Los snapshots siguen siendo detección posterior, no un sandbox para un host de escritura.

## Extender dominios, agentes y checks

Agregar un dominio en `manifests/domains.json` con paths, exclusiones, ownership, dependencias, riesgos,
implicaciones de seguridad, skills y verificación. Mantener `enabled: false` mientras no exista producto y un
gate ejecutable. El agente asignado debe existir en `manifests/agents.json`; sus paths intersectan los del dominio.

Toda app ejecutable nueva bajo `apps/<nombre>` que declare `scripts.dev` debe quedar integrada en `start.sh` en la misma
tarea, con su comando, URL y health check locales. `harness:test` verifica que cada app ejecutable esté referenciada por
`start.sh`, para que habilitar un dominio sin wiring de arranque falle cerrado. Si una app no debe autoarrancar, la
excepción debe modelarse y documentarse explícitamente antes de habilitarla; no se omite de forma silenciosa.

Para agregar un rol fijo, declarar su contrato, permisos, skills, presupuesto y checks en `manifests/agents.json`
y actualizar la lista fija de `core/config.py`. Ejecutar `harness:agents-doc` para regenerar los contratos
documentales. Para una sola tarea, preferir `specialist:<nombre>` con el scope existente.

Declarar cada check como comando y argumentos separados en la verificación del dominio. Usar tooling existente;
el runner aplica timeout, límites y denegación de comandos destructivos también a estos checks. Validar metadata
con `harness:check`, contrato de skills con `agent-config:check` y comportamiento con `harness:test`.
Consultar `harness:verify -- --plan` para revisar la selección; ejecutar el plan para obtener evidencia.

## Reserva de migraciones entre ramas

Antes de crear una migración SQL ejecutá `pnpm harness:migrations`. El comando consulta las migraciones locales, la referencia `origin/qa` y los PR abiertos hacia `qa`; devuelve JSON con `next`, `local`, `qa`, `openPrs`, `sources` y `collisions`. Si detecta una colisión nueva con otro slug, sale con código 1. Si GitHub CLI no está disponible, los PR figuran como `null`: la comprobación remota queda omitida, no validada. Actualizá `origin/qa` antes de reservar un número. El comando es de solo lectura.

## Prevención de fallos repetidos

- **Reserva de migraciones:** `pnpm harness:migrations` consulta numeración local, `origin/qa` y PRs abiertos. Colisiones nuevas con slugs distintos bloquean; sin `gh`, la consulta queda `skipped`.
- **Declaración de cambios:** el snapshot determina los archivos modificados, renombrados y borrados. Se autodeclaran los cambios dentro de `owns` con auditoría `auto-declared`; texto libre en `files` se ignora y registra. **Relajación intencional:** no declarar manualmente ya no bloquea. Los cambios fuera del scope, protegidos o hechos por agentes read-only siguen siendo violaciones.
- **Baseline autoritativo:** `harness:run` ejecuta gates antes de crear tareas no triviales, reutilizando `state/gate-cache.json` y respetando `HARNESS_GATE_CACHE`. Fallos o skips bloquean. `--no-preflight` registra `preflight-bypassed`.
- **Triage de gates:** un fallo del verifier se puede contrastar sobre un worktree temporal con `HEAD` limpio. Si se confirma preexistente, no reabre implementadores. Resultados inconclusos conservan el comportamiento anterior. Tests flaky se reintentan una vez y no se ponen en cuarentena los críticos.
- **Host:** los errores `host-exit` registran código, causa y hasta 4 KB de stderr redactado, sin conservar prompts.
- **Alertas:** `parallel.longNodeWarningMs` advierte por nodos largos sin cancelar. El preflight informa de Air, Playwright CLI y watchers, sin finalizar procesos.
- **Artefactos generados:** sólo `*.tsbuildinfo` ignorados por Git se excluyen del snapshot. `next-env.d.ts` puede reescribirse al ejecutar Next, pero si está versionado sigue protegido. Se comparan contenidos, no marcas de tiempo.
- **Doctor:** `pnpm harness:doctor` revisa herramientas, locks, baselines, LF, estado local, frescura de `origin/qa` y migraciones. `pnpm harness:doctor -- api --file spec.md` agrega planificación, preflight y gates. Usa `git ls-remote` para no actualizar Git implícitamente. Devuelve hashes SHA-256 de cambios locales.
- **Guardia de ejecución:** el hook deniega `Edit` y `Write` en el repo si hay lock vivo o baseline pendiente, excepto `.harness/runtime/output/**`. No mata procesos ni relaja el latch.
