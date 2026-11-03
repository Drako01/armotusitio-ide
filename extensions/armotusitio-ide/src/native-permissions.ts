/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Declarative permissions (plan r6): `allow` / `ask` / `deny` rules from the user file, the project file and a preset.
 * They only ever decide INSIDE the immovable floor of `native-command-policy.ts`. Invalid files fail closed: requests are denied
 * until the file is repaired, and the problem is reported in `warnings`. No `vscode` dependency, so the tool server process can load it too.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionDecision, PermissionPreset, PermissionRequest, PermissionSource, PermissionVerdict } from './native-permissions-types.ts';

export interface PermissionSet {
	readonly preset: PermissionPreset;
	readonly warnings: string[];
	decide(request: PermissionRequest): PermissionVerdict;
	describe(): string[];
}
export type Translator = (text: string, ...args: string[]) => string;

const MAX_FILE_BYTES = 16 * 1024;
const MAX_RULES = 200;
const MAX_RULE_LENGTH = 300;
/** Longest subject matched; a longer one is denied outright, because a truncated match could skip a deny rule. */
const MAX_SUBJECT_LENGTH = 2048;
const FILE_KEYS = new Set(['version', 'preset', 'allow', 'ask', 'deny']);
const DECISIONS: readonly PermissionDecision[] = ['deny', 'ask', 'allow'];
const PRESETS: readonly PermissionPreset[] = ['readonly', 'dev', 'trusted'];
const READONLY_COMMANDS = new Set(['git', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'whoami', 'hostname']);
const INFO_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);

interface Rule { readonly text: string; readonly kind: PermissionRequest['kind']; readonly glob: string }
type Layer = Record<PermissionDecision, Rule[]>;

const defaultTranslator: Translator = (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '');
const emptyLayer = (): Layer => ({ allow: [], ask: [], deny: [] });

/** Lowercase executable name without Windows launcher extensions; shared with the command policy floor. */
export function commandName(command: string): string {
	return command.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** `*` matches any run of characters (including `/`); everything else is literal. Iterative with a single backtrack point: O(n*m), no RegExp. */
export function globMatches(glob: string, subject: string): boolean {
	let g = 0, s = 0, star = -1, resume = 0;
	while (s < subject.length) {
		if (g < glob.length && glob[g] === '*') { star = g++; resume = s; } else if (g < glob.length && glob[g] === subject[s]) { g++; s++; } else if (star >= 0) { g = star + 1; s = ++resume; } else { return false; }
	}
	while (g < glob.length && glob[g] === '*') { g++; }
	return g === glob.length;
}

/** Parses one rule of the shared grammar; `undefined` when it is not valid. */
function parseRule(text: unknown): Rule | undefined {
	if (typeof text !== 'string' || !text || text.length > MAX_RULE_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) { return undefined; }
	if (text === 'git_commit' || text === 'git_push' || text === 'git_branch_create' || text === 'git_pr_upsert') { return { text, kind: text, glob: '' }; }
	const match = /^(run|edit):(.+)$/.exec(text);
	return match ? { text, kind: match[1] as 'run' | 'edit', glob: match[2] } : undefined;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** The string rules match against, per request kind. */
function subjectOf(request: PermissionRequest): { kind: PermissionRequest['kind']; subject: string } {
	switch (request.kind) {
		case 'run': return { kind: 'run', subject: [commandName(request.command), ...request.args].join(' ') };
		case 'edit': return { kind: 'edit', subject: normalizePath(request.path) };
		default: return { kind: request.kind, subject: '' };
	}
}

function parseFile(raw: string, allowAllow: boolean, label: string, t: Translator, warnings: string[]): Layer | undefined {
	const invalid = (why: string): undefined => { warnings.push(t('El archivo de permisos {0} se ignor\u00f3: {1}.', label, why)); return undefined; };
	let data: unknown;
	try { data = JSON.parse(raw); } catch { return invalid(t('no es JSON v\u00e1lido')); }
	if (!data || typeof data !== 'object' || Array.isArray(data)) { return invalid(t('debe ser un objeto')); }
	const record = data as Record<string, unknown>;
	if (record.version !== 1) { return invalid(t('versi\u00f3n no soportada')); }
	const unknown = Object.keys(record).find(key => !FILE_KEYS.has(key));
	if (unknown) { return invalid(t('clave desconocida "{0}"', unknown)); }
	if (record.preset !== undefined && !PRESETS.includes(record.preset as PermissionPreset)) { return invalid(t('preset desconocido')); }
	const layer = emptyLayer();
	let total = 0;
	for (const decision of DECISIONS) {
		const list = record[decision];
		if (list === undefined) { continue; }
		if (!Array.isArray(list)) { return invalid(t('"{0}" debe ser una lista', decision)); }
		total += list.length;
		if (total > MAX_RULES) { return invalid(t('m\u00e1s de {0} reglas', String(MAX_RULES))); }
		for (const entry of list) {
			const rule = parseRule(entry);
			if (!rule) { return invalid(t('regla inv\u00e1lida')); }
			layer[decision].push(rule);
		}
	}
	if (!allowAllow && layer.allow.length) {
		warnings.push(t('El archivo de permisos {0} intenta permitir comandos; un proyecto solo puede pedir confirmaci\u00f3n o denegar. Se ignoraron esas reglas.', label));
		layer.allow = [];
	}
	return layer;
}

/** Reads one permissions file without following symlinks and within the size bound; missing file means no rules. */
async function readLayer(file: string, allowAllow: boolean, label: string, t: Translator, warnings: string[]): Promise<{ layer?: Layer; preset?: PermissionPreset; invalid?: boolean }> {
	let handle: fs.FileHandle | undefined;
	try {
		for (const target of [path.dirname(file), file]) {
			const stat = await fs.lstat(target);
			if (stat.isSymbolicLink()) { warnings.push(t('El archivo de permisos {0} se ignor\u00f3: es un enlace simb\u00f3lico.', label)); return { invalid: true }; }
		}
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { warnings.push(t('El archivo de permisos {0} se ignor\u00f3: no es un archivo regular o supera los 16 KiB.', label)); return { invalid: true }; }
		handle = await fs.open(file, 'r');
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_FILE_BYTES) { warnings.push(t('El archivo de permisos {0} se ignor\u00f3: supera los 16 KiB.', label)); return { invalid: true }; }
		const raw = buffer.subarray(0, bytesRead).toString('utf8');
		const layer = parseFile(raw, allowAllow, label, t, warnings);
		const preset = layer ? (JSON.parse(raw) as { preset?: PermissionPreset }).preset : undefined;
		return { layer, preset, invalid: !layer };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return {}; }
		warnings.push(t('El archivo de permisos {0} no se pudo leer.', label));
		return { invalid: true };
	} finally { await handle?.close(); }
}

/** What a preset says when no rule matched. Dependency changes are resolved by the policy from `preset` (see `dependencyDecision`; always `ask` unless readonly). */
function presetDecision(preset: PermissionPreset, request: PermissionRequest): PermissionDecision {
	switch (request.kind) {
		case 'edit': return preset === 'readonly' ? 'deny' : 'allow';
		case 'git_commit': return preset === 'readonly' ? 'deny' : preset === 'trusted' ? 'allow' : 'ask';
		case 'git_push':
		case 'git_branch_create':
		case 'git_pr_upsert': return preset === 'readonly' ? 'deny' : 'ask';
		case 'run': {
			if (preset !== 'readonly') { return 'allow'; }
			const name = commandName(request.command);
			return READONLY_COMMANDS.has(name) || (request.args.length > 0 && request.args.every(arg => INFO_FLAGS.has(arg))) ? 'allow' : 'deny';
		}
	}
}

/** Decision for a package install/update that the floor classified as `dependency-change` and no explicit rule covered. */
export function dependencyDecision(preset: PermissionPreset): PermissionDecision {
	return preset === 'readonly' ? 'deny' : 'ask';
}

function createPermissionSet(preset: PermissionPreset, project: Layer, user: Layer, warnings: string[], invalid = false): PermissionSet {
	const layers: Array<{ source: PermissionSource; layer: Layer }> = [{ source: 'project', layer: project }, { source: 'user', layer: user }];
	const find = (decision: PermissionDecision, kind: PermissionRequest['kind'], subject: string) => {
		for (const { source, layer } of layers) {
			const rule = layer[decision].find(candidate => candidate.kind === kind && (kind.startsWith('git_') || globMatches(candidate.glob, subject)));
			if (rule) { return { source, rule: rule.text }; }
		}
		return undefined;
	};
	return {
		preset,
		warnings,
		decide(request) {
			if (invalid) { return { decision: 'deny', source: 'default' }; }
			const { kind, subject } = subjectOf(request);
			if (subject.length > MAX_SUBJECT_LENGTH) { return { decision: 'deny', source: 'default' }; }
			// A deny anywhere wins first, so a weaker layer can never turn a stronger deny into an ask.
			for (const decision of DECISIONS) {
				const hit = find(decision, kind, subject);
				if (hit) { return { decision, ...hit }; }
			}
			return { decision: presetDecision(preset, request), source: 'preset' };
		},
		describe() {
			const count = (decision: PermissionDecision) => project[decision].length + user[decision].length;
			return ['preset ' + preset, ...DECISIONS.filter(count).map(decision => decision + ': ' + [...project[decision], ...user[decision]].map(rule => rule.text).join(', '))];
		}
	};
}

export async function loadPermissions(root: string, home: string = os.homedir(), t: Translator = defaultTranslator, options: { preset?: PermissionPreset } = {}): Promise<PermissionSet> {
	const warnings: string[] = [];
	const user = await readLayer(path.join(home, '.armotusitio', 'permissions.json'), true, '~/.armotusitio/permissions.json', t, warnings);
	const project = await readLayer(path.join(root, '.armotusitio', 'permissions.json'), false, '.armotusitio/permissions.json', t, warnings);
	if (user.invalid || project.invalid) { warnings.push(t('Se denegaron las acciones hasta que se repare el archivo de permisos.')); }
	return createPermissionSet(options.preset ?? user.preset ?? 'dev', project.layer ?? emptyLayer(), user.layer ?? emptyLayer(), warnings, user.invalid || project.invalid);
}

/** Appends a rule to the USER file (never the project one): atomic replace, no duplicates, the rest of the JSON preserved. */
export async function addUserRule(rule: string, decision: PermissionDecision, home: string = os.homedir()): Promise<void> {
	if (!parseRule(rule) || !DECISIONS.includes(decision)) { throw Error('PERMISSIONS_INVALID_RULE'); }
	const directory = path.join(home, '.armotusitio');
	const file = path.join(directory, 'permissions.json');
	let data: Record<string, unknown> = { version: 1 };
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		data = parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error instanceof SyntaxError ? Error('PERMISSIONS_FILE_UNSAFE') : error; }
	}
	const current = data[decision];
	if (current !== undefined && !Array.isArray(current)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
	const list = (current as unknown[] | undefined) ?? [];
	if (list.includes(rule)) { return; }
	const total = DECISIONS.reduce((sum, key) => sum + (Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0), 0);
	if (total + 1 > MAX_RULES) { throw Error('PERMISSIONS_TOO_MANY_RULES'); }
	data = { ...data, version: 1, [decision]: [...list, rule] };
	await fs.mkdir(directory, { recursive: true });
	const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
	try {
		await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

/** Exact rule for a repeatable command; an empty value means "always" must not be offered. */
export function suggestRule(request: PermissionRequest): string {
	if (request.kind !== 'run' || request.args.length === 0) { return ''; }
	const name = commandName(request.command);
	const sub = request.args[0].toLowerCase();
	// Package managers and launchers can install dependencies or run another executable. Their approvals are per action.
	if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'composer', 'gem', 'bundle'].includes(name) &&
		!(['npm', 'pnpm', 'yarn', 'bun'].includes(name) && ['test', 'run', 'lint', 'typecheck'].includes(sub))) { return ''; }
	if (['python', 'python3', 'py'].includes(name) && sub === '-m' && ['pip', 'twine', 'ensurepip', 'http.server', 'venv'].includes(request.args[1])) { return ''; }
	if ((name === 'go' && ['get', 'install'].includes(sub)) || (name === 'cargo' && ['install', 'add', 'remove', 'update'].includes(sub)) ||
		(name === 'dotnet' && ['add', 'remove', 'tool', 'nuget'].includes(sub))) { return ''; }
	// No escaping syntax exists in the glob grammar. Refuse metacharacters, empty arguments and argument-boundary ambiguity.
	const parts = [name, ...request.args];
	if (parts.some(part => !part || /[\s*?\u0000-\u001f\u007f]/.test(part))) { return ''; }
	const rule = 'run:' + parts.join(' ');
	return rule.length <= MAX_RULE_LENGTH ? rule : '';
}

/** Validates the raw `atsHarness.permissionsPreset` setting; `undefined` lets the permission files decide. */
export function configuredPreset(value: unknown): PermissionPreset | undefined {
	return PRESETS.find(preset => preset === value);
}
