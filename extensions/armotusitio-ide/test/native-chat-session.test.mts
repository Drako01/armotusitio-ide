/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore, type ChatProjectContext } from '../src/native-chat.ts';
import { HarnessChatSession, type ChatRuntime, type ChatSnapshot } from '../src/native-chat-session.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
const outcome = (output: string, status: AgentOutcome['status'] = 'passed'): AgentOutcome => ({ status, exitCode: status === 'passed' ? 0 : 1, durationMs: 5, output, truncated: false });
const plan = (title: string, steps: string[]) => '```harness-plan\n' + JSON.stringify({ title, summary: 'Resumen', steps }) + '\n```';

/** Scripted provider used only in tests: records every call so the Send/Approve boundary can be asserted. */
function scripted(replies: Array<string | AgentOutcome>, context: Partial<ChatProjectContext> = {}) {
	const calls: Array<{ kind: 'converse' | 'implement'; provider: string; instruction: string }> = [];
	let writer = context.writer ?? true;
	const runtime: ChatRuntime = {
		async context() { return { root: '/repo', writer, skills: [], guides: [], verification: { revision: 'b'.repeat(64), gates: [{ id: 'unit', command: 'npm test' }] }, ...context }; },
		async converse(provider, instruction, hooks) {
			calls.push({ kind: 'converse', provider, instruction });
			hooks.started(() => undefined); hooks.progress(4096);
			const next = replies.shift() ?? 'ok';
			return typeof next === 'string' ? outcome(next) : next;
		},
		async implement(request, hooks, signal) {
			calls.push({ kind: 'implement', provider: request.provider, instruction: request.instruction });
			hooks.started(() => undefined); hooks.stage('verifying'); hooks.gates([{ id: 'unit', status: 'running' }]);
			if (signal.aborted) { return { agent: outcome('', 'cancelled'), verification: { status: 'skipped', gates: [] } }; }
			return { agent: outcome('Archivos: src/clients.ts'), verification: { status: 'passed', gates: [{ id: 'unit', status: 'passed' }] } };
		}
	};
	return { runtime, calls, setWriter: (value: boolean) => { writer = value; } };
}

async function session(replies: Array<string | AgentOutcome>, context: Partial<ChatProjectContext> = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-session-'));
	const fake = scripted(replies, context);
	const snapshots: ChatSnapshot[] = [];
	const store = new ChatStore(directory);
	const chat = new HarnessChatSession(store, fake.runtime, snapshot => snapshots.push(snapshot), t);
	await chat.open();
	return { chat, ...fake, snapshots, store, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('Send converses, revises the plan and never implements; Approve runs only the latest plan digest', async () => {
	const s = await session([
		'\u00bfQu\u00e9 campos necesita el cliente?',
		'Perfecto.\n' + plan('CRUD de clientes', ['Modelo', 'API']),
		'Agrego validaciones.\n' + plan('CRUD de clientes', ['Modelo', 'API', 'Validaciones'])
	]);
	try {
		await s.chat.send('Quiero agregar un CRUD de clientes');
		await s.chat.send('Nombre, email y tel\u00e9fono');
		const first = s.chat.snapshot().plan!;
		await s.chat.send('Agreg\u00e1 validaciones');
		const second = s.chat.snapshot().plan!;
		assert.deepEqual({ kinds: s.calls.map(call => call.kind), versions: [first.version, second.version], approvable: second.approvable }, { kinds: ['converse', 'converse', 'converse'], versions: [1, 2], approvable: true });
		assert.match(s.calls[2].instruction, /Current plan \(v1\)/);
		// A stale card (v1) can never trigger an implementation.
		await assert.rejects(s.chat.approve(first.digest), /HARNESS_CHAT_PLAN_CHANGED/);
		await s.chat.approve(second.digest);
		const last = s.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({ kinds: s.calls.map(call => call.kind), role: last.role, status: last.run?.status, gates: last.run?.verification.gates, plan: last.run?.planVersion },
			{ kinds: ['converse', 'converse', 'converse', 'implement'], role: 'run', status: 'passed', gates: [{ id: 'unit', status: 'passed' }], plan: 2 });
		assert.match(s.calls[3].instruction, /Implement the approved plan v2[\s\S]*Validaciones/);
		// A successfully applied plan cannot be applied twice.
		assert.deepEqual({ approvable: s.chat.snapshot().plan?.approvable, reason: /ya se ejecut/.test(s.chat.snapshot().plan?.blockedReason ?? '') }, { approvable: false, reason: true });
		await assert.rejects(s.chat.approve(second.digest), /HARNESS_CHAT_PLAN_ALREADY_APPLIED/);
		assert.equal(s.calls.filter(call => call.kind === 'implement').length, 1);
		// Progress was published while executing: stage, gates and activity bytes.
		assert.ok(s.snapshots.some(snapshot => snapshot.activity?.kind === 'executing' && snapshot.activity.stage === 'verifying' && snapshot.activity.gates?.[0].status === 'running'));
		assert.ok(s.snapshots.some(snapshot => snapshot.activity?.kind === 'thinking' && snapshot.activity.observedBytes === 4096));
		// The conversation survives a reload, including the executed run.
		const reloaded = new HarnessChatSession(s.store, s.runtime, () => undefined, t);
		await reloaded.open();
		assert.equal(reloaded.snapshot().messages.length, s.chat.snapshot().messages.length);
	} finally { await s.cleanup(); }
});

test('provider choice persists per project and a running turn keeps the provider it started with', async () => {
	let release: () => void = () => undefined;
	const s = await session([]);
	try {
		let entered: () => void = () => undefined;
		const inside = new Promise<void>(resolve => { entered = resolve; });
		s.runtime.converse = async (provider, instruction, hooks) => {
			s.calls.push({ kind: 'converse', provider, instruction });
			const done = new Promise<void>(resolve => { release = resolve; });
			hooks.started(() => release());
			entered();
			await done;
			return outcome('respuesta');
		};
		await s.chat.selectProvider('codex');
		const pending = s.chat.send('hola');
		await inside;
		await s.chat.selectProvider('claude');
		await assert.rejects(s.chat.send('otra'), /HARNESS_ALREADY_RUNNING/);
		release();
		await pending;
		const reply = s.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({ started: s.calls[0].provider, reply: reply.provider, next: s.chat.snapshot().provider }, { started: 'codex', reply: 'codex', next: 'claude' });
		const reloaded = new HarnessChatSession(s.store, s.runtime, () => undefined, t, 'codex');
		await reloaded.open();
		assert.equal(reloaded.snapshot().provider, 'claude');
	} finally { await s.cleanup(); }
});

test('hybrid projects can plan but cannot approve, and provider failures stay inside the chat', async () => {
	const s = await session([plan('Plan', ['Paso']), { ...outcome('', 'failed'), rateLimited: true }, outcome('', 'timeout')], { writer: false });
	try {
		await s.chat.send('Planific\u00e1');
		const state = s.chat.snapshot().plan!;
		assert.deepEqual({ approvable: state.approvable, reason: /propio Harness/.test(state.blockedReason ?? '') }, { approvable: false, reason: true });
		await assert.rejects(s.chat.approve(state.digest), /HARNESS_HYBRID_WRITER_UNAVAILABLE/);
		await s.chat.send('otra'); await s.chat.send('y otra');
		const notices = s.chat.snapshot().messages.filter(message => message.role === 'notice').map(message => message.text);
		assert.deepEqual(notices.map(text => /limit\u00f3/.test(text) || /a tiempo/.test(text)), [true, true]);
		assert.equal(s.calls.some(call => call.kind === 'implement'), false);
	} finally { await s.cleanup(); }
});

test('a storage failure never leaves the chat stuck in a thinking state or launches the provider', async () => {
	const s = await session(['respuesta']);
	try {
		s.store.save = async () => { throw Error('HARNESS_CHECKPOINT_STORAGE_UNSAFE'); };
		await assert.rejects(s.chat.send('hola'), /HARNESS_CHECKPOINT_STORAGE_UNSAFE/);
		assert.deepEqual({ busy: s.chat.busy, activity: s.snapshots.at(-1)?.activity, calls: s.calls.length, notice: /HARNESS_CHECKPOINT_STORAGE_UNSAFE/.test(s.chat.snapshot().messages.at(-1)!.text) },
			{ busy: false, activity: undefined, calls: 0, notice: true });
	} finally { await s.cleanup(); }
});

test('cancelling an execution aborts the runtime signal and records the cancelled run', async () => {
	const s = await session([plan('Plan', ['Paso'])]);
	try {
		await s.chat.send('Plan');
		let aborted = false;
		s.runtime.implement = async (_request, hooks, signal) => {
			hooks.started(() => undefined);
			s.chat.cancel();
			aborted = signal.aborted;
			return { agent: outcome('', 'cancelled'), verification: { status: 'skipped', gates: [] } };
		};
		await s.chat.approve(s.chat.snapshot().plan!.digest);
		assert.deepEqual({ aborted, status: s.chat.snapshot().messages.at(-1)!.run?.status, busy: s.chat.busy }, { aborted: true, status: 'cancelled', busy: false });
	} finally { await s.cleanup(); }
});
