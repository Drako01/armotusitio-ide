/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexAdapter } from '../src/runtime/codex-adapter.ts';
import type { AdapterHost, AgentConnection, SessionOpenOptions } from '../src/runtime/contracts.ts';
import { CODEX_CHILD_SPAWNS_PER_TURN, CodexChildGuard, codexChildActivity } from '../src/native-codex-subagents.ts';
import { FAKE_CODEX, installFakeCli } from './native-runtime-fakes.mts';
import { pathKey, settledPids } from './native-runtime-harness.mts';

const root = '/tmp/ats-codex-guard-fixture';
const base: SessionOpenOptions = {
	identity: { root, worktree: root, provider: 'codex', conversationId: 'private' },
	role: 'conversation', instructions: 'Inspect only', env: process.env, nativeSubagents: true
};
const host: AdapterHost = { emit: () => undefined, approve: async () => ({ allowed: false, scope: 'once' }), ask: async () => undefined };

test('native Codex subagents never open with writer, MCP, web or global full-access permissions', async () => {
	const adapter = new CodexAdapter();
	for (const override of [
		{ role: 'writer' as const },
		{ webSearch: true },
		{ toolServer: { command: 'node', args: [], env: {}, mcpConfigFile: '' } }
	]) {
		await assert.rejects(adapter.open({ ...base, ...override }, host), /RUNTIME_SUBAGENTS_UNSAFE/);
	}
	const unrestricted = new CodexAdapter({ fullAccess: () => true });
	await assert.rejects(unrestricted.open(base, host), /RUNTIME_SUBAGENTS_UNSAFE/);
});

test('native Codex child session refuses an unauditable root without starting a CLI', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-child-app-server-'));
	try {
		await assert.rejects(
			new CodexAdapter().open({ ...base, identity: { ...base.identity, root, worktree: root } }, host),
			/HARNESS_DELEGATION_ISOLATION_UNSUPPORTED/
		);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the child guard separates disabled, nested and cumulative delegation from allowed activity', () => {
	const spawn = (id: string, senderThreadId = 'root') => ({ id, tool: 'spawnAgent', senderThreadId });
	const off = new CodexChildGuard(false);
	const on = new CodexChildGuard(true);
	const verdicts = [
		off.observe(spawn('a'), 'root'),
		on.observe({ id: 'w', tool: 'wait', senderThreadId: 'root' }, 'root'),
		on.observe(spawn('nested', 'child'), 'root'),
		...Array.from({ length: CODEX_CHILD_SPAWNS_PER_TURN + 1 }, (_, index) => on.observe(spawn('s' + index), 'root')),
		// The started and completed notifications of one call count once.
		on.observe(spawn('s0'), 'root') === 'HARNESS_DELEGATION_CHILD_LIMIT' ? 'still-over' : 'unexpected'
	];
	on.beginTurn();
	assert.deepEqual([...verdicts, on.observe({ id: 'r', tool: 'resume_agent' }), codexChildActivity({ type: 'collab_tool_call', id: 'x', tool: 'spawn_agent', sender_thread_id: 't' }), codexChildActivity({ type: 'commandExecution', id: 'c' })], [
		'HARNESS_DELEGATION_CHILD_UNEXPECTED', undefined, 'HARNESS_DELEGATION_CHILD_DEPTH',
		undefined, undefined, undefined, undefined, 'HARNESS_DELEGATION_CHILD_LIMIT', 'still-over',
		undefined, { id: 'x', tool: 'spawn_agent', senderThreadId: 't' }, undefined
	]);
});

interface Fixture { open(nativeSubagents: boolean): Promise<AgentConnection>; argv(): Promise<string[]>; pids(): Promise<number[]>; close(): Promise<void> }

/** A committed Git root (auditable scope) and the fake `codex app-server`; no provider traffic. */
async function fixture(): Promise<Fixture> {
	const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-codex-children-')));
	const project = path.join(folder, 'project'), state = path.join(folder, 'state'), bin = path.join(folder, 'bin');
	await Promise.all([fs.mkdir(project), fs.mkdir(state)]);
	execFileSync('git', ['init', '-q', '-b', 'main', project]);
	await fs.writeFile(path.join(project, 'README.md'), 'seed\n');
	execFileSync('git', ['-C', project, 'add', 'README.md']);
	execFileSync('git', ['-C', project, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'seed']);
	await installFakeCli(bin, 'codex', FAKE_CODEX);
	const env = { ...process.env, [pathKey]: bin + path.delimiter + (process.env[pathKey] ?? ''), FAKE_STATE_DIR: state };
	const connections: AgentConnection[] = [];
	return {
		async open(nativeSubagents) {
			const connection = await new CodexAdapter().open({ identity: { root: project, worktree: project, provider: 'codex', conversationId: 'children' }, role: 'conversation', instructions: 'Inspect only', env, ...(nativeSubagents ? { nativeSubagents: true } : {}) }, host);
			connections.push(connection);
			return connection;
		},
		argv: async () => JSON.parse(await fs.readFile(path.join(state, 'argv.json'), 'utf8')) as string[],
		pids: async () => (await fs.readFile(path.join(state, 'pids.log'), 'utf8')).split('\n').filter(Boolean).map(Number),
		async close() {
			await Promise.all(connections.map(connection => connection.close()));
			await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	};
}
const turn = (connection: AgentConnection, text: string) => connection.startTurn({ text, clientTurnId: 'turn-' + text, role: 'conversation' });

test('Codex sessions switch native children off unless the user opted in, and stop a process that spawns one anyway', async () => {
	const codex = await fixture();
	try {
		const connection = await codex.open(false);
		const argv = await codex.argv();
		const result = await turn(connection, 'CHILD 1');
		await connection.exited;
		assert.deepEqual([argv.slice(0, 7), result.status, result.error, await settledPids(await codex.pids())], [
			['--config', 'features.multi_agent=false', '--config', 'features.multi_agent_v2=false', '--config', 'agents.enabled=false', 'app-server'], 'failed', 'HARNESS_DELEGATION_CHILD_UNEXPECTED', []
		]);
	} finally { await codex.close(); }
});

test('opted-in Codex children are bounded per turn, limited to depth one and die with an interrupted parent', async () => {
	const codex = await fixture();
	try {
		const allowed = await codex.open(true);
		const argv = await codex.argv();
		const within = await turn(allowed, 'CHILD ' + CODEX_CHILD_SPAWNS_PER_TURN);
		// The bound is per turn: an earlier turn's children do not consume the next one's.
		const next = await turn(allowed, 'again CHILD 1');
		const over = await turn(allowed, 'CHILD ' + (CODEX_CHILD_SPAWNS_PER_TURN + 1));
		await allowed.exited;
		const nested = await codex.open(true);
		const depth = await turn(nested, 'NESTED CHILD 1');
		await nested.exited;
		const slow = await codex.open(true);
		const running = turn(slow, 'SLOW');
		await new Promise(resolve => setTimeout(resolve, 300));
		await slow.interrupt();
		const interrupted = await running;
		await slow.exited;
		assert.deepEqual([
			['features.multi_agent=true', 'features.multi_agent_v2=false', 'agents.max_threads=2', 'agents.max_depth=1', 'tools.web_search=false'].filter(flag => !argv.includes(flag)),
			within.status, next.status, [over.status, over.error], [depth.status, depth.error], interrupted.status, await settledPids(await codex.pids())
		], [[], 'completed', 'completed', ['failed', 'HARNESS_DELEGATION_CHILD_LIMIT'], ['failed', 'HARNESS_DELEGATION_CHILD_DEPTH'], 'interrupted', []]);
	} finally { await codex.close(); }
});
