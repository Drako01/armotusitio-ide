# Entrega del Harness nativo

Estado: implementación local con aceptación de instaladores pendiente. No se ejecutó un release.

## Trazabilidad de esta entrega

| Frente | Implementación y evidencia | Límite |
| --- | --- | --- |
| Autoridad | `native-authority.ts`, adaptador y pruebas de proyecto genérico | Entradas desconocidas bloquean el motor incluido |
| Configuración | Perfiles Node, Go, PHP y personalizado; creación exclusiva y retirada por huella | No se borran configuraciones modificadas |
| Ejecución | Plan completo, dependencias, aprobación ligada a configuración y confianza | IA real y delegación automática fuera de esta entrega |
| Estado | Intentos persistidos, locks correlacionados y reconciliación explícita | No hay reejecución automática |
| Evidencias | Huellas por intento, invalidación y fallos de persistencia independientes del resultado | Solo cubren entradas declaradas; nunca omiten gates |
| Soporte | Exportación acotada con proyección de campos permitidos | No es un respaldo del proyecto |
| Interfaz | Proyecto, siguiente acción, verificaciones y opciones secundarias | Aceptación humana pendiente |
| Chat | Tareas locales sin MCP y acceso en barra de estado | Prepara tareas; no sustituye al proveedor de IA |
| MCP | Opcional por workspace, desactivado por defecto y clave guardada reconocida | No se infiere vencimiento ni validez desde la clave |
| Distribución | Bundle y recursos comprobados | Instaladores Windows, Linux y host WSL pendientes |

## Validación reutilizada

- Windows: 134 de 135 pruebas iniciales; se corrigió la aserción del renderer restante.
- El usuario ejecutó posteriormente 11 de 11 pruebas de UI y puente, tipos, recursos, bundle, paquete e higiene.
- Ubuntu WSL: 42 de 42 pruebas nativas sobre copias equivalentes sin tipos.
- Chat/MCP: 11 de 11 pruebas focalizadas tras hacer opcional la integración.
- El runner `node scripts/ats-harness-check.mts` produce `test.log` sin ejecutar releases ni proveedores de IA.

Los resultados anteriores no equivalen a pruebas E2E completas ni validan instaladores de otros destinos.

## Release anterior y pendientes

El error local disponible de `2026-10-29` pertenece a `detect`: encontró una operación con PID activo.
No permite atribuir la causa del release fallido. Se conservaron los artefactos y las claves existentes.

La aceptación de instaladores, las pruebas E2E completas y los proveedores reales siguen pendientes.
GitHub Actions debe permanecer deshabilitado; el PR no autoriza merge, release ni publicación de instaladores.
