# Native Engineering Skills Pack

## Implementation checklist

### Estado general

- Rama: `feat/native-engineering-skills-pack`.
- Base: `ef4570db8d473596ecd8a955dde893bd7705cd92`; último checkpoint local: `b0f349e01e8`.
- Fase actual: 6, entrega en Draft PR solicitada por el usuario.
- Estado: implementación completada con condiciones de aceptación; el usuario autorizó después publicar y crear un único Draft PR contra main. Sin merge, tags ni release.
- Fecha: 2026-11-10 (America/Buenos_Aires).
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
- [x] Catálogo nativo con índice de metadatos, precedencia y lectura bajo demanda.
- [x] Selección determinista con límites y trazabilidad.
- [x] Integración en Chat Harness y ambos proveedores.

### Fase 2 — Skills P0

- [x] Engineering Principles.
- [x] Abstraction Auditor.
- [x] Architecture Guardian.
- [x] Safe Refactoring.
- [x] Evidence Code Review.

### Fase 3 — Skills P1

- [x] Design Patterns.
- [x] Testing Strategy.
- [x] API Contract Integrity.

### Fase 4 — Skills P2

- [x] Security by Design.
- [x] Performance Engineering.

### Fase 5 — Integración y regresión

- [x] Tests de catálogo, selección, precedencia y seguridad.
- [x] Tests de comandos y sesiones de Claude/Codex.
- [x] Gate integral disponible de la extensión, compilación y empaquetado ejecutados; resultados y límites registrados, sin convertir FAIL/SKIP en PASS.
- [ ] Revisión de diff y ausencia de cambios ajenos al alcance.

### Fase 6 — Documentación y entrega

- [x] Documentación de uso, precedencia, seguridad y extensión del pack.
- [ ] Checklist final y commits locales completos.
- [ ] Estado final del árbol y rama comprobado.

### Skills implementadas

| Skill | Estado | Tests | Evidencia |
|---|---|---|---|
| `engineering-principles` | Implementada | Formato y selección PASS | `resources/engineering-skills/engineering-principles/SKILL.md` |
| `abstraction-auditor` | Implementada | Formato y selección PASS | `resources/engineering-skills/abstraction-auditor/SKILL.md` |
| `architecture-guardian` | Implementada | Formato y selección PASS | `resources/engineering-skills/architecture-guardian/SKILL.md` |
| `safe-refactoring` | Implementada | Formato y selección PASS | `resources/engineering-skills/safe-refactoring/SKILL.md` |
| `evidence-code-review` | Implementada | Formato y selección PASS | `resources/engineering-skills/evidence-code-review/SKILL.md` |
| `design-patterns` | Implementada | Formato y selección PASS | `resources/engineering-skills/design-patterns/SKILL.md` |
| `testing-strategy` | Implementada | Formato y selección PASS | `resources/engineering-skills/testing-strategy/SKILL.md` |
| `api-contract-integrity` | Implementada | Formato y selección PASS | `resources/engineering-skills/api-contract-integrity/SKILL.md` |
| `security-by-design` | Implementada | Formato y selección PASS | `resources/engineering-skills/security-by-design/SKILL.md` |
| `performance-engineering` | Implementada | Formato y selección PASS | `resources/engineering-skills/performance-engineering/SKILL.md` |

### Verificaciones

| Comando | Resultado | Revisión | Observaciones |
|---|---|---|---|
| `node --test extensions/armotusitio-ide/test/native-project-skills.test.mts extensions/armotusitio-ide/test/native-chat-skills.test.mts` | PASS | Cambios de Foundation sobre base `ef4570db8d4` | 9 tests, cero skips; incluye 7 del lector |
| `npm run check --prefix extensions/armotusitio-ide` | PASS | Foundation en progreso | Typecheck y recursos; gate de índice todavía no incorporado |
| `git ls-remote origin refs/heads/main` | WARN | Baseline | Red del shell restringida; consulta por connector confirmó el SHA base |

| Validadores `quick_validate.py` de skill-creator | PASS | Diez cuerpos definitivos | 10/10; `python -X utf8` |
| `node --test extensions/armotusitio-ide/test/native-engineering-skills.test.mts` | PASS | Catálogo Foundation | 15 tests, cero skips |
| `node --test extensions/armotusitio-ide/test/native-engineering-chat.test.mts` | PASS | Composición de prompts | 13 tests, cero skips; ambos proveedores simulados y host real con Codex sintético |
| `npm run compile` y `npm run check:native-package` en la extensión | PASS | Pack local | Índice fresco, recursos y bundle; sandbox requirió elevación para escribir `dist` |
| `vsce package --no-dependencies` | PASS | VSIX local | 27 archivos; índice y diez cuerpos incluidos; WARN previos: repository/licencia de VSIX ausentes en manifiesto de la extensión |
| `npm run test` dentro del sandbox | WARN | Ejecución interrumpida | Bloqueado al cancelar procesos de prueba; solo se detuvo su árbol identificado; nueva ejecución integral con permisos y timeout en curso |

| Suite integral con `node --test --test-timeout=120000 --test-concurrency=4` y los mismos globs de `npm test` | FAIL inicial / WARN residual | Pack final | 785 tests: 770 PASS, 3 FAIL, 12 SKIP; sin cancelados |
| Catálogo de errores, ejecución focalizada posterior | PASS | Corrección del pack | Nuevo código requería hints de recuperación: agregados; test 1/1 |
| MCP stdio, repetición focalizada posterior | PASS | Runner y dependencias sin cambios | 1/1 en 230 ms; timeout60s en suite se conserva como fallo inicial; causa ambiental inferida |
| Runtime R06, repetición focalizada posterior | PASS | Runtime y tests sin cambios | 2/2; diagnóstico con bootstrap600ms reproduce falla de gracia300ms preexistente bajo carga; no se modificó esa lógica |
| ESLint focalizado del pack | PASS | Trece archivos y catálogo de errores | Un import duplicado en test corregido; sin reglas debilitadas |

### Requerimiento 18 — Extensiones oficiales preinstaladas

- [x] Seis publicaciones y manifiestos reales contrastados con Open VSX, hashes descargados y licencias MIT.
- [x] Identificador corregido según registro y captura del usuario: `armotusitio.vestigivo`, no `armotusitio.vestigivo-rca` (404).
- [x] Manifiesto reproducible de versiones y SHA-256 conectado al empaquetado nativo de Code OSS.
- [x] Seis archivos universales incluidos por el pipeline nativo; extracción offline real PASS6/6. Ejecución de otras plataformas: NOT VERIFIED.
- [x] Actualización automática tildada por defecto; preferencias explícitas del usuario conservadas.
- [x] Pruebas de deduplicación, versiones más recientes y compatibilidad.
- [x] Perfil aislado del producto desde fuentes: reconocimiento y activación PASS6/6, sin duplicados, fallo sintético aislado. Instalador completo: NOT VERIFIED.

| ID real | Versión fijada | SHA-256 |
|---|---|---|
| `armotusitio.indizivo` | 0.3.0 | `afc190873b0530934e25c7fa583473c1e9d5fe4697b235be044baf2ba15cf28a` |
| `armotusitio.noditrivo` | 0.1.1 | `1d9825de71f655e66585fef777c6be97f6c7955982ff18ac4b18442449c53cb4` |
| `armotusitio.orquestivo` | 0.1.1 | `60310406a2a852704c2554c45900986e9f51670e834db7f63b52c94cd6e6175f` |
| `armotusitio.probato-pr` | 1.0.1 | `38e83c43ea5a54a4aa00e3e0529489fdb2c214de9dab66a8a15c318ea09ff873` |
| `armotusitio.saturivo` | 0.2.2 | `0e963acf6701aee4448f403728c7620fb46405128fdceaaf47775d984e77f84f` |
| `armotusitio.vestigivo` | 0.1.2 | `0e1997a5efc844406432ae4993f6233814783c0f25675b93552b69656b018519` |

Procedencia observada: namespace verificado, publicación confiable por Drako01, todas `preRelease=false`. Orquestivo declara `preview=true` en todas sus versiones publicadas: no existe una alternativa no-preview y no se oculta esa limitación. Seis VSIX `universal`, sin binarios nativos ni shell scripts detectados. Sin dependencias de extensiones ni APIs propuestas; motores VS Code `^1.99.0` o `^1.96.0` compatibles con el IDE 1.145.2. Probato requiere Node `>=22.12.0`; el Electron local real 43.8.3 devolvió Node 24.22.0. Integraciones opcionales GitHub/IA y Sentry/Grafana mantienen sus controles; Saturivo requiere k6/Go para sus funciones respectivas. Firma criptográfica y uso real de servicios externos: NOT VERIFIED. Escaneo limitado de los VSIX sin archivos sensibles ni patrones de credenciales de alta confianza; no equivale a auditoría exhaustiva.

Verificaciones adicionales del requerimiento18: build tests9/9 PASS; typecheck build PASS con compilador nativo, fuente/DTO generado idénticos tras EPERM del wrapper; ESLint PASS. Build-fast de cliente/extensiones/Copilot PASS; Electron25/25 PASS (servicio, checkbox y scanner). Primer inicio con seis archivos locales y proxy inaccesible PASS, sin usar cuentas ni descargar extensiones. Errores de canales AgentHost de inicio reproducidos con baseline vacío; un timeout de apagado adicional no atribuido queda NOT VERIFIED. Actualización real desde galería con conservación de configuración, instalador limpio Windows x64 y ejecución Linux/macOS/WSL: NOT VERIFIED. Orquestivo solo tiene versiones preview; condición explícita de entrega.

### Decisiones arquitectónicas

- Una fuente de contenido por skill en recursos distribuidos de la extensión; índice reproducible con hashes.
- Workspace gana por nombre sin distinguir mayúsculas: `.agents`, `.codex`, `.claude`, nativas.
- Se reutilizan comandos, lector, canales y permisos existentes; el contenido es guía no confiable, nunca autorización.
- No se añaden servicios, dependencias ni clasificadores de IA.
- Tests deterministas verifican integración y límites; no certifican la calidad de decisiones futuras de un modelo.

### Bloqueos y riesgos

- Pruebas con modelos reales y CI remoto: NOT VERIFIED; no se consumen servicios pagos ni se disparan Actions.
- Empaquetado final del instalador y ejecución Linux/WSL: NOT VERIFIED; no confundir el gate de recursos con una release.
- Markdown mantiene párrafos sin hard-wrap según regla del repositorio; advertencias de longitud del fallback se registran como excepción de formato.

### Archivos relevantes

- `extensions/armotusitio-ide/src/native-project-skills.ts`: lector seguro existente, ampliado.
- `extensions/armotusitio-ide/src/native-engineering-skills.ts`: catálogo y selección.
- `extensions/armotusitio-ide/src/native-chat-skills.ts`: comandos existentes.
- `extensions/armotusitio-ide/src/native-chat-session.ts`: entrega al proveedor y reutilización de contexto.
- `extensions/armotusitio-ide/src/native-integration.ts`: composición con el runtime existente.

### Próxima acción concreta

- Publicar la rama y crear Draft PR contra main, autorizado expresamente al final de la sesión. No ejecutar merge ni release. Veredicto: READY WITH CONDITIONS; revisar las condiciones de aceptación registradas.

### Historial de checkpoints

- Baseline: `ef4570db8d473596ecd8a955dde893bd7705cd92`; primer checkpoint con lector acotado y estado recuperable.

- Checkpoint `6609eff15e3`: lector compartido acotado y baseline persistente.
- Checkpoint de contenido: diez skills con validadores estáticos y muestra conductual independiente de ocho escenarios; no certifica decisiones futuras.

- `b0f349e01e8`: pack de diez skills, integración, tests y documentación; gate precommit PASS tras usar escapes Unicode exigidos por higiene.
