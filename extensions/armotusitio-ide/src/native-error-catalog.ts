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
	HARNESS_CHAT_MESSAGE_INVALID: t => t('Escrib\u00ed un mensaje de hasta 10.000 caracteres.'),
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
	HARNESS_AGENT_ISOLATION_INSUFFICIENT: t => t('Tu configuraci\u00f3n exige m\u00e1s aislamiento del que ofrece este proveedor. Eleg\u00ed el otro o ajust\u00e1 \u00abatsHarness.writerIsolation\u00bb.'),
	HARNESS_AGENT_TURNS_INVALID: t => t('Revis\u00e1 \u00abatsHarness.implementerMaxTurns\u00bb: debe estar entre 10 y 150.'),
	HARNESS_PROVIDER_MODEL_INVALID: t => t('Revis\u00e1 el modelo elegido en \u00abatsHarness.codexModel\u00bb o \u00abatsHarness.claudeModel\u00bb.'),
	HARNESS_PROVIDER_EFFORT_INVALID: t => t('Revis\u00e1 el nivel de razonamiento elegido para el proveedor.'),
	HARNESS_PROVIDER_UNSUPPORTED: t => t('Eleg\u00ed Codex o Claude Code.'),
	HARNESS_NO_PROVIDER_AVAILABLE: t => t('Ning\u00fan proveedor est\u00e1 listo. Us\u00e1 \u00abArmoTuSitio: Diagnosticar Codex y Claude locales\u00bb para ver qu\u00e9 falta.'),
	HARNESS_EXECUTABLE_UNAVAILABLE: t => t('No se encontr\u00f3 el programa necesario en el PATH. Instalalo o us\u00e1 \u00abArmoTuSitio: Diagnosticar Codex y Claude locales\u00bb.'),
	HARNESS_CHAT_TURN_INVALID: t => t('Escrib\u00ed un mensaje nuevo para que la IA responda.'),
	HARNESS_CHECKPOINT_APPROVAL_REQUIRED: t => t('Esta acci\u00f3n necesita tu confirmaci\u00f3n. Volv\u00e9 a ejecutarla y aprobala.'),
	HARNESS_CHECKPOINT_ROLLBACK_INCOMPLETE: t => t('La reversi\u00f3n qued\u00f3 incompleta. Revis\u00e1 git status antes de seguir y us\u00e1 {0}.', DIAGNOSE),
	HARNESS_WORKFLOW_AUTH_REVOKED: t => t('Se revoc\u00f3 la confianza o el consentimiento durante el workflow. Volv\u00e9 a aprobarlo para continuar.'),
	HARNESS_WORKFLOW_CALL_BUDGET_EXCEEDED: t => t('El workflow us\u00f3 todas las llamadas a la IA que ten\u00eda permitidas. Revis\u00e1 el resultado y crea uno nuevo si falta trabajo.'),
	HARNESS_WORKFLOW_FOREIGN_PROJECT_STATE: t => t('El estado guardado pertenece a otro proyecto. Abr\u00ed el proyecto correcto o us\u00e1 {0}.', DIAGNOSE),
	HARNESS_GATE_CAPACITY_INVALID: t => t('La configuraci\u00f3n de verificaciones en paralelo no es v\u00e1lida. Us\u00e1 \u00abArmoTuSitio: Configurar Harness nativo del proyecto\u00bb para regenerarla.'),
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
