# Native Engineering Skills Pack

## Implementation checklist

### Estado general

- Rama: `feat/native-engineering-skills-pack`.
- Base y último commit previo: `ef4570db8d473596ecd8a955dde893bd7705cd92`.
- Fase actual: 1, Foundation, en progreso.
- Estado: implementación local autorizada; sin push, PR, merge, tags ni release.
- Fecha: 2026-11-09 (America/Buenos_Aires).
- Registro canónico de esta tarea: este archivo, solicitado por `PROMPT_CODEX.md`; no se mantiene un segundo estado.

### Fase 0 — Baseline

- [x] Reglas raíz y `.github/copilot-instructions.md`; sin reglas anidadas aplicables a las rutas modificadas.
- [x] Árbol inicial limpio salvo `PROMPT_CODEX.md`, entrada del usuario que se preserva sin incluirla en commits.
- [x] Base local coincide con último commit remoto consultado por GitHub connector; rama principal `main`.
- [x] Consulta remota de PRs abiertos: ninguno; rama local única creada desde la base indicada.
- [x] Revisados lector, comandos, sesión, integración, tests y empaquetado existentes; se reutilizan sin otro motor.
- [x] Identificados árboles de skills distintos: `.codex/skills` son convenciones del checkout, `src/vs/sessions/skills` pertenece al producto Sessions; no se sustituyen.
- [x] Referencia ArmotuSitio `main`: `harness/config/skills.toml`, blob `eae28d4b369e64e2d1ff1cae1a784b4cb34b45ee`; extraídos contratos, RBAC y gates, sin copiar rutas globales.
- [x] Referencia RedEvent: lectura acotada de skills de arquitectura, review, API, testing, seguridad y operaciones; sin modificaciones.

### Fase 1 — Foundation

- [x] Lector compartido con lectura acotada incluso si crece el archivo; conserva hashes y validación de directorios.
- [ ] Catálogo nativo con índice de metadatos, precedencia y lectura bajo demanda.
- [ ] Selección determinista con límites y trazabilidad.
- [ ] Integración en Chat Harness y ambos proveedores.

### Fase 2 — Skills P0

- [ ] Engineering Principles.
- [ ] Abstraction Auditor.
- [ ] Architecture Guardian.
- [ ] Safe Refactoring.
- [ ] Evidence Code Review.

### Fase 3 — Skills P1

- [ ] Design Patterns.
- [ ] Testing Strategy.
- [ ] API Contract Integrity.

### Fase 4 — Skills P2

- [ ] Security by Design.
- [ ] Performance Engineering.

### Fase 5 — Integración y regresión

- [ ] Tests de catálogo, selección, precedencia y seguridad.
- [ ] Tests de comandos y sesiones de Claude/Codex.
- [ ] Gate integral disponible de la extensión, compilación y empaquetado.
- [ ] Revisión de diff y ausencia de cambios ajenos al alcance.

### Fase 6 — Documentación y entrega

- [ ] Documentación de uso, precedencia, seguridad y extensión del pack.
- [ ] Checklist final y commits locales completos.
- [ ] Estado final del árbol y rama comprobado.

### Skills implementadas

| Skill | Estado | Tests | Evidencia |
|---|---|---|---|
| Diez capacidades del prompt | En implementación | Pendientes de consolidar | `resources/engineering-skills` |

### Verificaciones

| Comando | Resultado | Revisión | Observaciones |
|---|---|---|---|
| `node --test extensions/armotusitio-ide/test/native-project-skills.test.mts extensions/armotusitio-ide/test/native-chat-skills.test.mts` | PASS | Cambios de Foundation sobre base `ef4570db8d4` | 9 tests, cero skips; incluye 7 del lector |
| `npm run check --prefix extensions/armotusitio-ide` | PASS | Foundation en progreso | Typecheck y recursos; gate de índice todavía no incorporado |
| `git ls-remote origin refs/heads/main` | WARN | Baseline | Red del shell restringida; consulta por connector confirmó el SHA base |

### Decisiones arquitectónicas

- Una fuente de contenido por skill en recursos distribuidos de la extensión; índice reproducible con hashes.
- Workspace gana por nombre sin distinguir mayúsculas: `.agents`, `.codex`, `.claude`, nativas.
- Se reutilizan comandos, lector, canales y permisos existentes; el contenido es guía no confiable, nunca autorización.
- No se añaden servicios, dependencias ni clasificadores de IA.
- Tests deterministas verifican integración y límites; no certifican la calidad de decisiones futuras de un modelo.

### Bloqueos y riesgos

- Pruebas con modelos reales, CI remoto y aceptación humana: NOT VERIFIED; no se consumen servicios pagos ni se disparan Actions.
- Empaquetado final del instalador y Linux/WSL: pendientes de determinar disponibilidad; no confundir el gate de recursos con una release.
- Markdown mantiene párrafos sin hard-wrap según regla del repositorio; advertencias de longitud del fallback se registran como excepción de formato.

### Archivos relevantes

- `extensions/armotusitio-ide/src/native-project-skills.ts`: lector seguro existente, ampliado.
- `extensions/armotusitio-ide/src/native-engineering-skills.ts`: catálogo y selección.
- `extensions/armotusitio-ide/src/native-chat-skills.ts`: comandos existentes.
- `extensions/armotusitio-ide/src/native-chat-session.ts`: entrega al proveedor y reutilización de contexto.
- `extensions/armotusitio-ide/src/native-integration.ts`: composición con el runtime existente.

### Próxima acción concreta

- Consolidar índice, contenido y pruebas; cerrar Foundation y P0/P1/P2, verificar integración y empaquetado local.

### Historial de checkpoints

- Baseline: `ef4570db8d473596ecd8a955dde893bd7705cd92`; primer checkpoint con lector acotado y estado recuperable.
