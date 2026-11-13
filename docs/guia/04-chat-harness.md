# 4. Chat Harness

[← Anterior: Primeros pasos](03-primeros-pasos.md) · [Índice](../../README.md#índice) · [Siguiente: Configuración →](05-configuracion.md)

El Chat Harness es una conversación con Claude Code o Codex dentro del IDE. La IA trabaja sobre tu proyecto y el IDE controla cada acción sensible.

## Modos

Elegí el modo en la cabecera del chat o con `/modo`:

- **Actuar** (predeterminado): la IA cambia el código directamente y corre los comandos permitidos.
- **Preguntar**: la IA solo conversa y te propone un plan. No ejecuta nada hasta que lo aprobás.

## Sesiones persistentes

Con `atsHarness.agentTransport` en `native` o `auto`, el chat mantiene **una sesión viva del proveedor**:

- La conversación sigue entre mensajes y también **después de reiniciar el IDE**.
- El texto llega en tiempo real y cada herramienta aparece en la línea de tiempo.
- La IA te puede hacer preguntas con una tarjeta en el chat.
- Si el IDE se cierra a mitad de un turno, ese turno se marca como perdido y **nunca se repite solo**.

Con `structured` (el valor predeterminado), cada mensaje lanza un proceso nuevo con el contexto resumido.

## Permisos

Cuando la IA quiere correr un comando, editar un archivo protegido o usar git, aparece una tarjeta con **qué** va a hacer, **dónde**, el **riesgo** y estas opciones:

| Opción | Cuánto dura |
|---|---|
| Una vez | Solo esta acción. |
| Esta tarea | Hasta que termine el pedido actual. |
| Esta sesión | Hasta cerrar la sesión del chat (máximo 8 horas). |
| Siempre | Se guarda como regla en tus permisos. |
| Denegar | La IA recibe el rechazo y sigue por otro camino. |

Hay un **piso de seguridad** que ninguna regla puede saltear: nada fuera de la carpeta del proyecto, nada dentro de `.git` ni `.armotusitio`, y ningún push a ramas protegidas.

Las reglas permanentes viven en `~/.armotusitio/permissions.json` (tuyas) y `.armotusitio/permissions.json` (del proyecto). Las administrás con `/permisos` o con **ArmoTuSitio: Gestionar permisos**.

## Comandos del chat

| Comando | Qué hace |
|---|---|
| `/ayuda` | Lista todos los comandos. |
| `/modo [actuar\|preguntar]` | Muestra o cambia el modo. |
| `/permisos` | Permisos efectivos, tus reglas y los permisos temporales. |
| `/permisos temporales quitar [REGLA]` | Revoca permisos de esta tarea o sesión. |
| `/bifurcar` | Sigue en una copia de la sesión; la original queda guardada. |
| `/deshacer` | Descarta los cambios de la última ejecución. |
| `/checkpoints [restaurar ID]` | Lista los checkpoints por herramienta (turno, archivos) y restaura uno con la misma confirmación que la paleta. |
| `/objetivos [pausar\|detener ID]` | Objetivos autónomos en curso en esta ventana, con estado y preguntas pendientes; pausar o detener en el próximo punto seguro. |
| `/doctor` | Revisa la máquina y el proyecto. |
| `/auditoria` | Últimas acciones de las herramientas del agente. |
| `/costo` | Tokens informados por el proveedor en el último turno, consumo de subagentes cuando el proveedor lo informa y latencia hasta el primer token. |
| `/check`, `/verify`, `/test` | Corren las verificaciones del proyecto. |
| `/proyectos`, `/tareas CLAVE`, `/tarea CLAVE-123` | Consultan Work Management. |
| `/crear`, `/mover`, `/comentar` | Modifican tareas de Work Management (piden confirmación). |

## Más detalle

- Referencia completa del Harness y el chat: [README de la extensión](../../extensions/armotusitio-ide/README.md).
- Arquitectura de las sesiones nativas: [R8_ARCHITECTURE.md](../R8_ARCHITECTURE.md).
- Paridad entre Claude Code y Codex: [NATIVE_CHAT_PARITY_MATRIX.md](../NATIVE_CHAT_PARITY_MATRIX.md).
