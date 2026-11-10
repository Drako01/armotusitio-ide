# PR #86 – traspaso de sesión (2026-11-10)

> Documento operativo, no certificado de aprobación. Todo hallazgo requiere verificación con evidencia del SHA final.

## Identidad y alcance

- Repositorio: [Drako01/armotusitio-ide](https://github.com/Drako01/armotusitio-ide)
- PR: [#86](https://github.com/Drako01/armotusitio-ide/pull/86), abierto como **Draft**, base `main`.
- Rama: `feat/chat-harness-competitive-parity`.
- **SHA observado antes de este commit de traspaso:** `10ce38ad0a83dbdcb0372afb828ec7e215d53484` (51 commits en el PR).
- Autoría obligatoria: Alejandro Daniel Di Stefano – ArmoTuSitio.com.ar, conservando los avisos/licencias upstream de Microsoft y metadatos originales de personalización.
- Restricciones: no merge, tags, release, consumo de cuota autenticada, despliegue ni bypass de Husky sin autorización; no modificar `main` directamente. Cambios aditivos y KISS/DRY/YAGNI/SOLID. Commits convencionales en la rama del PR, evidencia por SHA.
- Los archivos locales del usuario **no están en el PR**. La copia local quedó limpia y sincronizada hasta `8bfdefa`; el respaldo original está en `stash@{0}` (`BACKUP PR86 multimodal pendiente de integracion`). No borrar ni aplicar ese stash sin evaluar divergencias. El parche `F:/PR86-local-changes.patch.txt` nunca se adjuntó; se decidió reconstruir las funciones directamente en GitHub.

## Estado de CI reproducible

- Run en el SHA previo al traspaso: [ATS IDE Extension #42902553247](https://github.com/Drako01/armotusitio-ide/actions/runs/42902553247): `changes` PASS, `contract` Linux FAIL, `contract-windows` FAIL, `ATS gate` FAIL.
- Los dos tests fallaron en ambos SO:
  1. `test/native-chat-attachments.test.mts`, extracción PDF: `HARNESS_DOCUMENT_INVALID` (revisar fixture, parser y carga del worker).
  2. `test/native-user-mcp-legacy-sse.test.mts` en denegación de solicitud entrante `roots/list`: contador esperado 1, observado 0. Revisar parseo y secuencia del evento/POST. No relajar la política de denegación.
- No existe evidencia de CI completamente verde para el último bloque. El `check` TypeScript, `compile`, VSIX/recursos, `npm run precommit` y suite total **deben** verificarse otra vez para el SHA final; advertencias y pruebas SKIP se registran sin presentarlas como PASS.
- Muchos commits pequeños dispararon CI con `cancel-in-progress`; consolidar reparaciones y esperar resultados del nuevo SHA.

## Implementación remota existente (requiere validación integral)

| Bloque | Realizado | Estado abierto |
|---|---|---|
| Chat / imágenes | Selector existente, pegado y drag/drop PNG/JPEG, vista previa en memoria, validación de bytes y consentimiento modal del host | E2E de interfaz, accesibilidad, persistencia/privacidad y proveedor real |
| Documentos | `native-chat-attachment-file.ts`, `native-chat-attachments.ts`, worker `.mts`, PDF.js fijado, rutas de empaquetado ESM, comando `/documento` y `atsHarness.documentInput` opt-in | Test PDF fallido, validación del PDF.js en VSIX instalado, entrada host/proveedor y límites reales. Asegurar que la ruta del worker sea `.mjs`. |
| MCP | Legacy SSE opt-in con endpoint, broker y credenciales; tratamiento de mensajes iniciados por servidor en SSE/HTTP (ping inerte, denegación de privilegios) | Test SSE fallido; auditar ciclo de vida, timeout, cancelación, redirects, errores y revocación; conservar HTTP JSON/SSE y stdio |
| Subagentes Codex | Campo `nativeSubagents` en draft revisado y flags limitados/read-only en comando Codex | **No integrado** a un workflow de delegación completo; no probado el presupuesto agregado, permisos heredados, ciclo de vida/cancelación de todos los hijos ni compatibilidad con CLI instalada. Claude debe continuar con roles aislados sin herramientas. |
| Checkpoints | Reversión previa por ejecución y archivo, con rechazo de edición humana posterior | **Falta** checkpoint atribuido por turno y herramienta, almacenamiento acotado, snapshot propietario y restauración granular segura preservando cambios humanos |
| Skills/branding | 10 skills nativas, seis extensiones, personalizaciones y autoría preservadas en trabajos previos | Revisar que toda nueva pantalla/comando/documentación conserve metadatos |
| Documentación | Checklist `docs/CHAT_HARNESS_UPGRADE_PROGRESS.md` con evidencia histórica | Conciliar checklist con el código nuevo, README principal y capturas actuales, sin inventar screenshots |

## Pendientes de aceptación y controles externos

- Candidato instalado Windows x64: inicio, teclado, navegación, accesibilidad/lector de pantalla, recuperación y seis extensiones; comprobar instalación real y UX. Linux, macOS y WSL según entornos disponibles.
- E2E autenticados y benchmarks reales de Codex y Claude: **bloqueados por autorización de cuota**, no simular ni ejecutar silenciosamente llamadas pagas.
- Tests Rust: no hubo `cargo` disponible en el entorno local original. Reintentar en un runner apto; no marcar PASS por ausencia.
- Navegador y agentes cloud: opcionales, requieren autorización e aislamiento; no activar por defecto.
- Revisión de seguridad final: permisos, path traversal, symlinks, enlaces, URLs, secretos, tamaño/memoria, prompt injection, consentimiento y cancelación.
- Última ejecución de CI sobre el SHA final, todos los checks requeridos en verde; solo entonces plantear levantar Draft y mergear, sin hacerlo de forma automática.

## Próximas acciones ordenadas

1. Releer el head actual del PR y los logs exactos del CI. Corregir los dos tests rojos sin debilitar los controles.
2. Ejecutar typecheck de `tsconfig.json` y `tsconfig.worker.json`, compile, packaging VSIX, precommit e integración Linux/Windows.
3. Completar Codex nativo con delegación realmente accesible desde el Harness, permisos/cupos heredados, cancelación y pruebas aisladas sin cuota.
4. Implementar checkpoints per-turn/per-tool seguros y sus tests de conservación de ediciones humanas.
5. Integrar y validar multimodal/MCP en producto; actualizar README con capturas reales y checklist fase por fase.
6. Ejecutar criterios externos donde haya entorno y autorización; documentar bloqueos verificables, no transformarlos en checks verdes.

**Criterio de salida:** NO afirmar «100% terminado» ni «listo para mergear» hasta que los criterios implementables y verificables pasen, el CI sobre SHA final sea verde y el checklist refleje la evidencia. Mantener el PR Draft mientras tanto.


## Continuación registrada después del handoff original — 2026-11-10

Se continuó sobre la misma rama, preservando el stash local y el histórico.
La fuente de progreso detallado es `docs/CHAT_HARNESS_UPGRADE_PROGRESS.md`;
la lista de commits es `12988b4`, `dc92d47`, `3ff6e67`,
`79a7ea4`, `290f6de`, `a0334ad` y `025b90b`.

Se incorporaron correcciones PDF/MCP, un selector opt-in de subagentes
Codex de solo lectura con límites y fail-closed de presupuesto,
hardening de descartes por corrida y un journal granular acotado
de herramientas secuenciales. Los tests nuevos **no constituyen PASS**
hasta verificarse en CI Linux/Windows y un candidato instalado.
El README principal se actualizó; las capturas reales de instalación,
accesibilidad y seis extensiones continúan abiertas conforme a
`docs/PR86_SCREENSHOT_CAPTURE.md`.

El PR **sigue Draft**. No declarar listo para merge ni publicar release
antes de cerrar fallos, pruebas de instalación, las validaciones de
permisos/cancelación y las evidencias que requieran entorno o cuota.
