/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Onboarding "review my environment": pure mapping from facts already gathered elsewhere (provider diagnostics,
 * machine doctor, MCP probe, workspace settings) to a list of items, each with a status and at most one fix.
 * Nothing here touches the machine; the command executes the fix the user picks.
 */
import type { DoctorCheck } from './native-machine-doctor.ts';

export type SetupStatus = 'ok' | 'missing' | 'warning';
export type SetupFix =
	| { kind: 'settings'; setting: string; label: string }
	| { kind: 'copy'; text: string; label: string }
	| { kind: 'docs'; url: string; label: string }
	| { kind: 'command'; command: string; label: string };
export interface SetupItem { id: string; title: string; status: SetupStatus; detail: string; fix?: SetupFix }
export type Translate = (message: string, ...args: string[]) => string;

export interface SetupFacts {
	providers: Record<'codex' | 'claude', { status: string; version?: string }>;
	/** Output of `runDoctor`; only docker, wsl and git are read. */
	doctor: readonly DoctorCheck[];
	mcp: { state: string; reason?: string };
	trusted: boolean;
	coordinatedProjectWriters: boolean;
	chatMode: 'act' | 'ask';
}

const PROVIDERS = {
	claude: { title: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', login: 'claude', docs: 'https://docs.claude.com/en/docs/claude-code/setup' },
	codex: { title: 'Codex', install: 'npm install -g @openai/codex', login: 'codex login', docs: 'https://github.com/openai/codex#readme' }
} as const;
const DOCS = { git: 'https://git-scm.com/downloads', docker: 'https://docs.docker.com/get-docker/' } as const;

function providerItem(provider: keyof typeof PROVIDERS, fact: SetupFacts['providers']['codex'], t: Translate): SetupItem {
	const info = PROVIDERS[provider];
	const base = { id: provider, title: info.title };
	switch (fact.status) {
		case 'ready': return { ...base, status: 'ok', detail: t('Instalado y con sesi\u00f3n iniciada ({0}).', fact.version ?? '?') };
		case 'unauthenticated': return { ...base, status: 'warning', detail: t('Instalado, pero sin sesi\u00f3n iniciada.'), fix: { kind: 'copy', text: info.login, label: t('Copiar el comando para iniciar sesi\u00f3n') } };
		case 'incompatible': return { ...base, status: 'warning', detail: t('La versi\u00f3n instalada ({0}) no es compatible.', fact.version ?? '?'), fix: { kind: 'copy', text: info.install, label: t('Copiar el comando de actualizaci\u00f3n') } };
		case 'unavailable': return { ...base, status: 'missing', detail: t('No est\u00e1 instalado en este equipo.'), fix: { kind: 'copy', text: info.install, label: t('Copiar el comando de instalaci\u00f3n') } };
		default: return { ...base, status: 'warning', detail: t('No se pudo determinar el estado.'), fix: { kind: 'docs', url: info.docs, label: t('Abrir la documentaci\u00f3n') } };
	}
}

/** A doctor check as a setup item. The doctor's own advice stays as the detail; `fix` is the one actionable shortcut. */
function doctorItem(check: DoctorCheck | undefined, id: string, title: string, fix: SetupFix | undefined, t: Translate): SetupItem | undefined {
	if (!check) { return undefined; }
	const status: SetupStatus = check.status === 'ok' ? 'ok' : check.status === 'problem' ? 'missing' : 'warning';
	const detail = check.status === 'ok' || !check.action ? check.detail : check.detail + ' ' + check.action;
	return { id, title, status, detail: check.status === 'skipped' ? t('No se pudo comprobar.') : detail, ...(status === 'ok' || !fix ? {} : { fix }) };
}

function mcpItem(mcp: SetupFacts['mcp'], t: Translate): SetupItem {
	const base = { id: 'mcp', title: t('MCP de ArmoTuSitio') };
	if (mcp.state === 'connected') { return { ...base, status: 'ok', detail: t('Conectado.') }; }
	const fixes: Record<string, SetupFix> = {
		'missing-key': { kind: 'command', command: 'atsIde.mcpConfigure', label: t('Configurar la clave') },
		disabled: { kind: 'command', command: 'atsIde.mcpEnable', label: t('Habilitar en este workspace') },
		auth: { kind: 'command', command: 'atsIde.mcpChangeKey', label: t('Cambiar la clave') }
	};
	const reasons: Record<string, string> = { untrusted: t('El workspace no es confiable.'), disabled: t('La integraci\u00f3n est\u00e1 desactivada en este workspace.'), 'missing-key': t('No hay una clave configurada.'), auth: t('La clave fue rechazada o no tiene permisos.') };
	const fix = (mcp.reason && fixes[mcp.reason]) || { kind: 'settings', setting: 'atsHarness.mcp', label: t('Abrir configuraci\u00f3n') } as const;
	return { ...base, status: 'warning', detail: (mcp.reason && reasons[mcp.reason]) || t('No se pudo conectar. El chat funciona sin MCP.'), fix };
}

/** All items in display order: blockers first is the report's job, this keeps a stable reading order. */
export function buildSetupItems(facts: SetupFacts, t: Translate = message => message): SetupItem[] {
	const byId = new Map(facts.doctor.map(check => [check.id, check]));
	const items: (SetupItem | undefined)[] = [
		providerItem('claude', facts.providers.claude, t),
		providerItem('codex', facts.providers.codex, t),
		doctorItem(byId.get('git'), 'git', 'Git', { kind: 'docs', url: DOCS.git, label: t('Abrir la descarga de Git') }, t),
		doctorItem(byId.get('docker'), 'docker', 'Docker', { kind: 'docs', url: DOCS.docker, label: t('Abrir la descarga de Docker') }, t),
		doctorItem(byId.get('wsl'), 'wsl', 'WSL', { kind: 'copy', text: 'wsl --update', label: t('Copiar el comando de actualizaci\u00f3n') }, t),
		mcpItem(facts.mcp, t),
		facts.trusted
			? { id: 'trust', title: t('Confianza del workspace'), status: 'ok', detail: t('El workspace es confiable.') }
			: { id: 'trust', title: t('Confianza del workspace'), status: 'missing', detail: t('Sin confianza no se puede conversar ni ejecutar.'), fix: { kind: 'command', command: 'workbench.trust.manage', label: t('Administrar la confianza') } },
		facts.coordinatedProjectWriters
			? { id: 'writers', title: 'atsHarness.coordinatedProjectWriters', status: 'ok', detail: t('Habilitado: se puede escribir en proyectos con Harness propio.') }
			: { id: 'writers', title: 'atsHarness.coordinatedProjectWriters', status: 'warning', detail: t('Desactivado: en proyectos con Harness propio solo se conversa y se planifica.'), fix: { kind: 'settings', setting: 'atsHarness.coordinatedProjectWriters', label: t('Abrir configuraci\u00f3n') } },
		{ id: 'mode', title: t('Modo del chat'), status: 'ok', detail: facts.chatMode === 'ask' ? t('Preguntar: solo conversa y propone planes.') : t('Actuar: la IA cambia el c\u00f3digo directamente.'), fix: { kind: 'settings', setting: 'atsHarness.chatMode', label: t('Abrir configuraci\u00f3n') } }
	];
	return items.filter((item): item is SetupItem => !!item);
}

const ICON: Record<SetupStatus, string> = { ok: '$(check)', warning: '$(warning)', missing: '$(error)' };
export const setupIcon = (status: SetupStatus): string => ICON[status];
