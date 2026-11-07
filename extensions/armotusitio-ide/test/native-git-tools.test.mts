/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { endsGitDelivery, GIT_TOOLS, handleGitTool, isSensitiveGitPath, repoFingerprint, type GitToolsContext } from '../src/native-git-tools.ts';
import type { ApprovalAnswer, PermissionDecision, PermissionRequest } from '../src/native-permissions-types.ts';
import type { ApprovalDraft } from '../src/native-approval.ts';

const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface Fixture { root: string; remote: string; context: GitToolsContext; asked: ApprovalDraft[]; requests: PermissionRequest[]; set(decision: PermissionDecision, answer?: ApprovalAnswer): void }

/** A real repository on `feat/work` with a bare `origin`; `set` chooses what the fake permissions answer. */
async function withRepo(work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-git-tools-')));
	const root = path.join(base, 'work'), remote = path.join(base, 'origin.git');
	try {
		await fs.mkdir(root);
		execFileSync('git', ['init', '-q', '-b', 'feat/work', root]);
		execFileSync('git', ['init', '-q', '--bare', remote]);
		git(root, 'remote', 'add', 'origin', remote);
		await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
		git(root, 'add', 'README.md');
		git(root, 'commit', '-qm', 'seed');
		let decision: PermissionDecision = 'allow', answer: ApprovalAnswer = 'once';
		const asked: ApprovalDraft[] = [], requests: PermissionRequest[] = [];
		const context: GitToolsContext = {
			root, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test' },
			logDirectory: path.join(base, 'logs'),
			permissions: { decide: request => { requests.push(request); return { decision, source: 'preset' }; } },
			ask: async request => { asked.push(request); return answer; }
		};
		await work({ root, remote, context, asked, requests, set: (next, reply = 'once') => { decision = next; answer = reply; } });
	} finally { await fs.rm(base, { recursive: true, force: true }); }
}

const head = (root: string): string => git(root, 'rev-parse', 'HEAD');

test('the tools are described to the model with their immovable rules', () => {
	const [commit, push] = GIT_TOOLS;
	assert.deepEqual({
		names: GIT_TOOLS.map(tool => tool.name), required: commit.inputSchema.required, noProps: Object.keys(push.inputSchema.properties),
		commitTold: /hooks always run/.test(commit.description) && /do not retry/.test(commit.description),
		pushTold: /never forces/i.test(push.description) && /main, master, develop, trunk/.test(push.description) && /do not retry/.test(push.description)
	}, { names: ['git_commit', 'git_push', 'git_branch_create', 'git_fetch', 'git_pr_upsert'], required: ['paths', 'message'], noProps: [], commitTold: true, pushTold: true });
});

test('sensitive paths are recognized wherever they sit', () => {
	const table: Array<[string, boolean]> = [
		['.env', true], ['apps/api/.env.production', true], ['id_rsa', true], ['certs/server.pem', true], ['k/private.KEY', true], ['.npmrc', true], ['.git/config', true],
		['pkg/.git/hooks/pre-commit', true], ['.armotusitio/permissions.json', true], ['.ssh/config', true], ['.git-credentials', true], ['.htpasswd', true], ['cert.jks', true], ['cert.keystore', true], ['terraform.tfstate', true], ['prod.tfvars', true], ['kubeconfig', true], ['src/environment.ts', false], ['docs/env.md', false], ['src/[id]/page.tsx', false]
	];
	assert.deepEqual(table.map(([file]) => isSensitiveGitPath(file)), table.map(([, expected]) => expected));
});

test('git_commit commits exactly the named files and leaves other staged work out', async () => {
	await withRepo(async ({ root, context, requests }) => {
		await fs.mkdir(path.join(root, 'src'));
		await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
		await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
		git(root, 'add', 'b.txt');
		const result = await handleGitTool(context, 'git_commit', { paths: ['src/a.ts', './src/a.ts'], message: '  feat: add a  ' });
		assert.deepEqual({
			error: result.isError, text: result.text.startsWith('COMMITTED '), subject: git(root, 'log', '-1', '--format=%s'), committed: git(root, 'show', '--name-only', '--format=', 'HEAD'),
			stillStaged: git(root, 'diff', '--cached', '--name-only'), asked: requests.map(request => [request.kind, (request as { branch: string }).branch, (request as { files: string[] }).files])
		}, { error: false, text: true, subject: 'feat: add a', committed: 'src/a.ts', stillStaged: 'b.txt', asked: [['git_commit', 'feat/work', ['src/a.ts']]] });
	});
});

test('git_commit also records the deletion of a tracked file', async () => {
	await withRepo(async ({ root, context }) => {
		await fs.rm(path.join(root, 'README.md'));
		const result = await handleGitTool(context, 'git_commit', { paths: ['README.md'], message: 'remove readme' });
		assert.deepEqual([result.isError, git(root, 'show', '--name-status', '--format=', 'HEAD')], [false, 'D\tREADME.md']);
	});
});

test('git_commit refuses paths and messages outside its floor and leaves the repository untouched', async () => {
	await withRepo(async ({ root, context, asked }) => {
		await fs.mkdir(path.join(root, 'src'));
		await fs.writeFile(path.join(root, 'src', 'ok.ts'), 'x\n');
		await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
		await fs.mkdir(path.join(root, 'cfg'));
		await fs.writeFile(path.join(root, 'cfg', '.env.local'), 'SECRET=2\n');
		await fs.writeFile(path.join(root, 'server.pem'), 'k\n');
		const before = head(root);
		const bad: Array<[string, unknown, unknown]> = [
			['parent', ['../outside.txt'], 'm'], ['nested parent', ['src/../../outside.txt'], 'm'], ['absolute', [path.join(root, 'src', 'ok.ts')], 'm'], ['posix absolute', ['/etc/passwd'], 'm'],
			['drive', ['C:\\x.txt'], 'm'], ['dot', ['.'], 'm'], ['directory', ['src'], 'm'], ['directory slash', ['src/'], 'm'], ['flag', ['-A'], 'm'], ['pathspec magic', [':(top)src/ok.ts'], 'm'],
			['env', ['.env'], 'm'], ['nested env', ['cfg/.env.local'], 'm'], ['key', ['server.pem'], 'm'], ['git dir', ['.git/config'], 'm'], ['missing', ['nope.txt'], 'm'], ['glob is literal', ['src/*.ts'], 'm'],
			['one bad among good', ['src/ok.ts', '.env'], 'm'], ['empty list', [], 'm'], ['not a list', 'src/ok.ts', 'm'], ['non string', [1], 'm'],
			['empty message', ['src/ok.ts'], '   '], ['nul message', ['src/ok.ts'], 'a\0b'], ['long message', ['src/ok.ts'], 'x'.repeat(2001)], ['message type', ['src/ok.ts'], 5]
		];
		const results = await Promise.all(bad.map(async ([, paths, message]) => (await handleGitTool(context, 'git_commit', { paths, message })).text));
		assert.deepEqual(results.map((text, index) => [bad[index][0], text.startsWith('POLICY_DENIED: ')]), bad.map(([label]) => [label, true]));
		assert.deepEqual({ head: head(root) === before, staged: git(root, 'diff', '--cached', '--name-only'), asked: asked.length }, { head: true, staged: '', asked: 0 });
		const edge = await handleGitTool(context, 'git_commit', { paths: ['src/ok.ts'], message: 'x'.repeat(2000) });
		assert.equal(edge.isError, false);
	});
});

test('git_commit refuses a symlink that leaves the project', { skip: process.platform === 'win32' && !process.env.ATS_TEST_SYMLINKS }, async () => {
	await withRepo(async ({ root, context }) => {
		const outside = path.join(path.dirname(root), 'outside.txt');
		await fs.writeFile(outside, 'x\n');
		await fs.symlink(outside, path.join(root, 'link.txt'));
		assert.match((await handleGitTool(context, 'git_commit', { paths: ['link.txt'], message: 'm' })).text, /^POLICY_DENIED: path-outside-project/);
	});
});

test('git_commit runs the repository hooks and reports a failing hook without bypassing it', async () => {
	await withRepo(async ({ root, context }) => {
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		const hook = path.join(root, '.git', 'hooks', 'pre-commit');
		await fs.writeFile(hook, '#!/bin/sh\necho "lint failed: no semicolons"\nexit 1\n', { mode: 0o755 });
		const before = head(root);
		const failed = await handleGitTool(context, 'git_commit', { paths: ['a.txt'], message: 'add a' });
		assert.deepEqual({ error: failed.isError, told: /git commit failed \(exit 1\)/.test(failed.text) && failed.text.includes('lint failed: no semicolons') && /do not bypass hooks/.test(failed.text), head: head(root) === before }, { error: true, told: true, head: true });
		await fs.writeFile(hook, '#!/bin/sh\necho ran > "$(git rev-parse --git-dir)/hook-ran"\nexit 0\n', { mode: 0o755 });
		const fixed = await handleGitTool(context, 'git_commit', { paths: ['a.txt'], message: 'add a' });
		assert.deepEqual({ error: fixed.isError, hook: (await fs.readFile(path.join(root, '.git', 'hook-ran'), 'utf8')).trim(), moved: head(root) !== before }, { error: false, hook: 'ran', moved: true });
	});
});

test('permissions decide git_commit: deny refuses, ask needs the user, allow runs', async () => {
	await withRepo(async ({ root, context, asked, set }) => {
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		const before = head(root);
		set('deny');
		const denied = await handleGitTool(context, 'git_commit', { paths: ['a.txt'], message: 'm' });
		set('ask', 'deny');
		const refused = await handleGitTool(context, 'git_commit', { paths: ['a.txt'], message: 'refuse me' });
		const noUi = await handleGitTool({ ...context, ask: undefined }, 'git_commit', { paths: ['a.txt'], message: 'm' });
		assert.deepEqual({ denied: denied.text.startsWith('POLICY_DENIED: '), refused: refused.text, noUi: noUi.text, unchanged: head(root) === before, card: asked.map(card => [card.kind, card.title, card.detail, card.rule]) }, {
			denied: true, refused: 'DENIED: the user did not allow it', noUi: 'DENIED: this run has no way to ask the user', unchanged: true,
			card: [['git_commit', 'Commit', ['branch: feat/work', 'files: a.txt', 'message: refuse me'], '']]
		});
		set('ask', 'once');
		assert.equal((await handleGitTool(context, 'git_commit', { paths: ['a.txt'], message: 'now' })).isError, false);
		assert.notEqual(head(root), before);
	});
});

test('an approval that cannot be requested is a denial', async () => {
	await withRepo(async ({ root, context, set }) => {
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		set('ask');
		const timeout = await handleGitTool({ ...context, ask: async () => { throw Error('HARNESS_TIMEOUT'); } }, 'git_commit', { paths: ['a.txt'], message: 'm' });
		const broken = await handleGitTool({ ...context, ask: async () => { throw Error('socket closed'); } }, 'git_commit', { paths: ['a.txt'], message: 'm' });
		assert.deepEqual([timeout.text, broken.text], ['DENIED: the user did not answer in time', 'DENIED: the approval could not be requested']);
	});
});

test('git_push never targets a protected or default branch', async () => {
	await withRepo(async ({ root, remote, context, asked }) => {
		for (const name of ['main', 'master', 'develop', 'trunk', 'Main']) {
			git(root, 'checkout', '-q', '-B', name);
			assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: protected-branch', name);
		}
		// The remote's own default branch is protected even when it has another name.
		git(root, 'checkout', '-q', '-B', 'release');
		git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');
		assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: protected-branch');
		git(root, 'checkout', '-q', '--detach');
		assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: no-current-branch');
		assert.deepEqual({ asked: asked.length, remoteRefs: git(remote, 'for-each-ref') }, { asked: 0, remoteRefs: '' });
	});
});

test('git_push pushes the current branch, sets the upstream once and never moves tags', async () => {
	await withRepo(async ({ root, remote, context, requests, set }) => {
		set('ask', 'once');
		git(root, 'tag', 'v1');
		const first = await handleGitTool(context, 'git_push', {});
		const upstream = git(root, 'config', '--get', 'branch.feat/work.remote') + ' ' + git(root, 'config', '--get', 'branch.feat/work.merge');
		await fs.writeFile(path.join(root, 'next.txt'), 'n\n');
		assert.equal((await handleGitTool(context, 'git_commit', { paths: ['next.txt'], message: 'next' })).isError, false);
		const second = await handleGitTool(context, 'git_push', {});
		assert.deepEqual({
			first: [first.isError, first.text.startsWith('PUSHED feat/work to origin')], second: second.isError, upstream, remoteHead: git(remote, 'rev-parse', 'refs/heads/feat/work') === head(root),
			tags: git(remote, 'tag', '--list'), requests: requests.filter(request => request.kind === 'git_push')
		}, {
			first: [false, true], second: false, upstream: 'origin refs/heads/feat/work', remoteHead: true, tags: '',
			requests: [{ kind: 'git_push', branch: 'feat/work', remote: 'origin' }, { kind: 'git_push', branch: 'feat/work', remote: 'origin' }]
		});
	});
});

test('git_push is never a force push and refuses an upstream with another name', async () => {
	await withRepo(async ({ root, remote, context, set }) => {
		assert.equal((await handleGitTool(context, 'git_push', {})).isError, false);
		const other = path.join(path.dirname(root), 'other');
		execFileSync('git', ['clone', '-q', '-b', 'feat/work', remote, other]);
		await fs.writeFile(path.join(other, 'theirs.txt'), 't\n');
		git(other, 'add', 'theirs.txt'); git(other, 'commit', '-qm', 'theirs'); git(other, 'push', '-q', 'origin', 'feat/work');
		const theirs = git(remote, 'rev-parse', 'refs/heads/feat/work');
		await fs.writeFile(path.join(root, 'mine.txt'), 'm\n');
		assert.equal((await handleGitTool(context, 'git_commit', { paths: ['mine.txt'], message: 'mine' })).isError, false);
		const diverged = await handleGitTool(context, 'git_push', {});
		assert.deepEqual({ failed: diverged.isError, told: /git push failed/.test(diverged.text) && /do not bypass/.test(diverged.text), remoteKept: git(remote, 'rev-parse', 'refs/heads/feat/work') === theirs }, { failed: true, told: true, remoteKept: true });
		git(root, 'config', 'branch.feat/work.merge', 'refs/heads/other');
		assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: upstream-mismatch');
		git(root, 'remote', 'remove', 'origin');
		set('allow');
		assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: no-remote');
	});
});

test('git_push honours deny and denied approvals without touching the remote', async () => {
	await withRepo(async ({ remote, context, set }) => {
		set('deny');
		const denied = await handleGitTool(context, 'git_push', {});
		set('ask', 'deny');
		const refused = await handleGitTool(context, 'git_push', {});
		assert.deepEqual([denied.text.startsWith('POLICY_DENIED: '), refused.text, git(remote, 'for-each-ref')], [true, 'DENIED: the user did not allow it', '']);
	});
});

test('unknown tools and malformed input are rejected', async () => {
	await withRepo(async ({ context }) => {
		assert.equal((await handleGitTool(context, 'git_reset', {})).text, 'Unknown tool');
		assert.match((await handleGitTool(context, 'git_commit', null)).text, /^POLICY_DENIED: invalid-paths/);
	});
});

test('git tools refuse modified hooks and config, including changes while approval is pending', async () => {
	await withRepo(async ({ root, context, set }) => {
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		const baseline = await repoFingerprint(root);
		const guarded = { ...context, repoBaseline: baseline };
		await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
		assert.equal((await handleGitTool(guarded, 'git_commit', { paths: ['a.txt'], message: 'm' })).text, 'POLICY_DENIED: repo-config-changed');
		await fs.rm(path.join(root, '.git', 'hooks', 'pre-commit'));
		set('ask');
		guarded.ask = async () => { git(root, 'config', 'core.hooksPath', '.githooks'); return 'once'; };
		assert.equal((await handleGitTool(guarded, 'git_commit', { paths: ['a.txt'], message: 'm' })).text, 'POLICY_DENIED: repo-config-changed');
		assert.equal(git(root, 'log', '-1', '--format=%s'), 'seed');
	});
});

test('tracked hook directories cannot be committed or executed with uncommitted changes', async () => {
	await withRepo(async ({ root, context }) => {
		git(root, 'config', 'core.hooksPath', '.githooks');
		await fs.mkdir(path.join(root, '.githooks'));
		await fs.writeFile(path.join(root, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		const guarded = { ...context, repoBaseline: await repoFingerprint(root) };
		assert.equal((await handleGitTool(guarded, 'git_commit', { paths: ['a.txt'], message: 'm' })).text, 'POLICY_DENIED: hooks-modified');
		assert.equal((await handleGitTool(guarded, 'git_commit', { paths: ['.githooks/pre-commit'], message: 'm' })).text, 'POLICY_DENIED: hooks-modified');
	});
});

test('push protects configured patterns and init.defaultBranch without a remote HEAD', async () => {
	await withRepo(async ({ root, context }) => {
		git(root, 'checkout', '-q', '-B', 'production');
		git(root, 'config', 'init.defaultBranch', 'production');
		assert.equal((await handleGitTool(context, 'git_push', {})).text, 'POLICY_DENIED: protected-branch');
		git(root, 'checkout', '-q', '-B', 'release/next');
		assert.equal((await handleGitTool({ ...context, protectedBranches: ['release/*'] }, 'git_push', {})).text, 'POLICY_DENIED: protected-branch');
	});
});

test('only integrity refusals end git delivery; a user denial covers its own call and input refusals can be corrected', () => {
	assert.deepEqual(['DENIED: the user did not allow it', 'POLICY_DENIED: repo-config-changed', 'POLICY_DENIED: hooks-modified', 'POLICY_DENIED: denied by permissions',
		'POLICY_DENIED: protected-branch', 'POLICY_DENIED: path-not-found', 'POLICY_DENIED: invalid-message', 'POLICY_DENIED: all-paths-ignored', 'COMMITTED abc on feat/x: 1 file(s)'].map(endsGitDelivery),
		[false, true, true, true, false, false, false, false, false]);
});
