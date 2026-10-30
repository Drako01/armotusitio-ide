# Harness de ArmotuSitio IDE

La barra de estado abre el inicio de ArmotuSitio IDE con un clic.


## Ejecución nativa de agentes IA (experimental, opt-in)

La paleta agrega **ArmoTuSitio: Ejecutar agente IA con autorización**
(`atsHarness.nativeAgentExecute`). Se mantiene la prioridad del Harness del proyecto:
el comando solo está habilitado para carpetas sin `.harness/` ni `harness/`.
No modifica ninguna configuración de proveedor, no crea PRs, no hace push ni despliega.

1. Instalá e iniciá sesión en Codex CLI o Claude Code CLI en la misma máquina donde corre el IDE.
2. Abrí una carpeta de trabajo confiable, seleccioná el proveedor y el rol.
3. Revisá el JSON que muestra el ejecutable, argumentos, permisos e instrucción.
4. Confirmá **Ejecutar agente**. La ejecución tiene límite de 30 minutos, salida acotada,
   cancelación manual desde **Cancelar tarea nativa** y resultado visible en un documento JSON.
   Las últimas 100 ejecuciones se resumen localmente en **ArmoTuSitio: Métricas locales de agentes IA**:
   porcentaje de éxito, duración promedio y p95, sin prompts, rutas de proyecto ni salidas.
5. Revisá los cambios con `git diff` y corré las verificaciones del proyecto antes de incorporarlos.
   El sistema no comitea ni integra cambios automáticamente.

Codex: `exec --sandbox read-only` para planner/reviewer y `workspace-write` para implementer.
Claude: `--permission-mode plan` para planner/reviewer y `dontAsk` para implementer.
`dontAsk` no equivale a un sandbox de filesystem: depende de las reglas de permisos del
proveedor y deniega herramientas no autorizadas. La ejecución nativa **no garantiza**
aislamiento de red, secretos, filesystem o procesos externos; para código no confiable usá
un contenedor/VM aislado. Nunca concedas permisos de bypass.

Ahora también existe **ArmoTuSitio: Ejecutar workflow multiagente nativo** con handoffs
ejecutables (plan → implementación → revisión), aprobación explícita, bloqueo de ejecución,
historial persistente y recuperación conservadora desde **Reconciliar workflows interrumpidos**.
El reviewer debe emitir `HARNESS_REVIEW: PASS` para que el flujo continúe; si no, falla cerrado.
Si el proyecto configura `.ats-harness.json`, el workflow ejecuta los gates después de la revisión;
sin esos gates, el estado de verificación es `not-configured` y no equivale a un resultado verificado.

**El modo recomendado crea un Git worktree aislado automáticamente** después de solicitar autorización.
No modifica el checkout principal y conserva el worktree al finalizar para revisar el diff. La
alternativa es ejecutar en el workspace actual bajo autorización explícita. El worktree por sí
solo no es un sandbox de sistema operativo; un proceso puede conservar acceso a recursos del
usuario. Los handoffs transportan resúmenes acotados en memoria y no guardan prompts en el
historial. Los roles de solo lectura verifican un fingerprint de Git y de archivos sensibles
antes y después de la ejecución; las diferencias bloquean el avance sin borrar cambios.

La ejecución de Claude con rol implementador usa `dontAsk` con autorización explícita de herramientas
de lectura y edición, y denegación explícita de Bash y herramientas web. Los gates del proyecto
son responsables de comprobar el resultado. Las ejecuciones de Codex conservan sandbox
`workspace-write` o `read-only` según el rol.

**Pendiente para calificación AAA:** sandbox OS/red, integración transaccional automática,
correcciones autónomas del feedback, contabilidad verificable de tokens/costos y benchmarks
reales con proveedores autenticados.

El Harness especializado de cada proyecto conserva sus capacidades anteriores.

### Validación local

Desde la raíz de este repositorio:

```bash
node scripts/ats-harness-check.mts
cd extensions/armotusitio-ide
npm test
npm run check
```

El check focalizado no llama a proveedores de IA.
El test de integración real de Codex/Claude requiere CLI, autenticación y aprobación del usuario;
no se simulan credenciales ni se ejecutan agentes en las pruebas automatizadas.

## Ejecutar una tarea con el Harness

1. Abrí **ArmotuSitio: Inicio** desde la paleta de comandos.
2. Elegí el proyecto. En RedEvent, elegí la IA o conservá **Configuración del proyecto**.
   ArmotuSitio usa **Verificaciones del proyecto**, con el host nativo `project`.
3. Describí el cambio y cómo verificarlo. Elegí **Preparar tarea**.
4. El Harness revisa requisitos y verificaciones. Respondé sus preguntas si las hay.
5. Revisá el plan. **Editar tarea** permite corregir la descripción antes de empezar.
6. Elegí **Ejecutar con Harness** para crear y ejecutar la tarea nativa.
7. Seguí el gate activo, los dominios y los intentos. Abrí **Ver detalles** o la evidencia de cada verificación.

La selección de IA de este formulario se aplica al proceso de la tarea; no edita `.harness/.env`.
Si hay un comando de agente personalizado, se usa **Configuración del proyecto** para respetarlo.
La preparación no crea ni ejecuta la tarea hasta que confirmás el plan.
El Harness conserva la autoridad sobre agentes, dependencias, verificaciones, bloqueos y recuperación.

**Detener tarea** confirma proyecto, tarea e intento antes de actuar.
RedEvent permite detener procesos propios; ArmotuSitio ofrece cancelación nativa cooperativa también al observar tareas.
Los cambios realizados se conservan. **Reanudar tarea** y **Reintentar tarea** requieren una acción explícita.
Al volver a abrir el IDE, se consulta el estado nativo; no se reanudan tareas automáticamente.
Cerrar el panel no cancela la ejecución.

Se conservan hasta 40 referencias terminales por workspace; las referencias activas no se eliminan por ese límite.
El historial no copia las fuentes de las tareas.
El propio Harness conserva sus registros y fuentes de acuerdo con la política del proyecto.
Los borradores usan SecretStorage por workspace y las plantillas locales se guardan solo al solicitarlas.
Los textos de borradores, respuestas y comandos privados quedan fuera de los resúmenes del historial.

## Herramientas del Harness

Abrí **Herramientas del proyecto y actividad anterior** y elegí una herramienta por su propósito:

- **Tareas:** listado, estado, avance, métricas e importación desde la bandeja de entrada.
- **Calidad y diagnóstico:** entorno, conexión con IA, contratos, verificaciones, pruebas, CI y migraciones.
- **Contexto y agentes:** contexto, inventario, cambios, tokens, lecciones y documentación de agentes.
- **Rendimiento:** telemetría y medición del paralelismo.
- **Mantenimiento:** consulta de caché y diagnóstico de tareas o espacios abandonados.

La descripción explica qué hace cada herramienta. Las herramientas de una tarea piden su identificador.
Las operaciones con efectos piden confirmación y los resultados aparecen en el panel.
Las salidas estructuradas se pueden desplegar por secciones; la salida técnica queda disponible en los detalles.
Las consultas de mantenimiento no eliminan espacios de trabajo ni limpian tareas automáticamente.

La ejecución libre se habilita cuando RedEvent expone `preflight`, `run`, `execute`, `progress`,
`resume`, `retry` y `abort`.
ArmotuSitio requiere `harness:ide` y el contrato `armotusitio-harness-ide` v1 comprobado con `capabilities`.
Su entrada es `node harness/scripts/ide.mjs`; `harness:run -- <comando>` conserva el uso anterior.
Las tareas IDE de ArmotuSitio ejecutan gates del proyecto, sin iniciar agentes de IA.

## Progreso

- Ambos productores usan lecturas compartidas por raíz, con un máximo global de dos subprocesos de consulta.
- Los cambios de archivos invalidan el estado; el respaldo usa unos 2 s con actividad y 15 s en reposo.
- Detecta tareas externas, incluso las iniciadas desde una terminal.
- El porcentaje y la duración provienen del Harness; no se calculan estimaciones de avance.
- Una tarea sin proceso activo aparece como tal, aunque conserve un porcentaje registrado.
- ArmotuSitio: descubre también ejecuciones externas y conserva su resultado por ID.
- La tarea iniciada desde el IDE tiene prioridad sobre registros antiguos sin proceso activo.
- Un error de lectura marca el progreso como desactualizado.
- El ícono **Actualizar estado** consulta manualmente el estado; la tarea muestra la hora de la última lectura correcta.

La consulta requiere un workspace confiable y `atsHarness.enabled` activado.
RedEvent necesita Node disponible en el PATH y los requisitos de su propio Harness.
El monitor no inicia, reintenta ni cancela ejecuciones.

## Experiencia y recuperación

El panel ofrece modo foco, vista compacta, tarea fijada y atención pendiente.
Cada tarea indica si se inició desde este IDE, si es una ejecución externa observada o si es un objetivo preparado sin ejecutar.
**Qué significa cada estado** explica los estados y las medidas; el estado de cada tarea también tiene su explicación.
Los requisitos que bloquean la ejecución se separan de los avisos e indican su corrección manual.
Las acciones deshabilitadas muestran el motivo, por ejemplo modo restringido o una tarea del proyecto en curso.
Los errores ofrecen **Diagnóstico** y **Ver detalles** como siguiente paso.
Los filtros permiten buscar por proyecto, estado, host y fecha.
La paleta **ArmotuSitio: Abrir Tarea del Harness** permite navegar a una ejecución concreta.
Las actualizaciones conservan foco, selección, formularios y secciones abiertas.
Los logs capturados admiten búsqueda y seguimiento voluntario; leer líneas anteriores detiene ese seguimiento.
Los logs nativos se abren desde referencias verificadas dentro de la raíz, con contenido acotado y redactado.

Si cambia el plan o la configuración de ejecución, se exige otra revisión antes de crear la tarea.
Una creación sin resultado confirmado bloquea nuevas preparaciones y permite revisar el listado para reconciliarla.
La cancelación pendiente sigue visible hasta obtener confirmación nativa.
El modo foco conserva los avisos de errores y reduce las notificaciones de éxito de tareas propias.

**Más acciones** permite consultar una tarjeta MCP y exportar un resumen local con selección previa de contenido.
La exportación abre una vista local; no publica ni envía información.
Reutilizar una tarea o plantilla abre otro borrador y requiere preflight y aprobación nuevos.
**Diagnóstico** consulta el contrato y el entorno sin ejecutar la tarea.

La pausa segura, el presupuesto de tokens con unidades verificables y la atribución de cambios requieren soporte nativo.
No se ofrecen controles operativos ni datos inventados para capacidades ausentes.
La ETA de RedEvent se identifica como estimación; ArmotuSitio v1 declara que no la ofrece.

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

El contrato IDE v1 de ArmotuSitio usa el host `project` para ejecutar verificaciones.
Sus herramientas anteriores de planes de agentes conservan su propia configuración.
Las tareas iniciadas fuera del IDE no reciben una IA estimada en el panel de progreso.

## Historial

Se guardan las últimas 20 tareas terminales de comandos por proyecto.
Los registros activos o desconocidos se conservan para evitar pérdidas al recargar.
Incluye acción, proyecto, fecha de inicio, resultado y fecha de finalización cuando se conoce.
No guarda salida de terminal, argumentos, credenciales ni títulos de tareas externas.
Una ejecución pendiente al reiniciar figura con resultado desconocido.
El historial pertenece al workspace abierto y no se sincroniza entre workspaces distintos.

Usá **ArmotuSitio: Historial del Harness** para abrirlo desde la paleta de comandos.
**Borrar historial** solicita confirmación y conserva las tareas que siguen ejecutándose.
Las tareas nativas externas mantienen su referencia y resultado; observarlas no concede propiedad de sus procesos.

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

Los comandos del historial anterior avisan al finalizar según `atsHarness.notifications`:

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
