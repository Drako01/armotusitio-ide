# Actividad del Harness

La barra de estado abre el inicio de ArmotuSitio IDE con un clic.

## Progreso

- RedEvent: consulta `node .harness/core.mjs progress --json` cada 15 segundos.
- Detecta tareas externas, incluso las iniciadas desde una terminal.
- El porcentaje y la duración provienen del Harness; no se calculan estimaciones de avance.
- Una tarea sin proceso activo aparece como tal, aunque conserve un porcentaje registrado.
- ArmotuSitio: muestra actividad de las tareas lanzadas desde el IDE, sin progreso externo.
- Un error de lectura reemplaza el progreso anterior y permite volver a consultar con **Actualizar**.

La consulta requiere un workspace confiable y `atsHarness.enabled` activado.
RedEvent necesita Node disponible en el PATH y los requisitos de su propio Harness.
El monitor no inicia, reintenta ni cancela ejecuciones.

## Elegir IA por proyecto

Usá **ArmotuSitio: Elegir IA del Harness**, el botón de IA del panel o la fila **IA** debajo de cada proyecto.
El inicio del IDE también muestra la selección y permite cambiarla.

- RedEvent: elegí **Codex** o **Claude Code** para guardar `HARNESS_HOST` en `.harness/.env`.
- **Usar configuración del proyecto** conserva el valor actual sin modificarlo.
- Se mantienen las demás variables, credenciales, comentarios y finales de línea del archivo.
- El CLI elegido debe existir en `PATH`; la comprobación no ejecuta un agente ni valida su sesión.
- Los cambios se aplican a futuras ejecuciones. El historial conserva la IA capturada al iniciar cada tarea del IDE.
- Las pruebas del Harness mantienen su aislamiento: no se les inyecta `HARNESS_HOST` desde el IDE.

Requiere un workspace confiable y el archivo `.env` sin cambios pendientes en el editor.
La selección se detiene si encuentra cambios externos o un archivo enlazado.
Si `HARNESS_AGENT_COMMAND` está definido, se muestra **Comando personalizado** y se avisa que tiene prioridad.
Si el IDE heredó `HARNESS_HOST`, esa variable tiene prioridad sobre el archivo.
Se informa sin cambiar el entorno global.

El Harness actual de ArmotuSitio selecciona la IA en su plan de agentes y no consume `HARNESS_HOST`.
En ese caso se muestra **IA por plan de agentes**, sin modificar archivos que el Harness ignoraría.
Las tareas iniciadas fuera del IDE no reciben una IA estimada en el panel de progreso.

## Historial

Se guardan las últimas 20 tareas por proyecto, con un máximo de 100 entradas por workspace.
Incluye acción, proyecto, fecha de inicio, resultado y fecha de finalización cuando se conoce.
No guarda salida de terminal, argumentos, credenciales ni títulos de tareas externas.
Una ejecución pendiente al reiniciar figura con resultado desconocido.
El historial pertenece al workspace abierto y no se sincroniza entre workspaces distintos.

Usá **ArmotuSitio: Historial del Harness** para abrirlo desde la paleta de comandos.
**Borrar historial** solicita confirmación y conserva las tareas que siguen ejecutándose.
Las tareas externas de RedEvent se muestran como progreso, sin agregarlas al historial del IDE.

### Repetir tareas

Las entradas finalizadas de `check`, `verify` y `test` incluyen **Repetir tarea**.
Requiere el proyecto original abierto, el comando disponible y un workspace confiable.
Se solicita confirmación y se crea una ejecución nueva con su propio registro.
Una tarea igual activa en el IDE, o esperando confirmación, bloquea otra ejecución del mismo comando y proyecto.
El bloqueo también aplica a esos tres comandos desde el panel de proyectos.
Se libera al cancelar la confirmación o si no se puede iniciar el proceso.
Las entradas con resultado desconocido al reiniciar y los comandos `run`, `dispatch` y `abort` no se repiten.
Este bloqueo controla ejecuciones del IDE; no detecta procesos equivalentes iniciados desde otras terminales.

## Notificaciones

Las tareas iniciadas desde el IDE avisan al finalizar según `atsHarness.notifications`:

- `errors` (predeterminado): avisa ante fallos o cuando falta el código de salida.
- `always`: también avisa cuando terminan correctamente o se cancelan.
- `never`: desactiva los avisos.

Cada aviso incluye acción, proyecto, duración y **Ver historial**.
Las cancelaciones voluntarias no generan avisos en el modo `errors`.
Podés configurar esta opción por proyecto desde los ajustes de VS Code.
La preferencia vigente al terminar la tarea determina si se muestra el aviso.
No se notifican tareas externas ni entradas recuperadas del historial después de reiniciar.
Desactivar `atsHarness.enabled` también silencia estos avisos.

## Chat @harness y Work Management

Abrí **ArmotuSitio: Chat Harness** desde la paleta o desde el inicio del IDE.
El panel propio funciona sin Copilot ni llamadas a modelos de IA.
Esta versión de la extensión requiere la base Code - OSS 1.143 del IDE.
También se registra `@harness` en el chat nativo cuando ese chat tiene un proveedor predeterminado disponible.
La integración no reemplaza al agente predeterminado ni requiere activar APIs propuestas.
Son comandos explícitos; no es un planificador de lenguaje natural.

```text
@harness comandos
@harness estado
@harness check redevent
@harness verify armotusitio
@harness proyectos
@harness proyecto RED
@harness tareas RED
@harness tarea RED-001-219
@harness buscar autenticación
@harness tablero RED
@harness crear RED Revisar autenticación
@harness mover RED-001-219 7
@harness comentar RED-001-219 Revisar el resultado del test
```

Los comandos locales `check`, `verify` y `test` conservan confirmación, control de duplicados e historial.
Si hay varios proyectos, indicá `armotusitio` o `redevent`.
El MCP permite consultar proyectos, tableros, tareas y contexto con la clave del agente.
Para `mover`, obtené el ID real de la columna con `tablero`; los ejemplos no indican una columna recomendada.
Crear, mover y comentar requieren contexto actual, herramienta habilitada y confirmación con los argumentos completos.
La API del servidor sigue validando el usuario de ejecución, los permisos y el alcance de proyectos.
El chat no reintenta modificaciones ni ejecuta comandos arbitrarios.

### Conexión MCP

El proveedor nativo se llama **ArmotuSitio Work Management** y publica las herramientas autorizadas por el servidor.
El endpoint es `https://armotusitio.com.ar/backend/api/mcp.php` y no puede sustituirse desde un workspace.
Podés usar esas herramientas en un agente de chat compatible con MCP, según sus aprobaciones y permisos.
Las herramientas de creación, edición, asignación y otras acciones dependen de las capacidades de la clave.

Se utiliza primero la clave guardada en SecretStorage y luego la variable heredada `ATS_MCP_TOKEN`.
El IDE debe iniciarse desde un entorno que contenga esa variable para poder reutilizarla.
Como alternativa, ejecutá **ArmotuSitio: Configurar clave MCP** e ingresá la clave en el diálogo protegido.
No pegues claves en el chat ni las guardes en `settings.json`, `mcp.json` o archivos del repositorio.
**ArmotuSitio: Borrar clave MCP guardada** elimina la copia segura; la variable heredada sigue siendo válida.
Para desconectar por completo, desactivá `atsHarness.mcp.enabled` en los ajustes del IDE.
Se requiere un workspace confiable para consultas y ejecución.

Las respuestas se muestran como texto sin interpretar HTML o instrucciones del servidor.
No se persiste la conversación y cada consulta HTTP tiene límites de tiempo y tamaño.
**Cancelar consulta** interrumpe la espera; no revierte una modificación que ya aceptó el servidor.
Si falla una modificación, consultá el estado actual antes de repetirla.
No se transmite contexto del editor a un modelo de IA desde este participante.

## Bienvenida y actualización local

La bienvenida nativa muestra el mismo logo real que el inicio de ArmotuSitio IDE.
Los cambios requieren recompilar; una ventana con una compilación anterior no los muestra.
La compilación de Windows y el ZIP quedan a cargo del usuario.

## Validación local

```powershell
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
```
