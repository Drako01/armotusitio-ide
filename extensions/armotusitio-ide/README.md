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

## Historial

Se guardan las últimas 20 tareas por proyecto, con un máximo de 100 entradas por workspace.
Incluye acción, proyecto, fecha de inicio, resultado y fecha de finalización cuando se conoce.
No guarda salida de terminal, argumentos, credenciales ni títulos de tareas externas.
Una ejecución pendiente al reiniciar figura con resultado desconocido.
El historial pertenece al workspace abierto y no se sincroniza entre workspaces distintos.

Usá **ArmotuSitio: Historial del Harness** para abrirlo desde la paleta de comandos.
**Borrar historial** solicita confirmación y conserva las tareas que siguen ejecutándose.
Las tareas externas de RedEvent se muestran como progreso, sin agregarlas al historial del IDE.

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

## Bienvenida y actualización local

La bienvenida nativa muestra el mismo logo real que el inicio de ArmotuSitio IDE.
Los cambios requieren recompilar; una ventana con una compilación anterior no los muestra.
La compilación de Windows y el ZIP quedan a cargo del usuario.

## Validación local

```powershell
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
```
