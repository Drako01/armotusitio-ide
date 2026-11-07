# 1. Qué es ArmoTuSitio IDE

[← Volver al índice](../../README.md#índice) · [Siguiente: Instalación →](02-instalacion.md)

ArmoTuSitio IDE es un editor de código basado en **Code - OSS** (el código abierto de Visual Studio Code). Se ve y se usa igual que VS Code, y suma herramientas propias para trabajar con agentes de IA de forma segura.

## Qué agrega a VS Code

| Función | Para qué sirve |
|---|---|
| **Chat Harness** | Conversar con **Claude Code** o **Codex** sobre tu proyecto. La IA puede leer, editar, correr comandos y usar git, siempre bajo los permisos que vos aprobás. |
| **Harness nativo** | Ejecutar tareas y verificaciones (tests, lint, typecheck) del proyecto con historial, cancelación y evidencias, aunque el proyecto no tenga su propio Harness. |
| **Permisos** | Cada acción sensible muestra una tarjeta con qué se va a hacer, dónde, el riesgo y por cuánto tiempo vale tu permiso. |
| **Work Management (MCP)** | Consultar y gestionar proyectos y tareas de ArmoTuSitio desde el chat, con tu clave de agente. |
| **Inicio propio** | Una pantalla de inicio con tus proyectos, tareas en curso y accesos rápidos. |
| **Extensiones de Open VSX** | El panel de extensiones usa el catálogo abierto de Open VSX. |
| **Actualizaciones firmadas** | El IDE busca nuevas versiones en GitHub y verifica su firma antes de ofrecerlas. |

## Qué no es

- No reemplaza a Claude Code ni a Codex: los usa. Necesitás tener instalado y con sesión iniciada al menos uno de los dos.
- No es un sandbox del sistema operativo. Los permisos del IDE son una barrera de buena fe; para código que no es de confianza, usá un contenedor o una máquina virtual.
- No usa el Marketplace de Microsoft ni incluye extensiones propietarias.
