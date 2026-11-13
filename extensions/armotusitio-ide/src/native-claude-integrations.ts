/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Project Claude configuration is data. Only an explicitly approved, digest-pinned subset can run. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readSkillFile } from './native-project-skills.ts';
import { redactSecrets } from './native-redact.ts';

type Translate = (text: string, ...args: string[]) => string;
export interface ClaudeIntegration {
	id: string;
	kind: 'hook' | 'agent' | 'skill' | 'command' | 'plugin';
	source: string;
	digest: string;
	name: string;
	event?: string;
	command?: string[];
}
const LIMIT = 64;
const safeName = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stops enumeration at the cap; does not follow symlinked ancestors or directory entries. */
async function entries(root: string, relative: string): Promise<string[]> {
	let cursor = root;
	for (const component of relative.split('/')) {
		cursor = path.join(cursor, component);
		try {
			const stat = await fs.lstat(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(cursor) !== cursor) { throw Error('HARNESS_CLAUDE_INTEGRATION_UNSAFE'); }
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
	}
	const result: string[] = [];
	for await (const entry of await fs.opendir(cursor)) {
		if (result.length >= LIMIT) { throw Error('HARNESS_CLAUDE_INTEGRATION_LIMIT'); }
		result.push(entry.name);
	}
	return result.sort();
}

/** This deliberately excludes shell quoting, expansions, operators, stdin and non-command hook semantics. */
function compatibleCommand(event: string, group: Record<string, unknown>, hook: Record<string, unknown>): string[] | undefined {
	if (event !== 'UserPromptSubmit' || Object.keys(group).some(key => !['hooks', 'matcher'].includes(key)) || (group.matcher !== undefined && group.matcher !== '') ||
		hook.type !== 'command' || Object.keys(hook).some(key => !['type', 'command'].includes(key)) || typeof hook.command !== 'string' ||
		hook.command.length > 512 || !/^[a-zA-Z0-9_./:@=+ -]+$/.test(hook.command)) { return undefined; }
	const words = hook.command.trim().split(/ +/);
	return words[0] && words.length <= 32 ? words : undefined;
}

/** Metadata discovery never loads provider settings, imports modules or registers MCP servers. */
export async function discoverClaudeIntegrations(root: string): Promise<ClaudeIntegration[]> {
	if (await fs.realpath(root) !== root) { throw Error('HARNESS_CLAUDE_INTEGRATION_UNSAFE'); }
	const result: ClaudeIntegration[] = [];
	const add = (item: Omit<ClaudeIntegration, 'id'>, suffix = '') => {
		if (result.length >= LIMIT) { throw Error('HARNESS_CLAUDE_INTEGRATION_LIMIT'); }
		result.push({ ...item, id: hash(item.source + '\0' + suffix).slice(0, 16) });
	};
	const read = async (source: string): Promise<Buffer | undefined> => {
		try { await fs.lstat(path.join(root, source)); return await readSkillFile(root, path.join(root, source)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
	};
	const hooks = async (source: string) => {
		const data = await read(source);
		if (!data) { return; }
		const value: unknown = JSON.parse(data.toString('utf8'));
		if (!record(value) || !record(value.hooks)) { return; }
		for (const [event, groups] of Object.entries(value.hooks)) {
			if (!Array.isArray(groups)) { continue; }
			for (const [index, group] of groups.entries()) {
				if (!record(group) || !Array.isArray(group.hooks)) { continue; }
				for (const [offset, hook] of group.hooks.entries()) {
					if (!record(hook)) { continue; }
					add({ kind: 'hook', source, digest: hash(data), name: event.slice(0, 64), event, command: compatibleCommand(event, group, hook) }, `${event}/${index}/${offset}`);
				}
			}
		}
	};
	await hooks('.claude/settings.json');
	await hooks('.claude/settings.local.json');
	for (const [directory, kind] of [['agents', 'agent'], ['commands', 'command'], ['skills', 'skill']] as const) {
		for (const entry of await entries(root, '.claude/' + directory)) {
			const name = kind === 'skill' ? entry : entry.endsWith('.md') ? entry.slice(0, -3) : '';
			if (!safeName.test(name)) { continue; }
			const source = '.claude/' + directory + '/' + entry + (kind === 'skill' ? '/SKILL.md' : '');
			const data = await read(source);
			if (data) { add({ kind, source, name, digest: hash(data) }); }
		}
	}
	const plugin = async (base: string) => {
		const source = base + '/.claude-plugin/plugin.json';
		const data = await read(source);
		if (!data) { return; }
		const value: unknown = JSON.parse(data.toString('utf8'));
		if (record(value) && typeof value.name === 'string' && safeName.test(value.name)) {
			add({ kind: 'plugin', source, name: value.name, digest: hash(data) });
			await hooks(base + '/hooks/hooks.json');
		}
	};
	await plugin('.');
	for (const entry of await entries(root, '.claude/plugins')) { if (safeName.test(entry)) { await plugin('.claude/plugins/' + entry); } }
	return result;
}

export interface ClaudeIntegrationDeps {
	confirm(summary: string): Promise<boolean>;
	/** The existing IDE command policy and terminal executor, never a raw shell. */
	run(root: string, command: string, args: string[]): Promise<string>;
	valid(root: string): boolean;
}

/** Approvals are in memory, scoped to the exact project and source digest; restarting disables every item. */
export class ClaudeIntegrationBridge {
	private readonly enabled = new Map<string, Map<string, string>>();
	private readonly running = new Set<string>();
	private readonly deps: ClaudeIntegrationDeps;
	constructor(deps: ClaudeIntegrationDeps) { this.deps = deps; }
	private active(root: string): Map<string, string> {
		let active = this.enabled.get(root);
		if (!active) { active = new Map(); this.enabled.set(root, active); }
		return active;
	}
	async command(root: string, words: string[], t: Translate): Promise<string> {
		if (!this.deps.valid(root)) { throw Error('HARNESS_CLAUDE_INTEGRATION_CONTEXT_CHANGED'); }
		const [action, id] = words;
		if (!action) {
			const items = await discoverClaudeIntegrations(root);
			return [t('Integraciones locales de Claude. Deshabilitadas al reiniciar; no se cargan plugins ni servidores MCP.'),
			...items.map(item => `${item.id} \u00b7 ${item.kind} \u00b7 ${item.source} \u00b7 ${item.name} \u00b7 ` + (this.active(root).get(item.id) === item.digest ? t('habilitado') : t('deshabilitado')) + ' \u00b7 ' + (item.command ? t('comando mediado por permisos del IDE') : t('solo inspecci\u00f3n; us\u00e1 /skill para skills y comandos')))].join('\n');
		}
		if (words.length !== 2 || !['ver', 'habilitar', 'deshabilitar'].includes(action) || !/^[a-f0-9]{16}$/.test(id ?? '')) { return t('Uso: /integraciones [ver|habilitar|deshabilitar ID]'); }
		if (action === 'deshabilitar') { this.active(root).delete(id); return t('Integraci\u00f3n deshabilitada.'); }
		const item = (await discoverClaudeIntegrations(root)).find(candidate => candidate.id === id);
		if (!item) { return t('No encontr\u00e9 esa integraci\u00f3n.'); }
		if (action === 'ver') {
			const content = await readSkillFile(root, path.join(root, item.source), item.digest);
			return `${item.source}\nSHA-256: ${item.digest}\n` + t('Contenido no confiable; nunca concede permisos. Puede contener comandos externos.') + '\n' + redactSecrets(content.toString('utf8')).slice(0, 8000);
		}
		if (!item.command) { return t('No compatible: solo hooks UserPromptSubmit de comando simple, sin stdin, variables ni opciones adicionales. Los dem\u00e1s componentes son de inspecci\u00f3n.'); }
		const summary = t('\u00bfHabilitar este hook en este proyecto hasta cerrar el IDE? Se pedir\u00e1 permiso en cada env\u00edo. Puede modificar archivos seg\u00fan la pol\u00edtica del IDE; no recibir\u00e1 el texto del mensaje.') + `\n${root}\n${item.source}\n${item.command.join(' ')}\nSHA-256: ${item.digest}`;
		if (!await this.deps.confirm(summary)) { return t('La integraci\u00f3n sigue deshabilitada.'); }
		await readSkillFile(root, path.join(root, item.source), item.digest);
		if (!this.deps.valid(root)) { throw Error('HARNESS_CLAUDE_INTEGRATION_CONTEXT_CHANGED'); }
		this.active(root).set(id, item.digest);
		return t('Hook habilitado para UserPromptSubmit. Cada ejecuci\u00f3n requiere confirmaci\u00f3n y conserva los permisos del IDE.');
	}
	/** Fails closed before sending the prompt. Hook output never becomes provider context or authority. */
	async beforePrompt(root: string, t: Translate): Promise<void> {
		const active = this.enabled.get(root);
		if (!active?.size) { return; }
		if (this.running.has(root)) { throw Error('HARNESS_CLAUDE_HOOK_BUSY'); }
		this.running.add(root);
		try {
			const items = await discoverClaudeIntegrations(root);
			for (const [id, digest] of active) {
				const item = items.find(candidate => candidate.id === id);
				if (!item?.command || item.digest !== digest) { active.delete(id); throw Error('HARNESS_CLAUDE_HOOK_CHANGED'); }
				if (!await this.deps.confirm(t('\u00bfEjecutar el hook antes de enviar el mensaje? Cancelar detiene el env\u00edo.') + `\n${item.source}\n${item.command.join(' ')}\nSHA-256: ${digest}`)) { throw Error('HARNESS_CLAUDE_HOOK_DECLINED'); }
				await readSkillFile(root, path.join(root, item.source), digest);
				if (!this.deps.valid(root) || active.get(id) !== digest) { throw Error('HARNESS_CLAUDE_INTEGRATION_CONTEXT_CHANGED'); }
				const output = await this.deps.run(root, item.command[0], item.command.slice(1));
				if (!/^exit 0 \u00b7 /.test(output)) { throw Error('HARNESS_CLAUDE_HOOK_FAILED'); }
				if (!this.deps.valid(root)) { throw Error('HARNESS_CLAUDE_INTEGRATION_CONTEXT_CHANGED'); }
			}
		} finally { this.running.delete(root); }
	}
}
