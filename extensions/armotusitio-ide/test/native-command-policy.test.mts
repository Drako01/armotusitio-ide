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
import { createCommandPolicy } from '../src/native-command-policy.ts';
import { loadPermissions, type PermissionSet } from '../src/native-permissions.ts';
import type { PermissionPreset } from '../src/native-permissions-types.ts';
import { detectEcosystems } from '../src/native-ecosystems.ts';
import { runCommand } from '../src/native-command-runner.ts';
import { handleRun, type RunnerConfig } from '../src/ats-runner.ts';

const monorepo = [{ path: 'apps/api', ecosystem: 'go' as const }, { path: 'apps/web', ecosystem: 'node' as const, packageManager: 'pnpm' as const, scripts: ['test', 'lint'] }];

test('the IDE floor rejects what no preset, project or user extra can allow', () => {
	const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: ['rm', 'curl', 'make test'] });
	const project = createCommandPolicy({ subprojects: [], delegate: true, extras: [] });
	const reasons = (target: typeof policy) => ([
		['git', ['push']], ['git', ['commit', '-m', 'x']], ['git', ['config', '--global', 'user.name', 'x']], ['npm', ['publish']], ['pnpm', ['add', 'left-pad']],
		['npm', ['install', 'left-pad']], ['go', ['get', 'example.com/x']], ['go', ['env', '-w', 'GOPROXY=x']], ['curl', ['https://x']], ['rm', ['-rf', '.']],
		['node', ['-e', 'process.exit()']], ['python', ['-c', 'print(1)']], ['bash', ['-c', 'ls']], ['go', ['test', '&&', 'rm']], ['sudo', ['go']], ['docker', ['compose', 'up']],
		['gh', ['pr', 'create']], ['python', ['-m', 'pip', 'install', 'x']], ['npx', ['-y', 'cowsay']]
	] as Array<[string, string[]]>).map(([command, args]) => target.decide(command, args, 'apps/api')).map(decision => decision.allowed ? 'allowed' : decision.reason);
	const expected = ['git-mutation', 'git-mutation', 'global-config', 'publish', 'dependency-change', 'dependency-change', 'dependency-change', 'global-config', 'network', 'destructive',
		'inline-code', 'inline-code', 'shell-operator', 'shell-operator', 'privilege', 'publish', 'publish', 'dependency-change', 'dependency-change'];
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
	} finally { await fs.rm(root, { recursive: true, force: true }); }
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
		const ran = await handleRun(config, { command: 'node', args: ['print.js'], cwd: 'apps/web' }, 9);
		const audit = (await fs.readFile(path.join(logs, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual({ denied, ranExit: ran.text.startsWith('exit 3'), budget: /about 1 turns left/.test(ran.text), audit: audit.map(entry => entry.denied ?? entry.exitCode) },
			{ denied: { isError: true, text: 'POLICY_DENIED: git-mutation' }, ranExit: true, budget: true, audit: ['git-mutation', 3] });
	} finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(logs, { recursive: true, force: true }); }
});

async function permissionsFor(preset: PermissionPreset, files: { user?: unknown; project?: unknown } = {}): Promise<{ set: PermissionSet; cleanup: () => Promise<void> }> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-policy-permissions-')));
	for (const [folder, content] of [['home', files.user], ['project', files.project]] as const) {
		if (content !== undefined) {
			await fs.mkdir(path.join(base, folder, '.armotusitio'), { recursive: true });
			await fs.writeFile(path.join(base, folder, '.armotusitio', 'permissions.json'), JSON.stringify(content));
		}
	}
	return { set: await loadPermissions(path.join(base, 'project'), path.join(base, 'home'), undefined, { preset }), cleanup: () => fs.rm(base, { recursive: true, force: true }) };
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
		floorStays: await answer('trusted', 'pnpm', ['publish']), floorShell: await answer('trusted', 'bash', ['-c', 'ls']), floorGlobal: await answer('trusted', 'pnpm', ['add', '-g', 'x'])
	}, {
		none: 'dependency-change', dev: 'needs-approval', trusted: 'needs-approval', projectAllow: 'needs-approval', userAllowAdd: 'allowed', readonly: 'dependency-change', notListed: 'needs-approval', userAllow: 'allowed', projectAsk: 'needs-approval',
		corruptFile: 'dependency-change', floorStays: 'publish', floorShell: 'shell-operator', floorGlobal: 'global-config'
	});
});

test('a permission ask is a denial for consumers that only read allowed, and carries the rule and the resolved command', async () => {
	const loaded = await permissionsFor('dev', { project: { version: 1, ask: ['run:go test*'], deny: ['run:go vet*'] }, user: { version: 1, allow: ['run:go vet*'] } });
	try {
		const policy = createCommandPolicy({ subprojects: monorepo, delegate: false, extras: [], permissions: loaded.set });
		const asked = policy.decide('go.exe', ['test', './...'], 'apps/api\\');
		assert.deepEqual({ asked, denied: policy.decide('go', ['vet'], 'apps/api'), outside: policy.decide('go', ['build'], 'apps/web'), allowed: policy.decide('go', ['build'], 'apps/api').allowed },
			{ asked: { allowed: false, reason: 'needs-approval', rule: 'run:go test ./...', executable: 'go.exe', cwd: 'apps/api', delegate: false }, denied: { allowed: false, reason: 'not-allowed' }, outside: { allowed: false, reason: 'not-allowed' }, allowed: true });
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
			['C:/node/node.exe', ['--version']], ['curl', ['--help']], ['gh', ['--version']], ['bash', ['--version']]
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
