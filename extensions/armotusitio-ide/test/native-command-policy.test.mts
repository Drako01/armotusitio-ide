/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';

test('ripgrep is available for navigation without allowing executable helpers', () => {
	const policy = createCommandPolicy({ subprojects: [], delegate: false, extras: [] });
	assert.equal(policy.decide('rg', ['--files', 'src'], '.').allowed, true);
	assert.equal(policy.decide('rg', ['-n', 'MFA', 'src'], '.').allowed, true);
	for (const delegate of [false, true]) {
		for (const args of [['--pre', 'helper'], ['--pre=helper'], ['--hostname-bin', 'helper'], ['--hostname-bin=helper']]) {
			assert.deepEqual(createCommandPolicy({ subprojects: [], delegate, extras: [] }).decide('rg', args, '.'), { allowed: false, reason: 'inline-code' });
		}
	}
});
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCommandPolicy, denialText } from '../src/native-command-policy.ts';
import { addUserRule, loadPermissions, type PermissionSet } from '../src/native-permissions.ts';
import type { PermissionPreset } from '../src/native-permissions-types.ts';
import { detectEcosystems } from '../src/native-ecosystems.ts';
import { runCommand } from '../src/native-command-runner.ts';
import { handleRun, type RunnerConfig } from '../src/ats-runner.ts';

const monorepo = [{ path: 'apps/api', ecosystem: 'go' as const }, { path: 'apps/web', ecosystem: 'node' as const, packageManager: 'pnpm' as const, scripts: ['test', 'lint'] }];

test('unknown development tools ask for consent and a persisted user grant survives reloading', async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-remember-tool-')));
	const home = path.join(base, 'home');
	const root = path.join(base, 'project');
	const request = ['custom-tool', ['check'], '.'] as const;
	const policyFor = async () => createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions: await loadPermissions(root, home) });
	try {
		assert.deepEqual((await policyFor()).decide(...request), { allowed: false, reason: 'needs-approval', rule: 'run:custom-tool check', executable: 'custom-tool', cwd: '.', delegate: false });
		await addUserRule('run:custom-tool check', 'allow', home);
		assert.equal((await policyFor()).decide(...request).allowed, true);
		assert.equal((await policyFor()).decide('custom-tool', ['other'], '.').allowed, false);
		await addUserRule('run:custom-tool check', 'deny', home);
		assert.deepEqual((await policyFor()).decide(...request), { allowed: false, reason: 'not-allowed' });
	} finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the IDE floor rejects what no preset, project or user extra can allow', () => {
	const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: ['rm', 'curl', 'make test'] });
	const project = createCommandPolicy({ subprojects: [], delegate: true, extras: [] });
	const reasons = (target: typeof policy) => ([
		['git', ['push']], ['git', ['commit', '-m', 'x']], ['git', ['config', '--global', 'user.name', 'x']], ['npm', ['publish']], ['pnpm', ['add', 'left-pad']],
		['npm', ['install', 'left-pad']], ['go', ['get', 'example.com/x']], ['go', ['env', '-w', 'GOPROXY=x']], ['curl', ['https://x']], ['rm', ['-rf', '.']],
		['node', ['-e', 'process.exit()']], ['python', ['-c', 'print(1)']], ['bash', ['-c', 'ls']], ['go', ['test', '&&', 'rm']], ['sudo', ['go']], ['docker', ['compose', 'up']],
		['gh', ['pr', 'create']], ['python', ['-m', 'pip', 'install', 'x']], ['npx', ['-y', 'cowsay']]
	] as Array<[string, string[]]>).map(([command, args]) => target.decide(command, args, 'apps/api')).map(decision => decision.allowed ? 'allowed' : decision.reason);
	// External CLIs (curl, docker, gh) are not allowed without a way to ask the user; with one they become a question (see below).
	const expected = ['git-mutation', 'git-mutation', 'global-config', 'publish', 'dependency-change', 'dependency-change', 'dependency-change', 'global-config', 'external-cli', 'destructive',
		'inline-code', 'inline-code', 'inline-code', 'shell-operator', 'privilege', 'external-cli', 'external-cli', 'dependency-change', 'dependency-change'];
	assert.deepEqual({ ide: reasons(policy), delegated: reasons(project) }, { ide: expected, delegated: expected });
});

test('presets follow the detected subproject; the cwd must stay inside the project', () => {
	const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: ['make test'] });
	const decide = (command: string, args: string[], cwd: string) => { const decision = policy.decide(command, args, cwd); return decision.allowed ? decision.cwd : decision.reason; };
	assert.deepEqual([
		decide('go', ['test', './...'], 'apps/api'), decide('go', ['test', './...'], 'apps/web'), decide('pnpm', ['run', 'lint'], 'apps/web'), decide('pnpm', ['lint'], 'apps/web\\'),
		decide('pnpm', ['install', '--frozen-lockfile'], 'apps/web'), decide('pnpm', ['deploy'], 'apps/web'), decide('git', ['status'], '.'), decide('make', ['test'], '.'), decide('make', ['deploy'], '.'),
		decide('go', ['test'], '../other'), decide('go', ['test'], 'C:/Windows'), decide('go', ['test'], '/etc')
	], ['apps/api', 'not-allowed', 'apps/web', 'apps/web', 'apps/web', 'not-allowed', '.', '.', 'not-allowed', 'cwd-outside-project', 'cwd-outside-project', 'cwd-outside-project']);
	// A delegating project decides beyond the floor itself.
	assert.deepEqual(createCommandPolicy({ subprojects: [], delegate: true, extras: [] }).decide('just', ['test'], '.'), { allowed: true, executable: 'just', cwd: '.', delegate: true });
});

test('a monorepo is detected completely, skipping dependency folders, with each package manager and its scripts', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-ecosystems-')));
	try {
		const write = async (file: string, content = '') => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
		await write('pnpm-lock.yaml'); await write('package.json', '{"scripts":{"build":"x"}}');
		await write('apps/api/go.mod', 'module x'); await write('apps/web/package.json', '{"scripts":{"test":"vitest","lint":"eslint ."}}');
		await write('apps/web/node_modules/dep/package.json', '{}'); await write('services/jobs/pyproject.toml'); await write('tools/build.gradle.kts'); await write('tools/gradlew');
		const found = (await detectEcosystems(root)).map(project => [project.path, project.ecosystem, project.packageManager, project.scripts, project.wrapper]);
		assert.deepEqual(found, [
			['.', 'node', 'pnpm', ['build'], undefined], ['apps/api', 'go', undefined, undefined, undefined], ['apps/web', 'node', 'pnpm', ['test', 'lint'], undefined],
			['services/jobs', 'python', undefined, undefined, undefined], ['tools', 'java', undefined, undefined, 'gradlew']
		]);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the runner executes without a shell, bounds time and output, and the tool server answers denials as POLICY_DENIED', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-runner-')));
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-runner-logs-'));
	try {
		await fs.mkdir(path.join(root, 'apps', 'web'), { recursive: true });
		await fs.writeFile(path.join(root, 'apps', 'web', 'print.js'), 'console.log("cwd=" + process.cwd().split(/[\\\\/]/).pop()); console.log("x".repeat(70000)); process.exit(3);');
		await fs.writeFile(path.join(root, 'apps', 'web', 'slow.js'), 'setTimeout(() => {}, 60000);');
		const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot };
		const printed = await runCommand({ root, cwd: 'apps/web', command: 'node', args: ['print.js'], env, logDirectory: logs });
		const slow = await runCommand({ root, cwd: 'apps/web', command: 'node', args: ['slow.js'], timeoutSec: 1, env, logDirectory: logs });
		const log = await fs.readFile(printed.logFile, 'utf8');
		assert.deepEqual({ exit: printed.exitCode, truncated: printed.truncated, size: printed.output.length <= 64 * 1024, full: log.startsWith('cwd=web'), timedOut: slow.timedOut },
			{ exit: 3, truncated: true, size: true, full: true, timedOut: true });
		const config: RunnerConfig = { schemaVersion: 1, root, env, logDirectory: logs, maxTurns: 10, policy: { subprojects: [{ path: 'apps/web', ecosystem: 'node', packageManager: 'npm', scripts: [] }], delegate: false, extras: [] } };
		const denied = await handleRun(config, { command: 'git', args: ['push'] }, 1);
		// Running a program file is the user's call: the card is answered yes (and the user's real permission file is not read).
		const ran = await handleRun(config, { command: 'node', args: ['print.js'], cwd: 'apps/web' }, 9, { permissions: await loadPermissions(root, logs), ask: async () => 'once' });
		const audit = (await fs.readFile(path.join(logs, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual({ denied, ranExit: ran.text.startsWith('exit 3'), budget: /about 1 turns left/.test(ran.text), audit: audit.map(entry => entry.denied ?? entry.exitCode) },
			{ denied: { isError: true, text: denialText('git-mutation') }, ranExit: true, budget: true, audit: ['git-mutation', 3] });
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

async function permissionsFor(preset: PermissionPreset, files: { user?: unknown; project?: unknown } = {}): Promise<{ set: PermissionSet; cleanup: () => Promise<void> }> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-policy-permissions-')));
	for (const [folder, content] of [['home', files.user], ['project', files.project]] as const) {
		if (content !== undefined) {
			await fs.mkdir(path.join(base, folder, '.armotusitio'), { recursive: true });
			await fs.writeFile(path.join(base, folder, '.armotusitio', 'permissions.json'), JSON.stringify(content));
		}
	}
	return { set: await loadPermissions(path.join(base, 'project'), path.join(base, 'home'), undefined, { preset }), cleanup: () => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('permissions move dependency-change out of the floor: ask in dev and trusted, deny in readonly, denied without permissions', async () => {
	const answer = async (preset: PermissionPreset | undefined, command: string, args: string[], files?: { user?: unknown; project?: unknown }) => {
		const loaded = preset ? await permissionsFor(preset, files) : undefined;
		try {
			const decision = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded?.set }).decide(command, args, 'apps/web');
			return decision.allowed ? 'allowed' : decision.reason;
		} finally { await loaded?.cleanup(); }
	};
	assert.deepEqual({
		none: await answer(undefined, 'pnpm', ['install', 'left-pad']), dev: await answer('dev', 'pnpm', ['install', 'left-pad']), trusted: await answer('trusted', 'pnpm', ['install', 'left-pad']), projectAllow: await answer('dev', 'pnpm', ['add', 'x'], { project: { version: 1, allow: ['run:pnpm add*'] } }),
		readonly: await answer('readonly', 'pnpm', ['install', 'left-pad']), notListed: await answer('trusted', 'pnpm', ['add', 'left-pad']), userAllowAdd: await answer('dev', 'pnpm', ['add', 'x'], { user: { version: 1, allow: ['run:pnpm add*'] } }),
		userAllow: await answer('dev', 'pnpm', ['install', 'left-pad'], { user: { version: 1, allow: ['run:pnpm install*'] } }),
		projectAsk: await answer('trusted', 'pnpm', ['install', 'left-pad'], { project: { version: 1, ask: ['run:pnpm install*'] } }),
		corruptFile: await answer('trusted', 'pnpm', ['add', 'x'], { user: { version: 2 } }),
		floorStays: await answer('trusted', 'pnpm', ['publish']), floorShell: await answer('trusted', 'bash', []), floorInline: await answer('trusted', 'bash', ['-c', 'sudo ls']), floorGlobal: await answer('trusted', 'pnpm', ['add', '-g', 'x'])
	}, {
		none: 'dependency-change', dev: 'needs-approval', trusted: 'needs-approval', projectAllow: 'needs-approval', userAllowAdd: 'allowed', readonly: 'dependency-change', notListed: 'needs-approval', userAllow: 'allowed', projectAsk: 'needs-approval',
		corruptFile: 'dependency-change', floorStays: 'publish', floorShell: 'shell-operator', floorInline: 'privilege', floorGlobal: 'global-config'
	});
});

test('a permission ask is a denial for consumers that only read allowed, and carries the rule and the resolved command', async () => {
	const loaded = await permissionsFor('dev', { project: { version: 1, ask: ['run:go test*'], deny: ['run:go vet*'] }, user: { version: 1, allow: ['run:go vet*'] } });
	try {
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const asked = policy.decide('go.exe', ['test', './...'], 'apps/api\\');
		assert.deepEqual({ asked, denied: policy.decide('go', ['vet'], 'apps/api'), outside: policy.decide('go', ['build'], 'apps/web'), allowed: policy.decide('go', ['build'], 'apps/api').allowed },
			{ asked: { allowed: false, reason: 'needs-approval', rule: 'run:go test ./...', executable: 'go.exe', cwd: 'apps/api', delegate: false }, denied: { allowed: false, reason: 'not-allowed' }, outside: { allowed: false, reason: 'needs-approval', rule: 'run:go build', executable: 'go', cwd: 'apps/web', delegate: false }, allowed: true });
		const delegated = createCommandPolicy({ subprojects: [], delegate: true, extras: [], permissions: await permissionsFor('readonly').then(({ set }) => set) });
		assert.equal((createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set }).decide('pnpm', ['add', 'x'], 'apps/web') as { rule?: string }).rule, '');
		assert.deepEqual([delegated.decide('git', ['status'], '.').allowed, delegated.decide('just', ['test'], '.')], [true, { allowed: false, reason: 'not-allowed' }]);
	} finally { await loaded.cleanup(); }
});


test('the floor checks executable paths, inline flag variants and nested launcher payloads before permissions or delegation', async () => {
	const loaded = await permissionsFor('trusted', { user: { version: 1, allow: ['run:*'] } });
	try {
		const cases: Array<[string, string[]]> = [
			['git', ['grep', '-Osh', 'x']], ['git', ['grep', '--open-files-in-pager=sh', 'x']], ['git', ['log', '--paginate']],
			['node', ['--eval=1']], ['node', ['-pe', '1']], ['node', ['--require=./evil.js']], ['node', ['--import=./evil.js']],
			['python', ['-Ic', 'print(1)']], ['python', ['-ic', 'print(1)']],
			['pnpm', ['exec', 'sh', '-c', 'x']], ['pnpm', ['exec', 'curl', 'https://x']], ['uv', ['run', 'python', '-c', 'x']],
			['poetry', ['run', 'curl', 'https://x']], ['bundle', ['exec', 'ruby', '-e', 'x']], ['npx', ['sh', '-c', 'x']], ['npx', ['-y', 'curl', 'https://x']],
			['/usr/bin/curl', ['https://x']], ['C:\\Windows\\System32\\curl.exe', ['https://x']], ['/bin/rm', ['file']], ['./bash', ['-c', 'x']], ['/usr/bin/node', ['file.js']],
			['pnpm', ['--dir', '.', 'exec', 'sh', '-c', 'x']], ['uv', ['--project', '.', 'run', 'python', '-c', 'x']],
			['pnpm', ['exec', 'npx', 'sh', '-c', 'x']], ['uv', ['run', '--project', '.', 'python', '-c', 'x']]
		];
		for (const delegate of [false, true]) {
			const policy = createCommandPolicy({ subprojects: monorepo, delegate, extras: ['curl', 'sh'], permissions: loaded.set });
			assert.deepEqual(cases.map(([command, args]) => policy.decide(command, args, 'apps/web').allowed), cases.map(() => false));
		}
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		assert.equal(policy.decide('pnpm', ['exec', 'tsc', '--noEmit'], 'apps/web').allowed, true);
	} finally { await loaded.cleanup(); }
});


test('exact toolchain information probes are available without a detected project and preserve delegation and permissions', async () => {
	for (const delegate of [false, true]) {
		const policy = createCommandPolicy({ subprojects: [], delegate, extras: [] });
		for (const command of ['node', 'node.exe', 'npm', 'pnpm', 'npx', 'yarn', 'bun', 'go', 'cargo', 'dotnet', 'python', 'pip', 'uv', 'composer', 'git']) {
			for (const flag of ['--version', '-v', '-V', '--help', '-h']) {
				assert.deepEqual(policy.decide(command, [flag], '.'), { allowed: true, executable: command, cwd: '.', delegate });
			}
		}
		for (const [command, args] of [
			['node', ['--version', '--eval=1']], ['pnpm', ['--version', 'exec', 'sh']], ['npx', ['--help', 'curl']],
			['C:/node/node.exe', ['--version']], ['curl', ['--help']], ['gh', ['--version', 'x']], ['bash', ['--version']]
		] as Array<[string, string[]]>) { assert.equal(policy.decide(command, args, '.').allowed, false); }
	}
	const plain = createCommandPolicy({ subprojects: [], delegate: false, extras: [] });
	for (const [command, args] of [['unlisted-tool', ['--version']], ['pnpm', ['--version=anything']], ['pnpm', ['--version --help']]] as Array<[string, string[]]>) {
		assert.equal(plain.decide(command, args, '.').allowed, false);
	}
	const loaded = await permissionsFor('readonly', { project: { version: 1, deny: ['run:pnpm --version'] } });
	try {
		for (const delegate of [false, true]) {
			const policy = createCommandPolicy({ subprojects: [], delegate, extras: [], permissions: loaded.set });
			assert.equal(policy.decide('node', ['--version'], '.').allowed, true);
			assert.deepEqual(policy.decide('pnpm', ['--version'], '.'), { allowed: false, reason: 'not-allowed' });
		}
	} finally { await loaded.cleanup(); }
});

test('provider version probes preserve delegation and permission rules without allowing nested agents', async () => {
	const deniedArgs = [[], ['--help'], ['-h'], ['-v'], ['-V'], ['--version=1'], ['--version', '--help'], ['--version', '-p', 'prompt'],
	['exec', 'prompt'], ['-p', 'prompt'], ['login'], ['auth', 'login'], ['config'], ['--dangerously-skip-permissions'], ['--sandbox', 'danger-full-access']];
	const trusted = await permissionsFor('trusted', { user: { version: 1, allow: ['run:*'] } });
	const readonly = await permissionsFor('readonly', { project: { version: 1, deny: ['run:claude --version'], ask: ['run:codex --version'] } });
	try {
		for (const delegate of [false, true]) {
			const policy = createCommandPolicy({ subprojects: [], delegate, extras: ['claude', 'codex'], permissions: trusted.set });
			for (const command of ['claude', 'claude.exe', 'codex', 'codex.exe']) {
				assert.deepEqual(policy.decide(command, ['--version'], '.'), { allowed: true, executable: command, cwd: '.', delegate });
				assert.deepEqual(deniedArgs.map(args => policy.decide(command, args, '.')), deniedArgs.map(() => ({ allowed: false, reason: 'not-allowed' })));
			}
			const restricted = createCommandPolicy({ subprojects: [], delegate, extras: [], permissions: readonly.set });
			assert.deepEqual(restricted.decide('claude', ['--version'], '.'), { allowed: false, reason: 'not-allowed' });
			assert.deepEqual(restricted.decide('codex', ['--version'], '.'), {
				allowed: false, reason: 'needs-approval', rule: 'run:codex --version', executable: 'codex', cwd: '.', delegate
			});
			assert.deepEqual(policy.decide('claude', ['--version', ';'], '.'), { allowed: false, reason: 'shell-operator' });
			assert.deepEqual(policy.decide('C:/tools/codex.exe', ['--version'], '.'), { allowed: false, reason: 'invalid' });
			assert.deepEqual(policy.decide('pnpm', ['exec', 'claude', '-p', 'prompt'], '.'), { allowed: false, reason: 'not-allowed' });
		}
	} finally { await trusted.cleanup(); await readonly.cleanup(); }
});


test('external CLIs ask the user, read-only gh runs directly, credentials never, and only a rule naming the CLI pre-approves it', async () => {
	const loaded = await permissionsFor('dev', { user: { version: 1, allow: ['run:*', 'run:aws sts get-caller-identity'] } });
	try {
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const plain = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [] });
		const verdict = (target: typeof policy, command: string, ...args: string[]) => { const decision = target.decide(command, args, '.'); return decision.allowed ? 'allowed' : decision.reason; };
		assert.deepEqual({
			ghRead: [['pr', 'checks', '12'], ['run', 'view', '99', '--log-failed'], ['issue', 'list', '--state', 'open'], ['pr', 'view', '--web']].map(args => verdict(policy, 'gh', ...args)),
			asks: [['aws', 's3', 'ls'], ['gh', 'pr', 'merge', '12'], ['gh', 'api', 'repos/o/r'], ['kubectl', 'get', 'pods'], ['docker', 'build', '.'], ['curl', 'https://example.test'], ['terraform', 'plan']]
				.map(([command, ...args]) => verdict(policy, command, ...args)),
			remembered: verdict(policy, 'aws', 'sts', 'get-caller-identity'),
			credentials: [['aws', 'configure', 'export-credentials'], ['aws', '--profile', 'prod', 'sts', 'get-session-token'], ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', 'x'],
			['aws', 'ssm', 'get-parameter', '--name', 'x', '--with-decryption'], ['gh', 'auth', 'token'], ['az', 'account', 'get-access-token'], ['gcloud', 'auth', 'print-access-token'],
			['docker', 'login'], ['heroku', 'auth:token'], ['kubectl', 'config', 'view', '--raw'], ['vercel', 'login']].map(([command, ...args]) => verdict(policy, command, ...args)),
			hidden: [verdict(policy, 'pnpm', 'exec', 'aws', 's3', 'ls'), verdict(policy, '/usr/bin/aws', 's3', 'ls')],
			noChannel: [verdict(plain, 'aws', 's3', 'ls'), verdict(plain, 'gh', 'pr', 'checks'), verdict(plain, 'gh', '--version')],
			describe: policy.describe().some(line => line.includes('aws'))
		}, {
			ghRead: ['allowed', 'allowed', 'allowed', 'needs-approval'],
			asks: Array(7).fill('needs-approval'),
			remembered: 'allowed',
			credentials: Array(11).fill('credential-access'),
			hidden: ['not-allowed', 'invalid'],
			noChannel: ['external-cli', 'allowed', 'allowed'],
			describe: true
		});
		const readonly = await permissionsFor('readonly');
		try {
			const strict = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: readonly.set });
			assert.deepEqual([verdict(strict, 'aws', 's3', 'ls'), verdict(strict, 'gh', 'pr', 'checks')], ['external-cli', 'not-allowed']);
		} finally { await readonly.cleanup(); }
	} finally { await loaded.cleanup(); }
});


test('a shell may run one project script file with approval; inline code asks once; interactive shells, encoded code and outside scripts stay denied', async () => {
	const loaded = await permissionsFor('dev', { user: { version: 1, allow: ['run:powershell -NoProfile -File scripts/approved.ps1'] } });
	try {
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const plain = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [] });
		const verdict = (target: typeof policy, line: string) => { const [command, ...args] = line.split(' '); const decision = target.decide(command, args, '.'); return decision.allowed ? 'allowed' : decision.reason; };
		assert.deepEqual({
			asks: ['powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1', 'pwsh -File scripts\\setup.ps1 -Verbose', 'bash scripts/setup.sh --dry-run', 'sh tools/build.sh'].map(line => verdict(policy, line)),
			remembered: verdict(policy, 'powershell -NoProfile -File scripts/approved.ps1'),
			shells: ['powershell -Command Get-ChildItem', 'powershell -EncodedCommand ZQBjAGgAbwA=', 'pwsh', 'bash -c ls', 'bash', 'powershell -File ../outside.ps1', 'powershell -File C:/x.ps1',
				'bash /etc/x.sh', 'powershell -File scripts/setup.bat', 'powershell -ExecutionPolicy Unrestricted -File scripts/setup.ps1', 'cmd /c scripts\\setup.cmd'].map(line => verdict(policy, line)),
			ghStatus: [verdict(policy, 'gh auth status'), verdict(policy, 'gh auth status --show-token'), verdict(policy, 'gh auth status -t'), verdict(policy, 'gh auth token')],
			noChannel: verdict(plain, 'bash scripts/setup.sh')
		}, {
			asks: Array(4).fill('needs-approval'),
			remembered: 'allowed',
			// `-Command`, `-c` and `cmd /c` carry code the card shows whole; `-EncodedCommand` hides it, so it stays a shell.
			shells: ['needs-approval', 'shell-operator', 'shell-operator', 'needs-approval', ...Array(6).fill('shell-operator'), 'needs-approval'],
			ghStatus: ['allowed', 'credential-access', 'credential-access', 'credential-access'],
			noChannel: 'script-file'
		});
		assert.match(denialText('script-file'), /^POLICY_DENIED: script-file\nNext: /);
	} finally { await loaded.cleanup(); }
});

test('package-manager workspace flags are judged on their subcommand and folder; unknown forms ask, or go to the project Harness', async () => {
	const loaded = await permissionsFor('dev');
	try {
		const ide = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const project = createCommandPolicy({ subprojects: [], delegate: true, extras: [], permissions: loaded.set });
		const noChannel = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [] });
		const verdict = (target: typeof ide, command: string, ...args: string[]) => { const decision = target.decide(command, args, '.'); return decision.allowed ? 'allowed' : decision.reason; };
		assert.deepEqual({
			ide: [['--dir', 'apps/web', 'lint'], ['-C', 'apps/web', 'test'], ['--dir=apps/web', 'lint'], ['--filter', 'web', 'lint'], ['--dir', 'apps/web', 'add', 'left-pad'],
			['--dir', '../outside', 'lint'], ['-g', 'add', 'x'], ['--weird-flag', 'lint'], ['--weird', 'exec', 'sh', '-c', 'x'], ['--dir', 'apps/web', 'publish']].map(args => verdict(ide, 'pnpm', ...args)),
			uvHidden: verdict(ide, 'uv', '--project', '.', 'run', 'python', '-c', 'x'),
			project: [['--weird-flag', 'lint'], ['--dir', 'apps/backoffice', 'lint'], ['--weird', 'exec', 'sh', '-c', 'x']].map(args => verdict(project, 'pnpm', ...args)),
			noChannel: verdict(noChannel, 'pnpm', '--weird-flag', 'lint')
		}, {
			// Inline code behind a launcher is never asked: the card would show the launcher, not the code it runs.
			ide: ['allowed', 'allowed', 'allowed', 'needs-approval', 'needs-approval', 'cwd-outside-project', 'global-config', 'needs-approval', 'inline-code', 'publish'],
			uvHidden: 'inline-code',
			project: ['allowed', 'allowed', 'inline-code'],
			noChannel: 'unusual-form'
		});
	} finally { await loaded.cleanup(); }
});

test('npx cannot download and run an unknown package without a question; the project tools and --no-install still run', () => {
	const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [] });
	const decide = (args: string[]) => { const decision = policy.decide('npx', args, 'apps/web'); return decision.allowed ? 'allowed' : decision.reason; };
	assert.deepEqual([decide(['cowsay']), decide(['left-pad', 'x']), decide(['prettier', '--check', '.']), decide(['tsc', '--noEmit']), decide(['--no-install', 'cowsay'])],
		['dependency-change', 'dependency-change', 'allowed', 'allowed', 'allowed']);
});

test('read-only git forms and shell readers run without a question, only inside the project and never on credential files', async () => {
	const loaded = await permissionsFor('dev');
	try {
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const verdict = (line: string) => { const [command, ...args] = line.split(' '); const decision = policy.decide(command, args, '.'); return decision.allowed ? 'allowed' : decision.reason; };
		assert.deepEqual({
			gitReads: ['git branch -a', 'git branch --show-current', 'git branch --list feat/x', 'git tag -l', 'git tag', 'git remote -v', 'git stash list', 'git worktree list', 'git reflog -n 5',
				'git config --get user.name', 'git config user.email', 'git rev-list --count HEAD', 'git for-each-ref refs/heads', 'git --no-pager log -1'].map(verdict),
			gitChanges: ['git branch feat/x', 'git branch -D main', 'git tag v1', 'git tag -d v1', 'git remote add x y', 'git stash', 'git stash pop', 'git worktree add ../x', 'git reflog expire',
				'git config user.name x', 'git config --get remote.origin.url', 'git config --list', 'git --no-pager push'].map(verdict),
			readers: ['ls -la src', 'cat package.json', 'head -n 20 README.md', 'grep -rn TODO src', 'grep -A 3 /api/users src', 'find . -name *.ts', 'wc -l a.ts', 'echo /etc/passwd', 'diff a.ts b.ts', 'cat .env.example'].map(verdict),
			refused: ['cat .env', 'cat apps/web/.env.local', 'cat ../outside.txt', 'cat C:/Windows/win.ini', 'grep -r token .aws', 'ls .git', 'rg secret /etc', 'find . -delete', 'find . -exec rm {} ;',
				'sort -o out.txt a.txt', 'uniq a.txt b.txt'].map(verdict)
		}, {
			gitReads: Array(14).fill('allowed'),
			gitChanges: Array(13).fill('git-mutation'),
			readers: Array(10).fill('allowed'),
			refused: ['credential-access', 'credential-access', 'path-outside-project', 'path-outside-project', 'credential-access', 'credential-access', 'path-outside-project', 'destructive', 'shell-operator',
				'destructive', 'destructive']
		});
		const readonly = await permissionsFor('readonly');
		try {
			const strict = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: readonly.set });
			assert.deepEqual(['cat', 'grep', 'find'].map(command => strict.decide(command, ['src'], '.').allowed), [true, true, true]);
		} finally { await readonly.cleanup(); }
	} finally { await loaded.cleanup(); }
});

test('a program file asks like a shell script; test runners, modules and dependency tools still run; inline code asks once unless it is hazardous', async () => {
	const loaded = await permissionsFor('dev');
	const readonly = await permissionsFor('readonly');
	try {
		const policy = createCommandPolicy({ subprojects: [...monorepo, { path: '.', ecosystem: 'node', packageManager: 'pnpm', scripts: [] }, { path: '.', ecosystem: 'python' }, { path: '.', ecosystem: 'php' }], delegate: false, extras: [], permissions: loaded.set });
		const strict = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: readonly.set });
		const decide = (target: typeof policy, command: string, ...args: string[]) => target.decide(command, args, '.');
		const reason = (target: typeof policy, command: string, ...args: string[]) => { const decision = decide(target, command, ...args); return decision.allowed ? 'allowed' : decision.reason; };
		const inline = decide(policy, 'node', '-e', 'console.log(1)');
		assert.deepEqual({
			programs: [reason(policy, 'node', 'scripts/build.mjs'), reason(policy, 'python', 'tools/gen.py'), reason(policy, 'node', '../outside.js'), reason(policy, 'node', '--test', 'test/a.test.mts'),
				reason(policy, 'python', '-m', 'pytest'), reason(policy, 'php', 'vendor/bin/phpunit', '--version')],
			inline: [inline.allowed === false && inline.reason === 'needs-approval' && inline.rule, reason(strict, 'node', '-e', '1'), reason(createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [] }), 'node', '-e', '1')],
			hazards: [reason(policy, 'node', '-e', 'require("fs").rmSync("x")'), reason(policy, 'python', '-c', 'open(".env").read()'), reason(policy, 'powershell', '-Command', 'Invoke-WebRequest x'),
				reason(policy, 'bash', '-c', 'sudo ls'), reason(policy, 'bash', '-c', 'npm publish'), reason(policy, 'bash', '-c', 'sleep 9 &'), reason(policy, 'node', '-e', 'console.log(process.env.PATH)')]
		}, {
			programs: ['needs-approval', 'needs-approval', 'path-outside-project', 'allowed', 'allowed', 'allowed'],
			inline: ['', 'inline-code', 'inline-code'],
			hazards: ['destructive', 'credential-access', 'network', 'privilege', 'publish', 'shell-operator', 'needs-approval']
		});
	} finally { await loaded.cleanup(); await readonly.cleanup(); }
});
