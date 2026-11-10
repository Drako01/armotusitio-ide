/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** What the user can do about each `HARNESS_*` code (block J): exact entries first, then one entry per code family. */

type Translate = (message: string, ...args: string[]) => string;
type Hint = (t: Translate) => string;

const DIAGNOSE = '\u00abArmoTuSitio: Diagn\u00f3stico del Harness nativo\u00bb';
const RECONCILE_FENCE = '\u00abArmoTuSitio: Reconciliar lock compartido obsoleto\u00bb';

const EXACT: Record<string, Hint> = {
	HARNESS_CHAT_SESSION_INVALID: t => t('Eleg\u00ed una conversaci\u00f3n v\u00e1lida con /sesiones y retom\u00e1 su ID con /sesion.'),
	HARNESS_CHAT_SESSION_MISSING: t => t('La conversaci\u00f3n ya no est\u00e1 disponible en este proyecto. Actualiz\u00e1 /sesiones.'),
	HARNESS_CHAT_SESSION_LIMIT: t => t('Se alcanzaron las 32 conversaciones archivadas. Respald\u00e1 el historial antes de liberar espacio.'),
	HARNESS_CONTEXT_GIT_UNAVAILABLE: t => t('No se pudo consultar Git para adjuntar contexto. Revis\u00e1 git status en el proyecto y reintent\u00e1.'),
	HARNESS_DEBUG_EVIDENCE_INVALID: t => t('Us\u00e1 /debug COMANDO | ERROR con un comando breve y su salida de error acotada.'),
	HARNESS_DELEGATION_DENIED: t => t('La delegaci\u00f3n no fue autorizada y no inici\u00f3 otra llamada al modelo.'),
	HARNESS_DELEGATION_FAILED: t => t('La tarea delegada fall\u00f3. Revis\u00e1 su resultado antes de lanzar otra.'),
	HARNESS_DELEGATION_INPUT_INVALID: t => t('La delegaci\u00f3n requiere un rol permitido y una instrucci\u00f3n breve, sin campos adicionales.'),
	HARNESS_DELEGATION_ISOLATION_UNSUPPORTED: t => t('Este proveedor no demuestra el aislamiento requerido para delegar. Continu\u00e1 en el agente principal.'),
	HARNESS_DELEGATION_LIMIT_OR_DENIED: t => t('La delegaci\u00f3n fue rechazada o agot\u00f3 el l\u00edmite de dos llamadas por sesi\u00f3n. Continu\u00e1 sin otro agente.'),
	HARNESS_DELEGATION_OBSERVER_FAILED: t => t('Fall\u00f3 el indicador de actividad delegada. Consult\u00e1 el resultado final antes de reintentar.'),
	HARNESS_DELEGATION_PARENT_UNAVAILABLE: t => t('La sesi\u00f3n principal ya no tiene autoridad vigente. Retomala antes de delegar.'),
	HARNESS_ATTACHMENT_BUSY: t => t('Ya hay un adjunto en preparaci\u00f3n. Termin\u00e1 o cancel\u00e1 esa operaci\u00f3n antes de elegir otro archivo.'),
	HARNESS_ATTACHMENT_FORMAT: t => t('Eleg\u00ed un PDF o notebook Jupyter (.ipynb) v\u00e1lido dentro del proyecto; no se ejecuta c\u00f3digo adjunto.'),
	HARNESS_ATTACHMENT_INVALID: t => t('No se pudo verificar el adjunto. Revis\u00e1 que sea un archivo regular del proyecto, no un enlace ni un archivo sensible.'),
	HARNESS_ATTACHMENT_LIMIT: t => t('El adjunto supera el l\u00edmite de tama\u00f1o o cantidad. Eleg\u00ed uno m\u00e1s peque\u00f1o.'),
	HARNESS_DOCUMENT_CANCELLED: t => t('La lectura del documento fue cancelada y su texto no se agreg\u00f3 al chat. Seleccionalo nuevamente si quer\u00e9s reintentar.'),
	HARNESS_DOCUMENT_INVALID: t => t('El documento no pudo validarse. Verific\u00e1 su formato y eleg\u00ed otro PDF o notebook del proyecto.'),
	HARNESS_DOCUMENT_PARSER_NOT_PACKAGED: t => t('El paquete del IDE no contiene el parser PDF local. Reinstal\u00e1 la extensi\u00f3n desde una versi\u00f3n verificada.'),
	HARNESS_DOCUMENT_NO_TEXT: t => t('No se encontr\u00f3 texto utilizable en el documento. Eleg\u00ed un archivo con texto seleccionable.'),
	HARNESS_DOCUMENT_TEXT_LIMIT: t => t('El texto extra\u00eddo excede el l\u00edmite permitido. Acot\u00e1 el documento antes de adjuntarlo.'),
	HARNESS_DOCUMENT_TIMEOUT: t => t('La extracci\u00f3n excedi\u00f3 el tiempo permitido. Prob\u00e1 con un documento m\u00e1s peque\u00f1o.'),
	HARNESS_DOCUMENT_WORKER_EXIT: t => t('El proceso aislado de lectura termin\u00f3 antes de responder. Revis\u00e1 el estado del IDE antes de reintentar.'),
	HARNESS_DOCUMENT_WORKER_FAILED: t => t('Fall\u00f3 el proceso aislado de lectura. Repar\u00e1 la extensi\u00f3n si faltan archivos del paquete y volv\u00e9 a elegir el adjunto.'),
	HARNESS_NOTEBOOK_INVALID: t => t('El notebook no tiene un formato Jupyter v4 v\u00e1lido o supera el l\u00edmite de celdas. Revis\u00e1 su estructura.'),
	HARNESS_PDF_INVALID: t => t('El archivo no es un PDF v\u00e1lido o no pudo leerse. Eleg\u00ed un PDF local sin errores.'),
	HARNESS_PDF_PAGE_LIMIT: t => t('El PDF supera el l\u00edmite de 20 p\u00e1ginas. Dividilo o seleccion\u00e1 las p\u00e1ginas necesarias.'),
	HARNESS_IMAGE_DIMENSIONS: t => t('Eleg\u00ed una imagen de hasta 8192 p\u00edxeles por lado y 20 megap\u00edxeles.'),
	HARNESS_IMAGE_INVALID: t => t('Eleg\u00ed un PNG o JPEG v\u00e1lido y confirm\u00e1 nuevamente su env\u00edo.'),
	HARNESS_IMAGE_LIMIT: t => t('Adjunt\u00e1 una imagen de hasta 4 MiB por turno.'),
	HARNESS_IMAGE_PATH_DENIED: t => t('Eleg\u00ed una imagen regular dentro del proyecto y fuera de carpetas sensibles.'),
	HARNESS_IMAGE_TRANSPORT_UNAVAILABLE: t => t('La imagen requiere transporte nativo y un turno de consulta. Revis\u00e1 atsHarness.agentTransport.'),
	HARNESS_MCP_TIMEOUT: t => t('El servidor MCP no respondi\u00f3 antes del plazo. Revis\u00e1 la conexi\u00f3n y verific\u00e1 cualquier cambio remoto antes de reintentar.'),
	HARNESS_MCP_CANCELLED: t => t('La conexi\u00f3n MCP fue cancelada. Revis\u00e1 su estado antes de repetir una acci\u00f3n.'),
	HARNESS_MCP_CATALOG_INVALID: t => t('El servidor MCP anunci\u00f3 herramientas inv\u00e1lidas. Correg\u00ed el servidor o deshabilitalo con /mcp disable.'),
	HARNESS_MCP_CONNECTION_LOST: t => t('Se perdi\u00f3 la conexi\u00f3n MCP. Verific\u00e1 si la operaci\u00f3n se complet\u00f3 antes de repetirla.'),
	HARNESS_MCP_DISCOVERY_FAILED: t => t('No se pudo descubrir el servidor MCP. Revis\u00e1 su comando y autenticaci\u00f3n con /mcp.'),
	HARNESS_MCP_HTTP_URL: t => t('La URL del servidor MCP HTTP debe usar HTTPS o HTTP local (localhost/127.0.0.1/::1), sin credenciales ni fragmentos. Corregí la dirección configurada con /mcp antes de reconectar.'),
	HARNESS_MCP_HTTP_HEADERS: t => t('El servidor MCP HTTP solo admite el encabezado Authorization con un valor válido y acotado. Revisá la configuración de autenticación sin copiar ni mostrar el token.'),
	HARNESS_MCP_HTTP_STATUS: t => t('El servidor MCP HTTP devolvió una respuesta de error. Revisá su disponibilidad, URL y autenticación; si la llamada podía escribir, verificá su resultado antes de repetirla.'),
	HARNESS_MCP_PROTOCOL: t => t('El servidor MCP devolvi\u00f3 un protocolo incompatible. Actualizalo o deshabilitalo.'),
	HARNESS_MCP_SERVER_REQUEST_DENIED: t => t('El servidor MCP pidi\u00f3 una operaci\u00f3n no permitida. Revis\u00e1 el servidor sin ampliar sus permisos.'),
	HARNESS_MCP_STDIO_UNSUPPORTED: t => t('Este puente admite MCP stdio. Eleg\u00ed un servidor compatible o us\u00e1 el transporte disponible en Claude.'),
	HARNESS_MCP_STOP_FAILED: t => t('No se pudo confirmar el cierre del proceso MCP. Revis\u00e1 su PID antes de abrir otra conexi\u00f3n.'),
	HARNESS_PROCESS_DIAGNOSTIC_FAILED: t => t('Fall\u00f3 el diagn\u00f3stico del proceso. Revis\u00e1 los procesos del IDE antes de reanudar.'),
	HARNESS_PROCESS_TERMINATION_FAILED: t => t('El sistema no permiti\u00f3 terminar el proceso. Revis\u00e1 su PID y detenelo antes de reintentar.'),
	HARNESS_NATIVE_SKILL_METADATA_INVALID: t => t('El cat\u00e1logo de skills incluido con el IDE no es v\u00e1lido. Reinstal\u00e1 o repar\u00e1 el IDE desde su distribuci\u00f3n oficial.'),
	HARNESS_NATIVE_SKILL_INVALID: t => t('La skill nativa seleccionada no es v\u00e1lida. Consult\u00e1 /skills y volv\u00e9 a elegirla; si se repite, repar\u00e1 el IDE.'),
	HARNESS_MCP_FAILED: t => t('No se pudo consultar ArmotuSitio. Revis\u00e1 la conexi\u00f3n MCP y la clave del agente en este workspace.'),
	HARNESS_MCP_INPUT_INVALID: t => t('El pedido a ArmotuSitio tiene argumentos inv\u00e1lidos. Pedile al agente que revise los campos de la herramienta.'),
	HARNESS_MCP_TOOL_DENIED: t => t('La herramienta de ArmotuSitio no est\u00e1 habilitada para esta ejecuci\u00f3n. Revis\u00e1 la conexi\u00f3n, el modo de permisos y el alcance del agente.'),
	HARNESS_MCP_WRITE_DENIED: t => t('El cambio en ArmotuSitio no fue autorizado. La operaci\u00f3n qued\u00f3 sin ejecutar.'),
	HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED: t => t('Otra ejecuci\u00f3n tiene el lock del proyecto o qued\u00f3 colgada. Si no hay nada corriendo, us\u00e1 {0} y reintent\u00e1.', RECONCILE_FENCE),
	HARNESS_ALREADY_RUNNING: t => t('Hay otra tarea de IA en curso. Esper\u00e1 a que termine o cancelala.'),
	HARNESS_PROVIDER_CAPACITY_REACHED: t => t('Hay otra tarea de IA en curso. Esper\u00e1 a que termine o cancelala.'),
	HARNESS_BUSY: t => t('Hay otra tarea de IA en curso. Esper\u00e1 a que termine o cancelala.'),
	HARNESS_UNTRUSTED_WORKSPACE: t => t('Marc\u00e1 el workspace como confiable para continuar.'),
	HARNESS_UNTRUSTED_OR_CANCELLED: t => t('Marc\u00e1 el workspace como confiable y volv\u00e9 a intentarlo.'),
	HARNESS_CANCELLED_BEFORE_START: t => t('La ejecuci\u00f3n se cancel\u00f3 antes de iniciar; no se modific\u00f3 ning\u00fan archivo.'),
	HARNESS_CHAT_VERIFICATION_CHANGED: t => t('La configuraci\u00f3n del proyecto cambi\u00f3 despu\u00e9s de revisar el plan. Pedile a la IA que lo confirme de nuevo.'),
	HARNESS_PROJECT_SKILL_CHANGED: t => t('La configuraci\u00f3n del proyecto cambi\u00f3 despu\u00e9s de revisar el plan. Pedile a la IA que lo confirme de nuevo.'),
	HARNESS_PROJECT_GUIDANCE_CHANGED: t => t('La configuraci\u00f3n del proyecto cambi\u00f3 despu\u00e9s de revisar el plan. Pedile a la IA que lo confirme de nuevo.'),
	HARNESS_PROJECT_SKILL_SELECTION_INVALID: t => t('El plan nombra una skill que el proyecto ya no tiene. Pedile a la IA que actualice el plan.'),
	HARNESS_PROJECT_SKILLS_TOO_MANY: t => t('El plan usa demasiadas skills a la vez. Pedile a la IA que elija las imprescindibles.'),
	HARNESS_CHAT_MESSAGE_TOO_LARGE: t => t('Tu mensaje no entra junto con el contexto del proyecto. Sub\u00ed \u00abatsHarness.promptBudgetKiB\u00bb o guard\u00e1 el detalle en un archivo del proyecto y mencion\u00e1 su ruta.'),
	HARNESS_CHAT_CONTEXT_TOO_LARGE: t => t('Tu mensaje no entra junto con el contexto del proyecto. Sub\u00ed \u00abatsHarness.promptBudgetKiB\u00bb o guard\u00e1 el detalle en un archivo del proyecto y mencion\u00e1 su ruta.'),
	HARNESS_CHAT_QUEUE_FULL: t => t('Ya hay 5 mensajes en cola. Esper\u00e1 a que avance la tarea o quit\u00e1 alguno.'),
	HARNESS_CHAT_MESSAGE_INVALID: t => t('Escrib\u00ed un mensaje de hasta 10.000 caracteres.'),
	HARNESS_FORK_UNAVAILABLE: t => t('Bifurcar necesita el transporte nativo (atsHarness.agentTransport en native o auto) y que no haya una tarea en curso.'),
	HARNESS_CHAT_RUN_NOT_CONTINUABLE: t => t('Esa ejecuci\u00f3n ya no se puede continuar (hay una m\u00e1s nueva, el plan cambi\u00f3 o escribiste despu\u00e9s). Aprob\u00e1 el plan actual para ejecutarlo.'),
	HARNESS_CHAT_PLAN_CHANGED: t => t('El plan cambi\u00f3 mientras lo aprobabas. Revis\u00e1 la versi\u00f3n m\u00e1s nueva y aprobala.'),
	HARNESS_CHAT_PLAN_NOT_APPROVABLE: t => t('Este plan no se puede aprobar ahora; el motivo aparece debajo del bot\u00f3n.'),
	HARNESS_CHAT_STATE_BUSY: t => t('Otra ventana est\u00e1 guardando esta conversaci\u00f3n. Reintent\u00e1 en unos segundos.'),
	HARNESS_CHAT_CONTEXT_UNAVAILABLE: t => t('No se pudo leer el estado del proyecto. Reintent\u00e1 en unos segundos.'),
	HARNESS_CHAT_UNAVAILABLE: t => t('El Harness nativo est\u00e1 desactivado o no carg\u00f3. Revis\u00e1 \u00abatsHarness.enabled\u00bb y recarg\u00e1 la ventana.'),
	HARNESS_HYBRID_WRITER_UNAVAILABLE: t => t('Este proyecto tiene su propio Harness. Activ\u00e1 \u00abatsHarness.coordinatedProjectWriters\u00bb (Usuario) y us\u00e1 un motor con lease de escritura.'),
	HARNESS_HYBRID_WRITER_UNSUPPORTED: t => t('El Harness de este proyecto no declara la capacidad \u00abwriter-lease\u00bb; actualizalo para que el IDE pueda escribir.'),
	HARNESS_HYBRID_WRITER_PROJECT_BUSY: t => t('El Harness del proyecto est\u00e1 ejecutando otra tarea. Esper\u00e1 a que termine y reintent\u00e1.'),
	HARNESS_HYBRID_WRITER_CONSENT_REQUIRED: t => t('Aprob\u00e1 el plan para dar consentimiento al motor del proyecto y reintent\u00e1.'),
	HARNESS_HYBRID_WRITER_FAILED: t => t('El Harness del proyecto rechaz\u00f3 la operaci\u00f3n de escritura coordinada; su respuesta est\u00e1 abajo. Si habla del lease, mir\u00e1 su estado con /lease y liberalo con /lease liberar.'),
	HARNESS_HYBRID_WRITER_TIMEOUT: t => t('El Harness del proyecto no respondi\u00f3 a tiempo. Revis\u00e1 que su entrada no est\u00e9 esperando una respuesta en una terminal y reintent\u00e1.'),
	HARNESS_HYBRID_WRITER_PROCESS: t => t('No se pudo iniciar el Harness del proyecto. Revis\u00e1 que Node.js funcione y que su entrada exista.'),
	HARNESS_HYBRID_WRITER_LEASE_LOST: t => t('El lease de escritura venci\u00f3 o el Harness del proyecto lo retir\u00f3 antes de que termine la ejecuci\u00f3n. Los cambios quedaron hechos y revisados; verific\u00e1 que el motor no haya corrido nada mientras tanto.'),
	HARNESS_AGENT_ISOLATION_INSUFFICIENT: t => t('Tu configuraci\u00f3n exige m\u00e1s aislamiento del que ofrece este proveedor. Eleg\u00ed el otro o ajust\u00e1 \u00abatsHarness.writerIsolation\u00bb.'),
	HARNESS_AGENT_TURNS_INVALID: t => t('Revis\u00e1 \u00abatsHarness.implementerMaxTurns\u00bb: debe estar entre 10 y 150.'),
	HARNESS_PROVIDER_MODEL_INVALID: t => t('Revis\u00e1 el modelo elegido en \u00abatsHarness.codexModel\u00bb o \u00abatsHarness.claudeModel\u00bb.'),
	HARNESS_PROVIDER_EFFORT_INVALID: t => t('Revis\u00e1 el nivel de razonamiento elegido para el proveedor.'),
	HARNESS_PROVIDER_UNSUPPORTED: t => t('Eleg\u00ed Codex o Claude Code.'),
	HARNESS_NO_PROVIDER_AVAILABLE: t => t('Ning\u00fan proveedor est\u00e1 listo. Us\u00e1 \u00abArmoTuSitio: Diagnosticar Codex y Claude locales\u00bb para ver qu\u00e9 falta.'),
	HARNESS_EXECUTABLE_UNAVAILABLE: t => t('No se encontr\u00f3 el programa necesario en el PATH. Instalalo o us\u00e1 \u00abArmoTuSitio: Diagnosticar Codex y Claude locales\u00bb.'),
	HARNESS_NODE_EXECUTABLE_UNAVAILABLE: t => t('No se encontr\u00f3 un Node.js utilizable. Us\u00e1 \u00abArmotuSitio: Seleccionar Node.js\u00bb para guardar su ruta en tu configuraci\u00f3n de usuario y reintent\u00e1.'),
	HARNESS_FILE_OPERATION_FAILED: t => t('No se pudo borrar o mover el archivo. Revis\u00e1 que no est\u00e9 abierto en otro programa y que tengas permisos sobre la carpeta.'),
	HARNESS_COMMAND_FAILED: t => t('No se pudo preparar el comando. Revis\u00e1 el error del sistema en los detalles; esto no significa que falte la herramienta.'),
	HARNESS_CHAT_TURN_INVALID: t => t('Escrib\u00ed un mensaje nuevo para que la IA responda.'),
	HARNESS_CHECKPOINT_APPROVAL_REQUIRED: t => t('Esta acci\u00f3n necesita tu confirmaci\u00f3n. Volv\u00e9 a ejecutarla y aprobala.'),
	HARNESS_CHECKPOINT_ROLLBACK_INCOMPLETE: t => t('La reversi\u00f3n qued\u00f3 incompleta. Revis\u00e1 git status antes de seguir y us\u00e1 {0}.', DIAGNOSE),
	HARNESS_WORKFLOW_AUTH_REVOKED: t => t('Se revoc\u00f3 la confianza o el consentimiento durante el workflow. Volv\u00e9 a aprobarlo para continuar.'),
	HARNESS_WORKFLOW_CALL_BUDGET_EXCEEDED: t => t('El workflow us\u00f3 todas las llamadas a la IA que ten\u00eda permitidas. Revis\u00e1 el resultado y crea uno nuevo si falta trabajo.'),
	HARNESS_WORKFLOW_FOREIGN_PROJECT_STATE: t => t('El estado guardado pertenece a otro proyecto. Abr\u00ed el proyecto correcto o us\u00e1 {0}.', DIAGNOSE),
	HARNESS_GATE_CAPACITY_INVALID: t => t('La configuraci\u00f3n de verificaciones en paralelo no es v\u00e1lida. Us\u00e1 \u00abArmoTuSitio: Configurar Harness nativo del proyecto\u00bb para regenerarla.'),
	HARNESS_CHANNEL_PATH_TOO_LONG: t => t('La carpeta temporal del sistema tiene una ruta demasiado larga para el canal local del Harness. Defin\u00ed una carpeta temporal m\u00e1s corta (variable TMPDIR) y reintent\u00e1.'),
	HARNESS_PROFILE_LIMIT: t => t('Alcanzaste el m\u00e1ximo de perfiles de IA. Elimin\u00e1 uno que no uses y reintent\u00e1.'),
	HARNESS_PROFILE_ALIAS_INVALID: t => t('El alias del perfil debe tener entre 1 y 40 caracteres, sin caracteres de control.'),
	HARNESS_PROFILE_ALIAS_TAKEN: t => t('Ya existe un perfil de ese proveedor con ese alias. Eleg\u00ed otro nombre.'),
	HARNESS_PROFILE_NOT_FOUND: t => t('El perfil ya no existe. Actualiz\u00e1 la lista de cuentas y volv\u00e9 a elegir.'),
	HARNESS_PROFILES_UNSAFE: t => t('El archivo de perfiles est\u00e1 da\u00f1ado o es de una versi\u00f3n m\u00e1s nueva. No se modific\u00f3; revis\u00e1lo o us\u00e1 {0}.', DIAGNOSE),
	HARNESS_MCP_SERVER_INVALID: t => t('El servidor MCP no es v\u00e1lido: us\u00e1 un nombre en min\u00fasculas (letras, n\u00fameros y guiones), una URL https (o http en localhost) o un comando, y sin credenciales dentro de la URL.'),
	HARNESS_MCP_SERVER_EXISTS: t => t('Ya hay un servidor MCP con ese nombre. Quitalo primero con /mcp remove.'),
	HARNESS_MCP_SERVER_LIMIT: t => t('Alcanzaste el m\u00e1ximo de servidores MCP. Quit\u00e1 uno que no uses y reintent\u00e1.'),
	HARNESS_MCP_SERVERS_UNSAFE: t => t('El archivo de servidores MCP est\u00e1 da\u00f1ado o es de una versi\u00f3n m\u00e1s nueva. No se modific\u00f3; revis\u00e1lo o us\u00e1 {0}.', DIAGNOSE),
	HARNESS_MCP_OAUTH_UNSUPPORTED: t => t('El servidor no admite el inicio de sesi\u00f3n que usa el IDE (OAuth con PKCE y registro din\u00e1mico sobre https). Pedile al proveedor un token y us\u00e1 --token.'),
	HARNESS_MCP_OAUTH_FAILED: t => t('No se pudo completar el inicio de sesi\u00f3n del servidor MCP. Reintent\u00e1 /mcp add con --oauth.'),
	HARNESS_MCP_OAUTH_TIMEOUT: t => t('No volviste del navegador a tiempo. Reintent\u00e1 /mcp add con --oauth.'),
	HARNESS_TIMEOUT: t => t('La operaci\u00f3n super\u00f3 su tiempo m\u00e1ximo. Reintent\u00e1 o acot\u00e1 el pedido.'),
	HARNESS_OPERATION_FAILED: t => t('La conversaci\u00f3n se conserva; pod\u00e9s reintentar. Si se repite, us\u00e1 {0}.', DIAGNOSE)
};

/** Families, checked in order; the first prefix that matches decides. */
const FAMILIES: Array<[RegExp, Hint]> = [
	[/^HARNESS_PROVIDER_.*(BUDGET|QUOTA|RATE_LIMITED)/, t => t('Se alcanz\u00f3 un l\u00edmite local de uso del proveedor. Revis\u00e1 \u00abArmoTuSitio: Consultar cupo local de llamadas de IA\u00bb o eleg\u00ed el otro proveedor.')],
	[/^HARNESS_FENCE_RECOVERY_/, t => t('Hay trabajo interrumpido pendiente de revisar antes de liberar el lock. Us\u00e1 \u00abArmoTuSitio: Reconciliar workflows interrumpidos\u00bb y despu\u00e9s {0}.', RECONCILE_FENCE)],
	[/^HARNESS_(FENCE|LOCK|LOCKED)_/, t => t('El lock del proyecto no est\u00e1 en un estado seguro. Si no hay nada corriendo, us\u00e1 {0}.', RECONCILE_FENCE)],
	[/^HARNESS_WORKFLOW_.*RECONCILIATION|^HARNESS_(RECONCILIATION_REQUIRED|RECONCILE)|^HARNESS_WORKFLOW_(PENDING_JOURNAL|ACTIVE_LOCK|ALREADY_RUNNING)/, t => t('Hay un workflow interrumpido. Us\u00e1 \u00abArmoTuSitio: Reconciliar workflows interrumpidos\u00bb y reintent\u00e1.')],
	[/^HARNESS_(WORKFLOW|CHECKPOINT|WORKTREE|INTEGRATION)_.*(DIRTY|HEAD|REPOSITORY|NOT_REPOSITORY_ROOT|GIT)/, t => t('El repositorio no est\u00e1 en el estado esperado (cambios sin guardar, otra rama o git no disponible). Revis\u00e1 git status y reintent\u00e1.')],
	[/^HARNESS_(HANDSHAKE|PROJECT_STATUS|PROJECT_GATE|CAPABILIT|HYBRID|CONTRACT|PROJECT_AUTHORITY)/, t => t('El Harness propio del proyecto no respondi\u00f3 como el IDE espera. Revis\u00e1 que est\u00e9 actualizado y us\u00e1 \u00abArmoTuSitio: Consultar estado del Harness externo\u00bb.')],
	[/^HARNESS_(CONFIG|GATE_CATALOG|PLAN_SCHEMA|INVALID_|DUPLICATE_GATE|CYCLE|DEPENDENCY|PATH_|PROJECT_(FILE|GUIDE|SKILL))/, t => t('La configuraci\u00f3n del Harness del proyecto no es v\u00e1lida. Us\u00e1 \u00abArmoTuSitio: Configurar Harness nativo del proyecto\u00bb para regenerarla.')],
	[/^HARNESS_(SCOPE|SENSITIVE)_/, t => t('No se pudo verificar qu\u00e9 archivos cambi\u00f3 la consulta. Revis\u00e1 que git funcione en el proyecto y reintent\u00e1.')],
	[/^HARNESS_(CHECKPOINT|WORKTREE)_.*(IDENTITY|ID_INVALID|WORKTREE_INVALID)/, t => t('El worktree o checkpoint del Harness no coincide con lo registrado. Us\u00e1 \u00abArmoTuSitio: Retirar Git worktree limpio del Harness\u00bb o {0}.', DIAGNOSE)],
	[/^HARNESS_.*(ROOT_CHANGED|PATH_CHANGED|_CHANGED)$/, t => t('El proyecto o su configuraci\u00f3n cambi\u00f3 mientras se preparaba la operaci\u00f3n. Reintent\u00e1.')],
	[/^HARNESS_.*(UNSAFE|STORAGE|STATE_INVALID|STATE_TOO_LARGE|TOO_LARGE|INVALID_STATE|INCOMPATIBLE_SCHEMA)/, t => t('El estado guardado del Harness est\u00e1 da\u00f1ado o es demasiado grande. Us\u00e1 {0} para ver cu\u00e1l y c\u00f3mo recuperarlo.', DIAGNOSE)],
	[/^HARNESS_(OTLP)_/, t => t('No se pudo exportar la traza. Revis\u00e1 \u00abatsHarness.otlpEndpoint\u00bb y que el colector responda.')],
	[/^HARNESS_(EVIDENCE|SUPPORT)/, t => t('No se pudo generar la evidencia o el informe de soporte. Reintent\u00e1 desde \u00abArmoTuSitio: Diagn\u00f3sticos y evidencias del Harness nativo\u00bb.')],
	[/^HARNESS_(AGENT|HANDOFF|DAG|READ_ONLY|IMPLEMENTER|ADAPTIVE)_/, t => t('El pedido al agente no pas\u00f3 la validaci\u00f3n del IDE. Ped\u00ed a la IA que regenere el plan y reintent\u00e1.')],
	[/^HARNESS_(OS_SANDBOX)_/, t => t('El aislamiento del sistema operativo no est\u00e1 disponible en esta m\u00e1quina. Ajust\u00e1 \u00abatsHarness.writerIsolation\u00bb o eleg\u00ed el otro proveedor.')],
	[/^HARNESS_(RESUME|RETRY|STOP_PENDING|ATTEMPT|APPROVAL_EXPIRED|NOT_OWNED|TASK|CREATE|PROGRESS|PREFLIGHT|PLAN_CHANGED|REQUEST|ANSWERS|ARGUMENTS|SOURCE|TOOL|WORKSPACE|UNSUPPORTED|OUTPUT_LIMIT|METRICS|PROVIDER|ROOT|STATE)/, t => t('La tarea no se pudo ejecutar como estaba preparada. Volv\u00e9 a abrirla o creala de nuevo; si se repite, us\u00e1 {0}.', DIAGNOSE)]
];

/** What the user can do about a known failure; an unknown code falls back to the generic retry hint. */
export function recoveryHint(t: Translate, code: string): string {
	const exact = EXACT[code];
	if (exact) { return exact(t); }
	const family = FAMILIES.find(([pattern]) => pattern.test(code));
	return (family?.[1] ?? EXACT.HARNESS_OPERATION_FAILED)(t);
}

/** True when a code has its own hint instead of the generic fallback. */
export function hasRecoveryHint(code: string): boolean {
	return code !== 'HARNESS_OPERATION_FAILED' && (Object.hasOwn(EXACT, code) || FAMILIES.some(([pattern]) => pattern.test(code)));
}
