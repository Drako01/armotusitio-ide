/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Offline delivery tests. No real GitHub requests, tokens or Actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GIT_TOOLS, endsGitDelivery, handleGitTool, repoFingerprint, type GitToolsContext } from '../src/native-git-tools.ts';
import { parseApprovalDraft, type ApprovalDraft } from '../src/native-approval.ts';
import { projectPermissionsDigest } from '../src/native-run-integrity.ts';
import { openToolChannel } from '../src/native-tool-server.ts';
import { startRunner } from './native-runner-process.mts';
import type { RunnerConfig } from '../src/ats-runner.ts';
import type { PermissionDecision } from '../src/native-permissions-types.ts';

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const outcome = (output: string) => ({ exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, output, truncated: false, logFile: 'fixture.log' });

async function fixture(work: (state: {
	root: string;
	base: string;
	context: GitToolsContext;
	asked: ApprovalDraft[];
	set: (decision: PermissionDecision, answer?: 'once' | 'deny') => void;
}) => Promise<void>): Promise<void> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-pr-delivery-')));
	const root = path.join(base, 'work');
	try {
		await fs.mkdir(root);
		execFileSync('git', ['init', '-q', '-b', 'main', root]);
		git(root, 'config', 'user.name', 'Fixture');
		git(root, 'config', 'user.email', 'fixture@example.test');
		git(root, 'remote', 'add', 'origin', 'https://github.com/Drako01/redevent.git');
		await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
		git(root, 'add', 'README.md');
		git(root, 'commit', '-qm', 'seed');
		git(root, 'switch', '-qc', 'feat/work');
		let decision: PermissionDecision = 'ask', answer: 'once' | 'deny' = 'once';
		const asked: ApprovalDraft[] = [];
		const context: GitToolsContext = {
			root,
			env: {
				...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
				GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test'
			},
			logDirectory: path.join(base, 'logs'),
			repoBaseline: await repoFingerprint(root),
			permissions: { decide: () => ({ decision, source: 'user' }) },
			ask: async draft => { asked.push(draft); return answer; },
			checkPermissions: async () => true
		};
		await work({ root, base, context, asked, set: (next, reply = 'once') => { decision = next; answer = reply; } });
	} finally { await fs.rm(base, { recursive: true, force: true }); }
}

test('branch creation is structured, idempotent, preserves dirty work and renews only its trusted baseline', async () => {
	await fixture(async ({ root, context, asked }) => {
		const initial = git(root, 'rev-parse', 'HEAD');
		await fs.writeFile(path.join(root, 'README.md'), 'uncommitted change\n');
		await fs.writeFile(path.join(root, 'local-note.txt'), 'do not discard\n');
		const result = await handleGitTool(context, 'git_branch_create', { branch: 'feat/new' });
		assert.equal(result.isError, false);
		assert.match(result.text, /^BRANCH_CREATED feat\/new/);
		assert.equal(git(root, 'branch', '--show-current'), 'feat/new');
		assert.equal(git(root, 'rev-parse', 'HEAD'), initial);
		assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'uncommitted change\n');
		assert.equal(await fs.readFile(path.join(root, 'local-note.txt'), 'utf8'), 'do not discard\n');
		assert.equal(result.repoBaseline, await repoFingerprint(root));
		context.repoBaseline = result.repoBaseline;
		const reused = await handleGitTool(context, 'git_branch_create', { branch: 'feat/new' });
		assert.match(reused.text, /^BRANCH_REUSED/);
		assert.equal(asked.length, 2);
		assert.equal(asked[0].kind, 'git_branch_create');
		assert.deepEqual([asked[0].repo, asked[0].branch, asked[0].from], ['Drako01/redevent', 'feat/new', 'HEAD']);
	});
});

test('the local project base is explicit: dirty cross-base checkout, protected refs and worktree branches are refused', async () => {
	await fixture(async ({ root, base, context, asked }) => {
		const seed = git(root, 'rev-parse', 'HEAD');
		await fs.writeFile(path.join(root, 'README.md'), 'second\n');
		git(root, 'add', 'README.md'); git(root, 'commit', '-qm', 'second');
		git(root, 'update-ref', 'refs/remotes/origin/qa', seed);
		// The base changes README.md, which also has a local edit: switching would mix them, so it is refused.
		await fs.writeFile(path.join(root, 'README.md'), 'local edit\n');
		const before = git(root, 'status', '--porcelain');
		const crossed = await handleGitTool(context, 'git_branch_create', { branch: 'feat/from-qa', from: 'origin/qa' });
		assert.deepEqual([crossed.text, endsGitDelivery(crossed.text)], ['POLICY_DENIED: local-changes-on-base-switch\nFiles changed both locally and in origin/qa: README.md', false]);
		assert.equal((await handleGitTool(context, 'git_branch_create', { branch: 'main' })).text, 'POLICY_DENIED: protected-branch');
		assert.match((await handleGitTool(context, 'git_branch_create', { branch: '../escape' })).text, /^POLICY_DENIED:/);
		assert.equal(git(root, 'status', '--porcelain'), before);
		git(root, 'checkout', '--', 'README.md');
		const linked = path.join(base, 'other-worktree');
		git(root, 'worktree', 'add', '-qb', 'feat/occupied', linked, 'main');
		assert.match((await handleGitTool(context, 'git_branch_create', { branch: 'feat/occupied' })).text, /^git switch failed/);
		assert.equal(git(root, 'branch', '--show-current'), 'feat/work');
		const branch = await handleGitTool(context, 'git_branch_create', { branch: 'feat/from-qa', from: 'origin/qa' });
		assert.equal(branch.isError, false);
		assert.equal(git(root, 'rev-parse', 'HEAD'), seed);
		assert.equal(asked.length, 2);
	});
});

test('local changes travel to a new branch when the base does not touch them; commit skips ignored files; fetch is validated', async () => {
	await fixture(async ({ root, base, context }) => {
		const seed = git(root, 'rev-parse', 'HEAD');
		await fs.writeFile(path.join(root, 'other.txt'), 'base\n');
		git(root, 'add', 'other.txt'); git(root, 'commit', '-qm', 'other');
		git(root, 'update-ref', 'refs/remotes/origin/qa', seed);
		await fs.writeFile(path.join(root, 'README.md'), 'local edit\n');
		const branch = await handleGitTool(context, 'git_branch_create', { branch: 'feat/carry', from: 'origin/qa' });
		await fs.writeFile(path.join(root, '.gitignore'), 'spec.md\n');
		await fs.writeFile(path.join(root, 'spec.md'), 'private\n');
		const ignoredOnly = await handleGitTool(context, 'git_commit', { paths: ['spec.md'], message: 'docs: spec' });
		const committed = await handleGitTool(context, 'git_commit', { paths: ['README.md', 'spec.md'], message: 'fix: readme' });
		const remote = path.join(base, 'remote.git');
		execFileSync('git', ['clone', '-q', '--bare', root, remote]);
		git(root, 'remote', 'add', 'mirror', remote);
		context.repoBaseline = await repoFingerprint(root); // The user, not the agent, added the remote.
		const fetched = await handleGitTool(context, 'git_fetch', { remote: 'mirror', branch: 'feat/carry' });
		const unknown = await handleGitTool(context, 'git_fetch', { remote: 'nowhere' });
		assert.deepEqual({
			branch: [branch.isError, git(root, 'branch', '--show-current'), git(root, 'rev-parse', 'HEAD~1') === seed],
			ignoredOnly: ignoredOnly.text, committed: [committed.isError, /SKIPPED \(ignored[^\n]*spec\.md/.test(committed.text), git(root, 'show', '--name-only', '--format=', 'HEAD')],
			fetched: [fetched.isError, fetched.text.split('\n')[0], git(root, 'rev-parse', 'refs/remotes/mirror/feat/carry') === git(root, 'rev-parse', 'HEAD')],
			unknown: unknown.isError
		}, {
			branch: [false, 'feat/carry', true],
			ignoredOnly: 'POLICY_DENIED: all-paths-ignored', committed: [false, true, 'README.md'],
			fetched: [false, 'FETCHED mirror/feat/carry', true],
			unknown: true
		});
	});
});

test('a clean checkout resumes an existing local delivery branch without force or a duplicate', async () => {
	await fixture(async ({ root, context }) => {
		git(root, 'branch', 'feat/existing', 'main');
		const reused = await handleGitTool(context, 'git_branch_create', { branch: 'feat/existing' });
		assert.equal(reused.isError, false);
		assert.match(reused.text, /^BRANCH_REUSED feat\/existing/);
		assert.equal(git(root, 'branch', '--show-current'), 'feat/existing');
		assert.equal(reused.repoBaseline, await repoFingerprint(root));
	});
});

test('cancellation fails closed before a branch or PR command can execute', async () => {
	await fixture(async ({ root, context }) => {
		const stopped = new AbortController();
		stopped.abort();
		const cancelled = { ...context, signal: stopped.signal };
		const before = git(root, 'branch', '--show-current');
		assert.equal((await handleGitTool(cancelled, 'git_branch_create', { branch: 'feat/cancelled' })).text, 'POLICY_DENIED: cancelled');
		assert.equal(git(root, 'branch', '--show-current'), before);
		let calls = 0;
		cancelled.ghRunner = async () => { calls++; return outcome('[]'); };
		assert.equal((await handleGitTool(cancelled, 'git_pr_upsert', { base: 'qa', title: 'Title', body: 'Body' })).text, 'POLICY_DENIED: cancelled');
		assert.equal(calls, 0);
	});
});

test('delivery permissions refuse denial without trying a different route', async () => {
	await fixture(async ({ root, context, asked, set }) => {
		set('deny');
		assert.match((await handleGitTool(context, 'git_branch_create', { branch: 'feat/no' })).text, /^POLICY_DENIED:/);
		set('ask', 'deny');
		assert.equal((await handleGitTool(context, 'git_branch_create', { branch: 'feat/no' })).text, 'DENIED: the user did not allow it');
		assert.equal((await handleGitTool({ ...context, ask: undefined }, 'git_branch_create', { branch: 'feat/no' })).text, 'DENIED: this run has no way to ask the user');
		assert.equal(git(root, 'branch', '--show-current'), 'feat/work');
		assert.equal(asked.length, 1);
	});
});

test('PR delivery creates, reuses and updates exactly one real-shaped GitHub PR without an issue or merge', async () => {
	await fixture(async ({ root, context, asked }) => {
		type Pr = { number: number; headRefName: string; baseRefName: string; state: string; title: string; body: string; url: string; headRepositoryOwner: { login: string }; headRepository: { name: string } };
		let pr: Pr | undefined;
		const commands: string[][] = [];
		context.ghRunner = async args => {
			commands.push(args);
			if (args[1] === 'list') { return outcome(JSON.stringify(pr ? [pr] : [])); }
			const flag = (name: string) => args[args.indexOf(name) + 1];
			if (args[1] === 'create') {
				pr = {
					number: 42, headRefName: 'feat/work', baseRefName: flag('--base'), state: 'OPEN',
					title: flag('--title'), body: flag('--body'), url: 'https://github.com/Drako01/redevent/pull/42',
					headRepositoryOwner: { login: 'Drako01' }, headRepository: { name: 'redevent' }
				};
				return outcome(pr.url);
			}
			if (args[1] === 'edit' && pr) {
				pr = { ...pr, title: flag('--title'), body: flag('--body') };
				return outcome(pr.url);
			}
			throw Error('UNEXPECTED_GH_COMMAND');
		};
		const requested = { base: 'qa', title: 'fix: delivery', body: 'Summary\n- behavior preserved' };
		const created = await handleGitTool(context, 'git_pr_upsert', requested);
		assert.equal(created.text, 'PR_CREATED https://github.com/Drako01/redevent/pull/42 (feat/work -> qa)');
		assert.deepEqual([asked[0].kind, asked[0].repo, asked[0].branch, asked[0].base, asked[0].prTitle, asked[0].prBody],
			['git_pr_upsert', 'Drako01/redevent', 'feat/work', 'qa', requested.title, requested.body]);
		assert.equal(parseApprovalDraft(asked[0])?.rule, '');
		const reused = await handleGitTool(context, 'git_pr_upsert', requested);
		assert.match(reused.text, /^PR_REUSED/);
		const changed = await handleGitTool(context, 'git_pr_upsert', { ...requested, body: 'Updated summary' });
		assert.match(changed.text, /^PR_UPDATED/);
		assert.equal(pr?.body, 'Updated summary');
		assert.equal(asked.length, 2);
		assert.deepEqual(commands.filter(args => ['create', 'edit'].includes(args[1])).map(args => args[1]), ['create', 'edit']);
		assert.ok(commands.every(args => !args.includes('--admin') && !args.includes('--force') && !args.includes('--no-verify')));
		assert.equal(git(root, 'branch', '--show-current'), 'feat/work');
	});
});

test('PR base is per project, and closed/other-base PRs or denied approvals cannot be rewritten', async () => {
	await fixture(async ({ root, context, set }) => {
		git(root, 'remote', 'set-url', 'origin', 'https://github.com/Drako01/armotusitio2.0.git');
		context.repoBaseline = await repoFingerprint(root);
		const existing = {
			number: 9, headRefName: 'feat/work', baseRefName: 'main', state: 'OPEN',
			title: 'Prior', body: 'Prior body', url: 'https://github.com/Drako01/armotusitio2.0/pull/9',
			headRepositoryOwner: { login: 'Drako01' }, headRepository: { name: 'armotusitio2.0' }
		};
		let mutations = 0;
		context.ghRunner = async args => {
			if (args[1] === 'list') { return outcome(JSON.stringify([existing])); }
			mutations++; return outcome('not authorized');
		};
		const draft = { base: 'qa', title: 'New', body: 'Details' };
		assert.equal((await handleGitTool(context, 'git_pr_upsert', draft)).text, 'POLICY_DENIED: existing-pr-other-base');
		set('ask', 'deny');
		assert.equal((await handleGitTool(context, 'git_pr_upsert', { ...draft, base: 'main' })).text, 'DENIED: the user did not allow it');
		existing.state = 'MERGED';
		assert.equal((await handleGitTool(context, 'git_pr_upsert', { ...draft, base: 'main' })).text, 'POLICY_DENIED: closed-pr-exists');
		assert.equal(mutations, 0);
	});
});

test('the actual ats-runner stdio MCP process exposes and carries branch/commit tools with authenticated channel approval', async () => {
	await fixture(async ({ root, base, context }) => {
		const channel = await openToolChannel(path.join(base, 'channel'), async (method, params) => {
			if (method !== 'approval') { throw Error('UNEXPECTED_CHANNEL_CALL'); }
			// The user refuses only the branch named feat/refused, so the final user-denial latch can be observed.
			const draft = parseApprovalDraft(params);
			return draft && !draft.detail.some(line => line.includes('feat/refused')) ? 'once' : 'deny';
		});
		const logs = path.join(base, 'runner-logs');
		const config: RunnerConfig = {
			schemaVersion: 1, root, policy: { subprojects: [], delegate: false, extras: [] },
			env: context.env, logDirectory: logs, git: true, files: true, permissions: { preset: 'dev' },
			repoBaseline: await repoFingerprint(root), projectPermissionsBaseline: await projectPermissionsDigest(root),
			channel: { address: channel.address, token: channel.token }
		};
		const runner = await startRunner(config, path.join(base, 'runner.json'), { cwd: root });
		const rpc = runner.rpc;
		try {
			assert.equal(runner.serverName, 'ats-runner');
			const listed = await rpc('tools/list');
			assert.deepEqual(GIT_TOOLS.map(tool => tool.name).every(name => listed.tools?.some(tool => tool.name === name)), true);
			const branch = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'feat/delivered' } });
			assert.equal(branch.isError, false, JSON.stringify(branch));
			assert.match(branch.content?.[0]?.text ?? '', /^BRANCH_CREATED/);
			await fs.writeFile(path.join(root, 'transport.txt'), 'transport\n');
			const committed = await rpc('tools/call', { name: 'git_commit', arguments: { paths: ['transport.txt'], message: 'test: transport' } });
			assert.equal(committed.isError, false, JSON.stringify(committed));
			assert.match(committed.content?.[0]?.text ?? '', /^COMMITTED/);
			assert.equal(git(root, 'branch', '--show-current'), 'feat/delivered');
			assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), 'transport.txt');
			const audit = (await fs.readFile(path.join(logs, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			assert.deepEqual(audit.map(entry => [entry.tool, entry.isError]), [['git_branch_create', false], ['git_commit', false]]);
			const denied = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'main' } });
			assert.equal(denied.content?.[0]?.text, 'POLICY_DENIED: protected-branch');
			// A protected-branch refusal is about the agent's input: it recovers by choosing a feature branch.
			const recovered = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'feat/alternate' } });
			assert.match(recovered.content?.[0]?.text ?? '', /^BRANCH_CREATED/);
			assert.equal(listed.tools?.some(tool => tool.name === 'delete_path') && listed.tools?.some(tool => tool.name === 'move_path'), true);
			const moved = await rpc('tools/call', { name: 'move_path', arguments: { from: 'transport.txt', to: 'moved/transport.txt' } });
			const deleted = await rpc('tools/call', { name: 'delete_path', arguments: { path: 'moved' } });
			const refused = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'feat/refused' } });
			// The refusal covers that exact call only: asking the same again is answered from memory, another branch is asked normally.
			const repeated = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'feat/refused' } });
			const other = await rpc('tools/call', { name: 'git_branch_create', arguments: { branch: 'feat/other' } });
			assert.deepEqual([moved, deleted, refused, repeated].map(result => result.content?.[0]?.text),
				['MOVED transport.txt -> moved/transport.txt', 'DELETED moved (2 entries)', 'DENIED: the user did not allow it', 'DENIED: the user already refused this exact action in this run. Do something else or report it.']);
			assert.match(other.content?.[0]?.text ?? '', /^BRANCH_CREATED feat\/other/);
			assert.equal(git(root, 'branch', '--show-current'), 'feat/other');
		} finally {
			await runner.close();
			await channel.close();
		}
	});
});
