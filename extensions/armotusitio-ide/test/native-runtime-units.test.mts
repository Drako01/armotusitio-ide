/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Unit contracts of the r8 runtime pieces: event bridge, JSON-RPC framing, session store, approval broker, provider policy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventBridge, MAX_RETAINED_EVENTS } from '../src/runtime/event-bridge.ts';
import { JsonRpcConnection, ProviderRequestError } from '../src/runtime/json-rpc.ts';
import { AgentSessionStore, migrateStore, SESSION_STORE_VERSION, type SessionRecord } from '../src/runtime/session-store.ts';
import { ApprovalBroker, SESSION_GRANT_TTL_MS } from '../src/runtime/approval-broker.ts';
import { decideProviderCall, unwrapShell, verdictOf } from '../src/runtime/provider-policy.ts';
import { minorOf } from '../src/runtime/codex-adapter.ts';
import { claudeToolCall } from '../src/runtime/claude-adapter.ts';
import { SESSION_TRANSITIONS, sessionKey, type SessionIdentity } from '../src/runtime/contracts.ts';
import { createCommandPolicy } from '../src/native-command-policy.ts';
import { loadPermissions } from '../src/native-permissions.ts';
import { parseClaudeQuestions } from '../src/native-approve-tool.ts';

const identity: SessionIdentity = { root: '/p', worktree: '/p', provider: 'codex', conversationId: 'c' };

test('event bridge orders, deduplicates replays, isolates listeners and redacts text', () => {
	const bridge = new EventBridge('s1');
	const seen: number[] = [];
	bridge.subscribe(() => { throw Error('observer bug'); });
	bridge.subscribe(event => seen.push(event.sequence));
	bridge.publish({ nativeKey: 'a', payload: { type: 'turn.started' } });
	assert.equal(bridge.publish({ nativeKey: 'a', payload: { type: 'turn.started' } }), undefined);
	const secret = bridge.publish({ payload: { type: 'message.completed', itemId: 'm', text: 'token ghp_' + 'a'.repeat(36) } });
	assert.deepEqual({ seen, failures: bridge.failures, redacted: !(secret!.payload as { text: string }).text.includes('ghp_a') }, { seen: [1, 2], failures: 2, redacted: true });
});

test('event bridge bounds retention and diagnostics; deltas are never retained', () => {
	const bridge = new EventBridge('s1');
	for (let index = 0; index < MAX_RETAINED_EVENTS + 50; index++) { bridge.publish({ payload: { type: 'tool.completed', status: 'completed' } }); }
	for (let index = 0; index < 100; index++) { bridge.publish({ payload: { type: 'message.delta', itemId: 'm', text: 'x' } }); }
	let diagnostics = 0;
	for (let index = 0; index < 50; index++) { if (bridge.publish({ payload: { type: 'diagnostic', source: 'x', text: 'y'.repeat(5000) } })) { diagnostics++; } }
	const retained = bridge.since(0);
	assert.equal(retained.length, MAX_RETAINED_EVENTS);
	assert.ok(retained.every(event => event.payload.type !== 'message.delta'));
	assert.equal(diagnostics, 20);
	assert.ok((retained.at(-1)!.payload as { text: string }).text.length <= 500);
});

test('json-rpc correlates responses, answers server requests and survives malformed lines', async () => {
	const toServer = new PassThrough(), fromServer = new PassThrough();
	const malformed: string[] = [];
	const notifications: string[] = [];
	const rpc = new JsonRpcConnection(toServer, fromServer, {
		request: async method => method === 'approve' ? { decision: 'accept' } : Promise.reject(Error('nope')),
		notification: method => notifications.push(method),
		malformed: reason => malformed.push(reason)
	});
	const written: Array<Record<string, unknown>> = [];
	toServer.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { written.push(JSON.parse(line)); } });
	const pending = rpc.request<{ ok: boolean }>('ping', {});
	fromServer.write('not json\n{"method":"note","params":{}}\n{"id":7,"method":"approve","params":{}}\n{"id":8,"method":"other"}\n');
	fromServer.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n');
	assert.deepEqual(await pending, { ok: true });
	const failing = rpc.request('fail', {});
	fromServer.write(JSON.stringify({ id: 2, error: { code: -32600, message: 'thread not found: x' } }) + '\n');
	await assert.rejects(failing, (error: unknown) => error instanceof ProviderRequestError && error.providerMessage === 'thread not found: x');
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual({ malformed, notifications, answered: written.filter(item => item.id === 7 || item.id === 8).map(item => item.result ?? (item.error as { message: string }).message) },
		{ malformed: ['invalid-json'], notifications: ['note'], answered: [{ decision: 'accept' }, 'request failed'] });
	const timed = rpc.request('slow', {}, 20);
	await assert.rejects(timed, /RUNTIME_REQUEST_TIMEOUT/);
	rpc.close();
	await assert.rejects(rpc.request('after', {}), /RUNTIME_CONNECTION_CLOSED/);
});

test('session store: journal survives, lost turns are marked, corrupt files are quarantined, newer schemas refused', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-store-'));
	try {
		const store = new AgentSessionStore(directory);
		const key = sessionKey(identity);
		const record: SessionRecord = { key, identity, state: 'running', createdAt: 'x', updatedAt: 'x', cursor: 3, nativeSessionId: 'thread-1', journal: [{ clientTurnId: 't1', role: 'writer', status: 'running', inputDigest: 'a'.repeat(64), startedAt: 'x', pid: 999_999_999 }] };
		await store.update(key, () => record);
		const lost = await store.reconcile(pid => pid !== 999_999_999);
		const after = await store.get(key);
		assert.deepEqual({ lost: lost.map(item => item.entry.status), state: after?.state, id: after?.nativeSessionId, raw: (await fs.readFile(path.join(directory, 'agent-sessions.json'), 'utf8')).includes('inputDigest') },
			{ lost: ['lost'], state: 'interrupted', id: 'thread-1', raw: true });
		await fs.writeFile(path.join(directory, 'agent-sessions.json'), '{broken');
		assert.equal(await store.get(key), undefined);
		assert.equal(store.quarantined, true);
		assert.ok((await fs.readdir(directory)).some(name => name.endsWith('.corrupt')));
		await fs.writeFile(path.join(directory, 'agent-sessions.json'), JSON.stringify({ schemaVersion: SESSION_STORE_VERSION + 1, sessions: {} }));
		await assert.rejects(store.get(key), /RUNTIME_STORE_NEWER/);
		assert.deepEqual(migrateStore({ sessions: {} }), { schemaVersion: SESSION_STORE_VERSION, sessions: {} });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('session store: a corrupt registry that cannot be archived is kept byte for byte and the failure is reported', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-store-'));
	try {
		const file = path.join(directory, 'agent-sessions.json');
		const results: unknown[] = [];
		for (const code of ['EACCES', 'EXDEV']) {
			await fs.writeFile(file, '{broken');
			const store = new AgentSessionStore(directory, async () => { throw Object.assign(new Error('rename failed'), { code }); });
			await assert.rejects(store.get('k'), error => (error as Error).message === 'RUNTIME_STORE_QUARANTINE_FAILED' && ((error as Error).cause as NodeJS.ErrnoException).code === code);
			results.push({ code, bytes: await fs.readFile(file, 'utf8'), quarantined: store.quarantined, files: (await fs.readdir(directory)).filter(name => !name.endsWith('.lock')) });
		}
		assert.deepEqual(results, ['EACCES', 'EXDEV'].map(code => ({ code, bytes: '{broken', quarantined: false, files: ['agent-sessions.json'] })));
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('approval broker: scopes, expiry, revocation and audit, never across projects', () => {
	let now = 1000;
	const audit: string[] = [];
	const broker = new ApprovalBroker({ now: () => now, sink: entry => audit.push(entry.event + ':' + entry.rule) });
	const other = new ApprovalBroker({ now: () => now });
	broker.record('run:docker ps', 'task');
	broker.record('run:pnpm test', 'session');
	broker.record('run:aws s3 ls', 'once');
	broker.record('run:rm x', 'deny');
	const before = { docker: broker.covers('run:docker ps'), aws: broker.covers('run:aws s3 ls'), crossProject: other.covers('run:docker ps'), dockerSimilar: broker.covers('run:docker run x') };
	broker.endTask();
	const afterTask = { docker: broker.covers('run:docker ps'), pnpm: broker.covers('run:pnpm test') };
	now += SESSION_GRANT_TTL_MS + 1;
	const expired = broker.covers('run:pnpm test');
	broker.record('run:git push', 'session');
	const revoked = broker.revoke('run:git push');
	assert.deepEqual({ before, afterTask, expired, revoked, left: broker.list(), events: audit.filter(item => /expired|revoked|denied/.test(item)) }, {
		before: { docker: true, aws: false, crossProject: false, dockerSimilar: false }, afterTask: { docker: false, pnpm: true }, expired: false, revoked: 1, left: [],
		events: ['denied:run:rm x', 'expired:run:pnpm test', 'revoked:run:git push']
	});
});

test('provider policy: shell wrappers, sandboxed compound lines asked once, floor and trust deny without a card', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-policy-')));
	try {
		const permissions = await loadPermissions(root, root, undefined, { preset: 'dev' });
		const policy = createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions });
		const cards: string[][] = [];
		let trusted = true;
		const context = { root, policy, permissions, sandboxed: true, trusted: () => trusted, ask: async (draft: { detail: string[] }) => { cards.push(draft.detail); return 'session' as const; } };
		const results = {
			unwrapped: unwrapShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "git status"'),
			bash: unwrapShell('/bin/bash -lc \'ls | wc -l\''),
			plain: await decideProviderCall(context, { kind: 'command', name: 'commandExecution', command: 'git status' }),
			compound: await decideProviderCall(context, { kind: 'command', name: 'commandExecution', command: 'bash -lc "ls | wc -l"' }),
			floor: await decideProviderCall(context, { kind: 'command', name: 'commandExecution', command: 'rm -rf build' }),
			outside: await decideProviderCall(context, { kind: 'file_change', name: 'fileChange', paths: [path.join(os.tmpdir(), 'elsewhere.txt')] }),
			escalation: await decideProviderCall(context, { kind: 'permissions', name: 'permissions', reason: 'network' }),
			unknown: await decideProviderCall(context, { kind: 'mcp', name: 'mcpToolCall' })
		};
		trusted = false;
		const untrusted = await decideProviderCall(context, { kind: 'command', name: 'commandExecution', command: 'git status' });
		assert.deepEqual({ ...results, floor: results.floor.allowed, outside: results.outside.reason, unknown: results.unknown.allowed, untrusted: untrusted.reason, cards: cards.length }, {
			unwrapped: 'git status', bash: 'ls | wc -l',
			plain: { allowed: true, scope: 'once' },
			// No exact rule for a compound line: "session" is downgraded to this action only.
			compound: { allowed: true, scope: 'once' },
			floor: false, outside: 'POLICY_DENIED: path-outside-project',
			escalation: { allowed: true, scope: 'once' }, unknown: false, untrusted: 'POLICY_DENIED: untrusted-workspace', cards: 2
		});
		assert.deepEqual(verdictOf('deny', 'run:x'), { allowed: false, scope: 'once', reason: 'DENIED: the user did not allow it' });
		assert.deepEqual(verdictOf('session', 'run:x'), { allowed: true, scope: 'session' });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('contracts: lifecycle transitions, tool normalization, question parsing and version pinning', () => {
	assert.ok(!SESSION_TRANSITIONS.closed.includes('running'));
	assert.ok(SESSION_TRANSITIONS.running.includes('awaiting_approval'));
	assert.deepEqual([claudeToolCall('Bash', { command: 'ls' }).kind, claudeToolCall('Write', { file_path: 'a' }).kind, claudeToolCall('mcp__ats-runner__run', {}).server, claudeToolCall('AskUserQuestion', {}).kind],
		['command', 'file_change', 'ats-runner', 'question']);
	assert.deepEqual(parseClaudeQuestions({ questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a' }, { label: '' }], multiSelect: true }] }),
		[{ id: 'q0', header: 'H', question: 'Q?', options: [{ label: 'a' }], multiSelect: true, allowOther: true, secret: false }]);
	assert.equal(parseClaudeQuestions({ questions: [] }), undefined);
	assert.deepEqual([minorOf('0.166.0'), minorOf('codex-cli 0.167.2')], ['0.166', '0.167']);
	assert.notEqual(sessionKey(identity), sessionKey({ ...identity, root: '/q' }));
	assert.notEqual(sessionKey(identity), sessionKey({ ...identity, provider: 'claude' }));
});

test('a file change through a junction or symlink that leaves the project is denied without a card (S17)', async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-junction-')));
	try {
		const root = path.join(base, 'project'), outside = path.join(base, 'outside');
		await fs.mkdir(root); await fs.mkdir(outside);
		await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
		const permissions = await loadPermissions(root, base, undefined, { preset: 'dev' });
		const policy = createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions });
		let asked = 0;
		const context = { root, policy, permissions, sandboxed: true, trusted: () => true, ask: async () => { asked++; return 'once' as const; } };
		const through = await decideProviderCall(context, { kind: 'file_change', name: 'fileChange', paths: [path.join(root, 'escape', 'owned.txt')] });
		const traversal = await decideProviderCall(context, { kind: 'file_change', name: 'fileChange', paths: ['../outside/owned.txt'] });
		const inside = await decideProviderCall(context, { kind: 'file_change', name: 'fileChange', paths: [path.join(root, 'src', 'ok.ts')] });
		assert.deepEqual({ through: through.reason, traversal: traversal.reason, inside: inside.allowed, asked }, { through: 'POLICY_DENIED: path-outside-project', traversal: 'POLICY_DENIED: path-outside-project', inside: true, asked: 0 });
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
