# 9. Configurar permisos

[← Anterior: Historial](08-historial.md) · [Índice](../../README.md#índice) · [Siguiente: Comparativa de chats →](10-comparativa-chats.md)

El Chat Harness pide confirmación antes de cada acción sensible: hacer push, crear una rama, abrir un pull request o correr un CLI externo como `gh`. Esta guía explica cómo guardar reglas para que esas preguntas dejen de aparecer en tus proyectos, y qué controles no se pueden desactivar.

Todo lo que se describe acá vale igual para **Claude Code** y para **Codex**: los dos piden permiso a través del IDE y el IDE decide con las mismas reglas.

## Dónde se guardan las reglas

| Archivo | Quién lo escribe | Qué puede hacer |
|---|---|---|
| `~/.armotusitio/permissions.json` | Vos | Permitir (`allow`), preguntar (`ask`) y denegar (`deny`). Es el **único** lugar donde se dan permisos. |
| `<proyecto>/.armotusitio/permissions.json` | El repositorio | Solo **agregar** `ask` y `deny`. Si trae `allow`, el IDE lo ignora y avisa. |

En Windows, `~` es tu carpeta de usuario, por ejemplo `C:\Users\<usuario>\.armotusitio\permissions.json`.

El archivo del proyecto no puede dar permisos para que un repositorio clonado no se autorice solo. Si querés que el agente pueda hacer algo sin preguntar, la regla va en tu archivo de usuario.

Para ver o crear los archivos desde el chat:

| Comando | Qué hace |
|---|---|
| `/permisos` | Muestra el preset, las reglas efectivas para el proyecto abierto y los permisos temporales. |
| `/permisos usuario` | Abre (o crea) tu archivo de usuario. |
| `/permisos proyecto` | Abre (o crea) el archivo del proyecto. |
| `/permisos quitar REGLA` | Borra una regla guardada. |

Responder **Siempre** en una tarjeta de permiso también guarda la regla en tu archivo de usuario.

## Formato del archivo

```json
{
  "version": 1,
  "allow": [],
  "ask": [],
  "deny": [],
  "projects": {
    "c:/work/mi-app": {
      "allow": []
    }
  }
}
```

- `version` es obligatorio y vale `1`.
- `allow`, `ask` y `deny` en el nivel superior valen para **todos** tus proyectos.
- `projects` agrupa reglas que valen solo para un proyecto. La clave es la ruta de la carpeta raíz con `/`, sin barra final y, en Windows, en minúsculas (`c:/work/mi-app`, no `C:\Work\Mi-App\`).
- Hasta 200 reglas por sección y 16 KiB por archivo.

> **Importante:** si el archivo tiene un error (JSON inválido, una clave desconocida o una regla mal escrita), el IDE **deniega todas las acciones** hasta que lo corrijas. `/permisos` muestra el motivo. Antes de editarlo a mano, guardá una copia.

## Reglas

| Regla | Qué permite |
|---|---|
| `git_fetch` | Traer cambios del remoto. |
| `git_branch_create` | Crear o reutilizar una rama. |
| `git_commit` | Commitear archivos concretos. |
| `git_push` | Hacer push de la rama actual a su rama del mismo nombre. |
| `git_pr_upsert` | Crear o actualizar el pull request de la rama en GitHub. |
| `run:<patrón>` | Correr un comando. `*` reemplaza cualquier texto: `run:pnpm test*`. |
| `edit:<patrón>` | Borrar o mover archivos con las herramientas del IDE (ruta relativa al proyecto). |
| `mcp:<servidor>/<herramienta>` | Usar una herramienta de un servidor MCP que agregaste vos: `mcp:github/*`. |
| `web:<host>` | Leer páginas de un sitio: `web:docs.python.org`. |

Las reglas de git se escriben solas (`git_push`) para que valgan en cualquier proyecto, o con la ruta del proyecto (`git_push:c:/work/mi-app`) para que valgan solo en ese.

Responder **Siempre** en la tarjeta de commit, push, rama, fetch o pull request guarda la regla solo para el proyecto abierto.

`git_commit` rechaza commits en `main`, `master`, `develop`, `trunk`, la rama por defecto del remoto y las ramas de `atsHarness.protectedBranches`. El agente crea primero una rama de trabajo con `git_branch_create`, y los cambios locales pasan con él a la rama nueva.

### Orden de prioridad

1. El **piso de seguridad** (ver más abajo). Ninguna regla lo atraviesa.
2. `deny`, después `ask`, después `allow`. Un `deny` en cualquier archivo gana siempre.
3. Si ninguna regla coincide, decide el **preset**.

## Presets

El preset es la respuesta por defecto cuando ninguna regla coincide. Se elige en los ajustes con `atsHarness.permissionsPreset`.

| Acción | `readonly` | `dev` (predeterminado) | `trusted` |
|---|---|---|---|
| Comandos del proyecto (`pnpm test`, `go build`...) | Solo consulta | Permitidos | Permitidos |
| Instalar o actualizar dependencias | Denegado | Pregunta | Pregunta |
| CLI externos (`gh`, `docker`, `aws`, `curl`...) | Denegado | Pregunta | Pregunta |
| `git_fetch` | Denegado | Permitido | Permitido |
| `git_commit` | Denegado | Pregunta | Permitido |
| `git_branch_create`, `git_push`, `git_pr_upsert` | Denegado | Pregunta | Pregunta |
| Servidores MCP y páginas web | Denegado | Pregunta | Pregunta |

Ningún preset permite push, ramas, pull requests ni CLI externos sin preguntar: para eso hacen falta reglas.

Las instalaciones que solo restauran lo que fija el lockfile (`pnpm install`, `npm ci`, `composer install`, `uv sync`, `poetry install`, sin nombrar paquetes) se pueden aprobar con **Siempre en este proyecto**. Agregar un paquete nuevo (`pnpm add zod`, `npm install lodash`) se pregunta cada vez.

## Recetas

### Git y GitHub sin preguntas en todos tus proyectos

```json
{
  "version": 1,
  "allow": [
    "git_fetch",
    "git_branch_create",
    "git_commit",
    "git_push",
    "git_pr_upsert",
    "run:gh",
    "run:gh *"
  ]
}
```

### Git y GitHub sin preguntas solo en algunos proyectos

```json
{
  "version": 1,
  "projects": {
    "c:/work/api": {
      "allow": [
        "git_fetch:c:/work/api",
        "git_branch_create:c:/work/api",
        "git_commit:c:/work/api",
        "git_push:c:/work/api",
        "git_pr_upsert:c:/work/api",
        "run:gh",
        "run:gh *"
      ]
    },
    "c:/work/web": {
      "allow": [
        "git_fetch:c:/work/web",
        "git_branch_create:c:/work/web",
        "git_commit:c:/work/web",
        "git_push:c:/work/web",
        "git_pr_upsert:c:/work/web",
        "run:gh",
        "run:gh *"
      ]
    }
  }
}
```

Un error frecuente es copiar una regla con la ruta de un proyecto (`git_push:c:/work/api`) al nivel superior esperando que valga para todos. Vale solo para ese proyecto, aunque `/permisos` la liste entre las reglas de "todos los proyectos": esa etiqueta indica dónde está guardada, no dónde aplica.

### CLI de GitHub (`gh`)

- Las consultas (`gh pr view`, `gh pr checks`, `gh run list`, `gh issue list`, `gh auth status`...) nunca preguntan.
- El resto (`gh pr merge`, `gh api`, `gh release create`...) necesita una regla que **nombre** a `gh`: `run:gh` y `run:gh *`. Un comodín general como `run:*` no alcanza para los CLI externos.
- Nunca se pueden permitir: el resto de `gh auth` (incluido `gh auth status --show-token`), `gh secret`, `gh ssh-key`, `gh gpg-key`, `gh extension`, `gh alias` y `gh config set`. Su salida puede incluir tokens, y esa salida le llega al agente. Iniciá sesión vos en tu terminal (`gh auth login`) y el agente usa esa sesión.

Lo mismo aplica a `docker`, `aws`, `az`, `gcloud`, `kubectl`, `terraform`, `vercel` y `curl`: `run:docker *`, `run:terraform plan*`, etc.

### Comandos propios del proyecto

Los comandos del ecosistema detectado (`pnpm`, `go`, `cargo`, `dotnet`, `pytest`...) ya están permitidos con el preset `dev`. Para sumar otro, como `make test`, usá el ajuste `atsHarness.agentCommands.allow` o una regla `run:make test*`.

## Comandos de terminal: qué corre solo, qué pregunta y qué se rechaza

- **Líneas compuestas.** `git status && git diff`, `pnpm test 2>&1 | tail -20` o `NODE_ENV=test pnpm test` se juzgan comando por comando con las mismas reglas. Si todos pueden correr, la línea corre. Si alguno pide permiso, una sola tarjeta muestra la línea completa (solo esa vez). Si alguno se rechaza, se rechaza la línea y el mensaje dice cuál. `cd`, `$(...)`, comodines sin comillas, `&` y redirecciones a archivos siguen rechazados.
- **Lecturas.** `git branch -a`, `git remote -v`, `git stash list`, `git tag -l`, `git worktree list`, `git config --get <clave>` y los lectores de shell (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `diff`...) corren sin preguntar, solo dentro del proyecto. Las claves de configuración que pueden tener credenciales (URLs, tokens) no se leen.
- **Archivos de credenciales.** `.env`, `.ssh`, `.aws`, claves y similares se rechazan igual desde la terminal que desde Read, Grep y Glob. Las copias de ejemplo (`.env.example`) sí se leen.
- **Código en línea.** `node -e`, `python -c`, `powershell -Command`, `bash -c` y `cmd /c` muestran el código completo en una tarjeta y se aprueban cada vez; nunca se guardan como regla. Se rechazan sin preguntar si el código borra, usa la red, publica, eleva privilegios, lee credenciales o deja procesos en segundo plano.
- **Programas del proyecto.** `node scripts/build.mjs` o `python tools/gen.py` piden aprobación (como `bash script.sh`). `node --test`, `python -m pytest` y las herramientas de `vendor/bin` siguen corriendo solas.
- **Reglas por familia.** La tarjeta ofrece «Siempre `cargo test *`»: guarda la regla exacta y la de la familia, para no aprobar cada variante. No se ofrece para CLI externos (`gh`, `docker`...), instalaciones ni código en línea.
- **Configuración de git durante la ejecución.** Los cambios que escriben el editor o las herramientas de GitHub (upstream de la rama, merge-base, datos del PR) se aceptan solos. Otro cambio pide una tarjeta con los nombres de las claves (nunca los valores), válida solo para esa ejecución. Los cambios de hooks o de claves que deciden qué ejecuta git (`core.hooksPath`, helpers, filtros, alias) se rechazan siempre.

## Lo que no se puede habilitar

Estos controles protegen tu máquina y tus credenciales y ninguna regla los desactiva.

| Bloqueo | Motivo | Alternativa |
|---|---|---|
| Shells con código suelto: `powershell -Command`, `bash -c`, `cmd`, `wsl` o un shell interactivo | Un shell ejecuta cualquier cosa y saltearía todos los demás controles. | Un script del proyecto: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1` o `bash scripts/setup.sh`. Pide aprobación (o una regla que nombre ese script) y solo acepta rutas dentro del proyecto. |
| Operadores de shell: `&&`, `\|`, `;`, `>` | Mismo motivo. | Un comando por paso. |
| `git pull`, `git merge`, `git rebase`, `git stash`, `git checkout -- archivo`, `git reset` | Pueden pisar trabajo local o reescribir historia. | Para traer lo último: `git_fetch` y una rama nueva desde `origin/<base>`. Para descartar lo que hizo el agente: `/deshacer` o `/checkpoints`. El resto, desde tu terminal. |
| Código en línea: `node -e`, `python -c` | Mismo motivo. | Un script versionado en el proyecto. |
| Borrado con `rm`, `del`, `Remove-Item` | Irreversible. | Las herramientas de borrar y mover del IDE (permitidas con `dev`; las reglas `edit:` las restringen por ruta). |
| `sudo`, `runas` | Elevación de privilegios. | Correlo vos. |
| Login y lectura de secretos de cualquier CLI | El secreto llegaría al agente. | Iniciá sesión vos en tu terminal. |
| Archivos fuera del proyecto, dentro de `.git` o `.armotusitio` | Integridad del repositorio y de los permisos. | — |
| Push a `main`, `master`, `develop`, `trunk` y a las ramas de `atsHarness.protectedBranches` | Las ramas protegidas se actualizan por pull request. | `git_pr_upsert`. |

## Problemas frecuentes

### "Lo aprobé con Siempre y me lo vuelve a preguntar"

- Revisá con `/permisos` que la regla aparezca en **Permisos efectivos** del proyecto abierto. Si no está, probablemente tiene la ruta de otro proyecto.
- Para `gh` y otros CLI externos, la regla tiene que nombrar al CLI (`run:gh *`).
- Una instalación que nombra un paquete (`pnpm add zod`) se pregunta siempre; `pnpm install` o `npm ci` sin paquetes se pueden recordar.

### `POLICY_DENIED: repo-config-changed`

No es un problema de permisos y ninguna regla lo evita. Al empezar una ejecución, el IDE toma una huella de `.git/config` y de los hooks del repositorio; si cambian antes de un commit o un push, lo rechaza para que nadie desvíe el push cambiando un remoto o un hook a mitad de camino.

Las claves que las extensiones de Git y de pull requests del editor guardan por rama (`vscode-merge-base`, `github-pr-*`) no cuentan como cambio. Si igual aparece, algo modificó un remoto, un hook u otra configuración: revisá qué cambió con `git config --local --list` y, si el cambio es legítimo, pedí el push en una ejecución nueva.

### `POLICY_DENIED: protected-branch` al commitear

El agente intentó commitear en una rama protegida. Lo corrige solo: crea una rama de trabajo con `git_branch_create` y vuelve a commitear ahí.

### `POLICY_DENIED: invalid-arguments`

El agente llamó a una herramienta de git con un argumento mal escrito (por ejemplo `name` en lugar de `branch`). El mensaje dice qué falta y qué se esperaba, y el agente lo corrige en el siguiente intento.

### `POLICY_DENIED: project-permissions-changed`

El archivo `.armotusitio/permissions.json` del proyecto cambió durante la ejecución. Revisá el cambio y empezá una ejecución nueva.

### Todo aparece denegado

Tu archivo de permisos tiene un error. `/permisos` muestra cuál; corregilo o restaurá la copia.
