# PR: Chat Harness sigue a Codex 0.169, errores tipados, memoria y mandos del chat

Rama `feat/chat-harness-codex-parity-upgrade` → `main`. Un solo PR; commits internos por bloque.
Etiqueta sugerida al abrirlo: `sin-release` hasta contar con un candidato instalado del SHA final.

## Resumen

Codex CLI publica una versión por semana y el candidato anterior solo aceptaba la 0.166: cualquier
actualización degradaba el chat al canal estructurado. Además enviaba una política de aprobación que la
documentación oficial ya retiró. Este PR audita el protocolo real (0.166.0 y 0.169.0, sin llamadas al
modelo), regenera los tipos, pasa a compatibilidad por rango y cierra las brechas de experiencia que esa
auditoría dejó a la vista.

## Cambios

### Runtime Codex (P0)

- Tipos del protocolo regenerados desde Codex CLI 0.169.0 (cambios aditivos); `generate-codex-protocol.mts`
  admite `CODEX_BIN` para generar desde un binario concreto.
- Compatibilidad por rango: piso 0.166.0. Un CLI más nuevo que lo validado sigue en transporte nativo y lo
  avisa una vez; uno más viejo cae al canal estructurado y explica por qué.
- Escritores con `approval_policy = on-request` (la documentada); `untrusted` dejó de enviarse.
- Aprobaciones `humanCommand` (0.169): decisión única; un alcance «esta sesión» del IDE se acota a ese comando.
- `codexErrorInfo` → códigos estables (`RUNTIME_CONTEXT_EXCEEDED`, `RUNTIME_RATE_LIMITED`,
  `RUNTIME_UNAUTHENTICATED`, `RUNTIME_PROVIDER_UNAVAILABLE`, `RUNTIME_MODEL_UNAVAILABLE`,
  `RUNTIME_POLICY_BLOCKED`) con pista de recuperación en el chat.
- Subagentes: el apagado explícito agrega `agents.enabled=false` (clave que 0.169 documenta; 0.166 la acepta).

### Memoria, consumo y latencia (P1/P2)

- La memoria compactada guarda por corrida los archivos editados, los gates fallidos, descartes,
  reversiones y continuaciones, solo a partir de registros del IDE.
- Latencia hasta el primer token medida por turno en ambos adaptadores; `/costo` la muestra.
- Recibos de consumo de hilos hijos de Codex sumados al turno cuando el servidor los emite; hilos ajenos
  ignorados; sin recibos no se estima y el presupuesto sigue bloqueado.

### Chat (P1)

- `/checkpoints` y `/checkpoints restaurar ID`: mismos registros, confirmación, fence y lease que la paleta.
- `/objetivos`, `/objetivos pausar ID`, `/objetivos detener ID`.

### Documentación

README, guía del chat, historial, matriz de paridad, evidencia competitiva y el checklist maestro
`docs/CHAT_HARNESS_UPGRADE_2026-11.md`.

## Verificación

Ver «Validación local» en `docs/CHAT_HARNESS_UPGRADE_2026-11.md`. Los resultados allí son de la corrida local
sobre el último commit de la rama; el CI de Linux y Windows del SHA final debe revisarse antes del merge.

## Fuera de alcance y bloqueos

- Sin llamadas reales a Claude ni a Codex (cuota no autorizada).
- Sin build instalado del SHA: capturas y accesibilidad pendientes, como en el PR #86.
- Navegador interactivo y delegación remota siguen bloqueados por decisión vigente.
- Pruebas Rust no ejecutadas (sin `cargo`).

## Changelog

### Added

- Compatibilidad por rango con Codex CLI (0.166.0 a 0.169.0 validados) y aviso ante versiones más nuevas.
- Aprobaciones `humanCommand` de decisión única.
- Códigos de error estables para fallos tipados de Codex, con próximo paso en el chat.
- Recibos de consumo de subagentes y latencia al primer token en `/costo`.
- Comandos `/checkpoints` y `/objetivos`.
- Memoria compactada con archivos editados, verificación, descartes y reversiones.

### Changed

- Escritores Codex usan `on-request` en lugar de la retirada `untrusted`.
- El apagado de subagentes también envía `agents.enabled=false`.
- Tipos del protocolo app-server generados desde 0.169.0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
