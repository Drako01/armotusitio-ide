# Harness Enterprise AAA - validación de las seis áreas ampliadas

> Rama: `feat/native-harness-enterprise-upgrade`. Estado: **implementación experimental a validar**, no certificación de producción.
> No ejecutar proveedores reales sin revisión del plan y aprobación explícita. No crear PR ni modificar `main`.

## Revisión técnica por área

| Área | Cambios para probar | Límites deliberados |
|---|---|---|
| Capacidad de motores externos | `probeProjectHandshake`: ejecución consentida con nonce, plazo de 5 segundos, salida acotada y capacidades limitadas por manifiesto; comando `atsHarness.nativeProjectHandshake` | Es una respuesta auto-reportada del proceso, no prueba de cumplimiento ni habilita ejecución automática |
| DAG de agentes | `planAgentWaves` y ruta de ejecución concurrente para lectores independientes, escritores exclusivos y revisión de cada escritor | Escrituras compartidas paralelas denegadas; el workflow predeterminado sigue con ciclo correctivo conservador |
| Protección ante inyección | Pruebas adversariales de delimitadores, veredictos falsificados, comandos maliciosos y DAGs inválidos; datos de handoff encapsulados | No reemplaza red-team E2E ni sandbox de sistema operativo |
| Recuperación | `restartInterrupted`: reinicio explícito con nuevo ID, plan aprobado intacto y rechazo si comenzó cualquier escritor | No es reanudación granular de un checkpoint con escrituras previas; se mantiene bloqueo preventivo |
| Compatibilidad de CLIs | `--version`, `--help` y estado de login local; flags faltantes y estado desconocido representados explícitamente | Un login local o un flag reconocido no demuestra disponibilidad real del modelo ni permisos efectivos |
| Observabilidad | Eventos `workflow-started`, `step-started`, `provider-progress`, `step-finished`, `verification-finished`, `workflow-finished`; trazas limitadas en historial | Sin prompts, salidas ni secretos; no hay tracing distribuido entre procesos remotos |

## Pruebas automatizadas

Desde la raíz del repositorio:

```bash
node scripts/ats-harness-check.mts
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
git diff --check
```

Si falla solo el formato (no errores de compilación ni lint semántico), ejecutar el formateador oficial de forma explícita:

```bash
node scripts/ats-harness-check.mts --fix
git diff --check
```

Revisar los archivos cambiados por `--fix` antes de crear commits. No utilizar `git reset --hard` ni descartar cambios del usuario.

## Pruebas manuales de integración (requeridas)

1. En un proyecto de prueba con Harness externo, registrar un manifiesto v2 y ejecutar el comando de handshake. Confirmar que una respuesta con nonce falso se rechaza, sin iniciar ejecución de tareas ni conceder capacidades verificadas.
2. En un repositorio Git descartable, probar dos planners independientes, un implementer que depende de ambos y un reviewer dependiente del implementer. Revisar eventos, exclusividad de escritor y fallo cerrado si falla un planner.
3. Inyectar contenido malicioso en un handoff simulado. Verificar que los permisos del subprocess permanecen inalterados y que un veredicto ambiguo no aprueba.
4. Interrumpir una ejecución antes de la escritura y comprobar el reinicio explícito con nuevo ID. Repetir después de iniciar un writer: la reanudación debe denegarse y preservar el estado existente.
5. Ejecutar diagnósticos Codex/Claude locales y revisar compatibilidad real de opciones. No inferir acceso al modelo a partir de `localSession`; probar modelos reales solo con autorización del operador.
6. Observar un workflow y abrir su historial. Los eventos deben tener ID, clase, hora y opcionalmente bytes observados, sin prompts, salidas ni tokens.

## Gates para cerrar las seis áreas

- [ ] Typecheck, suite de tests, formato y CI multiplataforma sobre el mismo SHA.
- [ ] E2E Linux/macOS/Windows, incluidos los casos omitidos en Windows.
- [ ] E2E con CLIs reales y cuentas autenticadas en un proyecto descartable.
- [ ] Prueba adversarial externa (prompt injection, exfiltración, TOCTOU y symlink) sin permisos fuera del sandbox.
- [ ] Contratos de motores externos ejercitados contra motores Python y Node reales.
- [ ] Reanudación granular luego de escrituras validada transaccionalmente; hasta entonces mantener fail-closed.
- [ ] Trazas y progreso comparados con ejecución real sin filtrado de secretos insuficiente.

La implementación de nuevas superficies no sustituye estos gates; el criterio es evidencia reproducible, no solo existencia de código.

## Smoke test real, explícito y manual

**No forma parte de `npm test`, `ats-harness-check` ni GitHub Actions.** El comando hace una única llamada autenticada al proveedor elegido y puede consumir cuota. Ejecutarlo únicamente en una terminal interactiva desde la raíz del repositorio. El runner crea y elimina un repositorio Git temporal; nunca envía el código del IDE ni el repositorio de trabajo al modelo.

```bash
node scripts/ats-harness-real-provider-smoke.mts --help
node scripts/ats-harness-real-provider-smoke.mts --provider codex --acknowledge-real-model-call
# Alternativa: cambiar codex por claude para una segunda prueba deliberada
```

Tras el comando autorizado, escribir `RUN` en la terminal. La salida solo contiene el estado, si el árbol Git fue verificado, si hubo una modificación no autorizada, duración y si el proveedor informó tokens. No se guardan prompts, respuestas ni credenciales en logs. Ante una violación del modo de solo lectura, el directorio temporal se conserva para inspección y se informa su ruta.

**Limitación:** el modo de solo lectura y la comprobación Git son controles del ejecutor/proveedor, NO equivalen a una política OS de red, filesystem y procesos. La prueba no certifica sandbox, acceso a cuentas reales en CI ni éxito del plan empresarial.
