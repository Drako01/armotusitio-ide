/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Verification commands of any repository (r6): read from manifests the project already declares, never executed here.
 * Complements `native-ecosystems.ts` (where the subprojects are) with what to run in each one.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { detectEcosystems, type Subproject } from './native-ecosystems.ts';
import { validateNativePlan, type Plan } from './native-harness.ts';
import type { PolicyDecision } from './native-command-policy.ts';

export type CommandKind = 'test' | 'lint' | 'typecheck' | 'build' | 'format';
export interface DetectedCommand { id: CommandKind; command: string; args: string[]; cwd: string; source: string }
export interface DetectedProject {
	manager?: string;
	commands: DetectedCommand[];
	ecosystems: string[];
	/** The subprojects the commands were derived from, so callers can build a command policy without scanning twice. */
	subprojects: Subproject[];
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_SUBPROJECTS = 16;
const MAX_COMMANDS = 48;
const MAX_GATES = 8;
/** Cheap checks first, so a failing gate is reported before the slowest one runs. */
const GATE_KINDS: readonly CommandKind[] = ['typecheck', 'lint', 'test'];
const SHELL_COMPOUND = /[;&|`<>]|\$\(/;
const RISKY = /\b(install|publish|unpublish|deploy|release|login|curl|wget|rm|sudo|docker|kubectl|terraform|git\s+(push|commit))\b/i;
const NODE_SCRIPTS: Record<CommandKind, readonly string[]> = {
	test: ['test', 'test:unit', 'unit'], lint: ['lint'], typecheck: ['typecheck', 'type-check', 'check-types', 'tsc', 'check'],
	build: ['build'], format: ['format:check', 'format-check', 'check-format', 'prettier:check']
};
const COMPOSER_SCRIPTS: Partial<Record<CommandKind, readonly string[]>> = {
	test: ['test', 'tests', 'phpunit'], lint: ['lint', 'phpcs', 'cs', 'cs-check', 'cs:check'], typecheck: ['phpstan', 'stan', 'analyse', 'analyze', 'psalm']
};
const MAKE_TARGETS: Partial<Record<CommandKind, readonly string[]>> = { test: ['test', 'check'], lint: ['lint'], build: ['build'] };

/**
 * Text of a regular file inside the project: a missing, oversized, symbolic or `.env` file reads as absent, never as an error,
 * so a hostile repository cannot make detection fail or leak a secret file.
 */
export async function readProjectText(root: string, relative: string, limit = MAX_FILE_BYTES): Promise<string | undefined> {
	if (relative.split(/[\\/]/).some(part => /^\.env(\.|$)/i.test(part))) { return undefined; }
	const target = path.join(root, relative);
	try {
		const info = await fs.lstat(target);
		if (!info.isFile() || info.size > limit) { return undefined; }
		const outside = path.relative(root, await fs.realpath(target));
		if (outside.startsWith('..') || path.isAbsolute(outside)) { return undefined; }
		return await fs.readFile(target, 'utf8');
	} catch { return undefined; }
}

async function readJson(root: string, relative: string): Promise<Record<string, unknown> | undefined> {
	const text = await readProjectText(root, relative);
	if (text === undefined) { return undefined; }
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

const joinPath = (folder: string, file: string): string => folder === '.' ? file : folder + '/' + file;
/** A script body is safe to run as a gate when it is a single command with no shell operators and no install/publish/deploy verbs. */
const safeBody = (body: unknown): body is string => typeof body === 'string' && body.length <= 1000 && !SHELL_COMPOUND.test(body) && !RISKY.test(body);

/** First usable script per kind; `pre`/`post` hooks run implicitly with the script, so an unsafe hook disqualifies it. */
function pickScripts(scripts: Record<string, unknown>, names: Partial<Record<CommandKind, readonly string[]>>): Array<[CommandKind, string]> {
	const picked: Array<[CommandKind, string]> = [];
	for (const [kind, candidates] of Object.entries(names) as Array<[CommandKind, readonly string[]]>) {
		const name = candidates.find(candidate => safeBody(scripts[candidate]) && ['pre', 'post'].every(prefix => scripts[prefix + candidate] === undefined || safeBody(scripts[prefix + candidate])));
		if (name) { picked.push([kind, name]); }
	}
	return picked;
}

async function nodeCommands(root: string, project: Subproject, workspaceRootKinds: Set<CommandKind>): Promise<{ commands: DetectedCommand[]; workspace: boolean }> {
	const file = joinPath(project.path, 'package.json');
	const manifest = await readJson(root, file);
	const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts as Record<string, unknown> : {};
	const manager = project.packageManager ?? 'npm';
	const isRoot = project.path === '.';
	const workspace = isRoot && (manifest?.workspaces !== undefined || (await readProjectText(root, 'pnpm-workspace.yaml')) !== undefined);
	const commands = pickScripts(scripts, NODE_SCRIPTS)
		// A workspace root script already covers its packages, so they do not repeat that kind.
		.filter(([kind]) => isRoot || !workspaceRootKinds.has(kind))
		.map(([kind, name]): DetectedCommand => ({ id: kind, command: manager, args: ['run', name], cwd: project.path, source: file + '#scripts.' + name }));
	return { commands, workspace };
}

async function pythonCommands(root: string, project: Subproject): Promise<DetectedCommand[]> {
	const read = (name: string): Promise<string | undefined> => readProjectText(root, joinPath(project.path, name));
	const [pyproject, pytestIni, toxIni, setupCfg, mypyIni, ruffToml, dotRuffToml] = await Promise.all(['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg', 'mypy.ini', 'ruff.toml', '.ruff.toml'].map(read));
	const declared = [pyproject, toxIni, setupCfg].filter((text): text is string => text !== undefined).join('\n');
	const make = (id: CommandKind, args: string[], source: string): DetectedCommand => ({ id, command: 'python', args, cwd: project.path, source: joinPath(project.path, source) });
	const commands: DetectedCommand[] = [];
	if (pytestIni !== undefined || /\[tool\.pytest|\bpytest\b/.test(declared)) { commands.push(make('test', ['-m', 'pytest', '-q'], pytestIni !== undefined ? 'pytest.ini' : 'pyproject.toml')); }
	if (ruffToml !== undefined || dotRuffToml !== undefined || /\[tool\.ruff|\bruff\b/.test(declared)) { commands.push(make('lint', ['-m', 'ruff', 'check', '.'], 'pyproject.toml')); }
	if (mypyIni !== undefined || /\[tool\.mypy|\bmypy\b/.test(declared)) { commands.push(make('typecheck', ['-m', 'mypy', '.'], mypyIni !== undefined ? 'mypy.ini' : 'pyproject.toml')); }
	return commands;
}

async function phpCommands(root: string, project: Subproject): Promise<DetectedCommand[]> {
	const file = joinPath(project.path, 'composer.json');
	const manifest = await readJson(root, file);
	if (!manifest) { return []; }
	const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	// A composer script may be one command or a list; a list is accepted only when every entry is safe.
	const scripts = Object.fromEntries(Object.entries(asRecord(manifest.scripts)).map(([name, body]) => [name, Array.isArray(body) ? (body.every(safeBody) ? body.join(' ') : undefined) : body]));
	const commands = pickScripts(scripts, COMPOSER_SCRIPTS).map(([kind, name]): DetectedCommand => ({ id: kind, command: 'composer', args: ['run-script', name], cwd: project.path, source: file + '#scripts.' + name }));
	// Without scripts, a declared dev tool is still run through php: gate executables are names, not paths.
	const dev = asRecord(manifest['require-dev']);
	const direct = (kind: CommandKind, tool: string, args: string[]): void => {
		if (dev[tool] !== undefined && !commands.some(command => command.id === kind)) { commands.push({ id: kind, command: 'php', args, cwd: project.path, source: file + '#require-dev.' + tool }); }
	};
	direct('test', 'phpunit/phpunit', ['vendor/bin/phpunit']);
	direct('typecheck', 'phpstan/phpstan', ['vendor/bin/phpstan', 'analyse']);
	return commands;
}

async function dotnetCommands(root: string, project: Subproject): Promise<DetectedCommand[]> {
	const names = await fs.readdir(path.join(root, project.path)).catch(() => [] as string[]);
	// A name starting with `-` would reach `dotnet` as an option, so it is never a candidate.
	const candidates = names.filter(name => !name.startsWith('-'));
	const solutions = candidates.filter(name => name.endsWith('.sln'));
	const projects = candidates.filter(name => name.endsWith('.csproj'));
	// `dotnet` refuses a folder with several candidates, so an ambiguous one is left out rather than guessed.
	const target = solutions.length === 1 ? solutions : solutions.length === 0 && projects.length === 1 ? [] : undefined;
	if (!target) { return []; }
	const source = joinPath(project.path, solutions[0] ?? projects[0]);
	return (['test', 'build'] as const).map(kind => ({ id: kind, command: 'dotnet', args: [kind, ...target], cwd: project.path, source }));
}

/** Targets of a root Makefile; a recipe that installs, publishes or deploys disqualifies its target. */
async function makeCommands(root: string): Promise<DetectedCommand[]> {
	const text = await readProjectText(root, 'Makefile');
	if (text === undefined) { return []; }
	const recipes = new Map<string, string>();
	let current: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const target = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
		if (target) { current = target[1]; recipes.set(current, recipes.get(current) ?? ''); }
		else if (current && /^\t/.test(line)) { recipes.set(current, recipes.get(current) + line + '\n'); }
		else if (line.trim() && !line.startsWith('#')) { current = undefined; }
	}
	const commands: DetectedCommand[] = [];
	for (const [kind, candidates] of Object.entries(MAKE_TARGETS) as Array<[CommandKind, readonly string[]]>) {
		const name = candidates.find(candidate => recipes.has(candidate) && !RISKY.test(recipes.get(candidate) ?? ''));
		if (name) { commands.push({ id: kind, command: 'make', args: [name], cwd: '.', source: 'Makefile:' + name }); }
	}
	return commands;
}

const FIXED: Partial<Record<Subproject['ecosystem'], Array<[CommandKind, string, string[]]>>> = {
	go: [['test', 'go', ['test', './...']], ['lint', 'go', ['vet', './...']]],
	rust: [['test', 'cargo', ['test']], ['lint', 'cargo', ['clippy']], ['typecheck', 'cargo', ['check']], ['build', 'cargo', ['build']]]
};
const FIXED_SOURCE: Partial<Record<Subproject['ecosystem'], string>> = { go: 'go.mod', rust: 'Cargo.toml' };

/** Commands the project itself declares, per subproject. Reads at most 256 KiB per file and executes nothing. */
export async function detectProjectCommands(root: string): Promise<DetectedProject> {
	const canonical = await fs.realpath(root);
	const subprojects = (await detectEcosystems(canonical)).slice(0, MAX_SUBPROJECTS);
	const commands: DetectedCommand[] = [];
	const workspaceRootKinds = new Set<CommandKind>();
	// The root goes first so that its scripts are known before the packages it already covers.
	const ordered = [...subprojects].sort((a, b) => Number(b.path === '.') - Number(a.path === '.'));
	for (const project of ordered) {
		const fixed = (FIXED[project.ecosystem] ?? []).map(([id, command, args]): DetectedCommand => ({ id, command, args, cwd: project.path, source: joinPath(project.path, FIXED_SOURCE[project.ecosystem]!) }));
		switch (project.ecosystem) {
			case 'node': {
				const found = await nodeCommands(canonical, project, workspaceRootKinds);
				if (found.workspace) { found.commands.forEach(command => workspaceRootKinds.add(command.id)); }
				commands.push(...found.commands);
				break;
			}
			case 'python': commands.push(...await pythonCommands(canonical, project)); break;
			case 'php': commands.push(...await phpCommands(canonical, project)); break;
			case 'dotnet': commands.push(...await dotnetCommands(canonical, project)); break;
			default: commands.push(...fixed);
		}
	}
	commands.push(...await makeCommands(canonical));
	const node = subprojects.find(project => project.ecosystem === 'node' && project.path === '.') ?? subprojects.find(project => project.ecosystem === 'node');
	return { ...(node ? { manager: node.packageManager } : {}), commands: commands.slice(0, MAX_COMMANDS), ecosystems: [...new Set(subprojects.map(project => project.ecosystem as string))], subprojects };
}

/**
 * Verification plan for a project without its own Harness: test, lint and typecheck only. `build` is left out on purpose: it is the
 * slowest command, it writes artifacts into the tree the writer's diff is measured on, and a test or typecheck already compiles
 * what matters. Every command must also be allowed by the command policy, which is the same one the agent itself runs under.
 */
export function detectedVerificationPlan(detected: DetectedProject, decide: (command: string, args: readonly string[], cwd: string) => PolicyDecision): Plan | undefined {
	const gates: Plan['gates'] = [];
	const seen = new Set<string>();
	const candidates = detected.commands
		.filter(command => GATE_KINDS.includes(command.id) && decide(command.command, command.args, command.cwd).allowed)
		.sort((a, b) => GATE_KINDS.indexOf(a.id) - GATE_KINDS.indexOf(b.id));
	for (const command of candidates) {
		const slot = command.id + '@' + command.cwd;
		if (seen.has(slot) || gates.length >= MAX_GATES) { continue; }
		seen.add(slot);
		const suffix = command.cwd === '.' ? '' : '-' + (command.cwd.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sub');
		let id = command.id + suffix;
		for (let n = 2; gates.some(gate => gate.id === id); n++) { id = command.id + suffix + '-' + n; }
		gates.push({ id, executable: command.command, args: command.args, cwd: command.cwd });
	}
	if (!gates.length) { return undefined; }
	const plan: Plan = { schemaVersion: 1, gates };
	validateNativePlan(plan);
	return plan;
}
