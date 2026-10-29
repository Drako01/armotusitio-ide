# Guía de uso del Harness

Guía práctica para operar el Harness de RedEvent día a día. Para el diseño, los contratos y los detalles técnicos, ver
el [README](README.md).

## 1. Qué es y cómo pensar en él

El Harness recibe una tarea, la divide en pasos (un **DAG** de agentes especializados), los ejecuta uno por uno con
Codex o Claude Code, y verifica el resultado. Toda la información queda en archivos JSON dentro de `.harness/`, así que
podés cortar en cualquier momento y retomar desde otra sesión o con el otro host.

Tres ideas para tener presentes:

1. **Tu host (Codex o Claude Code) coordina, no programa.** El código de producto lo escriben los agentes delegados. En
   Claude Code un hook bloquea las ediciones directas del host sobre código de producto.
2. **Falla cerrado.** Ante cualquier duda (resultado inválido, escritura fuera de scope, host no disponible) la tarea
   falla o se bloquea. Nunca se aprueba por omisión.
3. **Nada se borra solo.** Ni tareas, ni handoffs, ni logs, ni tus archivos. Recuperar una falla siempre es una acción
   explícita tuya.

## 2. Requisitos

- Node 24 y pnpm 11 (versión fijada en `package.json`).
- Dependencias instaladas con `pnpm install --frozen-lockfile`.
- Python no requiere instalación manual: el bootstrap detecta uno compatible o provisiona el runtime local verificado.
- Para provisioning sin Python: HTTPS hacia GitHub y `tar` nativo (incluido en Windows compatible).
- Para ejecutar agentes reales: el CLI `codex` **o** `claude` instalado y con sesión iniciada.
- Ejecutá los comandos desde la raíz del repositorio. Usá siempre la misma terminal donde instalaste las dependencias:
  si instalaste en Windows, corré `pnpm` en Windows; en WSL, `pnpm` intentará reinstalar `node_modules`.

Si `pnpm` no es una opción, invocá la CLI mediante `node .harness/bootstrap.mts <comando>` para conservar la carga de
`.harness/.env`. La suite completa es `pnpm harness:test` (unittest Python más tests Node). `core.mts` conserva
compatibilidad y pasa por el mismo bootstrap.

## 3. Flujo básico

### Paso 1. Comprobar que el Harness está sano

```bash
pnpm harness:check
```

Debe terminar con `Harness check: OK`. Un aviso `Legacy failed evidence ...` es informativo: es evidencia histórica que
no se puede reintentar y no afecta el uso.

### Paso 2. Crear el plan de una tarea

Elegí un dominio o dejá que el Harness lo deduzca:

```bash
pnpm harness:run -- api "agregar endpoint de listado de eventos con paginación"
pnpm harness:run -- backoffice "mostrar el estado del evento en la tabla"
pnpm harness:run -- auto "modificar apps/api y el docker de infra"
pnpm harness:run -- auto --file especificacion.md
```

Dominios disponibles: `api`, `backoffice`, `provider-portal`, `sales-portal`, `infra`, `docs`, `repo` y `auto`. `n8n` y las aplicaciones placeholder
(`marketplace`, `planner-portal`, `workers`) están declaradas pero deshabilitadas:
pedirlas falla con un mensaje explícito.

`run <domain|auto> <task>` crea un plan sin ejecutar agentes. Imprime el plan en JSON; anotá el `id` (por ejemplo
`20260929140419-ec27bb`). Si usaste `auto` y el resultado tiene `"domain": "multi"`, la tarea se dividió en varias
hijas, una por dominio.

Ante ambigüedad, `auto` es una heurística conservadora. Revisá el plan y usá un dominio explícito si no coincide con lo
que querés.

Para especificaciones largas, usá `--file`. El contenido no pasa por la línea de comandos: se guarda íntegro en
`tasks/sources/<id>.txt` y los agentes reciben extractos con números de línea. Para leer el original por partes:

```bash
node .harness/bootstrap.mts source <task-id> 0 4000
```

### Paso 3. Configurar el host local y ejecutar

La primera vez en cada checkout, creá la configuración local del Harness:

```bash
cp .harness/.env.example .harness/.env
```

Editá `.harness/.env` y elegí el host que usa esa máquina:

```dotenv
HARNESS_HOST=codex
```

o:

```dotenv
HARNESS_HOST=claude
```

`.harness/.env` está ignorado por Git: cada desarrollador puede usar Codex o Claude Code sin modificar archivos
versionados. No guardes tokens, claves ni otras credenciales ahí; usalo sólo para configuración operativa del Harness.

Después ejecutá normalmente:

```bash
pnpm harness:execute -- <task-id>
```

Todos los comandos `pnpm harness:*` que pasan por la CLI entran por `.harness/bootstrap.mts`, que carga `.harness/.env`
antes de inicializar el motor. La precedencia es **variable del proceso/terminal > `.harness/.env` > defaults
internos**.

Para sobrescribir el host sólo en una ejecución, sin editar el archivo:

```bash
HARNESS_HOST=claude pnpm harness:execute -- <task-id>
```

En PowerShell:

```powershell
$env:HARNESS_HOST = "claude"; pnpm harness:execute -- <task-id>
```

Sin `HARNESS_HOST` (ni `HARNESS_AGENT_COMMAND`) los nodos que necesitan un agente quedan `blocked`: es a propósito, para
no ejecutar nada sin que lo elijas.

`execute` corre el DAG completo: `context-manager → especialistas → reviewer → security-auditor (si corresponde) →
verifier → logger`. Puede tardar. Al final imprime la tarea en JSON y devuelve **exit code 0 sólo si quedó
`completed`**.

Se puede interrumpir con Ctrl+C y retomar con el mismo comando: el nodo interrumpido se reanuda en la siguiente
ejecución.

### Paso 4. Ver el resultado

```bash
pnpm harness:status -- <task-id>   # JSON completo de la tarea
pnpm harness:list                  # resumen de todas las tareas y sus nodos
```

Cada nodo tiene un estado: `pending`, `running`, `passed`, `failed` o `blocked`. El detalle de qué hizo y por qué falló
cada agente está en `.harness/handoffs/<task-id>-<agente>-<intento>.json` (campos `risks`, `decisions`, `verification` y
`nextAction`).

Un `completed` significa que todos los nodos pasaron y que los gates del dominio (lint, tests, build, etc.) dieron
verde. Igual revisá el diff antes de commitear: el Harness no hace commit ni push.

### ¿Qué está haciendo el Harness?

Mientras `harness:execute` corre (a veces decenas de minutos por nodo), abrí otra terminal:

```bash
pnpm harness:progress                       # tarea activa (la del lock vivo): barra, % y estado de cada nodo
pnpm harness:progress -- <task-id> --watch  # se refresca solo cada 3 s hasta que termina
pnpm harness:progress -- --watch --interval 10 --json
```

Salida de `--watch`: 0 si la tarea quedó `completed`, 1 si `failed`, 3 si sigue `active` pero bloqueada o interrumpida
(mirá la línea «Causa» y seguí con la sección 5). Es de sólo lectura: no toma locks ni cambia nada, así que se puede
usar cuando quieras. `harness:execute` también muestra en su stderr una línea por cambio de nodo
(`[harness] 3/7 43% reviewer ⟳`).

## 4. Estados de una tarea

```bash
tasks/inbox  →  tasks/active  →  tasks/completed
                      │
                      └────────→  tasks/failed  ⇄ (harness:retry) ⇄ tasks/active
```

- `active`: plan creado o en ejecución.
- `completed`: terminó y verificó bien.
- `failed`: un nodo falló sin reintentos disponibles, se abortó a mano o hubo una violación de scope.

## 5. Cuando algo sale mal

Mirá primero el último handoff fallido de la tarea (`.harness/handoffs/`) y el campo `risks`. Después buscá el síntoma
acá.

| Síntoma                                              | Causa probable                              | Qué hacer                                                                                  |
| ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Nodos en `blocked` con `Set HARNESS_HOST`            | No elegiste host                            | Configurá `HARNESS_HOST=codex` o `claude` en `.harness/.env` y volvé a ejecutar            |
| `Failed to authenticate` / `OAuth session expired`   | Claude sin sesión                           | Hacé `claude /login`, luego `pnpm harness:retry -- <id> "auth restaurada"` y `execute`     |
| `You've hit your usage limit`                        | Codex sin cuota                             | Esperá o cambiá a `HARNESS_HOST=claude`, luego `retry` y `execute`                         |
| `Host exit 124`                                      | El agente superó `HARNESS_AGENT_TIMEOUT_MS` | Subí el límite o dividí la tarea; `retry` y `execute`                                      |
| `Invalid structured agent result`                    | El agente no devolvió el JSON esperado      | El Harness ya reintenta solo; si se agotan, `retry` y `execute`                            |
| Gate fallido (verifier)                              | El código no pasa lint/tests/build          | El Harness reactiva a los implementadores con el feedback; si se agotan, corregí y `retry` |
| `Unresolved scope violation`                         | Un agente escribió fuera de su scope        | Ver sección 6                                                                              |
| `Task is already executing (lock: ...)`              | Otra ejecución usa el workspace             | Esperá a que termine; el lock de un proceso muerto se recupera solo                        |
| `Malformed lock; inspect owner before recovery`      | Archivo de lock corrupto en `state/`        | Confirmá que no hay otro `execute` corriendo y borrá ese `.lock` a mano                    |
| Aviso `Legacy failed evidence ... not retryable`     | Evidencia inválida en `tasks/failed`        | `pnpm harness:hygiene -- --quarantine-invalid --yes` (sin `--yes` es dry-run)              |
| Tareas `active` viejas o nodos `running` en `failed` | Ejecuciones interrumpidas                   | `pnpm harness:hygiene` lista cada caso con su `harness:abort` / `harness:retry`            |
| `Dominio desconocido o deshabilitado`                | Pediste un dominio no soportado             | Usá otro dominio o `auto`                                                                  |
| `Delegated prompt budget excedido`                   | Tarea demasiado grande                      | Dividila o usá `--file`                                                                    |

### Reintentar una tarea fallida

```bash
pnpm harness:retry -- <task-id> "motivo del reintento"
pnpm harness:execute -- <task-id>
```

`retry` sólo pasa a `pending` los nodos fallidos, bloqueados o interrumpidos. Conserva los intentos previos, los
handoffs, los logs y las fuentes. Con una tarea multi reabre también sus hijas fallidas.

### Cancelar una tarea

```bash
pnpm harness:abort -- <task-id> "motivo"
```

La mueve a `failed/` con el motivo y un evento de auditoría. En una tarea multi cierra también a las hijas activas. No
borra nada.

## 6. Violaciones de scope: cómo recuperarse

Cada agente sólo puede tocar los paths de su dominio. Antes y después de cada agente el Harness compara el estado de
todo el repositorio (incluidos `.env`, `secrets/` y otros archivos ignorados por git). Si un agente escribe fuera de su
scope, modifica algo siendo de sólo lectura, toca el estado interno de `.harness/` o cambia un archivo que no declaró en
su resultado, la tarea queda en `failed` con un `scopeViolation`.

Esto **no se soluciona reintentando**: `retry` se rechaza con `Unresolved scope violation ... restore pre-attempt
content/mode or absence for <archivos>` hasta que dejes el workspace como estaba antes del intento.

Procedimiento:

1. Leé los archivos del error de `retry` o `scopeViolation.restoration` en `harness:status`.
2. Para cada archivo:
   - **Archivo nuevo** que creó el agente: borralo.
   - **Archivo que ya existía y estaba limpio:** `git checkout -- <archivo>`.
   - **Archivo que ya tenías modificado sin commitear:** devolvé _tu_ contenido anterior. Volver a `HEAD` no alcanza y
     se rechaza, porque no es el estado previo al intento. Si no lo guardaste, revisá el diff en tu editor o en el
     historial local del IDE.
3. Corré `pnpm harness:retry -- <task-id> "scope restaurado"` y luego `execute`.

Casos especiales:

- **Tocó estado operacional protegido** (`tasks`, `state`, `handoffs` o `logs`): no hay recuperación automática. Auditá
  el daño, reparalo y creá una tarea nueva con `harness:run`.
- **Se cortó el proceso mientras corría un agente:** el siguiente `execute` compara contra el baseline guardado. Si
  encuentra una escritura ilegal registra la violación (mismo procedimiento de arriba); si sólo hay trabajo legal
  parcial, lo conserva y continúa.
- **Tarea multi:** `retry` verifica todas las hijas antes de reabrir ninguna. Resolvé todas las violaciones y reintentá
  el padre.

El Harness nunca restaura ni borra tus archivos por su cuenta.

## 7. Variables de entorno

La configuración persistente por máquina vive en `.harness/.env`; usá `.harness/.env.example` como plantilla. Las
variables exportadas en la terminal prevalecen sobre el archivo. Si una variable no está definida en ninguno de los dos,
se aplica el default interno indicado. `.harness/.env` no se versiona y no debe contener secretos.

| Variable                    | Para qué sirve                                                       | Default               |
| --------------------------- | -------------------------------------------------------------------- | --------------------- |
| `HARNESS_HOST`              | Host que ejecuta los agentes: `codex` o `claude`                     | sin definir (bloquea) |
| `HARNESS_AGENT_COMMAND`     | Comando propio en vez de un host; admite `{agent}`, nunca `{prompt}` | sin definir           |
| `HARNESS_MAX_RETRIES`       | Reintentos automáticos por nodo (0 a 10)                             | 2                     |
| `HARNESS_AGENT_TIMEOUT_MS`  | Límite de tiempo por agente; `0` lo desactiva                        | 1800000 (30 min)      |
| `HARNESS_GATE_TIMEOUT_MS`   | Límite de tiempo por gate de verificación                            | 600000 (10 min)       |
| `HARNESS_CLAUDE_MODEL`      | Modelo que se pasa a `claude --model`                                | el del CLI            |
| `HARNESS_CLAUDE_MAX_TURNS`  | Turnos máximos de Claude (1 a 200)                                   | el del CLI            |
| `HARNESS_MAX_WORKERS`       | Agentes simultáneos (1 a 16); `1` = ejecución secuencial de siempre  | 2                     |
| `HARNESS_ROLE_LIMITS`       | Tope por rol, p. ej. `backend=2,tester=1`                            | 2 por rol             |
| `HARNESS_HOST_LIMIT`        | Tope de agentes simultáneos por host                                 | 2                     |
| `HARNESS_PLANNER`           | `auto`, `directive` (sólo `unit:`) u `off`                           | `auto`                |
| `HARNESS_WORKTREE_DIR`      | Ruta absoluta para los worktrees aislados                            | carpeta temporal      |
| `HARNESS_ALLOW_HOST_WRITES` | `1` desactiva la guardia del orquestador en Claude Code              | sin definir           |
| `HARNESS_DEBUG`             | `1` imprime el stack completo de los errores de la CLI               | sin definir           |

Ejemplo persistente en `.harness/.env`: `HARNESS_HOST=claude`. Para una excepción puntual podés ejecutar
`HARNESS_HOST=codex HARNESS_MAX_RETRIES=1 pnpm harness:execute -- <id>`.

## 8. Encolar tareas desde archivos (inbox)

Poné un `.md` o `.txt` en `.harness/tasks/inbox/` con una línea `domain: <api|backoffice|infra|docs|repo|auto>` (sin
ella se usa `auto`) y el texto de la tarea, y corré:

```bash
pnpm harness:dispatch
```

Cada archivo genera una tarea y se elimina del inbox sólo después de persistir el plan; su contenido queda guardado como
fuente en `tasks/sources/<id>.txt`. Después ejecutá cada tarea creada con `harness:execute`.

## 9. Qué se guarda y qué se versiona

| Ruta           | Contenido                                           | ¿Se commitea?        |
| -------------- | --------------------------------------------------- | -------------------- |
| `tasks/`       | Tareas por estado, fuentes y `legacy/`              | No (sólo `.gitkeep`) |
| `handoffs/`    | Resultado de cada nodo e intento                    | No (sólo `.gitkeep`) |
| `state/`       | Checkpoint mínimo por tarea                         | No (sólo `.gitkeep`) |
| `logs/`        | Auditoría, cierres y trazas                         | No (sólo `.gitkeep`) |
| `specs/`       | Borradores locales de especificaciones              | No                   |
| `runtime/`     | Resultados temporales, baselines y agentes efímeros | No (sólo `.gitkeep`) |
| `.env`         | Configuración local del Harness                     | No                   |
| `.env.example` | Plantilla de configuración local                    | Sí                   |

Los `.gitkeep` sí se versionan para conservar la estructura de carpetas. `harness:check` falla si algo más bajo esas
rutas, salvo los `.gitkeep` vacíos esperados, entra al índice de git (se omite sólo sin repositorio git; otro error
de git falla cerrado). Corregir con `git rm --cached --ignore-unmatch -- <archivos>` (lista exacta que imprime el
check; no toca los `.gitkeep`). La evidencia de una entrega vive en el cuerpo del PR, no en el repositorio.

**Actualizar una copia local antigua:** si querés conservar el historial, respaldá `.harness/{tasks,handoffs,state,logs,specs}`
antes de `git pull`, porque git borra del disco los archivos que dejaron de versionarse; después restaurá la copia.

Los JSON los escribe la máquina: no los edites a mano, salvo para reparar una situación puntual y siempre con la tarea
detenida.

## 10. Verificación y mantenimiento

```bash
pnpm harness:test                  # tests del propio Harness (aislados, no tocan el repo)
pnpm harness:check                 # manifests, schemas, tareas y contratos
pnpm agent-config:check            # skills sincronizadas entre .codex, .claude y .agents
pnpm harness:verify -- api         # gates de un dominio
pnpm harness:verify -- --full      # Prettier + tests del Harness + verificación Enterprise
pnpm harness:verify -- --plan --explain   # qué checks se eligen y por qué (no ejecuta)
pnpm harness:verify -- --fast      # sólo checks dirigidos por el grafo (NO es la verificación autoritativa; no combina con --full)
pnpm harness:verify -- --keep-going  # no corta en el primer fallo
pnpm harness:report                # último resumen: fallos, omitidos, aprobados (exit ≠ 0 si está STALE o fue --fast)
pnpm harness:ci-gaps               # paridad CI <-> Harness (--strict: exit 1 si hay filas sin cobertura; --json)
pnpm harness:agents-doc            # regenera .harness/agents/*.md desde agents.json
pnpm harness:context -- api        # ver el contexto que recibiría un agente del dominio
pnpm harness:tokens -- --domain api
node .harness/bootstrap.mts path-check repo architect package.json   # ¿este agente puede escribir ese path?
```

Si cambiás `manifests/agents.json`, corré `harness:agents-doc`; `harness:check` falla si los contratos quedaron
desactualizados.

### Paridad CI ↔ Harness

`pnpm harness:ci-gaps` lista cada comando de `.github/workflows/*.yml` (cubierto por un gate, por un check dirigido,
sólo-CI, ignorado o sin cobertura) y cada workspace/script/gate/app del Harness que CI no ejecuta. Un step con
`continue-on-error`, `|| true` o `if: false` no cuenta como cobertura (`soft`), y si el workflow tiene un job `required`
el job que cubre debe estar en su `needs` (si no: `not-required`). Si aparece una fila `uncovered` o `not-required`,
agregá el job o gate que falta; sólo si es legítimo, documentá la excepción con motivo en
`manifests/ci-parity.json`. Detalle en `README.md` (sección «Paridad CI ↔ Harness»).

### Probar con un host real

```bash
pnpm harness:smoke-host -- claude
pnpm harness:smoke-host -- codex
```

Corren en un workspace temporal descartable y registran el resultado en `.harness/logs/audit/`. Un error de
autenticación o de cuota queda como `blocked`, nunca como éxito.

## 11. Buenas prácticas

- Una tarea, un objetivo. Las tareas grandes conviene dividirlas o darlas por `--file`.
- Revisá el plan de `run` antes de `execute`, sobre todo con `auto`.
- No ejecutes dos `execute` a la vez: el Harness lo impide con un lock del workspace.
- Antes de ejecutar, dejá el árbol de trabajo en un estado que puedas reconocer (idealmente con commit o stash). Si hace
  falta recuperarse de una violación de scope, sabrás exactamente a qué estado volver.
- Un `completed` no reemplaza tu revisión ni el CI.
- Al crear una app ejecutable nueva bajo `apps/*` con `scripts.dev`, integrá su arranque en `start.sh` en la misma tarea;
  `harness:test` lo valida y debe fallar si falta ese wiring.
- No commitees ni hagas push desde el Harness: es siempre una acción tuya.

## 12. Diagnóstico y runner

```bash
pnpm harness:doctor
pnpm harness:verify -- --plan
pnpm harness:run -- pnpm agent-config:check
```

`doctor` diferencia PASS/WARN/FAIL del entorno; sólo el host configurado es obligatorio. Un CLI presente no prueba
que su autenticación o modelo estén disponibles. `verify --plan` no ejecuta checks ni aprueba una entrega.
`verify` elige primero los checks `targeted` (tests/typecheck/lint/build de los workspaces y paquetes Go afectados por
el grafo de dependencias) y luego los `authoritative`; `--explain` dice por qué se eligió cada uno. Fuera de `--fast`
no se repiten `go vet`/`go test` dirigidos si el plan ya incluye `verify-enterprise.sh`. Los checks `pnpm` sin
`node_modules` instalado (`pnpm install`) quedan `SKIPPED_ENVIRONMENT`, y si `verify-enterprise.sh` termina bien pero su
`verification-report.json` informa pasos omitidos (p. ej. falta `golangci-lint` o `govulncheck`, que ya no son prerrequisitos del check) el check también queda
`SKIPPED_ENVIRONMENT` (`PARTIAL`, exit 3) con la lista de pasos.

| Resultado de `verify` | Exit         | Qué hacer                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`                | 0            | Todos los checks corrieron y pasaron.                                                                                                                                                                                                                                                                               |
| `FAIL`                | 1            | Hay un fallo real: `pnpm harness:report`, corregir y reintentar (`--keep-going` los lista todos).                                                                                                                                                                                                                   |
| `PARTIAL`             | 3            | Sin fallos, pero se omitieron checks por falta de `docker`/`go`/`pnpm`/`golangci-lint`…: **no es éxito**. Instalar o iniciar la herramienta y volver a correr; si no es posible, dejarlo declarado, nunca darlo por verificado.                                                                                     |
| `EMPTY`               | 4            | No se ejecutó ningún check fuera de `--full` (plan vacío, p. ej. cambios ya commiteados, o `--fast` sin checks dirigidos): **no es éxito**. Con cambios commiteados usar `verify --base <ref>` (p. ej. `--base origin/qa`; en clones que sólo tienen `origin/qa`, `--base qa` se resuelve a `origin/qa` con aviso). |
| uso inválido          | 2            | Opción o argumento inválido del CLI (no es un `FAIL` de verificación).                                                                                                                                                                                                                                              |
| `verify <dominio>`    | 6 (`report`) | Un dominio restringe los gates: el resultado se registra con ese dominio y sólo es autoritativo si cubre todos los dominios del mismo conjunto de cambios; si no, `report` sale 6.                                                                                                                                  |
| `--fast` en `PASS`    | 0            | Sólo cubre los checks dirigidos; falta correr `verify` completo antes de entregar. `harness:report` lo devuelve con exit 6.                                                                                                                                                                                         |
| `report` `STALE`      | 5            | El `HEAD` o los archivos cambiados ya no coinciden con los de la última verificación: volver a correr `verify`.                                                                                                                                                                                                     |

Tabla completa de exit codes de `verify`/`report`: 0 PASS, 1 FAIL, 2 uso inválido, 3 PARTIAL, 4 EMPTY, 5 STALE, 6
FAST/no autoritativo.

`verify` mide los cambios contra una base: `--base <ref>` > `HARNESS_BASE` > merge-base con `origin/qa` (si esa ref
existe y `HEAD` no es `qa`) > sólo cambios locales sin commitear. El plan y el resumen informan la base usada. Una base inválida, inexistente o sin valor es error de uso (exit 2). La selección dirigida de JS sólo se amplía a todos los workspaces si cambia un `<ws>/package.json` o ese `package.json` existía en la base; un README en un placeholder sin app no selecciona checks JS. El Harness conserva los 5 directorios `run-*` más recientes de `.artifacts/verify-enterprise/` (o de `REDEVENT_VERIFY_REPORT_DIR`). Los
artefactos generados declarados en `manifests/policies.json` (`generatedArtifacts`: `*.tsbuildinfo`, `next-env.d.ts`) no
entran en la huella; si otro archivo cambia durante la verificación el resumen lo marca como `SELF-ALTERED` y `report` lo
da por `STALE`.

En el lifecycle, un `SKIPPED_ENVIRONMENT` deja el verificador `blocked` (o el multi sin cerrar) con el motivo y la tarea
queda `active`; corregí el entorno y volvé a correr `pnpm harness:execute -- <id>`. `harness:retry` no aplica: sólo
acepta tareas `failed`.
La variante runner de `run` acepta ejecutables permitidos, conserva logs sanitizados locales y muestra un resumen.
No acepta comandos destructivos, Git de entrega ni código inline no autorizado.

Si aparece `Python runtime checksum mismatch` o `Managed Python integrity failure`, detener ejecuciones activas,
inspeccionar el runtime local y retirar únicamente `.harness/runtime/python/` para reprovisionar. No modificar
checksums para aceptar un archivo corrupto. Windows/Git Bash usan Python Windows; WSL usa el artefacto Linux.
Una descarga bloqueada necesita acceso HTTPS a la release fijada, nunca instalar paquetes globales.

Si una interrupción deja `scopeValidationPending` o falta un baseline, el Harness conserva evidencia y deniega
el retry automático. Auditar manualmente el intento y crear una tarea nueva. Para ampliar el diseño (dominio,
agente o check), seguir la sección de extensión del [README](README.md) y regenerar contratos cuando corresponda.

## 13. Tareas con varias unidades en paralelo

Una tarea grande puede repartirse en **unidades** independientes que se ejecutan a la vez, cada una en su propio
worktree, y se integran al checkout al terminar. Es opcional: sin unidades, o con `HARNESS_MAX_WORKERS=1`, todo funciona
como antes.

1. Declarar las unidades en el texto de la tarea (o dejar que `auto` las proponga a partir de viñetas con rutas):

   ```text
   Implementar organizaciones y permisos

   unit: orgs  | agent=backend | owns=apps/api/internal/orgs/**  | weight=3
   unit: perms | agent=backend | owns=apps/api/internal/perms/** | weight=2
   unit: docs  | agent=documentation | owns=docs/api/**
   ```

2. Revisar el plan sin persistir nada: `pnpm harness:plan -- api --file tarea.md` muestra los nodos, el ownership, las
   dependencias, el speedup estimado y, si corresponde, por qué se decidió **no** repartir.
3. Crear y ejecutar como siempre: `pnpm harness:run -- api --file tarea.md` y `pnpm harness:execute -- <id>`. Cada
   `owns` es exclusivo: dos unidades con rutas solapadas se ordenan solas. `pnpm harness:progress -- <id> --watch` muestra
   varios nodos `⟳` a la vez.
4. Ver el resultado: `pnpm harness:metrics -- <id>` (duración, camino crítico, speedup, cola, integración, reintentos).

Qué hacer cuando algo sale mal:

- **Ctrl+C o cierre brusco**: la tarea sigue `active`. Volver a correr `pnpm harness:execute -- <id>`; los nodos
  interrumpidos se repiten y los agentes huérfanos se terminan. Los worktrees de los intentos cancelados se conservan
  como evidencia.
- **`integration-conflict`**: alguien modificó en el checkout un archivo que la unidad también cambió. No se pisó nada; la
  unidad se reintenta sobre el estado actual (o corregí a mano y `harness:retry`).
- **Limpieza**: `pnpm harness:hygiene` lista worktrees sobrantes; `pnpm harness:hygiene -- --prune-worktrees --yes` borra los
  de tareas completadas o abortadas (los patches y journals en `runtime/integration/` se conservan).
- **Medir**: `pnpm harness:bench` compara secuencial vs paralelo con un host simulado, sin consumir tokens.

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
