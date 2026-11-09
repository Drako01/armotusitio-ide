/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Commands that ask questions: stopped when nobody can answer, answered in the IDE terminal when a person can. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun, parseTerminalRequest, type RunnerConfig } from '../src/ats-runner.ts';
import { pendingPrompt, runCommand, type CommandResult } from '../src/native-command-runner.ts';
import { openInteractiveTerminal, type PseudoTerminal, type TerminalApi } from '../src/native-terminal.ts';
import type { PermissionSet } from '../src/native-permissions.ts';
import type { ApprovalDraft } from '../src/native-approval.ts';
import type { PermissionDecision } from '../src/native-permissions-types.ts';

const permissionsOf = (decision: PermissionDecision): PermissionSet => ({ preset: 'dev', warnings: [], describe: () => [], decide: () => ({ decision, source: 'user' }) });

async function withProject(work: (input: { root: string; config: RunnerConfig }) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-terminal-')));
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-terminal-logs-'));
	try { await work({ root, config: { schemaVersion: 1, root, env: { ...process.env }, logDirectory: logs, policy: { subprojects: [], delegate: false, extras: ['node'] }, permissions: {}, terminal: true } }); }
	finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('only an unfinished question line counts as a prompt, never ordinary output', () => {
	assert.deepEqual([
		pendingPrompt('Installing...\nContinue? (y/n) '), pendingPrompt('Project name: '), pendingPrompt('Enter password'), pendingPrompt('Done.\n'), pendingPrompt('Compiling 12 files'), pendingPrompt(''), pendingPrompt('x'.repeat(300) + '?')
	], ['Continue? (y/n)', 'Project name:', 'Enter password', undefined, undefined, undefined, undefined]);
});

test('a command waiting at a prompt is stopped with the prompt text, and a quiet but finished-line command is left alone', async () => {
	await withProject(async ({ root, config }) => {
		await fs.writeFile(path.join(root, 'ask.cjs'), 'process.stdout.write("Overwrite files? (y/n) "); setTimeout(() => {}, 30000);');
		await fs.writeFile(path.join(root, 'quiet.cjs'), 'console.log("working"); setTimeout(() => console.log("done"), 600);');
		const asked = await runCommand({ root, cwd: '.', command: 'node', args: ['ask.cjs'], env: config.env, logDirectory: config.logDirectory, promptIdleMs: 200 });
		const quiet = await runCommand({ root, cwd: '.', command: 'node', args: ['quiet.cjs'], env: config.env, logDirectory: config.logDirectory, promptIdleMs: 200 });
		assert.deepEqual({ prompt: asked.prompt, stopped: asked.exitCode !== 0, quiet: [quiet.exitCode, quiet.prompt, quiet.output.includes('done')] }, { prompt: 'Overwrite files? (y/n)', stopped: true, quiet: [0, undefined, true] });
	});
});

test('the runner tells the agent what to do next when a command stopped at a prompt', async () => {
	await withProject(async ({ root, config }) => {
		await fs.writeFile(path.join(root, 'ask.cjs'), 'process.stdout.write("Project name: "); setTimeout(() => {}, 30000);');
		const withTool = await handleRun({ ...config, terminal: true }, { command: 'node', args: ['ask.cjs'] }, 1, { permissions: permissionsOf('allow'), promptIdleMs: 200 });
		const without = await handleRun({ ...config, terminal: false }, { command: 'node', args: ['ask.cjs'] }, 2, { permissions: permissionsOf('allow'), promptIdleMs: 200 });
		assert.deepEqual({ first: withTool.text.split('\n')[0].startsWith('stopped: waiting for input'), tool: withTool.text.includes('run_in_terminal'), other: without.text.includes('own terminal') && !without.text.includes('run_in_terminal') }, { first: true, tool: true, other: true });
	});
}, { timeout: 60000 });

test('with a person attached the prompt is theirs: typed lines reach the command and its output comes back', async () => {
	await withProject(async ({ root, config }) => {
		await fs.writeFile(path.join(root, 'name.cjs'), 'process.stdout.write("Name? "); process.stdin.once("data", data => { console.log("hello " + String(data).trim()); process.exit(0); });');
		const shown: string[] = [];
		let write: ((data: string) => void) | undefined;
		const result = await runCommand({
			root, cwd: '.', command: 'node', args: ['name.cjs'], env: config.env, logDirectory: config.logDirectory, promptIdleMs: 100,
			interactive: { onOutput: text => { shown.push(text); if (text.includes('Name?')) { setTimeout(() => write?.('ana\n'), 400); } }, onInput: sink => { write = sink; return () => { write = undefined; }; } }
		});
		assert.deepEqual({ exit: result.exitCode, prompt: result.prompt, output: result.output.includes('hello ana'), screen: shown.join('').includes('hello ana') }, { exit: 0, prompt: undefined, output: true, screen: true });
	});
});

test('run_in_terminal applies the same policy and approval as run before anything is opened', async () => {
	await withProject(async ({ root, config }) => {
		const started: string[] = [];
		const terminal = async (request: { command: string; args: string[]; cwd: string }): Promise<CommandResult> => { started.push([request.command, ...request.args].join(' ')); return { exitCode: 0, timedOut: false, cancelled: false, durationMs: 5, output: 'answered', truncated: false, logFile: '' }; };
		const asked: ApprovalDraft[] = [];
		const denied = await handleRun(config, { command: 'node', args: ['setup.cjs'] }, 1, { permissions: permissionsOf('ask'), ask: async request => { asked.push(request); return 'deny'; }, terminal }, 'terminal');
		const noUi = await handleRun(config, { command: 'node', args: ['setup.cjs'] }, 2, { permissions: permissionsOf('ask'), terminal }, 'terminal');
		const shell = await handleRun(config, { command: 'bash', args: ['-c', 'echo hi'] }, 3, { permissions: permissionsOf('allow'), terminal }, 'terminal');
		const ran = await handleRun(config, { command: 'node', args: ['setup.cjs'] }, 4, { permissions: permissionsOf('allow'), terminal }, 'terminal');
		const audit = (await fs.readFile(path.join(config.logDirectory, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
		assert.deepEqual({
			asked: asked.length, denied: denied.isError, noUi: noUi.isError, shell: shell.text.startsWith('POLICY_DENIED'), started, ran: ran.text.endsWith('answered'),
			audit: audit.filter(entry => entry.via === 'terminal' && entry.exitCode === 0).length
		}, { asked: 1, denied: true, noUi: true, shell: true, started: ['node setup.cjs'], ran: true, audit: 1 });
		void root;
	});
});

test('terminal requests from the channel must be exactly a command request', () => {
	const good = { command: 'node', args: ['a.js'], cwd: '.', delegate: false, timeoutSec: 30 };
	assert.deepEqual([parseTerminalRequest(good), parseTerminalRequest({ ...good, extra: 1 })?.command, parseTerminalRequest({ ...good, args: [1] }), parseTerminalRequest({ ...good, timeoutSec: 99999 }), parseTerminalRequest({ ...good, delegate: 'yes' }), parseTerminalRequest(null), parseTerminalRequest({ command: '' })],
		[good, 'node', undefined, undefined, undefined, undefined, undefined]);
});

function fakeApi(): { api: TerminalApi; screen: string[]; pty: () => PseudoTerminal } {
	const screen: string[] = [];
	let created: PseudoTerminal | undefined;
	class Emitter { private listener: (value: string) => void = () => undefined; event = (listener: (value: string) => void) => { this.listener = listener; return {}; }; fire(value: string): void { this.listener(value); } }
	const api: TerminalApi = { EventEmitter: Emitter, window: { createTerminal: options => { created = options.pty; options.pty.onDidWrite(value => screen.push(value)); return { show: () => undefined }; } } };
	return { api, screen, pty: () => created! };
}

test('the IDE terminal echoes what is typed, sends a line on Enter, hides secrets and stops the command on Ctrl+C', () => {
	const { api, screen, pty } = fakeApi();
	let interrupted = 0;
	const sent: string[] = [];
	const terminal = openInteractiveTerminal(api, 'ArmoTuSitio: node setup.cjs', () => { interrupted++; });
	terminal.io.onInput(data => sent.push(data));
	terminal.io.onOutput('Name? ');
	for (const key of ['a', 'n', 'x', '\u007f', 'a', '\r']) { pty().handleInput(key); }
	terminal.io.onOutput('Password: ');
	for (const key of ['s', 'e', '\r']) { pty().handleInput(key); }
	pty().handleInput('\u0003');
	terminal.finished('[done]');
	pty().handleInput('late\r');
	// The backspace erases the typed x on the screen, and nothing of the password is echoed.
	assert.deepEqual({ sent, screen: screen.join('').startsWith('Name? anx\b \ba\r\nPassword: \r\n'), interrupted, finished: screen.at(-1)!.includes('[done]'), ignoredAfterEnd: sent.length }, { sent: ['ana\n', 'se\n'], screen: true, interrupted: 1, finished: true, ignoredAfterEnd: 2 });
});
