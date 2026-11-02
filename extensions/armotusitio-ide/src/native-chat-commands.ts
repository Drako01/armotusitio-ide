/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Slash commands of the chat. `chatCommands` is the single table: `/ayuda`, the composer autocomplete and the dispatcher
 * in `chat.ts` all derive from it, so a new command cannot be missing from the help. Commands that need the conversation
 * (`session: true`) run here against the session; the rest are Work Management / Harness queries handled in `chat.ts`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMode } from './native-chat.ts';
import type { HarnessChatSession } from './native-chat-session.ts';
import { loadPermissions } from './native-permissions.ts';
import type { PermissionPreset } from './native-permissions-types.ts';
import type { ProviderQuota } from './native-quota.ts';

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

export function chatCommands(t: CommandTranslator): ChatCommand[] {
	return [
		{ name: 'ayuda', description: t('Lista los comandos disponibles.'), session: false },
		{ name: 'permisos', usage: '[usuario|proyecto]', description: t('Muestra los permisos efectivos; con usuario o proyecto abre (o crea) su archivo JSON.'), session: true },
		{ name: 'modo', usage: '[actuar|preguntar]', description: t('Muestra o cambia el modo del chat.'), session: true },
		{ name: 'deshacer', description: t('Descarta los cambios de la \u00faltima ejecuci\u00f3n.'), session: true },
		{ name: 'costo', description: t('Muestra los tokens que inform\u00f3 el proveedor en el \u00faltimo turno.'), session: true },
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
	t('Pod\u00e9s anteponer @harness o usar /comando. Con @archivo adjunt\u00e1s un archivo del proyecto como contexto.')].join('\n');
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

const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

export interface SessionCommandDeps {
	t: CommandTranslator;
	chatMode(): ChatMode;
	setChatMode(mode: ChatMode): Promise<void>;
	/** `atsHarness.permissionsPreset`, when set. */
	permissionsPreset(): PermissionPreset | undefined;
	openFile(file: string): Promise<void>;
	/** Modal confirmation shared with the "discard changes" button. */
	confirmDiscard(): Promise<boolean>;
	home?: string;
}

/** Runs a command that needs the conversation; `undefined` when `action` is not one of them. */
export async function runSessionCommand(deps: SessionCommandDeps, action: string, words: string[], root: string, session: HarnessChatSession): Promise<string | undefined> {
	const { t } = deps;
	const home = deps.home ?? os.homedir();
	if (action === 'permisos') {
		const target = (words[0] ?? '').toLowerCase();
		if (target === 'usuario' || target === 'proyecto') {
			const file = target === 'usuario' ? path.join(home, '.armotusitio', 'permissions.json') : path.join(root, '.armotusitio', 'permissions.json');
			const existed = await exists(file);
			await ensurePermissionsFile(file);
			await deps.openFile(file);
			return existed ? t('Abr\u00ed {0}.', target === 'usuario' ? USER_FILE_LABEL : PROJECT_FILE_LABEL) : t('Cre\u00e9 {0} vac\u00edo y lo abr\u00ed. Agreg\u00e1 reglas en allow, ask o deny.', target === 'usuario' ? USER_FILE_LABEL : PROJECT_FILE_LABEL);
		}
		if (words.length) { return t('Uso: /permisos [usuario|proyecto]'); }
		const set = await loadPermissions(root, home, t, { preset: deps.permissionsPreset() });
		const files = [[USER_FILE_LABEL, path.join(home, '.armotusitio', 'permissions.json')], [PROJECT_FILE_LABEL, path.join(root, '.armotusitio', 'permissions.json')]] as const;
		return [
			t('Permisos efectivos:'), ...set.describe().map(line => '  ' + line),
			...(set.warnings.length ? ['', t('Avisos:'), ...set.warnings.map(warning => '  ' + warning)] : []),
			'', t('Archivos:'), ...await Promise.all(files.map(async ([label, file]) => '  ' + label + ' \u2014 ' + (await exists(file) ? t('existe') : t('no existe')))),
			'', t('Reglas: run:<glob> (comando), git_commit, git_push (edit:<glob> est\u00e1 reservado y todav\u00eda no se aplica). Ejemplo: "run:pnpm test*". Gana deny, despu\u00e9s ask, despu\u00e9s allow; el archivo del proyecto solo puede agregar ask y deny.'),
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
	if (action === 'deshacer') {
		await session.refreshContext();
		const status = session.undoStatus();
		if (!status.discardable || !status.messageId) { return status.reason ?? t('No hay nada para deshacer.'); }
		if (!await deps.confirmDiscard()) { return t('Cambio cancelado.'); }
		await session.discardRun(status.messageId);
		return t('Listo: descart\u00e9 los cambios de la \u00faltima ejecuci\u00f3n.');
	}
	if (action === 'costo') {
		const last = session.lastUsage();
		const usage = last?.usage;
		const quota = quotaLines(Object.values(session.quotaStatus()), t);
		return [
			...(usage ? [
				t('\u00daltimo turno ({0}):', providerName(last.provider)),
				t('  Entrada: {0} tokens', String(usage.inputTokens)),
				t('  Salida: {0} tokens', String(usage.outputTokens)),
				...(usage.cachedInputTokens !== undefined ? [t('  Entrada desde cach\u00e9: {0} tokens', String(usage.cachedInputTokens))] : []),
				...(usage.estimatedCostUsd !== undefined ? [t('  Costo estimado por el proveedor: US$ {0}', usage.estimatedCostUsd.toFixed(4))] : [])
			] : [t('El proveedor no inform\u00f3 el uso del \u00faltimo turno (o todav\u00eda no hubo turnos desde que abriste esta ventana).')]),
			...(quota.length ? ['', ...quota] : [])
		].join('\n');
	}
	return undefined;
}
