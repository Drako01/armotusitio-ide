/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCommandPolicy } from '../src/native-command-policy.ts';
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
