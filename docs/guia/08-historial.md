# 8. Historial del proyecto

[← Anterior: Releases](07-releases.md) · [Índice](../../README.md#índice)

Resumen de las etapas principales. El detalle de cada una está en su PR y en los documentos enlazados.

| Etapa | Qué agregó |
|---|---|
| Harness nativo (v4–v7) | Motor de tareas propio del IDE, guardado fuera del proyecto. Locks seguros, tareas acotadas, cancelación, ejecución en DAG con hasta dos procesos en paralelo y reconciliación tras cortes. |
| Distribución | Identidad propia de ArmotuSitio IDE, instalador de Windows, paquetes Linux, Open VSX y actualizaciones firmadas. Ver [Distribución](../armotusitio-ide/DISTRIBUTION.md) y [Actualizaciones](../armotusitio-ide/AUTOUPDATE.md). |
| WSL y Linux | Servidores remotos x64 y arm64 y cliente Linux. Ver [WSL y Linux](../ATS-WSL-LINUX.md). |
| r5–r6 | Agente directo en el chat con autonomía, permisos por reglas y tarjetas de aprobación. |
| r7 | Paridad del chat: herramientas estructuradas de git, auditoría, `/doctor`, `/deshacer` y conformidad contra proyectos reales. |
| r8 | Sesiones nativas y persistentes de Claude Code y Codex: streaming, preguntas del agente, permisos temporales, bifurcación, recuperación tras reinicios y release automático por CI. Ver [estado de r8](../R8_IMPLEMENTATION_STATUS.md). |

## Límites conocidos

- Los permisos del IDE son una barrera de buena fe, no un sandbox del sistema operativo.
- Los ejecutables de Windows no tienen firma de código de Windows; el manifiesto de actualización sí está firmado.
- Claude Code aprueba por su cuenta los comandos que considera de solo lectura. El IDE los muestra en la línea de tiempo, pero no los puede frenar antes.
