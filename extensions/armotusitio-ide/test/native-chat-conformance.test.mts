/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Chat conformance (r7): the flows that blocked a real task, replayed through the real ats-runner stdio process the way a
 * provider drives it (a scripted agent sends tool calls; a scripted user answers the approval cards through the
 * authenticated channel). Permissions are read from real files under a throwaway HOME, git runs against real repositories
 * (the GitHub origin is rewritten to a local bare repository) and project Harness delegation runs a real child process.
 *
 * S1 subfolder commands with a delegated Harness (plus a read-only live check against RedEvent when it exists),
 * S2 branch from origin with a dirty tree + commit with an ignored file + push, refusing once and continuing,
 * S3 external CLIs, S4 dependency installs, S5 a project without Harness, S6 denial and recovery in one run,
 * S7 "always in this project" across a restart and its revocation, S8 a missing Node found by the doctor,
 * plus multiple workspaces and recovery. `npm run check:conformance` runs this file with the unit suites it relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RunnerConfig } from '../src/ats-runner.ts';
import { parseApprovalDraft, type ApprovalDraft } from '../src/native-approval.ts';
import { createCommandPolicy, denialText } from '../src/native-command-policy.ts';
import { runCommand } from '../src/native-command-runner.ts';
import { repoFingerprint } from '../src/native-git-tools.ts';
import { runDoctor } from '../src/native-machine-doctor.ts';
import { addUserRule, loadPermissions, projectKey, removeUserRule } from '../src/native-permissions.ts';
import type { ApprovalAnswer } from '../src/native-permissions-types.ts';
import { projectPermissionsDigest } from '../src/native-run-integrity.ts';
import { resolveNodeRuntime } from '../src/native-runtime.ts';
import { openToolChannel } from '../src/native-tool-server.ts';
import { startRunner, type RunnerProcess } from './native-runner-process.mts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const ORIGIN = 'https://github.com/Drako01/conformance.git';
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
/** Prints the folder the command really ran in, so the tests see where the runner put it. */
const WHERE = 'console.log("CWD " + process.cwd());\n';
/**
 * A project Harness shaped like RedEvent's: its root is the process directory (`ROOT = cwd`) and `--cwd` is resolved
 * against it. It reports what it would run instead of running it, so no package manager is needed.
 */
const DELEGATE = [
	'import * as fs from "node:fs"; import * as path from "node:path";',
	'const args = process.argv.slice(2); const cwd = args[args.indexOf("--cwd") + 1]; const command = args.slice(args.indexOf("--") + 1);',
	'if (args[0] !== "ide-run" || (cwd !== "." && !fs.statSync(path.join(process.cwd(), cwd), { throwIfNoEntry: false })?.isDirectory())) { console.error("Carpeta inv\\u00e1lida para --cwd: " + cwd); process.exit(2); }',
	'console.log("HARNESS_RAN " + JSON.stringify({ cwd, command }));'
].join('\n');

interface Project {
	root: string; base: string; home: string;
	/** Every card the scripted user saw, already validated the way the extension validates it. */
	asked: ApprovalDraft[];
	/** The scripted user: answers each card; `deny` by default. */
	answer: (card: ApprovalDraft) => ApprovalAnswer;
	runner(overrides?: Partial<RunnerConfig>): Promise<RunnerProcess>;
}

/** One throwaway project: git repo with a GitHub-shaped origin backed by a bare repo, `apps/web`, a HOME and a channel. */
async function withProject(work: (project: Project) => Promise<void>, name = 'work'): Promise<void> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-conformance-')));
	const root = path.join(base, name), home = path.join(base, 'home'), bare = path.join(base, 'origin.git');
	await fs.mkdir(path.join(root, 'apps', 'web'), { recursive: true });
	await fs.mkdir(home);
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
	execFileSync('git', ['init', '-q', '-b', 'main', root]);
	git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
	git(root, 'remote', 'add', 'origin', ORIGIN);
	// The repository identity stays GitHub's; the transport goes to the local bare repository.
	git(root, 'config', 'url.' + bare.replace(/\\/g, '/') + '.insteadOf', ORIGIN);
	await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
	await fs.writeFile(path.join(root, 'where.js'), WHERE);
	await fs.writeFile(path.join(root, 'apps', 'web', 'where.js'), WHERE);
	await fs.writeFile(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { lint: 'echo lint' } }));
	await fs.writeFile(path.join(root, '.gitignore'), 'notes/\n');
	git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
	git(root, 'push', '-q', 'origin', 'main:main', 'main:qa');
	await fs.writeFile(path.join(root, 'other.txt'), 'main only\n');
	git(root, 'add', 'other.txt'); git(root, 'commit', '-qm', 'main only');
	const asked: ApprovalDraft[] = [];
	const project: Project = { root, base, home, asked, answer: () => 'deny', runner: undefined! };
	const channel = await openToolChannel(path.join(base, 'channel'), async (method, params) => {
		if (method !== 'approval') { throw Error('UNEXPECTED_CHANNEL_CALL'); }
		const card = parseApprovalDraft(params, root);
		if (!card) { return 'deny'; }
		asked.push(card);
		return project.answer(card);
	});
	const runners: RunnerProcess[] = [];
	// HOME/USERPROFILE point the runner's permission loading at the throwaway user file.
	const env = { ...process.env, ...IDENTITY, HOME: home, USERPROFILE: home };
	let started = 0;
	project.runner = async (overrides = {}) => {
		const config: RunnerConfig = {
			schemaVersion: 1, root, env, logDirectory: path.join(base, 'logs'), git: true, files: true, permissions: { preset: 'dev' },
			policy: { subprojects: [{ path: 'apps/web', ecosystem: 'node', packageManager: 'pnpm', scripts: ['lint'] }], delegate: false, extras: [] },
			repoBaseline: await repoFingerprint(root), projectPermissionsBaseline: await projectPermissionsDigest(root),
			channel: { address: channel.address, token: channel.token }, ...overrides
		};
		const runner = await startRunner(config, path.join(base, 'runner-' + (++started) + '.json'), { cwd: root, env });
		runners.push(runner);
		return runner;
	};
	try { await work(project); } finally {
		for (const runner of runners) { await runner.close(); }
		await channel.close();
		await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

const cwdOf = (text: string): string | undefined => /CWD (?<cwd>.+)/.exec(text)?.groups?.cwd.trim();
const harnessRan = (text: string): unknown => { const match = /HARNESS_RAN (?<json>\{.*\})/.exec(text); return match?.groups ? JSON.parse(match.groups.json) : text; };

test('S1: with a delegated project Harness, subfolder commands and unusual forms reach it from the project root; the floor still applies', async () => {
	await withProject(async ({ root, asked, runner }) => {
		await fs.mkdir(path.join(root, '.harness'));
		await fs.writeFile(path.join(root, '.harness', 'bootstrap.mjs'), DELEGATE);
		const agent = await runner({ policy: { subprojects: [], delegate: true, extras: [] }, delegateEntry: path.join(root, '.harness', 'bootstrap.mjs') });
		const results = [
			await agent.call('run', { command: 'pnpm', args: ['run', 'lint'], cwd: 'apps/web' }),
			await agent.call('run', { command: 'pnpm', args: ['--workspace-concurrency', '1', 'lint'], cwd: 'apps/web' }),
			await agent.call('run', { command: 'pnpm', args: ['--dir', '../elsewhere', 'lint'] }),
			await agent.call('run', { command: 'node', args: ['-e', '1'] })
		];
		assert.deepEqual({ ran: results.slice(0, 2).map(result => [result.isError, harnessRan(result.text)]), floor: results.slice(2).map(result => result.text), asked: asked.length }, {
			ran: [[false, { cwd: 'apps/web', command: ['pnpm', 'run', 'lint'] }], [false, { cwd: 'apps/web', command: ['pnpm', '--workspace-concurrency', '1', 'lint'] }]],
			floor: [denialText('cwd-outside-project'), denialText('inline-code')], asked: 0
		});
	});
});

const REDEVENT = process.env.ATS_REDEVENT_ROOT ?? 'F:\\redevent';
const REDEVENT_ENTRY = path.join(REDEVENT, '.harness', 'bootstrap.mjs');

test('S1 live: the real RedEvent Harness runs a read-only command in apps/backoffice and its files stay untouched', { skip: !existsSync(REDEVENT_ENTRY) && 'RedEvent is not on this machine' }, async () => {
	const root = await fs.realpath(REDEVENT);
	const harnessStatus = () => git(root, 'status', '--porcelain', '--', '.harness');
	const before = harnessStatus();
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-conformance-redevent-'));
	try {
		const result = await runCommand({ root, cwd: 'apps/backoffice', command: 'pnpm', args: ['--version'], env: process.env, logDirectory: logs, delegateEntry: REDEVENT_ENTRY, timeoutSec: 120 });
		assert.deepEqual({ exit: result.exitCode, version: /^\d+\.\d+\.\d+/m.test(result.output), invalidCwd: result.output.includes('--cwd'), harness: harnessStatus() }, { exit: 0, version: true, invalidCwd: false, harness: before });
	} finally { await fs.rm(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('S2: fetch, branch from origin with a dirty tree, commit skipping an ignored file and push; a refused branch does not stop the rest', async () => {
	await withProject(async project => {
		const { root, asked } = project;
		project.answer = card => card.detail.some(line => line.includes('feat/refused')) ? 'deny' : 'once';
		const agent = await project.runner();
		await fs.writeFile(path.join(root, 'README.md'), 'dirty edit\n');
		const fetched = await agent.call('git_fetch', { remote: 'origin', branch: 'qa' });
		const refused = await agent.call('git_branch_create', { branch: 'feat/refused', from: 'origin/qa' });
		const branch = await agent.call('git_branch_create', { branch: 'feat/s2', from: 'origin/qa' });
		await fs.mkdir(path.join(root, 'notes'));
		await fs.writeFile(path.join(root, 'notes', 'spec.md'), 'private\n');
		const commit = await agent.call('git_commit', { paths: ['README.md', 'notes/spec.md'], message: 'fix: readme' });
		const pushed = await agent.call('git_push', {});
		const bare = path.join(project.base, 'origin.git');
		assert.deepEqual({
			fetched: fetched.text.split('\n')[0], refused: refused.text, branch: branch.text.split(/\s/)[0], commit: [commit.text.split(/\s/)[0], /SKIPPED \(ignored[^\n]*notes\/spec\.md/.test(commit.text)],
			pushed: pushed.text.split('\n')[0], remote: git(bare, 'rev-parse', 'refs/heads/feat/s2') === git(root, 'rev-parse', 'HEAD'),
			files: git(root, 'show', '--name-only', '--format=', 'HEAD'), base: git(root, 'rev-parse', 'HEAD~1') === git(bare, 'rev-parse', 'refs/heads/qa'), cards: asked.map(card => card.kind)
		}, {
			fetched: 'FETCHED origin/qa', refused: 'DENIED: the user did not allow it', branch: 'BRANCH_CREATED', commit: ['COMMITTED', true],
			pushed: 'PUSHED feat/s2 to origin', remote: true, files: 'README.md', base: true, cards: ['git_branch_create', 'git_branch_create', 'git_commit', 'git_push']
		});
	});
});

test('S3: read-only gh runs directly, other external CLIs ask, and credentials stay denied even with a blanket allow rule', async () => {
	await withProject(async ({ root, home, asked, runner }) => {
		await addUserRule('run:*', 'allow', home);
		const policy = createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions: await loadPermissions(root, home) });
		const agent = await runner();
		const results = [
			await agent.call('run', { command: 'aws', args: ['s3', 'ls'] }),
			await agent.call('run', { command: 'docker', args: ['ps'] }),
			await agent.call('run', { command: 'gh', args: ['auth', 'token'] }),
			await agent.call('run', { command: 'aws', args: ['configure', 'list'] })
		];
		assert.deepEqual({ ghRead: policy.decide('gh', ['pr', 'list'], '.').allowed, results: results.map(result => result.text), cards: asked.map(card => card.detail[0]) }, {
			ghRead: true,
			results: ['DENIED: the user did not allow it', 'DENIED: the user did not allow it', denialText('credential-access'), denialText('credential-access')],
			cards: ['command: aws s3 ls', 'command: docker ps']
		});
	});
});

test('S4: installing a dependency is a card that can only be allowed once, and a refusal installs nothing', async () => {
	await withProject(async ({ root, asked, runner }) => {
		const agent = await runner();
		const result = await agent.call('run', { command: 'pnpm', args: ['add', 'left-pad'], cwd: 'apps/web' });
		assert.deepEqual({ text: result.text, card: asked.map(card => [card.detail[0], card.rule, card.noRemember]), installed: existsSync(path.join(root, 'apps', 'web', 'node_modules')) }, {
			text: 'DENIED: the user did not allow it', card: [['command: pnpm add left-pad', '', 'dependency']], installed: false
		});
	});
});

test('S5: without a project Harness the IDE runs in the subfolder, safe package-manager flags pass and other forms ask', async () => {
	await withProject(async ({ root, home, asked, runner }) => {
		const policy = createCommandPolicy({ subprojects: [{ path: 'apps/web', ecosystem: 'node', packageManager: 'pnpm', scripts: ['lint'] }], delegate: false, extras: [], permissions: await loadPermissions(root, home) });
		const agent = await runner({ policy: { subprojects: [{ path: 'apps/web', ecosystem: 'node', packageManager: 'pnpm', scripts: ['lint'] }], delegate: false, extras: [] } });
		const where = await agent.call('run', { command: 'node', args: ['where.js'], cwd: 'apps/web' });
		const unusual = await agent.call('run', { command: 'pnpm', args: ['--workspace-concurrency', '1', 'lint'], cwd: 'apps/web' });
		assert.deepEqual({
			where: [where.isError, cwdOf(where.text) && await fs.realpath(cwdOf(where.text)!)],
			safeFlags: [policy.decide('pnpm', ['--dir', 'apps/web', 'run', 'lint'], '.'), policy.decide('pnpm', ['--filter', 'web', 'lint'], 'apps/web')].map(decision => decision.allowed),
			unusual: unusual.text, cards: asked.map(card => card.detail[0])
		}, {
			where: [false, path.join(root, 'apps', 'web')], safeFlags: [true, true],
			unusual: 'DENIED: the user did not allow it', cards: ['command: pnpm --workspace-concurrency 1 lint']
		});
	});
});

test('S6: a refused call is answered from memory for that exact call only, and the run keeps working', async () => {
	await withProject(async ({ asked, runner }) => {
		const agent = await runner({ policy: { subprojects: [], delegate: false, extras: ['node'] } });
		const refused = await agent.call('run', { command: 'docker', args: ['ps'] });
		const repeated = await agent.call('run', { command: 'docker', args: ['ps'] });
		const other = await agent.call('run', { command: 'docker', args: ['images'] });
		const after = await agent.call('run', { command: 'node', args: ['where.js'] });
		assert.deepEqual({ texts: [refused.text, repeated.text, other.text], after: after.isError, cards: asked.map(card => card.detail[0]) }, {
			texts: ['DENIED: the user did not allow it', 'DENIED: the user already refused this exact action in this run. Do something else or report it.', 'DENIED: the user did not allow it'],
			after: false, cards: ['command: docker ps', 'command: docker images']
		});
	});
});

test('S7: "always in this project" survives a restart, does not apply to another project and is revocable', async () => {
	await withProject(async project => {
		const { root, home, asked } = project;
		const plain = { policy: { subprojects: [], delegate: false, extras: [] } };
		project.answer = () => 'always';
		const first = await (await project.runner(plain)).call('run', { command: 'node', args: ['where.js'] });
		// What the extension does with an "always" answer: the rule goes to the project's section of the user file.
		await addUserRule(asked[0].rule, 'allow', home, root);
		project.answer = () => 'deny';
		const restarted = await (await project.runner(plain)).call('run', { command: 'node', args: ['where.js'] });
		const otherProject = createCommandPolicy({ ...plain.policy, permissions: await loadPermissions(path.join(project.base, 'elsewhere'), home) }).decide('node', ['where.js'], '.');
		await removeUserRule(asked[0].rule, home, projectKey(root));
		const revoked = await (await project.runner(plain)).call('run', { command: 'node', args: ['where.js'] });
		assert.deepEqual({ first: first.isError, rule: asked[0].rule, restarted: restarted.isError, otherProject: otherProject.allowed === false && otherProject.reason, revoked: revoked.text, cards: asked.length }, {
			first: false, rule: 'run:node where.js', restarted: false, otherProject: 'needs-approval', revoked: 'DENIED: the user did not allow it', cards: 2
		});
	});
});

test('S8: a machine with only the editor\'s embedded Node is a doctor problem with its fix', async () => {
	const host = { execPath: process.execPath, electron: true };
	const checks = await runDoctor({ exec: async () => ({ code: 1, output: '' }), platform: process.platform, projectRoot: os.tmpdir(), node: () => resolveNodeRuntime({ PATH: '' }, host) });
	const node = checks.find(check => check.id === 'node');
	assert.deepEqual({ status: node?.status, fix: /atsHarness\.nodeExecutable/.test(node?.action ?? '') }, { status: 'problem', fix: true });
});

test('multiple workspaces: each runner works on its own repository', async () => {
	await withProject(async first => {
		await withProject(async second => {
			const plain = { policy: { subprojects: [], delegate: false, extras: ['node'] } };
			const [a, b] = [await first.runner(plain), await second.runner(plain)];
			const whereA = cwdOf((await a.call('run', { command: 'node', args: ['where.js'] })).text);
			first.answer = second.answer = () => 'once';
			await b.call('git_branch_create', { branch: 'feat/only-b' });
			assert.deepEqual({
				a: whereA && await fs.realpath(whereA), b: cwdOf((await b.call('run', { command: 'node', args: ['where.js'] })).text),
				branches: [git(first.root, 'branch', '--show-current'), git(second.root, 'branch', '--show-current')]
			}, { a: first.root, b: second.root, branches: ['main', 'feat/only-b'] });
		}, 'second');
	}, 'first');
});

test('native transport pilot: approve is served only when enabled, asks through the card and remembers a refusal', async () => {
	await withProject(async ({ asked, runner }) => {
		const structured = await runner();
		const native = await runner({ approve: true, policy: { subprojects: [], delegate: false, extras: ['node'] } });
		const prompt = async (tool_name: string, input: object) => JSON.parse((await native.call('approve', { tool_name, input, tool_use_id: 't' })).text) as { behavior: string; message?: string };
		const results = [
			await prompt('Bash', { command: 'node where.js' }), await prompt('Bash', { command: 'docker ps' }), await prompt('Bash', { command: 'docker ps' }),
			await prompt('Bash', { command: 'node a.js && node b.js' }), await prompt('Write', { file_path: '.armotusitio/permissions.json', content: '{}' })
		];
		assert.deepEqual({
			listed: [(await structured.rpc('tools/list')).tools?.some(tool => tool.name === 'approve'), (await native.rpc('tools/list')).tools?.some(tool => tool.name === 'approve')],
			results: results.map(result => result.behavior === 'allow' ? 'allow' : result.message!.split('\n', 1)[0]), cards: asked.map(card => card.detail[0])
		}, {
			listed: [false, true],
			results: ['allow', 'DENIED: the user did not allow it', 'DENIED: the user already refused this exact action in this run. Do something else or report it.', 'POLICY_DENIED: shell-operator', 'POLICY_DENIED: protected-path'],
			cards: ['command: docker ps']
		});
	});
});

test('recovery: unavailable tools and executables say so, and retrying a finished step does not repeat it', async () => {
	await withProject(async project => {
		project.answer = () => 'once';
		const noGit = await project.runner({ git: false });
		const missing = await noGit.call('run', { command: 'definitely-not-a-tool-r7', args: [] });
		const agent = await project.runner();
		const created = await agent.call('git_branch_create', { branch: 'feat/retry' });
		const retried = await agent.call('git_branch_create', { branch: 'feat/retry' });
		assert.deepEqual({
			unknownTool: [(await noGit.rpc('tools/list')).tools?.some(tool => tool.name === 'git_commit'), await noGit.call('git_commit', { paths: ['README.md'], message: 'm' }).then(() => 'served', (error: Error) => /Method not found/.test(error.message))], missing: [missing.isError, /could not start|not found|ENOENT|HARNESS_EXECUTABLE_UNAVAILABLE/i.test(missing.text)],
			created: created.text.split(/\s/)[0], retried: retried.text.split(/\s/)[0], branches: git(project.root, 'branch', '--list', 'feat/retry').trim()
		}, { unknownTool: [false, true], missing: [true, true], created: 'BRANCH_CREATED', retried: 'BRANCH_REUSED', branches: '* feat/retry' });
	});
});
