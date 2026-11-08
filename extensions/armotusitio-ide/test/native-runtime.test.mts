/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Native runtime contract suite (r8): the same scenarios run against both adapters, through the real session manager,
 * session store, event bridge, IDE policy and (for Claude) the real ats-runner approve tool. The providers are
 * protocol-faithful fakes started as real processes, so these verify the IDE side of the contract and recovery (S05-S10,
 * S18, R01-R08, DoD-09); real-provider behavior is covered by the opt-in E2E suite.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_TEXT_CHARS } from '../src/runtime/event-bridge.ts';
import type { RecoveryNotice } from '../src/runtime/session-manager.ts';
import { harness, record, settledPids } from './native-runtime-harness.mts';

for (const provider of ['codex', 'claude'] as const) {
	describe('native runtime contract: ' + provider, () => {
		test('two turns share one native session, in order (S01/S02)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const events = record(session);
				const first = await session.runTurn('hello there', 'conversation');
				const second = await session.runTurn('and again', 'conversation');
				const sequences = events.map(event => event.sequence);
				const stored = await h.store.get(session.key);
				assert.deepEqual({
					statuses: [first.status, second.status], sameSession: first.nativeSessionId === second.nativeSessionId && !!first.nativeSessionId,
					continuity: second.output.includes('prev=hello there'), ordered: sequences.every((value, index) => index === 0 || value > sequences[index - 1]),
					completed: events.filter(event => event.payload.type === 'turn.completed').length, journal: stored?.journal.map(entry => entry.status), state: session.state
				}, { statuses: ['completed', 'completed'], sameSession: true, continuity: true, ordered: true, completed: 2, journal: ['completed', 'completed'], state: 'ready' });
			} finally { await h.close(); }
		});

		test('an IDE restart resumes the session by id with its context (S03/S04, R02)', async () => {
			const h = await harness(provider);
			try {
				const before = await h.manager().session(h.identity);
				const first = await before.runTurn('remember PINEAPPLE', 'conversation');
				const old = h.manager();
				await old.dispose();
				const restarted = h.manager();
				const after = await restarted.session(h.identity);
				const notices: RecoveryNotice[] = [];
				after.onNotice(notice => notices.push(notice));
				const second = await after.runTurn('what did I say', 'conversation');
				assert.deepEqual({ same: second.nativeSessionId === first.nativeSessionId, recalled: second.output.includes('prev=remember PINEAPPLE'), notices: notices.map(item => item.kind) },
					{ same: true, recalled: true, notices: ['resumed'] });
			} finally { await h.close(); }
		});

		test('200 streamed deltas arrive in order and the bridge stays bounded (S18)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const events = record(session);
				const result = await session.runTurn('FLOOD 200', 'conversation');
				const deltas = events.filter(event => event.payload.type === 'message.delta');
				const last = deltas.at(-1)?.payload as { text: string } | undefined;
				assert.equal(result.status, 'completed');
				assert.ok(deltas.length >= 200, 'deltas: ' + deltas.length);
				assert.ok(deltas.every((event, index) => index === 0 || event.sequence > deltas[index - 1].sequence));
				assert.ok(last?.text.includes('d199'));
				// Deltas are delivered but never retained.
				assert.ok(session.bridge.since(0).every(event => event.payload.type !== 'message.delta'));
			} finally { await h.close(); }
		});

		if (provider === 'claude') {
			test('a runaway stream stops accumulating at the event bound and says so (AUD-P2-004)', async () => {
				const h = await harness(provider);
				try {
					const session = await h.session();
					const events = record(session);
					const result = await session.runTurn('FLOOD 30000', 'conversation');
					const deltaLengths = events.filter(event => event.payload.type === 'message.delta').map(event => (event.payload as { text: string }).text.length);
					assert.deepEqual({
						status: result.status, outputBound: result.output.length <= MAX_TEXT_CHARS, reachedBound: Math.max(...deltaLengths) === MAX_TEXT_CHARS,
						deltasBound: deltaLengths.every(length => length <= MAX_TEXT_CHARS), stoppedEarly: deltaLengths.length < 30000,
						truncationReported: events.filter(event => event.payload.type === 'diagnostic' && event.payload.text === 'message-truncated').length
					}, { status: 'completed', outputBound: true, reachedBound: true, deltasBound: true, stoppedEarly: true, truncationReported: 1 });
				} finally { await h.close(); }
			});
		}

		test('approvals decide execution: deny, once, and the floor without a card (S05/S06)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				h.user.approval = () => 'deny';
				const denied = await session.runTurn('RUN docker ps', 'writer');
				h.user.approval = () => 'once';
				const allowed = await session.runTurn('RUN docker ps', 'writer');
				const cardsBefore = h.cards.length;
				const floor = await session.runTurn('RUN rm -rf build', 'writer');
				assert.deepEqual({
					denied: denied.output.includes('declined=docker ps'), allowed: allowed.output.includes('executed=docker ps'), floor: floor.output.includes('declined=rm -rf build'),
					cardsForFloor: h.cards.length - cardsBefore, executions: await h.executions(), cardRule: h.cards[0]?.rule, state: session.state
				}, { denied: true, allowed: true, floor: true, cardsForFloor: 0, executions: ['docker ps'], cardRule: 'run:docker ps', state: 'ready' });
			} finally { await h.close(); }
		});

		test('the agent asks a question and continues with the answer, in the same turn (S07)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const result = await session.runTurn('ASK about colors', 'writer');
				assert.equal(result.status, 'completed');
				assert.equal(h.asked.length, 1);
				assert.equal(h.asked[0][0].question, 'Which color?');
				assert.match(result.output, /blue/);
			} finally { await h.close(); }
		});

		test('cancelling a streaming turn interrupts it; the session continues afterwards (S09)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 400);
				const started = Date.now();
				const cancelled = await session.runTurn('SLOW work', 'conversation', controller.signal);
				const elapsed = Date.now() - started;
				const next = await session.runTurn('after cancel', 'conversation');
				assert.deepEqual({ cancelled: cancelled.status, fast: elapsed < 2900, next: next.status }, { cancelled: 'interrupted', fast: true, next: 'completed' });
			} finally { await h.close(); }
		});

		test('a provider crash mid-turn is reported lost, never replayed; the next turn resumes (S10, R01)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				await session.runTurn('first message', 'conversation');
				const crashed = await session.runTurn('CRASH now', 'conversation');
				const stateAfterCrash = session.state;
				const next = await session.runTurn('after crash', 'conversation');
				const stored = await h.store.get(session.key);
				assert.deepEqual({
					crashed: crashed.error, stateAfterCrash, journal: stored?.journal.map(entry => entry.status),
					resumed: next.output.includes('prev=first message'), sameSession: next.nativeSessionId === crashed.nativeSessionId
				}, { crashed: 'RUNTIME_CONNECTION_LOST', stateAfterCrash: 'interrupted', journal: ['completed', 'lost', 'completed'], resumed: true, sameSession: true });
			} finally { await h.close(); }
		});

		test('a malformed provider line becomes a bounded diagnostic and the turn completes (R05)', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const events = record(session);
				const result = await session.runTurn('GARBAGE please', 'conversation');
				assert.equal(result.status, 'completed');
				assert.ok(events.some(event => event.payload.type === 'diagnostic' && /invalid-json/.test((event.payload as { text: string }).text)));
			} finally { await h.close(); }
		});

		test('a provider that dies while starting is retried once (R06)', async () => {
			const h = await harness(provider, { FAKE_HANDSHAKE: 'die-once' });
			try {
				const session = await h.session();
				const result = await session.runTurn('hello after retry', 'conversation');
				assert.equal(result.status, 'completed');
				assert.equal((await h.pids()).length, 2);
			} finally { await h.close(); }
		});

		test('a stored native id the provider does not know starts a new session with a notice (R08)', async () => {
			const h = await harness(provider);
			try {
				const first = await h.session();
				await first.runTurn('original', 'conversation');
				await h.store.update(first.key, record => record && { ...record, nativeSessionId: provider === 'claude' ? '00000000-0000-4000-8000-000000000000' : 'missing-thread' });
				const restarted = await h.session(h.manager());
				const notices: RecoveryNotice[] = [];
				restarted.onNotice(notice => notices.push(notice));
				const result = await restarted.runTurn('fresh start', 'conversation');
				assert.deepEqual({ status: result.status, notices: notices.map(item => item.kind), noInventedHistory: !result.output.includes('prev=') },
					{ status: 'completed', notices: ['new-session'], noInventedHistory: true });
			} finally { await h.close(); }
		});

		test('an IDE that dies while a turn waits for approval leaves a lost turn and no grant (R03/R04)', async () => {
			const h = await harness(provider);
			try {
				let release!: () => void;
				const waiting = new Promise<void>(resolve => { release = resolve; });
				h.user.approval = async () => { await waiting; return 'deny'; };
				const dying = h.manager();
				const session = await h.session(dying);
				const turn = session.runTurn('APPROVE_WAIT', 'writer');
				for (let attempt = 0; attempt < 100 && session.state !== 'awaiting_approval'; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); }
				const waited = session.state;
				// Simulate the IDE process dying: the journal still says `running`, owned by a process that is gone.
				const lost = await h.store.reconcile(() => false);
				release();
				await turn.catch(() => undefined);
				await dying.dispose();
				const stored = await h.store.get(session.key);
				assert.deepEqual({ waited, lost: lost.map(item => item.entry.status), executions: await h.executions() }, { waited: 'awaiting_approval', lost: ['lost'], executions: [] });
				assert.equal(stored?.journal[0].status === 'lost' || stored?.journal[0].status === 'completed', true);
				const next = await (await h.session(h.manager())).runTurn('after restart', 'conversation');
				assert.equal(next.status, 'completed');
			} finally { await h.close(); }
		});

		test('changing role reopens the provider with resume and the new permissions', async () => {
			const h = await harness(provider);
			try {
				const session = await h.session();
				const asked = await session.runTurn('plan only', 'conversation');
				const wrote = await session.runTurn('now write', 'writer');
				assert.equal(wrote.nativeSessionId, asked.nativeSessionId);
				assert.match(wrote.output, /prev=plan only/);
				if (provider === 'claude') {
					assert.match(asked.output, /mode=plan/);
					assert.match(wrote.output, /mode=default/);
				}
			} finally { await h.close(); }
		});

		test('fork branches a new native session with the history; the original is untouched', async () => {
			const h = await harness(provider);
			try {
				const manager = h.manager();
				const source = await h.session(manager);
				const original = await source.runTurn('shared start', 'conversation');
				const forked = await manager.fork(h.identity, 'c2');
				const branch = await forked.runTurn('branch only', 'conversation');
				const back = await source.runTurn('back on main', 'conversation');
				assert.deepEqual({ newId: branch.nativeSessionId !== original.nativeSessionId, inherited: branch.output.includes('prev=shared start'), untouched: back.output.includes('prev=shared start') },
					{ newId: true, inherited: true, untouched: true });
			} finally { await h.close(); }
		});

		test('100 consecutive turns: no lost message, no stuck state, no orphan process (DoD-09)', async () => {
			const h = await harness(provider);
			try {
				const manager = h.manager();
				const session = await h.session(manager);
				const events = record(session);
				const statuses = new Set<string>();
				for (let index = 0; index < 100; index++) { statuses.add((await session.runTurn('turn ' + index, 'conversation')).status); }
				const completed = events.filter(event => event.payload.type === 'turn.completed').length;
				const stored = await h.store.get(session.key);
				await manager.dispose();
				assert.deepEqual({ statuses: [...statuses], completed, state: session.state, journal: stored?.journal.length, everyCompleted: stored?.journal.every(entry => entry.status === 'completed'), orphans: await settledPids(await h.pids()) },
					{ statuses: ['completed'], completed: 100, state: 'closed', journal: 50, everyCompleted: true, orphans: [] });
			} finally { await h.close(); }
		});
	});
}

test('provider switch creates a new session for the other provider with an explicit handoff (S19)', async () => {
	const h = await harness('codex');
	try {
		const manager = h.manager();
		const codex = await h.session(manager);
		const first = await codex.runTurn('started on codex', 'conversation');
		const claude = await manager.handoff(h.identity, 'claude');
		const record = await h.store.get(claude.key);
		assert.deepEqual({ provider: claude.identity.provider, handoff: record?.handoffFrom, noNativeId: record?.nativeSessionId === undefined },
			{ provider: 'claude', handoff: { provider: 'codex', nativeSessionId: first.nativeSessionId }, noNativeId: true });
	} finally { await h.close(); }
});

test('codex steers a running turn with more input', async () => {
	const h = await harness('codex');
	try {
		const session = await h.session();
		const turn = session.runTurn('SLOW then steer', 'conversation');
		await new Promise(resolve => setTimeout(resolve, 300));
		const steered = await session.steer('also check tests');
		await turn;
		const sessions = JSON.parse(await fs.readFile(path.join(h.state, 'sessions.json'), 'utf8')) as Record<string, { messages: string[] }>;
		assert.equal(steered, true);
		assert.ok(Object.values(sessions).some(item => item.messages.includes('steer:also check tests')));
	} finally { await h.close(); }
});

test('two roots, two chats: sessions, working directories and processes never mix (S15)', async () => {
	const [left, right] = await Promise.all([harness('codex'), harness('codex')]);
	try {
		const [a, b] = await Promise.all([left.session(), right.session()]);
		const [first, second] = await Promise.all([a.runTurn('left project', 'conversation'), b.runTurn('right project', 'conversation')]);
		const threads = async (state: string) => JSON.parse(await fs.readFile(path.join(state, 'sessions.json'), 'utf8')) as Record<string, { cwd: string; messages: string[] }>;
		const leftThread = (await threads(left.state))[first.nativeSessionId];
		const rightThread = (await threads(right.state))[second.nativeSessionId];
		assert.deepEqual({ keys: a.key !== b.key, ids: first.nativeSessionId !== second.nativeSessionId, cwd: [leftThread.cwd === left.root, rightThread.cwd === right.root], messages: [leftThread.messages, rightThread.messages] },
			{ keys: true, ids: true, cwd: [true, true], messages: [['left project'], ['right project']] });
	} finally { await Promise.all([left.close(), right.close()]); }
});

test('an installed CLI that speaks another protocol version keeps the structured transport and says why (S20)', async () => {
	const { NativeChatTransport } = await import('../src/native-agent-transport.ts');
	for (const [provider, env, expected] of [
		['codex', { FAKE_VERSION: '0.150.0' }, /0\.150\.0/],
		['claude', { FAKE_HELP: '--resume --session-id' }, /--input-format/],
		['codex', {}, undefined]
	] as const) {
		const h = await harness(provider, env);
		try {
			const transport = new NativeChatTransport({
				storageFor: () => h.base, setting: () => 'auto', trusted: () => true,
				environment: async () => ({ env: { ...process.env, PATH: path.join(h.base, 'bin') + path.delimiter + process.env.PATH, FAKE_STATE_DIR: h.state, HOME: h.home, USERPROFILE: h.home, ...env }, writableRoots: [] }),
				toolServer: async () => { throw Error('unused'); }, policy: async () => { throw Error('unused'); }, instructions: async () => '',
				model: () => undefined, effort: () => undefined, codexFullAccess: () => false, maxTurns: () => 10, webSearch: () => false, clientVersion: '0'
			});
			const decision = await transport.decide(provider);
			if (expected) { assert.equal(decision.native, false); assert.match(decision.reason ?? '', expected); }
			else { assert.equal(decision.native, true); }
		} finally { await h.close(); }
	}
});
