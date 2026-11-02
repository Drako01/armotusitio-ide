/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleGit, handleRun, type RunnerConfig } from '../src/ats-runner.ts';
import { channelApprover, parseApprovalDraft, requestApproval, type ApprovalDraft } from '../src/native-approval.ts';
import { openToolChannel } from '../src/native-tool-server.ts';
import type { PermissionSet } from '../src/native-permissions.ts';
import type { ApprovalAnswer, PermissionDecision } from '../src/native-permissions-types.ts';
import { projectPermissionsDigest } from '../src/native-run-integrity.ts';

const permissionsOf = (decision: PermissionDecision): PermissionSet => ({ preset: 'dev', warnings: [], describe: () => [], decide: () => ({ decision, source: 'user' }) });

async function withProject(work: (input: { root: string; logs: string; config: RunnerConfig }) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approval-')));
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approval-logs-'));
	try {
		const env = { ...process.env };
		await work({ root, logs, config: { schemaVersion: 1, root, env, logDirectory: logs, policy: { subprojects: [], delegate: false, extras: ['node'] }, permissions: {}, git: true } });
	} finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(logs, { recursive: true, force: true }); }
}

test('a run that needs approval waits for the user: approved runs, denied and unanswered do not', async () => {
	await withProject(async ({ root, config }) => {
		await fs.writeFile(path.join(root, 'touch.js'), 'require("fs").writeFileSync("ran.txt", "yes");');
		const asked: ApprovalDraft[] = [];
		const ran = () => fs.access(path.join(root, 'ran.txt')).then(() => true, () => false);
		const answer = (reply: ApprovalAnswer | Error) => async (request: ApprovalDraft) => { asked.push(request); if (reply instanceof Error) { throw reply; } return reply; };
		const input = { command: 'node', args: ['touch.js'] };
		const denied = await handleRun(config, input, 1, { permissions: permissionsOf('ask'), ask: answer('deny') });
		const timeout = await handleRun(config, input, 2, { permissions: permissionsOf('ask'), ask: answer(Error('HARNESS_TIMEOUT')) });
		const noUi = await handleRun(config, input, 3, { permissions: permissionsOf('ask') });
		const before = await ran();
		const approved = await handleRun(config, input, 4, { permissions: permissionsOf('ask'), ask: answer('once') });
		assert.deepEqual({
			denied, timeout: timeout.text, noUi: noUi.text, before, approved: [approved.isError, approved.text.startsWith('exit 0')], after: await ran(),
			card: { ...asked[0], rule: asked[0].rule }, asks: asked.length
		}, {
			denied: { isError: true, text: 'DENIED: the user did not allow it' }, timeout: 'DENIED: the user did not answer in time', noUi: 'DENIED: this run has no way to ask the user', before: false,
			approved: [false, true], after: true, card: { kind: 'run', title: 'Run command', detail: ['command: node touch.js', 'cwd: .'], rule: asked[0].rule, command: 'node', args: ['touch.js'], cwd: '.' }, asks: 3
		});
		assert.match(asked[0].rule, /^run:node/);
	});
});

test('allow runs without asking and deny never asks, and the floor still wins over an allow', async () => {
	await withProject(async ({ config }) => {
		const ask = async (): Promise<ApprovalAnswer> => { throw Error('must not ask'); };
		const allowed = await handleRun(config, { command: 'node', args: ['--version'] }, 1, { permissions: permissionsOf('allow'), ask });
		const denied = await handleRun(config, { command: 'node', args: ['--version'] }, 2, { permissions: permissionsOf('deny'), ask });
		const floor = await handleRun(config, { command: 'git', args: ['push'] }, 3, { permissions: permissionsOf('allow'), ask });
		assert.deepEqual({ allowed: allowed.text.startsWith('exit 0'), denied, floor }, {
			allowed: true, denied: { isError: true, text: 'POLICY_DENIED: not-allowed' }, floor: { isError: true, text: 'POLICY_DENIED: git-mutation' }
		});
	});
});

test('the git tools are served only when the run is configured for them, and go through the same approval', async () => {
	await withProject(async ({ root, config }) => {
		execFileSync('git', ['init', '-q', '-b', 'feat/x', root]);
		execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
		execFileSync('git', ['-C', root, 'config', 'user.email', 'f@example.test']);
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
		const asked: ApprovalDraft[] = [];
		const ask = async (request: ApprovalDraft): Promise<ApprovalAnswer> => { asked.push(request); return asked.length === 1 ? 'deny' : 'once'; };
		const off = await handleGit({ ...config, git: false }, 'git_commit', { paths: ['a.txt'], message: 'm' }, { permissions: permissionsOf('allow') });
		const denied = await handleGit(config, 'git_commit', { paths: ['a.txt'], message: 'm' }, { permissions: permissionsOf('ask'), ask });
		const done = await handleGit(config, 'git_commit', { paths: ['a.txt'], message: 'add a' }, { permissions: permissionsOf('ask'), ask });
		const audit = (await fs.readFile(path.join(config.logDirectory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual({
			off, denied: denied.text, done: [done.isError, done.text.startsWith('COMMITTED ')], kinds: asked.map(card => card.kind),
			subject: execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), audit: audit.map(entry => [entry.tool, entry.isError])
		}, { off: { isError: true, text: 'Unknown tool' }, denied: 'DENIED: the user did not allow it', done: [false, true], kinds: ['git_commit', 'git_commit'], subject: 'add a', audit: [['git_commit', true], ['git_commit', true], ['git_commit', false]].slice(1) });
	});
});

test('the channel carries the approval to the extension and anything but an explicit answer is a denial', async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approval-channel-'));
	const seen: unknown[] = [];
	let reply: unknown = 'always';
	const channel = await openToolChannel(storage, async (method, params) => {
		if (method !== 'approval') { throw Error('HARNESS_TOOL'); }
		seen.push(params);
		return reply;
	});
	try {
		const ask = channelApprover(channel);
		const card: ApprovalDraft = { kind: 'git_push', title: 'Push', detail: ['branch: x'], rule: 'git_push' };
		const answers = [await ask(card)];
		reply = 'once'; answers.push(await ask(card));
		reply = 'yes please'; answers.push(await ask(card));
		reply = undefined; answers.push(await ask(card));
		const wrongToken = await requestApproval(channelApprover({ address: channel.address, token: 'wrong' }), card);
		assert.deepEqual({ answers, seen: seen.length, wrongToken }, { answers: ['always', 'once', 'deny', 'deny'], seen: 4, wrongToken: 'DENIED: the approval could not be requested' });
	} finally { await channel.close(); await fs.rm(storage, { recursive: true, force: true }); }
});

test('the extension accepts only well-formed approval cards from the runner process', () => {
	const good = { kind: 'run', title: 't', detail: ['a'], rule: 'run:node*', command: 'node', args: ['test.js'], cwd: '.' };
	assert.deepEqual([
		parseApprovalDraft(good), parseApprovalDraft({ ...good, kind: 'delete' }), parseApprovalDraft({ ...good, detail: 'a' }), parseApprovalDraft({ ...good, detail: Array(13).fill('x') }),
		parseApprovalDraft({ ...good, detail: [1] }), parseApprovalDraft(null), parseApprovalDraft({ ...good, title: 'x'.repeat(500) })?.title.length
	], [{ kind: 'run', title: 't', detail: ['command: node test.js', 'cwd: .'], rule: 'run:node test.js' }, undefined, undefined, undefined, undefined, undefined, 200]);
});

test('project permissions cannot be removed or rewritten before or during approval', async () => {
	await withProject(async ({ root, config }) => {
		const directory = path.join(root, '.armotusitio');
		await fs.mkdir(directory);
		const file = path.join(directory, 'permissions.json');
		await fs.writeFile(file, '{"version":1,"deny":["run:node *"]}');
		const baseline = await projectPermissionsDigest(root);
		const guarded = { ...config, projectPermissionsBaseline: baseline };
		await fs.rm(file);
		assert.equal((await handleRun(guarded, { command: 'node', args: ['--version'] }, 1, { permissions: permissionsOf('allow') })).text, 'POLICY_DENIED: project-permissions-changed');
		assert.equal((await handleGit(guarded, 'git_push', {}, { permissions: permissionsOf('allow') })).text, 'POLICY_DENIED: project-permissions-changed');
		await fs.writeFile(file, '{"version":1,"deny":["run:node *"]}');
		const result = await handleRun(guarded, { command: 'node', args: ['--version'] }, 2, { permissions: permissionsOf('ask'), ask: async () => { await fs.rm(file); return 'once'; } });
		assert.equal(result.text, 'POLICY_DENIED: project-permissions-changed');
	});
});

test('approval rules derive from the shown command, and malformed answers fail closed', async () => {
	assert.equal(parseApprovalDraft({ kind: 'run', title: 'Run', command: 'node', args: ['safe.js'], detail: ['fake'], rule: 'run:*' })?.rule, 'run:node safe.js');
	assert.equal(parseApprovalDraft({ kind: 'git_push', title: 'Push', detail: [], rule: 'git_push' })?.rule, '');
	const card: ApprovalDraft = { kind: 'git_push', title: 'Push', detail: [], rule: '' };
	assert.equal(await requestApproval(async () => 'always', card), 'DENIED: the user did not allow it');
});
