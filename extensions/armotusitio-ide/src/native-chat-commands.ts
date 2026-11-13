/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Slash commands of the chat. `chatCommands` is the single table: `/ayuda`, the composer autocomplete and the dispatcher
 * in `chat.ts` all derive from it, so a new command cannot be missing from the help. Commands that need the conversation
 * (`session: true`) run here against the session; the rest are Work Management / Harness queries handled in `chat.ts`.
 */
import { runMcpCommand, type McpCommandDeps } from './native-mcp-command.ts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { harnessErrorCode, type ChatMode } from './native-chat.ts';
import type { HarnessChatSession } from './native-chat-session.ts';
import type { ToolCheckpoint } from './native-chat-tool-checkpoints.ts';
import type { GoalIntegration, LiveGoalListing } from './native-goal-integration.ts';
import type { EngineLease, EngineLeaseState } from './native-hybrid-writer.ts';
import { listUserRules, loadPermissions, projectKey, removeUserRule } from './native-permissions.ts';
import type { PermissionPreset } from './native-permissions-types.ts';
import type { ProviderQuota } from './native-quota.ts';
import type { BudgetStatus, BudgetWarning } from './native-provider-quota.ts';
import { redactSecrets } from './native-redact.ts';
import { skillsListing } from './native-chat-skills.ts';
import { runProjectMemoryCommand } from './native-project-memory-command.ts';
import type { ClaudeIntegrationBridge } from './native-claude-integrations.ts';

export type CommandTranslator = (text: string, ...args: string[]) => string;
export interface ChatCommand {
	name: string;
	/** Arguments, shown after the name. */
	usage?: string;
	description: string;
	/** Needs the open conversation, so the VS Code chat participant cannot run it. */
	session: boolean;
}

const providerName = (provider: ProviderQuota['provider']): string => provider === 'claude' ? 'Claude Code' : 'Codex';

function ageText(ms: number, t: CommandTranslator): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	return minutes < 1 ? t('menos de 1 min') : minutes < 60 ? t('{0} min', String(minutes)) : minutes < 48 * 60 ? t('{0} h', String(Math.floor(minutes / 60))) : t('{0} d', String(Math.floor(minutes / 1440)));
}

/** Session/weekly usage windows as the provider reported them, with how old the reading is. */
export function quotaLines(quotas: readonly ProviderQuota[], t: CommandTranslator, now = Date.now()): string[] {
	const names: Record<string, string> = { session: t('Sesi\u00f3n'), weekly: t('Semanal') };
	return quotas.flatMap(quota => [
		t('Cupo de {0} (dato de hace {1}):', providerName(quota.provider), ageText(now - quota.asOf, t)),
		...quota.windows.map(window => '  ' + t('{0}: {1}% libre', names[window.id] ?? window.label, String(Math.round(Math.max(0, 100 - window.usedPercent)))) +
			(window.resetsAt ? ' \u00b7 ' + t('reinicia {0}', new Date(window.resetsAt * 1000).toLocaleString()) : ''))
	]);
}

/** Configured 24 h limits with recorded use; without limits it says how to set them instead of inventing a figure. */
export function budgetLines(status: BudgetStatus, t: CommandTranslator): string[] {
	const limits: Array<[BudgetWarning['kind'], number, string, (usage: BudgetStatus['budget']['providers']['codex'], calls: BudgetStatus['quota']['providers']['codex']) => string]> = [
		['calls', status.quota.maxCallsPer24h ?? 0, t('llamadas'), (_usage, calls) => String(calls.used)],
		['tokens', status.budget.policy.maxTokensPer24h, t('tokens'), usage => String(usage.tokens)],
		['cost', status.budget.policy.maxCostUsdPer24h, t('US$'), usage => usage.costUsd.toFixed(4)]
	];
	const enabled = limits.filter(([, limit]) => limit > 0);
	if (!enabled.length) { return [t('Presupuestos de 24 h: sin l\u00edmites configurados (atsHarness.providerCallsPer24h, providerTokensPer24h, providerCostUsdPer24h).')]; }
	return [t('Presupuestos de 24 h (uso registrado, nunca estimado):'), ...(['codex', 'claude'] as const).flatMap(provider => [
		'  ' + providerName(provider) + ': ' + enabled.map(([kind, limit, label, used]) => {
			const warning = status.warnings.find(item => item.provider === provider && item.kind === kind);
			return used(status.budget.providers[provider], status.quota.providers[provider]) + ' / ' + limit + ' ' + label + (warning ? ' ' + t('(\u00a1{0}%!)', String(warning.usedPercent)) : '');
		}).join(' \u00b7 '),
		...(status.budget.providers[provider].unmeteredCalls ? ['    ' + t('{0} llamadas sin consumo informado: con presupuesto de tokens o costo el pr\u00f3ximo lanzamiento se rechaza.', String(status.budget.providers[provider].unmeteredCalls))] : [])
	])];
}

export function chatCommands(t: CommandTranslator): ChatCommand[] {
	return [
		{ name: 'ayuda', description: t('Lista los comandos disponibles.'), session: false },
		{ name: 'permisos', usage: '[usuario|proyecto|quitar REGLA|temporales quitar [REGLA]]', description: t('Muestra los permisos efectivos, tus reglas guardadas y los permisos temporales de esta sesi\u00f3n; con usuario o proyecto abre (o crea) su archivo JSON; con quitar revoca una regla tuya; con temporales quitar revoca permisos de esta tarea o sesi\u00f3n.'), session: true },
		{ name: 'bifurcar', description: t('Contin\u00faa en una copia de la sesi\u00f3n nativa del proveedor; la original queda guardada sin cambios.'), session: true },
		{ name: 'modo', usage: '[actuar|preguntar]', description: t('Muestra o cambia el modo del chat.'), session: true },
		{ name: 'deshacer', description: t('Descarta los cambios de la \u00faltima ejecuci\u00f3n.'), session: true },
		{ name: 'checkpoints', usage: '[restaurar ID]', description: t('Lista los checkpoints granulares que dejaron las herramientas del agente (por turno y herramienta); "restaurar ID" vuelve esos archivos a su estado anterior solo si nadie los edit\u00f3 despu\u00e9s.'), session: true },
		{ name: 'objetivos', usage: '[pausar|detener ID]', description: t('Muestra los objetivos aut\u00f3nomos en curso en esta ventana, con su etapa y preguntas pendientes; "pausar" o "detener" act\u00faan en el pr\u00f3ximo punto seguro.'), session: true },
		{ name: 'lease', usage: '[liberar]', description: t('Estado del lease de escritura del Harness propio del proyecto; "liberar" lo retira cuando el IDE muri\u00f3 con \u00e9l.'), session: true },
		{ name: 'motor', usage: 'COMANDO [ARGUMENTOS]', description: t('Corre un comando del Harness propio del proyecto (por ejemplo pnpm harness:preflight) en la terminal del IDE, donde pod\u00e9s contestar sus preguntas; el resultado queda en la conversaci\u00f3n.'), session: true },
		{ name: 'skills', description: t('Lista las skills nativas y del proyecto (carpetas .agents, .codex o .claude).'), session: true },
		{ name: 'integraciones', usage: '[ver|habilitar|deshabilitar ID]', description: t('Inspecciona las integraciones locales de Claude y habilita hooks compatibles con aprobaci\u00f3n por ejecuci\u00f3n.'), session: true },
		{ name: 'memoria', usage: '[guardar decision|convencion|solucion TEXTO | corregir ID TEXTO | quitar ID]', description: t('Inspecciona y corrige la memoria confirmada del proyecto.'), session: true },
		{ name: 'skill', usage: 'NOMBRE [pedido]', description: t('Aplica una skill nativa o del proyecto a tu pedido: su contenido llega a la IA como convenciones, nunca como permisos.'), session: true },
		{ name: 'doctor', description: t('Revisa la m\u00e1quina y el proyecto (Node, gestor de paquetes, git, Docker, disco) y dice c\u00f3mo arreglar cada problema.'), session: true },
		{ name: 'debug', usage: 'COMANDO | ERROR', description: t('Analiza un fallo reproducible y propone un plan de diagn\u00f3stico. Los cambios y las pruebas requieren aprobar el plan.'), session: true },
		{ name: 'documento', usage: '[pedido]', description: t('Selecciona un PDF o notebook del proyecto para revisar y enviar solo su texto extraido, con consentimiento.'), session: true },
		{ name: 'imagen', usage: '[pedido]', description: t('Eleg\u00ed una imagen del proyecto, revisala y confirm\u00e1 su env\u00edo al proveedor seleccionado.'), session: true },
		{ name: 'sesiones', usage: '[b\u00fasqueda]', description: t('Busca las conversaciones guardadas de este proyecto.'), session: true },
		{ name: 'sesion', usage: 'ID', description: t('Retoma una conversaci\u00f3n guardada del proyecto sin repetir operaciones interrumpidas.'), session: true },
		{ name: 'auditoria', description: t('\u00daltimas acciones de las herramientas del agente en este proyecto (comandos, git, archivos) y su resultado.'), session: true },
		{ name: 'costo', description: t('Muestra los tokens que inform\u00f3 el proveedor en el \u00faltimo turno y el uso de los presupuestos de 24 h.'), session: true },
		{ name: 'estado', description: t('Progreso de las tareas del Harness.'), session: false },
		{ name: 'comandos', description: t('Acciones disponibles por proyecto.'), session: false },
		{ name: 'check', usage: '[proyecto]', description: t('Corre las verificaciones r\u00e1pidas del proyecto.'), session: false },
		{ name: 'verify', usage: '[proyecto]', description: t('Corre la verificaci\u00f3n completa del proyecto.'), session: false },
		{ name: 'test', usage: '[proyecto]', description: t('Corre las pruebas del proyecto.'), session: false },
		{ name: 'mcp', description: t('Herramientas de Work Management disponibles para tu clave.'), session: false },
		{ name: 'proyectos', description: t('Lista los proyectos de Work Management.'), session: false },
		{ name: 'proyecto', usage: 'CLAVE', description: t('Contexto de un proyecto.'), session: false },
		{ name: 'tareas', usage: 'CLAVE', description: t('Tareas de un proyecto.'), session: false },
		{ name: 'tarea', usage: 'CLAVE-123', description: t('Contexto de una tarea.'), session: false },
		{ name: 'tablero', usage: 'CLAVE', description: t('Tablero de un proyecto.'), session: false },
		{ name: 'buscar', usage: 'texto', description: t('Busca tareas por texto.'), session: false },
		{ name: 'crear', usage: 'CLAVE t\u00edtulo', description: t('Crea una tarea (pide confirmaci\u00f3n).'), session: false },
		{ name: 'mover', usage: 'CLAVE-123 columnaId', description: t('Mueve una tarea de columna (pide confirmaci\u00f3n).'), session: false },
		{ name: 'comentar', usage: 'CLAVE-123 texto', description: t('Comenta una tarea (pide confirmaci\u00f3n).'), session: false }
	];
}

/** One line per command, generated from the table. */
export function commandHelp(t: CommandTranslator): string {
	return [t('Comandos:'), ...chatCommands(t).map(command => '/' + command.name + (command.usage ? ' ' + command.usage : '') + ' \u2014 ' + command.description),
	t('Pod\u00e9s anteponer @harness o usar /comando. Con @archivo adjunt\u00e1s un archivo del proyecto como contexto y con @terminal la salida de tu \u00faltimo comando de terminal.')].join('\n');
}

const USER_FILE_LABEL = '~/.armotusitio/permissions.json';
const PROJECT_FILE_LABEL = '.armotusitio/permissions.json';
/** Valid against `resources/permissions.schema.json`; JSON has no comments, so the chat explains the rules instead. */
export const PERMISSIONS_TEMPLATE = JSON.stringify({ version: 1, allow: [], ask: [], deny: [] }, null, 2) + '\n';

/** Creates the permissions file with the empty template unless something is already there. */
async function ensurePermissionsFile(file: string): Promise<void> {
	const directory = path.dirname(file);
	try {
		if ((await fs.lstat(directory)).isSymbolicLink()) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		await fs.mkdir(directory, { recursive: true });
	}
	try { await fs.writeFile(file, PERMISSIONS_TEMPLATE, { encoding: 'utf8', flag: 'wx' }); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
	}
}

const AUDITED_RUNS = 10;

/** Latest tool actions of this project's recent runs, newest first, one line each; secrets are redacted. */
export async function auditLines(runsDirectory: string, limit = 30): Promise<string[]> {
	const runs = (await fs.readdir(runsDirectory).catch(() => [] as string[])).sort().reverse().slice(0, AUDITED_RUNS);
	const entries: Array<Record<string, unknown>> = [];
	for (const run of runs) {
		const raw = await fs.readFile(path.join(runsDirectory, run, 'logs', 'commands.jsonl'), 'utf8').catch(() => '');
		for (const line of raw.split('\n')) {
			// A torn last line (the run was killed mid-write) is skipped; every complete line is shown.
			try { const value = JSON.parse(line) as Record<string, unknown>; if (value && typeof value.at === 'string') { entries.push(value); } } catch { continue; }
		}
	}
	return entries.sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, limit).map(entry => {
		const what = typeof entry.command === 'string' ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ') : String(entry.tool);
		const result = entry.denied ? 'denegado: ' + entry.denied : entry.error ? 'error: ' + entry.error : entry.exitCode !== undefined ? 'exit ' + entry.exitCode : String(entry.outcome ?? '');
		return '  ' + String(entry.at).slice(0, 19).replace('T', ' ') + '  ' + redactSecrets(what).slice(0, 160) + '  -> ' + result;
	});
}

const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

export interface SessionCommandDeps {
	/** Recorded 24 h use against the configured limits; absent when the window has no Harness controller. */
	budget?(root: string): Promise<BudgetStatus>;
	integrations?: ClaudeIntegrationBridge;
	nativeSkillsDirectory?: string;
	t: CommandTranslator;
	chatMode(): ChatMode;
	setChatMode(mode: ChatMode): Promise<void>;
	/** `atsHarness.permissionsPreset`, when set. */
	permissionsPreset(): PermissionPreset | undefined;
	openFile(file: string): Promise<void>;
	/** Modal confirmation shared with the "discard changes" button. */
	confirmDiscard(): Promise<boolean>;
	/** Markdown report of the machine doctor for a project. */
	doctor?(root: string): Promise<string>;
	/** Folder holding this project's agent runs, each with `logs/commands.jsonl`. */
	runsDirectory?(root: string): string | undefined;
	home?: string;
	/** User-added MCP servers (`/mcp`); absent where the transport cannot use them. */
	mcp?: McpCommandDeps;
	/** The writer lease of a project that has its own Harness (`/lease`); absent when the project has none. */
	lease?: { status(): Promise<EngineLease>; clear(): Promise<EngineLeaseState>; confirmClear(): Promise<boolean> };
	/** Runs a project command in the visible IDE terminal and returns its result as text (`/motor`). */
	motor?: (command: string, args: string[]) => Promise<string>;
	image?: (request: string, root: string, session: HarnessChatSession) => Promise<string>;
	document?: (request: string, root: string, session: HarnessChatSession) => Promise<string>;
	/** Granular tool checkpoints of the project (`/checkpoints`); `restore` confirms with the user and returns `undefined` when they decline. */
	checkpoints?: { list(root: string): Promise<ToolCheckpoint[]>; restore(root: string, id: string): Promise<{ restored: string[]; skipped: string[] } | undefined> };
	/** Autonomous goals running in this window (`/objetivos`). */
	goals?: Pick<GoalIntegration, 'list' | 'control'>;
}

const GOAL_STATUS: Record<LiveGoalListing['status'], (t: CommandTranslator) => string> = {
	running: t => t('en ejecuci\u00f3n'), pausing: t => t('pausa pedida'), stopping: t => t('detenci\u00f3n pedida'), 'waiting-answers': t => t('espera tus respuestas')
};

/** `/checkpoints` lists what can be restored; `/checkpoints restaurar ID` restores one after the shared confirmation. */
async function runCheckpointsCommand(deps: SessionCommandDeps, words: string[], root: string, session: HarnessChatSession): Promise<string> {
	const { t, checkpoints } = deps;
	if (!checkpoints) { return t('Los checkpoints granulares no est\u00e1n disponibles en esta ventana.'); }
	if (words.length === 0) {
		const items = await checkpoints.list(root);
		if (!items.length) { return t('No hay checkpoints granulares seguros en este proyecto. Se crean cuando el agente edita archivos en una ejecuci\u00f3n del chat.'); }
		return [
			t('Checkpoints granulares (m\u00e1s reciente primero). Restaur\u00e1 uno con /checkpoints restaurar ID:'),
			...items.slice(0, 20).map(item => '  ' + item.id.slice(0, 8) + ' \u00b7 ' + item.at + ' \u00b7 ' + item.kind + ' \u00b7 ' + t('{0} archivos', String(item.files.length)) + (item.turnId ? ' \u00b7 ' + t('turno {0} #{1}', item.turnId.slice(0, 8), String(item.sequence ?? 1)) : '') + ' \u00b7 ' + item.files.slice(0, 3).map(file => file.path).join(', ') + (item.files.length > 3 ? ' +' + String(item.files.length - 3) : '')),
			...(items.length > 20 ? [t('  \u2026 y {0} m\u00e1s', String(items.length - 20))] : [])
		].join('\n');
	}
	if (words[0] !== 'restaurar' || words.length !== 2) { return t('Uso: /checkpoints [restaurar ID]'); }
	if (session.snapshot().activity) { return t('Hay una tarea en curso: esper\u00e1 a que termine o detenela antes de restaurar.'); }
	const wanted = words[1].toLowerCase();
	const matches = (await checkpoints.list(root)).filter(item => item.id.toLowerCase().startsWith(wanted));
	if (matches.length !== 1) { return matches.length ? t('El ID coincide con varios checkpoints; escrib\u00ed m\u00e1s caracteres.') : t('No encontr\u00e9 ese checkpoint. Consult\u00e1 /checkpoints.'); }
	const outcome = await checkpoints.restore(root, matches[0].id);
	if (!outcome) { return t('Restauraci\u00f3n cancelada.'); }
	await session.refreshContext();
	return t('Checkpoint {0}: {1} archivos restaurados; {2} preservados porque cambiaron despu\u00e9s.', matches[0].id.slice(0, 8), String(outcome.restored.length), String(outcome.skipped.length));
}

/** `/objetivos` lists the goals of this window; `/objetivos pausar|detener ID` asks one to stop at its next safe point. */
function runGoalsCommand(deps: SessionCommandDeps, words: string[]): string {
	const { t, goals } = deps;
	if (!goals) { return t('Los objetivos aut\u00f3nomos no est\u00e1n disponibles en esta ventana.'); }
	if (words.length === 0) {
		const items = goals.list();
		if (!items.length) { return t('No hay objetivos aut\u00f3nomos en curso en esta ventana. Cre\u00e1 uno con \u00abArmoTuSitio: Nuevo objetivo aut\u00f3nomo\u00bb.'); }
		return [
			t('Objetivos en curso:'),
			...items.map(item => '  ' + item.id + ' \u00b7 ' + item.project + ' \u00b7 ' + GOAL_STATUS[item.status](t) + ' \u00b7 ' + item.objective + (item.questions.length ? '\n    ' + t('Preguntas pendientes: {0}', item.questions.slice(0, 3).join(' | ')) : ''))
		].join('\n');
	}
	const action = words[0] === 'pausar' ? 'pause' : words[0] === 'detener' ? 'stop' : undefined;
	if (!action || words.length !== 2) { return t('Uso: /objetivos [pausar|detener ID]'); }
	if (!goals.control(words[1], action)) { return t('No hay un objetivo en curso con ese ID. Consult\u00e1 /objetivos.'); }
	return action === 'pause' ? t('Ped\u00ed pausar el objetivo {0}; se detiene en su pr\u00f3ximo punto seguro.', words[1]) : t('Ped\u00ed detener el objetivo {0}; se detiene en su pr\u00f3ximo punto seguro.', words[1]);
}

const LEASE_TEXT: Record<EngineLeaseState, (t: CommandTranslator, until?: string) => string> = {
	none: t => t('El Harness del proyecto no tiene un lease de escritura del IDE: nada que liberar.'),
	valid: (t, until) => t('El IDE tiene el lease de escritura del Harness del proyecto{0}. Si el IDE ya no est\u00e1 ejecutando, liberalo con /lease liberar.', until ? ' (' + t('vence {0}', until) + ')' : ''),
	expired: t => t('El lease de escritura venci\u00f3; el motor lo retira solo en su pr\u00f3ximo comando. Tambi\u00e9n pod\u00e9s liberarlo con /lease liberar.'),
	foreign: t => t('Hay un lease de escritura de otro entorno en este clon. Si ya no corre nada all\u00e1, liberalo con /lease liberar.'),
	invalid: t => t('El archivo del lease de escritura est\u00e1 ilegible. Liberalo con /lease liberar.')
};

/** `/lease` shows the engine's lease state; `/lease liberar` removes a lease left behind by an IDE that died holding it. */
async function runLeaseCommand(deps: SessionCommandDeps, words: string[]): Promise<string> {
	const { t, lease } = deps;
	if (!lease) { return t('Este proyecto no tiene un Harness propio con lease de escritura.'); }
	if (words.length > 1 || (words.length === 1 && words[0] !== 'liberar')) { return t('Uso: /lease [liberar]'); }
	const current = await lease.status().catch((error: unknown) => {
		// Without an engine entrypoint of its own the project has no lease to show.
		if (harnessErrorCode(error) === 'HARNESS_HYBRID_WRITER_ENTRY_UNAVAILABLE') { return undefined; }
		throw error;
	});
	if (!current) { return t('Este proyecto no tiene un Harness propio con lease de escritura.'); }
	if (words[0] !== 'liberar') { return LEASE_TEXT[current.state](t, current.expiresAt); }
	if (current.state === 'none') { return LEASE_TEXT.none(t); }
	if (!await lease.confirmClear()) { return t('No liber\u00e9 el lease.'); }
	const previous = await lease.clear();
	return t('Liber\u00e9 el lease de escritura (estaba: {0}). El Harness del proyecto vuelve a aceptar tareas.', previous);
}

/** Runs a command that needs the conversation; `undefined` when `action` is not one of them. */
export async function runSessionCommand(deps: SessionCommandDeps, action: string, words: string[], root: string, session: HarnessChatSession): Promise<string | undefined> {
	if (action === 'memoria') { return runProjectMemoryCommand(words, root, session, deps.t); }
	if (action === 'integraciones') { return deps.integrations?.command(root, words, deps.t) ?? deps.t('Las integraciones no est\u00e1n disponibles en esta ventana.'); }
	const { t } = deps;
	const home = deps.home ?? os.homedir();
	if (action === 'mcp' && deps.mcp) { return await runMcpCommand(deps.mcp, words); }
	if (action === 'lease') { return await runLeaseCommand(deps, words); }
	if (action === 'skills') { return await skillsListing(root, t, deps.nativeSkillsDirectory); }
	if (action === 'documento') { return deps.document ? await deps.document(words.join(' '), root, session) : t('El lector de documentos no esta disponible.'); }
	if (action === 'imagen') { return deps.image ? await deps.image(words.join(' '), root, session) : t('Las im\u00e1genes no est\u00e1n disponibles en este chat.'); }
	if (action === 'sesiones') {
		const found = await session.sessions(words.join(' '));
		return found.length ? found.map(item => item.id + '  ' + item.provider + '  ' + item.title).join('\n') : t('No hay conversaciones guardadas para esa b\u00fasqueda.');
	}
	if (action === 'sesion') {
		if (words.length !== 1) { return t('Uso: /sesion ID. Encontr\u00e1 el ID con /sesiones.'); }
		await session.resume(words[0]);
		return t('Conversaci\u00f3n retomada. Las operaciones interrumpidas requieren revisi\u00f3n antes de reintentar.');
	}
	if (action === 'debug') {
		const evidence = words.join(' ');
		const separator = evidence.indexOf('|');
		if (separator <= 0 || !evidence.slice(separator + 1).trim()) { return t('Uso: /debug COMANDO | ERROR. Inclu\u00ed el comando que falla y el error observado.'); }
		await session.diagnose(evidence.slice(0, separator).trim(), evidence.slice(separator + 1).trim());
		return t('Diagn\u00f3stico solicitado. Revis\u00e1 el plan antes de autorizar experimentos o cambios.');
	}
	if (action === 'motor') {
		if (!deps.motor) { return t('Este chat no puede abrir la terminal del IDE.'); }
		if (!words.length) { return t('Uso: /motor COMANDO [ARGUMENTOS] (por ejemplo /motor pnpm harness:preflight).'); }
		// The agent and the user must not both drive the project at once.
		if (session.snapshot().activity) { return t('Hay una ejecuci\u00f3n en curso en este chat. Esper\u00e1 a que termine o cancelala y volv\u00e9 a intentar.'); }
		return await deps.motor(words[0], words.slice(1));
	}
	if (action === 'permisos') {
		const target = (words[0] ?? '').toLowerCase();
		if (target === 'usuario' || target === 'proyecto') {
			const file = target === 'usuario' ? path.join(home, '.armotusitio', 'permissions.json') : path.join(root, '.armotusitio', 'permissions.json');
			const existed = await exists(file);
			await ensurePermissionsFile(file);
			await deps.openFile(file);
			return existed ? t('Abr\u00ed {0}.', target === 'usuario' ? USER_FILE_LABEL : PROJECT_FILE_LABEL) : t('Cre\u00e9 {0} vac\u00edo y lo abr\u00ed. Agreg\u00e1 reglas en allow, ask o deny.', target === 'usuario' ? USER_FILE_LABEL : PROJECT_FILE_LABEL);
		}
		if (target === 'quitar') {
			// Rules have no spaces except in `run:` commands, so the rest of the line is the rule verbatim.
			const rule = words.slice(1).join(' ');
			if (!rule) { return t('Uso: /permisos quitar REGLA (copiala de la lista de /permisos).'); }
			return await removeUserRule(rule, home, projectKey(root))
				? t('Revoqu\u00e9 la regla \u00ab{0}\u00bb. Desde ahora esa acci\u00f3n vuelve a pedir permiso.', rule)
				: t('No encontr\u00e9 la regla \u00ab{0}\u00bb en {1}.', rule, USER_FILE_LABEL);
		}
		if (target === 'temporales' && (words[1] ?? '').toLowerCase() === 'quitar') {
			const rule = words.slice(2).join(' ');
			const removed = session.revokeGrant(rule || undefined);
			return removed ? t('Revoqu\u00e9 {0} permisos temporales. Esas acciones vuelven a pedir permiso.', String(removed)) : t('No hab\u00eda permisos temporales para revocar.');
		}
		if (words.length) { return t('Uso: /permisos [usuario|proyecto|quitar REGLA|temporales quitar [REGLA]]'); }
		const set = await loadPermissions(root, home, t, { preset: deps.permissionsPreset() });
		// Only the rules that apply here: global ones and this project's own section.
		const key = projectKey(root);
		const saved = (await listUserRules(home).catch(() => [])).filter(entry => !entry.project || entry.project === key);
		const savedLines = saved.map(entry => '  ' + entry.decision + '  ' + entry.rule + '  (' + (entry.project ? t('este proyecto') : t('todos los proyectos')) + ')');
		const files = [[USER_FILE_LABEL, path.join(home, '.armotusitio', 'permissions.json')], [PROJECT_FILE_LABEL, path.join(root, '.armotusitio', 'permissions.json')]] as const;
		const grants = (session.broker?.list() ?? []).map(grant => '  ' + grant.rule + '  (' + (grant.scope === 'task' ? t('esta tarea') : t('esta sesi\u00f3n, hasta {0}', new Date(grant.expiresAt ?? 0).toLocaleTimeString())) + ')');
		return [
			t('Permisos efectivos:'), ...set.describe().map(line => '  ' + line),
			...(set.warnings.length ? ['', t('Avisos:'), ...set.warnings.map(warning => '  ' + warning)] : []),
			'', t('Tus reglas guardadas (revocalas con /permisos quitar REGLA):'), ...(savedLines.length ? savedLines : ['  ' + t('ninguna')]),
			'', t('Permisos temporales de este chat (revocalos con /permisos temporales quitar [REGLA]):'), ...(grants.length ? grants : ['  ' + t('ninguno')]),
			'', t('Archivos:'), ...await Promise.all(files.map(async ([label, file]) => '  ' + label + ' \u2014 ' + (await exists(file) ? t('existe') : t('no existe')))),
			'', t('Reglas: run:<glob> (comando), edit:<glob> (borrar o mover archivos), git_commit, git_push, git_branch_create, git_pr_upsert (con :<ruta> valen solo para ese proyecto). Ejemplo: "run:pnpm test*". Gana deny, despu\u00e9s ask, despu\u00e9s allow; el archivo del proyecto solo puede agregar ask y deny.'),
			t('Us\u00e1 /permisos usuario o /permisos proyecto para abrir o crear el archivo.')
		].join('\n');
	}
	if (action === 'modo') {
		const label = (mode: ChatMode) => mode === 'act' ? t('Actuar') : t('Preguntar');
		const modeWords: Record<string, ChatMode | undefined> = { actuar: 'act', act: 'act', preguntar: 'ask', ask: 'ask' };
		const wanted = modeWords[(words[0] ?? '').toLowerCase()];
		if (!words.length) { return t('Modo actual: {0}. Cambialo con /modo actuar o /modo preguntar.', label(deps.chatMode())); }
		if (words.length > 1 || !wanted) { return t('Uso: /modo [actuar|preguntar]'); }
		await deps.setChatMode(wanted);
		return t('Modo cambiado a {0}.', label(wanted));
	}
	if (action === 'bifurcar') {
		try { await session.fork(); }
		catch { return t('Bifurcar necesita el transporte nativo (atsHarness.agentTransport) y que no haya una tarea en curso.'); }
		return t('Listo: los pr\u00f3ximos mensajes contin\u00faan una copia de la sesi\u00f3n.');
	}
	if (action === 'deshacer') {
		await session.refreshContext();
		const status = session.undoStatus();
		if (!status.discardable || !status.messageId) { return status.reason ?? t('No hay nada para deshacer.'); }
		if (!await deps.confirmDiscard()) { return t('Cambio cancelado.'); }
		await session.discardRun(status.messageId);
		return t('Listo: descart\u00e9 los cambios de la \u00faltima ejecuci\u00f3n.');
	}
	if (action === 'checkpoints') { return runCheckpointsCommand(deps, words, root, session); }
	if (action === 'objetivos') { return runGoalsCommand(deps, words); }
	if (action === 'auditoria') {
		const directory = deps.runsDirectory?.(root);
		const lines = directory ? await auditLines(directory) : [];
		return lines.length ? [t('\u00daltimas acciones del agente (hora UTC, m\u00e1s reciente primero):'), ...lines].join('\n') : t('Todav\u00eda no hay acciones registradas del agente en este proyecto.');
	}
	if (action === 'doctor') {
		return deps.doctor ? await deps.doctor(root) : t('El m\u00e9dico de la m\u00e1quina no est\u00e1 disponible en esta ventana.');
	}
	if (action === 'costo') {
		const last = session.lastUsage();
		const usage = last?.usage;
		const quota = quotaLines(Object.values(session.quotaStatus()), t);
		const budget = deps.budget ? budgetLines(await deps.budget(root), t) : [];
		return [
			...(usage ? [
				t('\u00daltimo turno ({0}):', providerName(last.provider)),
				t('  Entrada: {0} tokens', String(usage.inputTokens)),
				t('  Salida: {0} tokens', String(usage.outputTokens)),
				...(usage.cachedInputTokens !== undefined ? [t('  Entrada desde cach\u00e9: {0} tokens', String(usage.cachedInputTokens))] : []),
				...(usage.estimatedCostUsd !== undefined ? [t('  Costo estimado por el proveedor: US$ {0}', usage.estimatedCostUsd.toFixed(4))] : []),
				// Child receipts and latency appear only when the provider reported them: never an estimate.
				...(usage.childThreads ? [t('  Subagentes: {0} hilos, {1} tokens de entrada y {2} de salida informados por el proveedor', String(usage.childThreads), String(usage.childInputTokens ?? 0), String(usage.childOutputTokens ?? 0))] : []),
				...(last.firstTokenMs !== undefined ? [t('  Primer token: {0} ms', String(last.firstTokenMs))] : [])
			] : [t('El proveedor no inform\u00f3 el uso del \u00faltimo turno (o todav\u00eda no hubo turnos desde que abriste esta ventana).')]),
			...(quota.length ? ['', ...quota] : []),
			...(budget.length ? ['', ...budget] : [])
		].join('\n');
	}
	return undefined;
}
