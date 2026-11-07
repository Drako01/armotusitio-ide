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
import type { NoRememberReason, PermissionDecision, PermissionPreset, PermissionRequest, PermissionSource, PermissionVerdict } from './native-permissions-types.ts';

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
const FILE_KEYS = new Set(['version', 'preset', 'allow', 'ask', 'deny', 'projects']);
const SECTION_KEYS = new Set(['allow', 'ask', 'deny']);
const DECISIONS: readonly PermissionDecision[] = ['deny', 'ask', 'allow'];
const PRESETS: readonly PermissionPreset[] = ['readonly', 'dev', 'trusted'];
const READONLY_COMMANDS = new Set(['git', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'whoami', 'hostname']);
const INFO_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);

/** `glob` is empty for a bare git rule, which applies in every project. */
interface Rule { readonly text: string; readonly kind: PermissionRequest['kind']; readonly glob: string }
const GIT_KINDS = new Set<string>(['git_commit', 'git_push', 'git_branch_create', 'git_pr_upsert', 'git_fetch']);
/** Git tools whose "always" answer is remembered (per project); a PR publishes new content each time, so it is asked every time. */
const REMEMBERED_GIT_KINDS = new Set<string>(['git_commit', 'git_push', 'git_branch_create', 'git_fetch']);
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
	if (GIT_KINDS.has(text)) { return { text, kind: text as PermissionRequest['kind'], glob: '' }; }
	const match = /^(run|edit|git_commit|git_push|git_branch_create|git_pr_upsert|git_fetch):(.+)$/.exec(text);
	if (!match) { return undefined; }
	return { text, kind: match[1] as PermissionRequest['kind'], glob: GIT_KINDS.has(match[1]) ? projectKey(match[2]) : match[2] };
}

/** How a project root is written in a scoped git rule: `/` separators, no trailing slash, lowercase on Windows (case-insensitive paths). */
export function projectKey(root: string, platform: NodeJS.Platform = process.platform): string {
	const key = root.replace(/\\/g, '/').replace(/\/+$/, '');
	return platform === 'win32' ? key.toLowerCase() : key;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** The string rules match against, per request kind. */
function subjectOf(request: PermissionRequest, root: string): { kind: PermissionRequest['kind']; subject: string } {
	switch (request.kind) {
		case 'run': return { kind: 'run', subject: [commandName(request.command), ...request.args].join(' ') };
		case 'edit': return { kind: 'edit', subject: normalizePath(request.path) };
		default: return { kind: request.kind, subject: projectKey(root) };
	}
}

/**
 * Parses one file. `projectKeyFor` (user file only) also takes the rules of `projects[projectKeyFor]`; every project section
 * is validated, so a broken one fails the whole file closed, like any other invalid rule.
 */
function parseFile(raw: string, allowAllow: boolean, label: string, t: Translator, warnings: string[], projectKeyFor?: string): Layer | undefined {
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
	/** Adds one section's lists to `into`; the reason it is invalid otherwise. */
	const readSection = (section: Record<string, unknown>, into: Layer | undefined): string | undefined => {
		let total = 0;
		for (const decision of DECISIONS) {
			const list = section[decision];
			if (list === undefined) { continue; }
			if (!Array.isArray(list)) { return t('"{0}" debe ser una lista', decision); }
			total += list.length;
			if (total > MAX_RULES) { return t('m\u00e1s de {0} reglas', String(MAX_RULES)); }
			for (const entry of list) {
				const rule = parseRule(entry);
				if (!rule) { return t('regla inv\u00e1lida'); }
				into?.[decision].push(rule);
			}
		}
		return undefined;
	};
	const topProblem = readSection(record, layer);
	if (topProblem) { return invalid(topProblem); }
	if (record.projects !== undefined) {
		// A cloned repository must not carry per-project grants either: only the user's own file has this section.
		if (!allowAllow) { return invalid(t('clave desconocida "{0}"', 'projects')); }
		if (!record.projects || typeof record.projects !== 'object' || Array.isArray(record.projects)) { return invalid(t('"{0}" debe ser un objeto', 'projects')); }
		for (const [key, section] of Object.entries(record.projects as Record<string, unknown>)) {
			if (!section || typeof section !== 'object' || Array.isArray(section) || Object.keys(section).some(name => !SECTION_KEYS.has(name))) { return invalid(t('secci\u00f3n de proyecto inv\u00e1lida')); }
			const problem = readSection(section as Record<string, unknown>, key === projectKeyFor ? layer : undefined);
			if (problem) { return invalid(problem); }
		}
	}
	if (!allowAllow && layer.allow.length) {
		warnings.push(t('El archivo de permisos {0} intenta permitir comandos; un proyecto solo puede pedir confirmaci\u00f3n o denegar. Se ignoraron esas reglas.', label));
		layer.allow = [];
	}
	return layer;
}

/** Reads one permissions file without following symlinks and within the size bound; missing file means no rules. */
async function readLayer(file: string, allowAllow: boolean, label: string, t: Translator, warnings: string[], projectKeyFor?: string): Promise<{ layer?: Layer; preset?: PermissionPreset; invalid?: boolean }> {
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
		const layer = parseFile(raw, allowAllow, label, t, warnings, projectKeyFor);
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
		case 'git_fetch': return preset === 'readonly' ? 'deny' : 'allow';
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

function createPermissionSet(root: string, preset: PermissionPreset, project: Layer, user: Layer, warnings: string[], invalid = false): PermissionSet {
	const layers: Array<{ source: PermissionSource; layer: Layer }> = [{ source: 'project', layer: project }, { source: 'user', layer: user }];
	const find = (decision: PermissionDecision, kind: PermissionRequest['kind'], subject: string) => {
		for (const { source, layer } of layers) {
			// A bare git rule (empty glob) covers every project; a scoped one only the projects its glob matches.
			// The most specific (longest) matching rule is reported: the decision is the same, but callers such as the
			// external CLI check can tell an exact `run:aws ...` rule from a blanket `run:*`.
			const rule = layer[decision].filter(candidate => candidate.kind === kind && ((GIT_KINDS.has(kind) && !candidate.glob) || globMatches(candidate.glob, subject)))
				.reduce<Rule | undefined>((best, candidate) => !best || candidate.text.length > best.text.length ? candidate : best, undefined);
			if (rule) { return { source, rule: rule.text }; }
		}
		return undefined;
	};
	return {
		preset,
		warnings,
		decide(request) {
			if (invalid) { return { decision: 'deny', source: 'default' }; }
			const { kind, subject } = subjectOf(request, root);
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
	const user = await readLayer(path.join(home, '.armotusitio', 'permissions.json'), true, '~/.armotusitio/permissions.json', t, warnings, projectKey(root));
	const project = await readLayer(path.join(root, '.armotusitio', 'permissions.json'), false, '.armotusitio/permissions.json', t, warnings);
	if (user.invalid || project.invalid) { warnings.push(t('Se denegaron las acciones hasta que se repare el archivo de permisos.')); }
	return createPermissionSet(root, options.preset ?? user.preset ?? 'dev', project.layer ?? emptyLayer(), user.layer ?? emptyLayer(), warnings, user.invalid || project.invalid);
}

/** The user file as a JSON object (`{ version: 1 }` when missing); anything unsafe or unparsable throws `PERMISSIONS_FILE_UNSAFE`. */
async function readUserFile(file: string): Promise<Record<string, unknown>> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		return parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1 }; }
		throw error instanceof SyntaxError ? Error('PERMISSIONS_FILE_UNSAFE') : error;
	}
}

/** Appends a rule to the USER file (never the project one): atomic replace, no duplicates, the rest of the JSON preserved. */
export async function addUserRule(rule: string, decision: PermissionDecision, home: string = os.homedir(), projectRoot?: string): Promise<void> {
	if (!parseRule(rule) || !DECISIONS.includes(decision)) { throw Error('PERMISSIONS_INVALID_RULE'); }
	const directory = path.join(home, '.armotusitio');
	const file = path.join(directory, 'permissions.json');
	const data = await readUserFile(file);
	// With a project, the rule goes to that project's section of the user file and applies nowhere else.
	let section: Record<string, unknown> = data;
	if (projectRoot) {
		const projects = data.projects ?? {};
		if (!projects || typeof projects !== 'object' || Array.isArray(projects)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		const key = projectKey(projectRoot);
		const existing = (projects as Record<string, unknown>)[key] ?? {};
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
		section = existing as Record<string, unknown>;
		data.projects = { ...(projects as Record<string, unknown>), [key]: section };
	}
	const current = section[decision];
	if (current !== undefined && !Array.isArray(current)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
	const list = (current as unknown[] | undefined) ?? [];
	if (list.includes(rule)) { return; }
	const total = DECISIONS.reduce((sum, key) => sum + (Array.isArray(section[key]) ? (section[key] as unknown[]).length : 0), 0);
	if (total + 1 > MAX_RULES) { throw Error('PERMISSIONS_TOO_MANY_RULES'); }
	section[decision] = [...list, rule];
	await writeUserFile(directory, file, { ...data, version: 1 });
}

/** Atomic replace of the user file: a crash leaves either the old or the new content, never a partial one. */
async function writeUserFile(directory: string, file: string, data: Record<string, unknown>): Promise<void> {
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

/** One rule of the USER file with where it applies: every project (`project` undefined) or the project with that key. */
export interface UserRule { rule: string; decision: PermissionDecision; project?: string }

/** Every rule of the USER file, global ones first, for listing and revoking; a missing file has none. */
export async function listUserRules(home: string = os.homedir()): Promise<UserRule[]> {
	const data = await readUserFile(path.join(home, '.armotusitio', 'permissions.json'));
	const fromSection = (section: unknown, project?: string): UserRule[] => !section || typeof section !== 'object' ? [] : DECISIONS.flatMap(decision => {
		const list = (section as Record<string, unknown>)[decision];
		return Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string').map(rule => ({ rule, decision, ...(project ? { project } : {}) })) : [];
	});
	const projects = data.projects && typeof data.projects === 'object' ? Object.entries(data.projects as Record<string, unknown>) : [];
	return [...fromSection(data), ...projects.flatMap(([key, section]) => fromSection(section, key))];
}

/**
 * Removes a rule from the USER file: from the global lists and, with `project` (a `projectKey`), from that project's section.
 * `false` when it was in neither. The rest of the JSON is preserved.
 */
export async function removeUserRule(rule: string, home: string = os.homedir(), project?: string): Promise<boolean> {
	const directory = path.join(home, '.armotusitio');
	const file = path.join(directory, 'permissions.json');
	const data = await readUserFile(file);
	const projects = data.projects as Record<string, Record<string, unknown>> | undefined;
	const sections = [data, ...(project && projects?.[project] ? [projects[project]] : [])];
	let removed = false;
	for (const section of sections) {
		for (const decision of DECISIONS) {
			const current = section[decision];
			if (current === undefined) { continue; }
			if (!Array.isArray(current)) { throw Error('PERMISSIONS_FILE_UNSAFE'); }
			if (current.includes(rule)) { section[decision] = current.filter(entry => entry !== rule); removed = true; }
		}
	}
	if (removed) { await writeUserFile(directory, file, data); }
	return removed;
}

/** Package managers and launchers that can install dependencies or run another executable: their approvals are per action. */
function installsOrLaunches(request: Extract<PermissionRequest, { kind: 'run' }>): boolean {
	const name = commandName(request.command);
	const sub = request.args[0]?.toLowerCase() ?? '';
	if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'composer', 'gem', 'bundle'].includes(name) &&
		!(['npm', 'pnpm', 'yarn', 'bun'].includes(name) && ['test', 'run', 'lint', 'typecheck'].includes(sub))) { return true; }
	if (['python', 'python3', 'py'].includes(name) && sub === '-m' && ['pip', 'twine', 'ensurepip', 'http.server', 'venv'].includes(request.args[1])) { return true; }
	return (name === 'go' && ['get', 'install'].includes(sub)) || (name === 'cargo' && ['install', 'add', 'remove', 'update'].includes(sub)) ||
		(name === 'dotnet' && ['add', 'remove', 'tool', 'nuget'].includes(sub));
}

/** Why an action cannot be remembered (shown on its card); `undefined` when `suggestRule` has a rule for it. */
export function whyNotRemembered(request: PermissionRequest, root?: string): NoRememberReason | undefined {
	if (suggestRule(request, root)) { return undefined; }
	if (request.kind === 'edit') { return 'irreversible'; }
	if (request.kind === 'git_pr_upsert') { return 'publication'; }
	return request.kind === 'run' && installsOrLaunches(request) ? 'dependency' : 'inexact';
}

/**
 * Exact rule for a repeatable action; an empty value means "always" must not be offered. Commit, push and branch creation
 * are remembered only for the project they were approved in (`root`); without a root they are never remembered.
 */
export function suggestRule(request: PermissionRequest, root?: string): string {
	if (REMEMBERED_GIT_KINDS.has(request.kind)) {
		const key = root ? projectKey(root) : '';
		const rule = request.kind + ':' + key;
		// The glob grammar has no escaping: a root containing `*` or control characters cannot be written as an exact rule.
		return key && !/[*\u0000-\u001f\u007f]/.test(key) && rule.length <= MAX_RULE_LENGTH ? rule : '';
	}
	if (request.kind !== 'run' || request.args.length === 0) { return ''; }
	if (installsOrLaunches(request)) { return ''; }
	// No escaping syntax exists in the glob grammar. Refuse metacharacters, empty arguments and argument-boundary ambiguity.
	const parts = [commandName(request.command), ...request.args];
	if (parts.some(part => !part || /[\s*?\u0000-\u001f\u007f]/.test(part))) { return ''; }
	const rule = 'run:' + parts.join(' ');
	return rule.length <= MAX_RULE_LENGTH ? rule : '';
}

/** Validates the raw `atsHarness.permissionsPreset` setting; `undefined` lets the permission files decide. */
export function configuredPreset(value: unknown): PermissionPreset | undefined {
	return PRESETS.find(preset => preset === value);
}
