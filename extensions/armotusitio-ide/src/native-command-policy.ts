/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Agent command policy (block A). Layers, strongest first; a lower layer never widens an upper one:
 * 1. the IDE floor (immovable), 2. the project's own Harness when it runs commands itself, 3. ecosystem presets, 4. user extras.
 * Pure: no I/O, so the same decision is made in the extension and in the tool server process.
 */
import type { Subproject } from './native-ecosystems.ts';

/** Machine-readable denial returned to the agent as `POLICY_DENIED: <category>`. */
export type PolicyDenial = 'shell-operator' | 'inline-code' | 'git-mutation' | 'publish' | 'network' | 'destructive' | 'privilege' | 'global-config' | 'dependency-change' | 'not-allowed' | 'cwd-outside-project' | 'invalid';
export type PolicyDecision = { allowed: true; executable: string; cwd: string; delegate: boolean } | { allowed: false; reason: PolicyDenial };
export interface CommandPolicy {
	/** Pure decision for one command; `cwd` is project-relative. */
	decide(command: string, args: readonly string[], cwd: string): PolicyDecision;
	/** Human-readable summary shown next to "Aprobar y ejecutar" ("puede ejecutar: go build/test/vet, ..."). */
	describe(): string[];
}
/** Serializable input of a policy, written for the tool server process. */
export interface CommandPolicyConfig {
	subprojects: Subproject[];
	/** The project's Harness runs each command through its `ide-run` protocol command (capability `command-runner`). */
	delegate: boolean;
	/** `atsHarness.agentCommands.allow`: extra executables (optionally `executable subcommand`), always inside the floor. */
	extras: string[];
}

const OPERATOR = /^(&&|\|\||\||;|>|>>|<|&)$|`|\$\(/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl', 'busybox', 'env', 'xargs', 'nohup', 'start', 'call']);
const INLINE: Record<string, readonly string[]> = { node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import'], python: ['-c'], python3: ['-c'], py: ['-c'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], deno: ['eval'], bun: ['-e', '--eval'] };
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'telnet', 'rsync', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'certutil', 'bitsadmin']);
const DESTRUCTIVE = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'format', 'shred', 'mkfs', 'dd', 'diskpart', 'takeown', 'icacls', 'chmod', 'chown']);
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'runas', 'gsudo']);
const PUBLISH_TOOLS = new Set(['gh', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'twine', 'vercel', 'netlify', 'firebase', 'flyctl', 'heroku', 'aws', 'az', 'gcloud']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'merge-base', 'name-rev', 'ls-tree']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const base = (command: string): string => command.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const hasFlag = (args: readonly string[], ...flags: string[]): boolean => args.some(arg => flags.includes(arg) || flags.some(flag => flag.startsWith('--') && arg.startsWith(flag + '=')));

/** The immovable floor: what no project, preset or user setting can allow. */
function floor(command: string, args: readonly string[]): PolicyDenial | undefined {
	const name = base(command);
	const sub = args[0]?.toLowerCase();
	if (!command || command.includes('\0') || args.some(arg => arg.includes('\0')) || args.length > 64) { return 'invalid'; }
	if (OPERATOR.test(command) || args.some(arg => OPERATOR.test(arg))) { return 'shell-operator'; }
	if (SHELLS.has(name)) { return 'shell-operator'; }
	if (INLINE[name] && args.some(arg => INLINE[name].includes(arg))) { return 'inline-code'; }
	if (PRIVILEGE.has(name)) { return 'privilege'; }
	if (NETWORK.has(name)) { return 'network'; }
	if (DESTRUCTIVE.has(name)) { return 'destructive'; }
	if (PUBLISH_TOOLS.has(name)) { return 'publish'; }
	if (name === 'git') {
		if (sub === 'config' && hasFlag(args, '--global', '--system')) { return 'global-config'; }
		if (!sub || !GIT_READ.has(sub) || hasFlag(args, '--output', '-o')) { return 'git-mutation'; }
	}
	if (PACKAGE_MANAGERS.has(name)) {
		if (['publish', 'login', 'adduser', 'logout', 'token', 'owner', 'dist-tag', 'deprecate', 'unpublish'].includes(sub ?? '')) { return 'publish'; }
		if (sub === 'config' && ['set', 'delete', 'edit'].includes(args[1] ?? '')) { return 'global-config'; }
		if (hasFlag(args, '-g', '--global', '--location=global')) { return 'global-config'; }
		if (['add', 'remove', 'rm', 'uninstall', 'un', 'upgrade', 'update', 'up', 'link', 'unlink'].includes(sub ?? '')) { return 'dependency-change'; }
		if ((sub === 'install' || sub === 'i') && (args.slice(1).some(arg => !arg.startsWith('-')) || (name !== 'npm' && !hasFlag(args, '--frozen-lockfile', '--immutable')))) { return 'dependency-change'; }
		if (name === 'npm' && (sub === 'install' || sub === 'i')) { return 'dependency-change'; }
	}
	if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
		if (hasFlag(args, '-y', '--yes', '-p', '--package')) { return 'dependency-change'; }
	}
	if (name === 'go') {
		if (sub === 'env' && hasFlag(args, '-w', '-u')) { return 'global-config'; }
		if (sub === 'get' || sub === 'install') { return 'dependency-change'; }
	}
	if (name === 'cargo' && ['publish', 'login', 'owner', 'yank'].includes(sub ?? '')) { return 'publish'; }
	if (name === 'cargo' && ['install', 'add', 'remove', 'update'].includes(sub ?? '')) { return 'dependency-change'; }
	if (['pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda'].includes(name) && ['install', 'uninstall', 'add', 'remove', 'publish', 'upload', 'config'].includes(sub ?? '') && !(name === 'uv' && sub === 'sync')) { return sub === 'publish' || sub === 'upload' ? 'publish' : 'dependency-change'; }
	if (['python', 'python3', 'py'].includes(name) && sub === '-m' && ['pip', 'twine', 'ensurepip', 'http.server', 'venv'].includes(args[1] ?? '')) { return args[1] === 'twine' ? 'publish' : 'dependency-change'; }
	if (name === 'dotnet' && (sub === 'nuget' || (sub === 'tool' && args[1] === 'install') || sub === 'add' || sub === 'remove')) { return sub === 'nuget' ? 'publish' : 'dependency-change'; }
	if (['mvn', 'gradle', './mvnw', './gradlew', 'mvnw', 'gradlew'].includes(name) && args.some(arg => ['deploy', 'publish', 'release:perform'].includes(arg) || arg.startsWith('publish'))) { return 'publish'; }
	if (name === 'composer' && (['require', 'remove', 'update', 'global', 'config'].includes(sub ?? '') || (sub === 'install' && !hasFlag(args, '--no-scripts')))) { return 'dependency-change'; }
	if (['gem', 'bundle'].includes(name) && ['install', 'add', 'update', 'push', 'config'].includes(sub ?? '')) { return sub === 'push' ? 'publish' : 'dependency-change'; }
	return undefined;
}

/** Commands each ecosystem may run: executable → allowed first argument (`*` any), or true for any arguments. */
function presets(project: Subproject): Record<string, true | readonly string[]> {
	switch (project.ecosystem) {
		case 'go': return { go: ['build', 'test', 'vet', 'list', 'mod', 'fmt', 'version', 'env', 'generate', 'run', 'tool'], gofmt: true };
		case 'node': {
			const manager = project.packageManager ?? 'npm';
			const scripts = project.scripts ?? [];
			return { [manager]: ['run', 'test', 'exec', 'ci', 'install', 'ls', 'list', 'why', ...scripts], npx: true, node: true, tsc: true, eslint: true, vitest: true, jest: true, prettier: true };
		}
		case 'python': return { python: true, python3: true, py: true, pytest: true, mypy: true, ruff: true, uv: ['run', 'sync'], poetry: ['run'] };
		case 'rust': return { cargo: ['build', 'test', 'check', 'clippy', 'fmt', 'fetch', 'tree', 'metadata', 'bench', 'doc'] };
		case 'dotnet': return { dotnet: ['build', 'test', 'restore', 'format', 'list'] };
		case 'java': return { mvn: true, gradle: true, './mvnw': true, './gradlew': true, 'mvnw': true, 'gradlew': true };
		case 'php': return { composer: ['install', 'validate', 'dump-autoload', 'show'], 'vendor/bin/phpunit': true, 'vendor/bin/phpstan': true, 'vendor/bin/pest': true, php: true };
		case 'ruby': return { bundle: ['exec'], rspec: true, rake: true, ruby: true };
	}
}

/** Project-relative, without `..`, inside the project: the agent never picks a folder outside it. */
function validCwd(cwd: string): string | undefined {
	const normalized = (cwd || '.').replace(/\\/g, '/').replace(/\/+$/, '') || '.';
	if (/^([a-zA-Z]:|\/|~)/.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) { return undefined; }
	return normalized.replace(/^\.\//, '') || '.';
}

const inside = (cwd: string, folder: string): boolean => folder === '.' || cwd === folder || cwd.startsWith(folder + '/');

export function createCommandPolicy(config: CommandPolicyConfig): CommandPolicy {
	const extras = config.extras.map(entry => entry.trim().split(/\s+/)).filter(parts => parts[0]);
	return {
		decide(command, args, cwd) {
			const folder = validCwd(cwd);
			if (!folder) { return { allowed: false, reason: 'cwd-outside-project' }; }
			const denied = floor(command, args);
			if (denied) { return { allowed: false, reason: denied }; }
			const name = base(command);
			// The project's Harness applies its own, possibly stricter, policy after the floor.
			if (config.delegate) { return { allowed: true, executable: command, cwd: folder, delegate: true }; }
			if (name === 'git') { return { allowed: true, executable: command, cwd: folder, delegate: false }; }
			const sub = args[0];
			const presetAllows = config.subprojects.some(project => {
				if (!inside(folder, project.path)) { return false; }
				const allowed = presets(project)[name];
				return allowed === true || (!!allowed && !!sub && allowed.includes(sub));
			});
			const extraAllows = extras.some(([executable, subcommand]) => base(executable) === name && (!subcommand || subcommand === sub));
			return presetAllows || extraAllows ? { allowed: true, executable: command, cwd: folder, delegate: false } : { allowed: false, reason: 'not-allowed' };
		},
		describe() {
			if (config.delegate) { return ['El Harness del proyecto decide qu\u00e9 comandos se ejecutan, dentro del piso del IDE.']; }
			const lines = config.subprojects.map(project => project.path + ' (' + project.ecosystem + '): ' + Object.entries(presets(project)).map(([executable, allowed]) => allowed === true ? executable : executable + ' ' + allowed.slice(0, 6).join('/')).join(', '));
			return ['git (solo lectura)', ...lines, ...(extras.length ? ['Extras: ' + extras.map(parts => parts.join(' ')).join(', ')] : [])];
		}
	};
}
