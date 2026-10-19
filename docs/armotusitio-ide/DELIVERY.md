# ArmoTuSitio IDE: estado de la implementación

## Fuentes de verdad
- `Drako01/armotusitio2.0`: `package.json`, `harness/QUICKSTART.md`.
- `Drako01/redevent`: `package.json`, `.harness/bootstrap.mjs`.
- Los comandos disponibles se detectan por proyecto. Un script ausente nunca aparece como ejecutable.

## Disponible en la rama
1. Tema ArmoTuSitio Dark y Light.
2. Selector por proyecto y comandos de harness; ejecuciones como tareas VS Code, con cancelación.
3. Validación estructural de planes DAG Codex/Claude (solo revisión).
4. Inventario acotado de archivos para contexto, sin leer contenido ni seguir enlaces simbólicos.
5. Visualización de worktrees, creación aislada tras confirmación.
6. Acceso a GitHub mediante comandos de solo lectura de `gh` local.
7. Apertura del dashboard n8n usando una URL configurable, sin credenciales embebidas.
8. Ejecución de `codex exec` o `claude -p` después de una confirmación visible.
9. Tests de contratos y workflow de CI para la extensión.

## Requisitos locales
- Node 24 y el entorno de build requerido por este checkout de Code - OSS.
- pnpm compatible con cada repositorio.
- `gh` instalado y autenticado para comandos de GitHub.
- CLI de Claude/Codex instalada y autenticada para ejecutar agentes.
- n8n disponible en la URL local configurada cuando corresponda.
- Workspace marcado como confiable para ejecutar tareas.

## Comprobación manual recomendada
- `npm run check --prefix extensions/armotusitio-ide`
- `npm test --prefix extensions/armotusitio-ide`
- Lanzar el entorno de desarrollo Code - OSS según `CONTRIBUTING.md`.
- Abrir los dos proyectos y verificar vista lateral, commands, cancelación y diferentes versiones de pnpm.
- Comprobar que los proveedores no lanzan comandos sin autorización.

## NO validado ni completo
Esta rama **no es una release**. No están probados el build completo de Code - OSS ni E2E Windows.
No se han construido todavía un dashboard multiagente con streaming estructurado, orquestación automática completa, memoria semántica persistente, aprobación/revisión automática de PR, autenticación n8n por API, centro de migraciones, telemetría fiable de tokens, instaladores firmados, actualizador de binarios ni sincronización upstream de producción.

No publicar ni fusionar por considerarlo 100% terminado. Antes de llamar a esto v1.0, cada área requiere pruebas funcionales con evidencia.
