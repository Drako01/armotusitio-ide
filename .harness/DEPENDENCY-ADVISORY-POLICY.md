# Regla de oro — hallazgos en dependencias externas

**Regla obligatoria para RedEvent:** una vulnerabilidad identificada en Go, una dependencia externa o un paquete de terceros NO debe convertir automáticamente los tests de implementación en fallidos ni bloquear el quality gate agregado.

## Separación de responsabilidades

- `govulncheck` y `pnpm audit` deben ejecutarse cuando corresponda y registrar los hallazgos íntegramente como **WARN / advisory** (incluidas fallas del scanner, que nunca se reportan como PASS).
- Los reportes deben conservar evidencia consultable para mantenimiento, evaluación de impacto, actualización de dependencias y planificación de remediaciones.
- Tests funcionales, `go test`, race detector, vet, lint, builds, pruebas E2E, contratos, controles de autorización, secretos y cambios de seguridad implementados por RedEvent mantienen su capacidad bloqueante.
- Una vulnerabilidad demostrablemente explotable desde nuestra aplicación se trata como riesgo de seguridad y requiere evaluación y tratamiento explícito. Esta regla **no autoriza a ocultarla, ignorarla ni afirmar que el software es seguro**.
- La política es independiente del agente que ejecute la tarea (Claude Code, Codex, CI o shell local). Los cambios futuros de verificación deben conservar esta distinción.
- No confundir una caída del scanner, falta de conectividad o ausencia de una herramienta con un escaneo exitoso: informar `WARN` o `SKIP` de modo explícito.

**Motivo:** el estado de la implementación se determina por las verificaciones del código y comportamiento producido por el equipo. La deuda de vulnerabilidades ajenas se gestiona mediante un circuito de advisories sin monopolizar ni bloquear esos ciclos de desarrollo.
