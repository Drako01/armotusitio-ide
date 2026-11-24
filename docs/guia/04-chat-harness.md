# 4. Chat Harness

[← Anterior: Primeros pasos](03-primeros-pasos.md) · [Índice](../../README.md#índice) · [Siguiente: Configuración →](05-configuracion.md)

El Chat Harness es una conversación con Claude Code o Codex dentro del IDE. La IA trabaja sobre tu proyecto y el IDE controla cada acción sensible.

## Modos

Elegí el modo en la cabecera del chat o con `/modo`:

- **Actuar** (predeterminado): lo que pedís se hace. La IA cambia el código, corre los comandos permitidos, verifica y pasa el cambio por una revisión independiente.
- **Preguntar**: la IA no cambia nada. Responde lo que preguntás y, si pedís un cambio, te propone el plan completo de una vez, con los supuestos a la vista; solo pregunta si le falta un dato que no está en el proyecto. El plan se ejecuta con **Aprobar y ejecutar**, por el mismo camino que Actuar.

## Un prompt → resultado verificado

En **Actuar**, lo que pedís se hace. El chat conversa con el modelo; el Harness orquesta el trabajo y lo controla. Elige el camino con reglas locales (no gasta una llamada al modelo para clasificarlo y nunca cambia tus permisos):

| Si el pedido es… | El Harness hace |
|---|---|
| Una pregunta de una línea («¿qué hace esta función?») | Responde sin modificar archivos. |
| Un cambio («renombrá `total` a `subtotal`», «corregí el login») | Lo implementa, corre las verificaciones, corrige lo que falle y pasa el cambio por una **revisión independiente**. |
| Algo con varias partes («una API en Go con su frontend en Next.js, login y base de datos») | Lo ejecuta como **objetivo autónomo** por etapas: análisis, diseño, implementación, revisión y verificación. La carta (alcance y presupuesto) aparece en el chat y el objetivo arranca; lo pausás o detenés desde ahí. Trabaja en una rama aparte; si el pedido menciona el PR o el push, al terminar sube la rama y abre el pull request contra la rama en la que estabas. Cuando termina, el chat te dice cómo terminó. |

Un log de errores pegado (un job de CI que falló, una corrida de tests, un stack trace) se toma como pedido de arreglo y va directo al agente, aunque tenga viñetas o nombre la base de datos. Un pedido escrito después de un link o en la segunda oración («El repo cambió de nombre. ¿Podés asociarlo?») también se ejecuta: no se toma como consulta.

Si el objetivo autónomo no puede arrancar (por ejemplo, git no puede crear su rama), el chat te dice por qué y el pedido sigue solo con el agente directo, con las mismas verificaciones.

Un pedido nunca se frena por las palabras que usa: «no despliegues» es un límite, no un pedido de despliegue. La seguridad actúa sobre cada acción: desplegar, publicar, forzar un push o leer credenciales sigue bloqueado aunque el pedido lo nombre, y el agente termina el resto y te deja el paso bloqueado con el comando exacto. Si preferís que todo pedido de Actuar vaya directo al agente, sin objetivos, configurá `atsHarness.actRouting` en `direct`. El comando **Objetivo autónomo** y `/objetivos` siguen disponibles para casos avanzados (varios repositorios, entorno efímero, elegir la entrega).

### Revisión independiente

Cuando un cambio pasó las verificaciones, otro agente lo revisa en modo de solo lectura: el otro proveedor si está instalado y con sesión iniciada, y si no, el mismo. Revisa el cambio real contra el pedido, la arquitectura, la seguridad, la duplicación y las reglas del proyecto, con el mismo criterio que el revisor de los objetivos. Mientras tanto ves «Revisando los cambios con un revisor independiente».

- Si encuentra problemas graves, el agente los corrige, se vuelven a correr las verificaciones y se revisa de nuevo: como máximo **2 rondas**. Si quedan problemas, el chat los lista y no da la tarea por terminada.
- Las sugerencias que no bloquean aparecen debajo de la aprobación.
- Si un revisor no devuelve una revisión válida, la hace el otro proveedor.
- Si la revisión no se puede hacer, el chat lo dice: el cambio queda verificado por las pruebas, pero sin revisión. Nunca se cuenta como aprobado.
- Para apagarla, configurá `atsHarness.independentReview` en `false`.

### Corrección automática

Después de cada cambio corren las verificaciones del proyecto (test, lint, typecheck y las que configures). Si alguna falla por un error del código, el IDE le pasa al agente **solo los errores observados** y le pide corregirlos, sin otro mensaje tuyo. Mientras tanto ves «Detecté errores y los estoy corrigiendo».

- Se corrige como máximo **2 veces** por pedido; después se detiene y te explica qué quedó.
- Si el mismo error se repite sin progreso, o la corrección no cambia ningún archivo, se detiene antes.
- Si la causa está fuera del código (un servicio caído, una dependencia o herramienta que falta, un permiso denegado, el disco lleno) **no lo intenta como código**: te dice qué falta.
- El agente tiene prohibido saltear o borrar tests, desactivar reglas de lint o tipos, bajar la cobertura o editar las verificaciones para que pasen.
- Los permisos que diste «para esta tarea» siguen valiendo durante las correcciones; una denegación nunca se convierte en permiso.
- Un `node_modules` dañado o trabado (por ejemplo por el antivirus) se informa como problema de dependencias: el agente no intenta «arreglarlo» cambiando código.
- Si la corrida se queda sin turnos pero avanzó, sigue sola, hasta 3 veces seguidas, sin que toques **Continuar**. Si no avanzó, se detiene.

### Cómo leer el resultado

Cada ejecución separa tres cosas: si el cambio **se aplicó**, si las verificaciones **lo validaron** y si hay **aceptación funcional** (una prueba E2E o smoke que recorrió la app).

| Estado | Qué significa |
|---|---|
| **Verificada** | Los cambios se aplicaron y las verificaciones que corrió el IDE pasaron. |
| **Aplicada sin verificar** | Los cambios se aplicaron, pero no corrió ninguna verificación (el proyecto no tiene test, lint ni typecheck detectables). No está comprobado que funcione. |
| **Fallida** | Una verificación falló y quedó sin corregir; la tarjeta dice por qué se detuvo la corrección. |
| **Bloqueada** | El agente necesita algo que no puede resolver solo (un servicio, una credencial, una decisión). |
| **Parcial** | Se cortó por tiempo, turnos o porque lo detuviste; podés continuar sin volver a aprobar. |
| **Sin cambios** | Terminó sin modificar archivos. |

Debajo de una ejecución verificada, «Funcional no verificado» indica que ninguna prueba recorrió la app. **Ver evidencia** lista cada comando que corrió el IDE con su código de salida; un resultado omitido, cancelado o desconocido nunca cuenta como aprobado, y lo que diga el agente en su informe no cuenta como prueba.

### Pruebas E2E locales

Si el proyecto ya tiene un script `test:e2e` o `e2e` y su runner instalado en `node_modules` (Playwright o Cypress), activá `atsHarness.verifyE2e` para sumarlo a las verificaciones. Corre al final, con la política de comandos del IDE; el IDE no descarga navegadores ni usa tus perfiles o cookies. Sin runner, la entrega queda como «Funcional no verificado».

### Pedidos en pausa

Si una tarea falla, la cancelás, el proveedor no responde o el IDE se cierra, los mensajes que estaban en cola y el pedido interrumpido **no se pierden ni se ejecutan solos**: quedan en la sección **En pausa** con tres botones, **Retomar**, **Editar** y **Descartar**. Se guardan con la conversación y sobreviven a un reinicio. Al reabrir el IDE después de un corte, el chat te dice hasta dónde llegó la ejecución (antes de editar, editando o verificando) para que sepas si puede haber cambios parciales.

## Sesiones persistentes

Con `atsHarness.agentTransport` en `auto` (el valor predeterminado) o `native`, el chat mantiene **una sesión viva del proveedor**, con toda la memoria de trabajo del modelo:

- La conversación sigue entre mensajes y también **después de reiniciar el IDE**.
- El texto llega en tiempo real y cada herramienta aparece en la línea de tiempo.
- La IA te puede hacer preguntas con una tarjeta en el chat.
- Si el IDE se cierra a mitad de un turno, ese turno se marca como perdido y **nunca se repite solo**; tu pedido queda en **En pausa** para que decidas.

Con `structured`, cada mensaje lanza un proceso nuevo con el contexto resumido. `auto` usa el estructurado solo si la versión instalada del proveedor no es compatible, y lo avisa.

### Conversaciones largas

El IDE guarda hasta 2000 mensajes por conversación y **no resume nada por su cuenta**: vos decidís cuándo con `/resumir` o con el botón **Resumir** debajo del cuadro de texto. Al lado ves **Espacio usado**, el porcentaje de la memoria de trabajo del modelo que ocupa la conversación, con los números que informa Claude o Codex (si no los informa, no se muestra nada). Al resumir, lo viejo queda como memoria (tus pedidos, los planes y sus resultados), los últimos 20 mensajes siguen completos y la conversación entera queda en **Sesiones guardadas**. Solo si se llega al límite de 2000 mensajes el IDE resume lo más viejo, y lo avisa en el chat.

### Mientras trabaja la IA

- La respuesta aparece **dentro de la conversación** a medida que se escribe.
- **Plan del agente**: la lista de tareas que arma la IA, con lo hecho tachado y lo que está haciendo resaltado.
- **Esc** detiene la tarea; **Enter** deja tu próximo mensaje en cola.

### Después de cada cambio

- **Mostrar cambios** muestra, dentro del chat, las líneas agregadas y quitadas de cada archivo; **Abrir en el editor** abre la comparación completa.
- Los archivos que nombra la IA (`src/app.ts:42`) y los enlaces se abren con un clic.
- **Editar**, debajo de cada mensaje tuyo, vuelve a ese punto para cambiarlo: lo que vino después queda en Sesiones guardadas y tus archivos no cambian (para deshacerlos usá **Puntos de restauración** del menú ⋯).
- El botón con el globo y el **+**, arriba a la derecha, empieza una conversación nueva.

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

Editar un **archivo protegido** (credenciales como `.env`, workflows de `.github/workflows` y hooks de git en `.githooks` o `.husky`) siempre muestra una tarjeta «Edit protected file», que vale una sola vez y no se puede recordar. Si querés que la IA los edite sin preguntar, escribí una regla explícita (por ejemplo `edit:.github/workflows/**`); una regla `deny` los bloquea.

Si elegís **Siempre** en una tarjeta de git (rama, commit, push o pull request), la acción se ejecuta en ese momento y la regla queda guardada para ese proyecto.

En un proyecto con su **Harness propio**, el IDE le pasa los comandos para que los ejecute con sus reglas. Si ese Harness rechaza un comando que el IDE ya permitió (por ejemplo, porque no está en su lista, como `gh` o `docker ps`), el IDE lo ejecuta por su cuenta con su propio piso de seguridad y el agente recibe el aviso. Así un proyecto con Harness y uno sin Harness trabajan igual de fluido, sin tocar el Harness del proyecto. El agente tampoco usa los comandos internos de ese Harness (`harness:preflight`, `harness:run`): son para sus propios agentes.

Un comando que responde con su código de salida, como `gh pr checks` (1 si hay checks fallados, 8 si hay pendientes) o una búsqueda sin resultados, aparece como hecho y no como error.

Las reglas permanentes viven en `~/.armotusitio/permissions.json` (tuyas) y `.armotusitio/permissions.json` (del proyecto). Las administrás con `/permisos` o con **ArmoTuSitio: Gestionar permisos**. Para dejar de confirmar git, pull requests o `gh` en tus proyectos, seguí [Configurar permisos](09-permisos.md).

## Adjuntos

Pegá, arrastrá o elegí con el botón **+** cualquier archivo: imágenes, PDF, texto, código, CSV o logs. Entran hasta 5 por mensaje, de hasta 10 MB cada uno y 20 MB en total. Se envían sin confirmación, en Preguntar o en Actuar, con Claude Code o con Codex.

En Windows también podés **dictar**: tocá el botón del micrófono, al lado de **Enviar**. Se abre el dictado de Windows (lo mismo que apretar **Win+H**) y lo que decís se escribe en el cuadro. Revisalo y envialo como siempre.

Cada adjunto se guarda en `.chat-attachments/` dentro del proyecto, una carpeta que git ignora localmente, y se borra a los 7 días. El agente recibe la ruta y lo abre con sus herramientas: Claude ve imágenes y PDF; Codex ve imágenes PNG y JPEG. Un binario que el agente no sabe leer, como un `.docx`, se adjunta igual, pero el chat te avisa que la IA no puede leerlo tal como está y el agente tiene indicado no afirmar que lo analizó: exportalo a PDF o texto si querés que lo use.

## Comandos del chat

| Comando | Qué hace |
|---|---|
| `/ayuda` | Lista todos los comandos. |
| `/modo [actuar\|preguntar]` | Muestra o cambia el modo. |
| `/permisos` | Permisos efectivos, tus reglas y los permisos temporales. |
| `/permisos temporales quitar [REGLA]` | Revoca permisos de esta tarea o sesión. |
| `/resumir` | Resume la conversación cuando vos quieras; la completa queda en Sesiones guardadas. |
| `/bifurcar` | Sigue en una copia de la sesión; la original queda guardada. |
| `/deshacer` | Descarta los cambios de la última ejecución. |
| `/checkpoints [restaurar ID]` | Lista los checkpoints por herramienta (turno, archivos) y restaura uno con la misma confirmación que la paleta. |
| `/objetivos [pausar\|detener ID]` | Objetivos autónomos en curso en esta ventana, con estado y preguntas pendientes; pausar o detener en el próximo punto seguro. |
| `/doctor` | Revisa la máquina y el proyecto. |
| `/auditoria` | Últimas acciones de las herramientas del agente. |
| `/costo` | Tokens informados por el proveedor en el último turno, consumo de subagentes cuando el proveedor lo informa, latencia hasta el primer token y uso registrado de los presupuestos de 24 horas. |
| `/memoria [guardar decision\|convencion\|solucion TEXTO \| corregir ID TEXTO \| quitar ID]` | Memoria confirmada del proyecto. Solo tus comandos la escriben; la IA la recibe como datos de fondo. |
| `/integraciones [ver\|habilitar\|deshabilitar ID]` | Hooks, agentes, skills, comandos y plugins de `.claude` del proyecto. Solo se habilitan hooks `UserPromptSubmit` de comando simple, con confirmación en cada envío. |
| `/check`, `/verify`, `/test` | Corren las verificaciones del proyecto. |
| `/proyectos`, `/tareas CLAVE`, `/tarea CLAVE-123` | Consultan Work Management. |
| `/crear`, `/mover`, `/comentar` | Modifican tareas de Work Management (piden confirmación). |

## Puntos de restauración

En el menú del chat, «Puntos de restauración» lista las herramientas que editaron archivos, agrupadas por turno. Cada archivo muestra si fue creado, modificado o borrado y si se puede restaurar; un archivo que cambiaste después bloquea la restauración completa y lo dice. «Ver cambios» compara el contenido anterior a la herramienta con el archivo actual. «Restaurar» usa `/checkpoints restaurar ID`, con la misma confirmación.

## Especialistas del proyecto

`.armotusitio/agents.json` (hasta 64 KiB) declara perfiles para la delegación de solo lectura:

```json
{
	"schemaVersion": 1,
	"maxConcurrent": 1,
	"maxLaunches": 2,
	"agents": [
		{ "id": "revisor-seguridad", "role": "reviewer", "enabled": true, "instruction": "Revisá autorización y tenancy.", "maxTurns": 4 }
	]
}
```

Los roles son `planner` o `reviewer`; `model` es opcional; `tools` solo admite `[]`. Los límites solo pueden bajar los del IDE (máximo 2). El archivo es contexto, nunca permisos: cada lanzamiento sigue pidiendo tu aprobación.

## Más detalle

- Referencia completa del Harness y el chat: [README de la extensión](../../extensions/armotusitio-ide/README.md).
- Arquitectura de las sesiones nativas: [R8_ARCHITECTURE.md](../R8_ARCHITECTURE.md).
- Paridad entre Claude Code y Codex: [NATIVE_CHAT_PARITY_MATRIX.md](../NATIVE_CHAT_PARITY_MATRIX.md).
- Comparativa de uso con Claude Code y Codex: [Comparativa de chats](10-comparativa-chats.md).
