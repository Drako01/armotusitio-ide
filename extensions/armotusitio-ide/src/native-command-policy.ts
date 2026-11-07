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
import { commandName, dependencyDecision, suggestRule, type PermissionSet } from './native-permissions.ts';

/** Machine-readable denial returned to the agent as `POLICY_DENIED: <category>`. */
export type PolicyDenial = 'shell-operator' | 'inline-code' | 'git-mutation' | 'publish' | 'network' | 'destructive' | 'privilege' | 'global-config' | 'dependency-change' | 'external-cli' | 'credential-access' | 'not-allowed' | 'cwd-outside-project' | 'invalid' | 'needs-approval';
/** `needs-approval` is a permission `ask`: still `allowed: false`, so a consumer that only reads `allowed` treats it as denied. */
export type PolicyDecision = { allowed: true; executable: string; cwd: string; delegate: boolean }
	| { allowed: false; reason: Exclude<PolicyDenial, 'needs-approval'> }
	| { allowed: false; reason: 'needs-approval'; rule: string; executable: string; cwd: string; delegate: boolean };
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
	/** Declarative allow/ask/deny rules and preset; they decide only inside the floor. Without it `dependency-change` stays denied. */
	permissions?: PermissionSet;
}

const OPERATOR = /^(&&|\|\||\||;|>|>>|<|&)$|`|\$\(/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl', 'busybox', 'env', 'xargs', 'nohup', 'start', 'call']);
const INLINE: Record<string, readonly string[]> = { node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import'], python: ['-c'], python3: ['-c'], py: ['-c'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], deno: ['eval'], bun: ['-e', '--eval'] };
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'telnet', 'rsync', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'certutil', 'bitsadmin']);
const DESTRUCTIVE = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'format', 'shred', 'mkfs', 'dd', 'diskpart', 'takeown', 'icacls', 'chmod', 'chown']);
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'runas', 'gsudo']);
const PUBLISH_TOOLS = new Set(['twine']);
/**
 * Cloud, container and HTTP CLIs: they act outside the project with the user's own credentials, so each call is the user's
 * decision (`external-cli`, approvable like a dependency change); without a way to ask, they stay denied.
 */
const EXTERNAL_CLIS = new Set(['gh', 'aws', 'az', 'gcloud', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'vercel', 'netlify', 'firebase', 'flyctl', 'heroku', 'curl', 'wget']);
/**
 * Calls that log in or print credentials, tokens or secrets: never approvable, because the output would reach the model and
 * its logs. Each entry matches when its words appear in this order among the arguments (flags in between do not hide it).
 */
const CREDENTIAL_COMMANDS: Record<string, readonly string[][]> = {
	gh: [['auth'], ['secret'], ['ssh-key'], ['gpg-key'], ['extension'], ['alias'], ['config', 'set']],
	aws: [['configure'], ['ecr', 'get-login-password'], ['ecr-public', 'get-login-password'], ['sts', 'get-session-token'], ['sts', 'assume-role'], ['sts', 'assume-role-with-saml'],
	['sts', 'assume-role-with-web-identity'], ['sts', 'get-federation-token'], ['sso', 'get-role-credentials'], ['secretsmanager', 'get-secret-value'],
	['secretsmanager', 'batch-get-secret-value'], ['codeartifact', 'get-authorization-token'], ['eks', 'get-token'], ['rds', 'generate-db-auth-token'], ['iam', 'create-access-key'],
	['ssm', '--with-decryption']],
	az: [['account', 'get-access-token'], ['keyvault', 'secret', 'show'], ['keyvault', 'secret', 'download'], ['acr', 'login'], ['ad', 'sp', 'credential']],
	gcloud: [['auth'], ['secrets', 'versions', 'access'], ['config', 'set'], ['config', 'unset']],
	kubectl: [['config', 'view', '--raw'], ['config', 'set'], ['config', 'set-credentials'], ['config', 'set-context'], ['config', 'set-cluster'], ['config', 'use-context'],
	['config', 'unset'], ['config', 'delete-context'], ['config', 'delete-cluster'], ['config', 'delete-user'], ['config', 'rename-context']],
	helm: [['registry', 'login'], ['registry', 'logout']]
};
/** Read-only GitHub queries an agent needs to follow CI and reviews; they run without a question. `--web` opens a browser, so it asks. */
const GH_READ: Record<string, readonly string[]> = {
	pr: ['view', 'list', 'status', 'diff', 'checks'], issue: ['view', 'list', 'status'], run: ['view', 'list'], workflow: ['view', 'list'],
	repo: ['view'], release: ['view', 'list'], label: ['list'], search: ['issues', 'prs', 'repos', 'commits', 'code']
};
const ghReadOnly = (name: string, args: readonly string[]): boolean =>
	name === 'gh' && !!GH_READ[args[0]]?.includes(args[1]) && !args.some(arg => arg === '--web' || arg === '-w');

/** `words` appear in `args` in this order (case-insensitive); flags and values between them do not matter. */
function inOrder(args: readonly string[], words: readonly string[]): boolean {
	let next = 0;
	for (const arg of args) {
		if (next < words.length && arg.toLowerCase() === words[next]) { next++; }
	}
	return next === words.length;
}

/** Floor verdict for an external CLI: credentials never, read-only gh always, anything else is the user's call. */
function externalCli(name: string, args: readonly string[]): PolicyDenial | undefined {
	// Every CLI's own login/logout/auth subcommands (`vercel login`, `heroku auth:token`, `docker logout`, `terraform login`).
	if (/^(login|logout|auth)(:|$)/i.test(args[0] ?? '') || CREDENTIAL_COMMANDS[name]?.some(words => inOrder(args, words))) { return 'credential-access'; }
	return ghReadOnly(name, args) ? undefined : 'external-cli';
}
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'merge-base', 'name-rev', 'ls-tree']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Exact information probes help distinguish an unavailable runtime from a failed project command. */
const INFO_TOOLS = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'go', 'gofmt', 'cargo', 'rustc', 'dotnet',
	'python', 'python3', 'py', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'mvn', 'mvnw', 'gradle', 'gradlew', 'composer', 'php', 'gem', 'bundle', 'ruby',
	'tsc', 'eslint', 'vitest', 'jest', 'prettier', 'pytest', 'mypy', 'ruff', 'git', 'rg', 'gh', 'aws', 'az', 'gcloud', 'docker', 'kubectl', 'terraform']);
const INFO_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);
const AGENT_TOOLS = new Set(['claude', 'codex']);
const informationProbe = (name: string, args: readonly string[]): boolean => args.length === 1 &&
	(AGENT_TOOLS.has(name) ? args[0] === '--version' : INFO_TOOLS.has(name) && INFO_FLAGS.has(args[0]));

const base = commandName;
const hasFlag = (args: readonly string[], ...flags: string[]): boolean => args.some(arg => flags.includes(arg) || flags.some(flag => flag.startsWith('--') && arg.startsWith(flag + '=')));

/** The immovable floor: what no project, preset or user setting can allow. */
function floor(command: string, args: readonly string[], depth = 0): PolicyDenial | undefined {
	const name = base(command);
	const sub = args[0]?.toLowerCase();
	if (depth > 8 || !command || command.includes('\0') || args.some(arg => arg.includes('\0')) || args.length > 64) { return 'invalid'; }
	if (OPERATOR.test(command) || args.some(arg => OPERATOR.test(arg))) { return 'shell-operator'; }
	if (SHELLS.has(name)) { return 'shell-operator'; }
	if (INLINE[name] && args.some(arg => INLINE[name].some(flag => flag.startsWith('--')
		? arg === flag || arg.startsWith(flag + '=')
		: flag.startsWith('-') ? /^-[^-]/.test(arg) && arg.slice(1).includes(flag.slice(1)) : arg === flag))) { return 'inline-code'; }
	if (PRIVILEGE.has(name)) { return 'privilege'; }
	// Only by bare name: a path could point at any binary, and the approval card must show the CLI the user knows.
	if (EXTERNAL_CLIS.has(name)) {
		if (/[\\/]/.test(command)) { return 'invalid'; }
		return informationProbe(name, args) ? undefined : externalCli(name, args);
	}
	if (NETWORK.has(name)) { return 'network'; }
	if (DESTRUCTIVE.has(name)) { return 'destructive'; }
	if (PUBLISH_TOOLS.has(name)) { return 'publish'; }
	// ripgrep can launch preprocessors and hostname helpers: navigation must not become command execution.
	if (name === 'rg' && hasFlag(args, '--pre', '--hostname-bin')) { return 'inline-code'; }
	const normalized = command.replace(/\\/g, '/');
	if (/[\\/]/.test(command) && !['./mvnw', './gradlew', 'vendor/bin/phpunit', 'vendor/bin/phpstan', 'vendor/bin/pest'].includes(normalized)) { return 'invalid'; }
	if (informationProbe(name, args)) { return undefined; }
	// Provider diagnostics must never become a nested agent, login or configuration invocation.
	if (AGENT_TOOLS.has(name)) { return 'not-allowed'; }
	// Inspect the executable behind launchers before dependency approval can let the outer command through.
	if ([...PACKAGE_MANAGERS, 'uv', 'poetry', 'bundle'].includes(name) && sub?.startsWith('-') &&
		!(args.length === 1 && ['--version', '-v', '--help', '-h'].includes(sub))) { return 'not-allowed'; }
	const launcher = ['npx', 'pnpx', 'bunx'].includes(name);
	const wrapper = (PACKAGE_MANAGERS.has(name) && ['exec', 'dlx', 'x'].includes(sub ?? '')) ||
		(['uv', 'poetry'].includes(name) && sub === 'run') || (name === 'bundle' && sub === 'exec');
	if (launcher || wrapper) {
		const nested = args.slice(launcher ? 0 : 1);
		while (launcher && ['-y', '--yes', '--no-install', '--'].includes(nested[0])) { nested.shift(); }
		if (!nested[0] || nested[0].startsWith('-')) { return 'not-allowed'; }
		const denied = floor(nested[0], nested.slice(1), depth + 1);
		// An external CLI behind a launcher would be approved under the launcher's name: call it directly instead.
		if (denied) { return denied === 'external-cli' ? 'not-allowed' : denied; }
	}

	if (name === 'git') {
		if (sub === 'config' && hasFlag(args, '--global', '--system')) { return 'global-config'; }
		if (!sub || !GIT_READ.has(sub) || hasFlag(args, '--output', '-o', '--open-files-in-pager', '--paginate', '-P') || args.some(arg => arg.startsWith('-O'))) { return 'git-mutation'; }
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

/** Commands each ecosystem may run: executable \u2192 allowed first argument (`*` any), or true for any arguments. */
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

/** The permission layer's verdict for one run request (`allow` when no permissions are configured and the floor did not object). */
function permit(permissions: PermissionSet | undefined, command: string, args: readonly string[], cwd: string, approvable: boolean): 'allow' | 'ask' | 'deny' {
	if (!permissions) { return 'allow'; }
	const verdict = permissions.decide({ kind: 'run', command, args: [...args], cwd });
	// A package install or an external CLI is `ask` by default; only an explicit rule overrides the preset's answer for it.
	if (approvable && verdict.source === 'preset') { return dependencyDecision(permissions.preset); }
	// A blanket rule (`run:*`, `run:a*`) must not pre-approve cloud or HTTP calls: only a rule naming this CLI does.
	const name = base(command);
	const namesThisCli = verdict.rule === 'run:' + name || !!verdict.rule?.startsWith('run:' + name + ' ');
	if (approvable && verdict.decision === 'allow' && EXTERNAL_CLIS.has(name) && !namesThisCli) { return 'ask'; }
	return verdict.decision;
}

/** Floor categories that become a question to the user (instead of a denial) when the run can ask. */
const APPROVABLE: ReadonlySet<PolicyDenial> = new Set(['dependency-change', 'external-cli']);

/** Whether the project's Harness, the ecosystem presets or the user extras let this command through (after the floor). */
function allowlisted(config: CommandPolicyConfig, extras: string[][], command: string, args: readonly string[], folder: string): Extract<PolicyDecision, { allowed: true }> | { allowed: false; reason: 'not-allowed' } {
	const name = /[\\/]/.test(command) ? command.replace(/\\/g, '/') : base(command);
	// The project's Harness applies its own, possibly stricter, policy after the floor.
	if (config.delegate) { return { allowed: true, executable: command, cwd: folder, delegate: true }; }
	if (name === 'git' || name === 'rg' || informationProbe(name, args) || ghReadOnly(name, args)) { return { allowed: true, executable: command, cwd: folder, delegate: false }; }
	const sub = args[0];
	const presetAllows = config.subprojects.some(project => {
		if (!inside(folder, project.path)) { return false; }
		const allowed = presets(project)[name];
		return allowed === true || (!!allowed && !!sub && allowed.includes(sub));
	});
	const extraAllows = extras.some(([executable, subcommand]) => base(executable) === name && (!subcommand || subcommand === sub));
	return presetAllows || extraAllows ? { allowed: true, executable: command, cwd: folder, delegate: false } : { allowed: false, reason: 'not-allowed' };
}

export function createCommandPolicy(config: CommandPolicyConfig): CommandPolicy {
	const extras = config.extras.map(entry => entry.trim().split(/\s+/)).filter(parts => parts[0]);
	return {
		decide(command, args, cwd) {
			const folder = validCwd(cwd);
			if (!folder) { return { allowed: false, reason: 'cwd-outside-project' }; }
			const denied = floor(command, args) as Exclude<PolicyDenial, 'needs-approval'> | undefined;
			const approvable = !!denied && APPROVABLE.has(denied) && !!config.permissions;
			if (denied && !approvable) { return { allowed: false, reason: denied }; }
			const permitted = permit(config.permissions, command, args, folder, approvable);
			if (permitted === 'deny') { return { allowed: false, reason: approvable ? denied! : 'not-allowed' }; }
			// Dependency changes and external CLIs are never in the ecosystem lists: the permission layer alone decides (ask unless an explicit user rule allows it).
			let decision = approvable ? { allowed: true as const, executable: command, cwd: folder, delegate: config.delegate } : allowlisted(config, extras, command, args, folder);
			if (!decision.allowed && config.permissions && config.permissions.preset !== 'readonly') {
				// A missing ecosystem entry is a request for consent, not a permanent denial.
				// Explicit deny/invalid files and the command floor have already returned above.
				const verdict = config.permissions.decide({ kind: 'run', command, args: [...args], cwd: folder });
				decision = { allowed: true, executable: command, cwd: folder, delegate: config.delegate };
				if (!(verdict.decision === 'allow' && verdict.source === 'user')) {
					return { allowed: false, reason: 'needs-approval', rule: suggestRule({ kind: 'run', command, args: [...args], cwd: folder }), executable: command, cwd: folder, delegate: config.delegate };
				}
			}
			if (!decision.allowed || permitted === 'allow') { return decision; }
			return { allowed: false, reason: 'needs-approval', rule: suggestRule({ kind: 'run', command, args: [...args], cwd: folder }), executable: decision.executable, cwd: decision.cwd, delegate: decision.delegate };
		},
		describe() {
			if (config.delegate) { return ['El Harness del proyecto decide qu\u00e9 comandos se ejecutan, dentro del piso del IDE.']; }
			const lines = config.subprojects.map(project => project.path + ' (' + project.ecosystem + '): ' + Object.entries(presets(project)).map(([executable, allowed]) => allowed === true ? executable : executable + ' ' + allowed.slice(0, 6).join('/')).join(', '));
			return ['git, rg (solo lectura)', 'gh de solo lectura (pr/issue/run view, list, checks); otros CLI externos (gh, aws, az, gcloud, docker, kubectl, terraform, curl...) piden permiso', ...lines, ...(extras.length ? ['Extras: ' + extras.map(parts => parts.join(' ')).join(', ')] : [])];
		}
	};
}
