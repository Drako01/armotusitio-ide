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

Ahora también existe **ArmoTuSitio: Ejecutar workflow multiagente nativo** con opción\nde revisión cruzada entre Codex y Claude (requiere ambos proveedores configurados) y handoffs
ejecutables (plan → implementación → revisión), aprobación explícita, bloqueo de ejecución,
historial persistente y recuperación conservadora desde **Reconciliar workflows interrumpidos**.
El reviewer debe terminar con una única línea `HARNESS_REVIEW: PASS` para aprobar;\nuna respuesta ambigua o truncada falla cerrado. Si detecta defectos, el Harness puede\nhacer **un solo ciclo correctivo** (implementador + nueva revisión) previamente autorizado;\nno hay reintentos ilimitados.
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

Se limita a dos operaciones de proveedor simultáneas por ventana del IDE y a un máximo\nde una hora por workflow, incluyendo la verificación. El diagnóstico de CLI consulta\nversiones sin consumir tokens y sin afirmar que las sesiones estén autenticadas.\nEl runner consume eventos JSONL de Codex y JSON de Claude, conserva solamente el mensaje\nfinal y métricas verificables de tokens, y muestra el costo estimado informado por Claude\ncuando existe. Los costos son estimaciones parciales y no equivalen a facturación real.\nCodex ejecuta con sesiones efímeras y política de aprobación no interactiva; Claude\nrecibe una señal para no persistir el historial de prompts cuando su versión la admite.\n\n**Pendiente para calificación AAA:** sandbox OS/red, integración transaccional automática,
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

## Chat Harness conversacional

Abrí **ArmotuSitio: Chat Harness** desde la paleta, la barra de estado o el inicio del IDE.
Es una conversación real con la IA elegida sobre el proyecto abierto, y todo el flujo ocurre en el mismo panel.

- **Enviar = conversar.** Cada mensaje inicia un turno de solo lectura del CLI local elegido (`codex exec --sandbox read-only` o `claude --permission-mode plan`). La IA puede leer el repositorio, hacer preguntas y proponer un plan, pero nunca modifica archivos al enviar.
- **Plan versionado.** Cuando la IA propone o ajusta un plan, aparece una tarjeta «Plan vN» con pasos, archivos, riesgos, skills y las verificaciones configuradas. Solo la última versión puede aprobarse; las anteriores quedan como reemplazadas. «Pedir cambios» sigue la conversación. Escribir algo nuevo después de un plan suspende su aprobación hasta que la IA lo confirme o lo actualice; si lo confirma sin cambios, conserva su número de versión.
- **Qué recibe la IA.** En los turnos de conversación, el historial reciente de mensajes del usuario, respuestas y ejecuciones (hasta unos 13 KB). En la implementación, solo el plan aprobado y los requisitos escritos por el usuario: las respuestas del modelo y los avisos locales (resultados de `/comandos` y de Work Management) no se reenvían, para que contenido de terceros no pueda dirigir al agente. Las credenciales que se escriban por error se ocultan antes de guardarlas o enviarlas.
- **Aprobar y ejecutar = modificar código.** Ejecuta el agente implementador sobre el plan aprobado, identificado por su digest. Usa el mismo camino protegido que el resto del Harness nativo: Workspace Trust, lock compartido de escritores, cuota y presupuesto del proveedor, métricas y referencias a guías y skills verificadas por digest. Si el agente termina bien y el proyecto tiene `.ats-harness.json`, sus gates corren con el mismo lock y se registran como una tarea más en el historial.
- **Seguimiento en el chat.** Se ven la etapa (preparación, agente, verificaciones), el estado de cada gate, el tiempo transcurrido y la actividad observada, y la ejecución se puede detener en cualquier fase, incluso antes de que arranque el proceso. Con Codex y Claude Code, los mensajes intermedios del agente aparecen como «Respuesta en curso» mientras trabaja (eventos JSONL/stream-json reales del CLI, redactados y no persistidos). Al terminar queda un resumen con el informe del agente y el resultado de las verificaciones, y la conversación continúa con ese contexto. Un plan que ya se ejecutó bien no se puede volver a aplicar; para eso se pide una versión nueva. Si un error tiene solución conocida (lock tomado, cupo agotado, configuración cambiada), el aviso indica qué hacer.
- **Selector de IA.** La cabecera muestra **Codex / Claude Code** con su estado local (autenticado, sin sesión, no instalado o versión incompatible), obtenido con `--version`, `auth status` y la ayuda del CLI, sin enviar prompts. La elección se guarda por proyecto y cambiarla no afecta un turno ya iniciado. Si el proveedor elegido no está instalado, el chat lo avisa antes de gastar un turno y conserva el texto escrito.
- **Versión del modelo y razonamiento.** Junto al proveedor aparecen dos controles independientes: **Modelo** (alias dinámico, como Opus, o versión explícita, como **Opus 5.5**) y **Esfuerzo de razonamiento** (Predeterminado, Bajo, Medio, Alto, Extra alto y, en Claude, Máximo). Elegir Predeterminado no sobrescribe la configuración de los CLI. Las selecciones se almacenan como preferencias personales del IDE por proveedor (`atsHarness.claudeModel`, `atsHarness.claudeEffort`, `atsHarness.codexModel`, `atsHarness.codexEffort`), y se aplican a **nuevas invocaciones**, incluidas las fases de los workflows. Los permisos y modelos disponibles dependen de la cuenta; si el CLI rechaza la combinación, el Harness informa el fallo sin ejecutar comandos de sustitución ni alterar permisos.
- **Estado de ArmotuSitio MCP.** El indicador muestra Conectado, Desconectado, Verificando o Error según un handshake real (`initialize` + `tools/list`) contra el endpoint existente; una clave guardada sola no cuenta como conexión. El detalle muestra servidor, cantidad de herramientas, motivo y hora de la última verificación, sin secretos, con accesos para verificar, habilitar, configurar o cambiar la clave. El MCP es opcional para conversar y ejecutar.
- **Historial por proyecto.** La conversación se guarda en el almacenamiento privado del IDE, con un máximo de 200 mensajes. Un archivo dañado o alterado se archiva y no se usa. «Nueva conversación» pide confirmación. Si el IDE se cierra durante una respuesta o una ejecución, al volver el chat avisa una vez qué quedó interrumpido y cómo verificarlo. Dos ventanas abiertas sobre el mismo proyecto no se pisan el historial: cada una agrega sus mensajes nuevos al guardar.
- **Accesibilidad.** Todo se opera con teclado (el selector de IA es un grupo de radio con flechas; Escape cierra los paneles y devuelve el foco). El lector de pantalla anuncia los cambios de fase y no los contadores de tiempo, y el Markdown del modelo se muestra como texto, sin ejecutar HTML ni enlaces.
- **Proyectos con Harness propio** (`.harness/` o `harness/`): se puede conversar y planificar, pero «Aprobar y ejecutar» queda deshabilitado con el motivo visible, porque el IDE no habilita escritores concurrentes sin coordinación verificable con ese motor.

Los mensajes que empiezan con `/` (por ejemplo `/estado` o `/tareas RED`) se resuelven con los comandos locales de abajo y su resultado queda en la conversación.

## Chat @harness y Work Management

También se registra `@harness` en el chat nativo cuando ese chat tiene un proveedor predeterminado disponible.
La integración no reemplaza al agente predeterminado ni requiere activar APIs propuestas.
En ese participante solo se aceptan comandos explícitos; el texto libre indica abrir Chat Harness.
Esta versión de la extensión requiere la base Code - OSS 1.143 del IDE.

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

Las respuestas se muestran como texto sin interpretar HTML o instrucciones del servidor; en Chat Harness el Markdown se renderiza sin HTML.
Cada consulta HTTP tiene límites de tiempo y tamaño.
**Detener** interrumpe la espera; no revierte una modificación que ya aceptó el servidor.
Si falla una modificación, consultá el estado actual antes de repetirla.
No se transmite contexto del editor a un modelo de IA desde el participante `@harness`.

## Bienvenida y actualización local

La bienvenida nativa muestra el mismo logo real que el inicio de ArmotuSitio IDE.
Los cambios requieren recompilar; una ventana con una compilación anterior no los muestra.
La compilación de Windows y el ZIP quedan a cargo del usuario.

## Validación local

```powershell
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
```
