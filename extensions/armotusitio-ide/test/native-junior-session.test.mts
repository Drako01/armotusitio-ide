/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* One prompt -> verified result, through the chat session with a scripted runtime: no provider is called (fixtures only). */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore, type GateSummary } from '../src/native-chat.ts';
import { HarnessChatSession, type ChatImplementOutcome, type ChatRuntime } from '../src/native-chat-session.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';
import type { RunDiffSummary } from '../src/native-run-diff.ts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
const agent = (output = 'Informe', status: AgentOutcome['status'] = 'passed'): AgentOutcome => ({ status, exitCode: status === 'passed' ? 0 : 1, durationMs: 5, output, truncated: false });
const changed = (...files: string[]): RunDiffSummary => ({ available: true, files: files.map(file => ({ path: file, change: 'modified' as const, preexisting: false })), count: files.length });
const gate = (id: string, status: GateSummary['status']): GateSummary => ({ id, status });
const evidence = (id: string, status: 'passed' | 'failed', exitCode: number) => ({ gate: id, kind: 'test' as const, command: 'npm test', status, exitCode, source: 'ide-gate' as const });

/** A verification that fails with `output`, as the engine reports it. */
const failing = (output: string, files = changed('src/sum.ts'), id = 'test'): ChatImplementOutcome => ({
	agent: agent(), diff: files,
	verification: { status: 'failed', gates: [gate(id, 'failed')], evidence: [evidence(id, 'failed', 1)], failures: [{ id, exitCode: 1, output }] }
});
const passing = (files = changed('src/sum.ts')): ChatImplementOutcome => ({ agent: agent('Listo'), diff: files, verification: { status: 'passed', gates: [gate('test', 'passed')], evidence: [evidence('test', 'passed', 0)] } });

async function session(results: ChatImplementOutcome[], extra: Partial<ChatRuntime> = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-junior-'));
	const calls: Array<{ kind: string; instruction: string }> = [];
	const runtime: ChatRuntime = {
		async context() { return { root: '/repo', writer: true, skills: [], guides: [], verification: { revision: 'c'.repeat(64), gates: [{ id: 'test', command: 'npm test' }] } }; },
		async converse(_provider, instruction, hooks) { calls.push({ kind: 'converse', instruction }); hooks.started(() => undefined); return agent('Respuesta'); },
		async implement(request, hooks) {
			calls.push({ kind: 'implement', instruction: request.instruction });
			hooks.started(() => undefined);
			return results.shift() ?? passing();
		},
		...extra
	};
	const store = new ChatStore(directory);
	const chat = new HarnessChatSession(store, runtime, () => undefined, t);
	await chat.open();
	return { chat, calls, store, directory, runtime, cleanup: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
const runs = (chat: HarnessChatSession) => chat.snapshot().messages.filter(message => message.run).map(message => message.run!);

test('J-02/J-05: a failing test is corrected and verified again with a single prompt, and the history keeps both runs with evidence', async () => {
	const s = await session([failing('not ok 1 - suma\n  expected 3, received 4'), passing()]);
	try {
		await s.chat.send('Correg\u00ed la suma del carrito', 'act');
		const [first, second] = runs(s.chat);
		assert.deepEqual({ calls: s.calls.map(call => call.kind), first: first.outcome?.kind, second: second.outcome?.kind, assurance: second.outcome?.assurance, repair: second.repair, evidence: second.evidence?.[0].status, busy: s.chat.busy },
			{ calls: ['implement', 'implement'], first: 'failed', second: 'completed', assurance: 'verified', repair: { attempt: 1, max: 2 }, evidence: 'passed', busy: false });
		// The correction carries only the classified failure and its output, plus the rule that gates may never be weakened.
		assert.match(s.calls[1].instruction, /Automatic correction 1 of 2/);
		assert.match(s.calls[1].instruction, /class="test-failure"/);
		assert.match(s.calls[1].instruction, /expected 3, received 4/);
		assert.match(s.calls[1].instruction, /Forbidden: skipping, deleting or weakening tests/);
		// Gate output is memory only: it never reaches the stored history.
		const stored = await fs.readFile(path.join(s.directory, 'conversation.json'), 'utf8');
		assert.ok(!stored.includes('received 4') && !stored.includes('"failures"'));
		assert.match(s.chat.snapshot().messages.map(message => message.text).join('\n'), /las estoy corrigiendo: intento 1 de 2/);
	} finally { await s.cleanup(); }
});

test('J-14: the same failure after a correction is a stall; the loop stops and says why instead of retrying', async () => {
	const s = await session([failing('FAIL suma expected 3 (12 ms)'), failing('FAIL suma expected 3 (40 ms)'), passing()]);
	try {
		await s.chat.send('Correg\u00ed la suma', 'act');
		const last = runs(s.chat).at(-1)!;
		assert.deepEqual({ calls: s.calls.length, stop: last.repairStop?.reason, failures: last.repairStop?.failures, kind: last.outcome?.kind },
			{ calls: 2, stop: 'stalled', failures: [{ gate: 'test', failure: 'test-failure' }], kind: 'failed' });
	} finally { await s.cleanup(); }
});

test('J-14: the correction budget is MAX_CORRECTIONS; exhausting it never pretends success', async () => {
	const s = await session([failing('FAIL a'), failing('FAIL b'), failing('FAIL c'), passing()]);
	try {
		await s.chat.send('Correg\u00ed todo', 'act');
		const all = runs(s.chat);
		assert.deepEqual({ calls: s.calls.length, kinds: all.map(run => run.outcome?.kind), stop: all.at(-1)!.repairStop?.reason },
			{ calls: 3, kinds: ['failed', 'failed', 'failed'], stop: 'budget' });
	} finally { await s.cleanup(); }
});

test('J-15/JUN-002: environment, dependency and permission failures are never "repaired" as code', async () => {
	for (const [output, failure] of [['connect ECONNREFUSED 127.0.0.1:5432', 'service-down'], [`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'`, 'dependency-missing'], ['EACCES: permission denied', 'permission-denied']] as const) {
		const s = await session([failing(output), passing()]);
		try {
			await s.chat.send('Agreg\u00e1 el endpoint de clientes', 'act');
			const last = runs(s.chat).at(-1)!;
			assert.deepEqual({ calls: s.calls.length, stop: last.repairStop }, { calls: 1, stop: { reason: 'not-repairable', failures: [{ gate: 'test', failure }] } });
		} finally { await s.cleanup(); }
	}
});

test('a correction that changes no file stops instead of looping; a cancelled run is never corrected', async () => {
	const s = await session([failing('FAIL a'), failing('FAIL b', changed())]);
	try {
		await s.chat.send('Correg\u00ed', 'act');
		assert.equal(runs(s.chat).at(-1)!.repairStop?.reason, 'no-changes');
	} finally { await s.cleanup(); }
	const cancelled = await session([{ agent: agent('', 'cancelled'), diff: changed('a.ts'), verification: { status: 'cancelled', gates: [] } }, passing()]);
	try {
		await cancelled.chat.send('Correg\u00ed', 'act');
		assert.equal(cancelled.calls.length, 1);
	} finally { await cancelled.cleanup(); }
});

test('J-16: a direct run without gates is "applied, not verified", never verified', async () => {
	const s = await session([{ agent: agent(), diff: changed('README.md'), verification: { status: 'skipped', gates: [], evidence: [{ gate: 'verification', kind: 'other', status: 'skipped', source: 'ide-gate', reason: 'no verification gates configured or detected for this project' }] } }]);
	try {
		await s.chat.send('Correg\u00ed el typo del README', 'act');
		const run = runs(s.chat)[0];
		assert.deepEqual({ kind: run.outcome?.kind, assurance: run.outcome?.assurance, evidence: run.evidence?.[0].status }, { kind: 'completed', assurance: 'unverified', evidence: 'skipped' });
	} finally { await s.cleanup(); }
});

test('J-04/J-20: a compound request starts the goal engine once; a trivial one stays on the fast direct writer', async () => {
	const goals: string[] = [];
	const s = await session([], { startGoal: async objective => { goals.push(objective); return { started: true }; } });
	try {
		await s.chat.send('Hac\u00e9 una API en Go con su frontend en Next.js para reservas, con login y base de datos', 'act');
		assert.deepEqual({ goals: goals.length, calls: s.calls.length, route: s.chat.snapshot().routing?.route }, { goals: 1, calls: 0, route: 'compound-goal' });
		assert.match(s.chat.snapshot().messages.map(message => message.text).join('\n'), /objetivo aut\u00f3nomo por etapas/);
		await s.chat.send('Renombr\u00e1 total a subtotal', 'act');
		assert.deepEqual({ goals: goals.length, calls: s.calls.map(call => call.kind), route: s.chat.snapshot().routing?.route }, { goals: 1, calls: ['implement'], route: 'simple-edit' });
	} finally { await s.cleanup(); }
});

test('J-08/JUN-008: a goal that does not start keeps the request suspended, and Retomar runs it through the normal path', async () => {
	let answer: 'declined' | undefined = 'declined';
	const s = await session([], { startGoal: async () => answer ? { started: false, reason: answer } : { started: true } });
	try {
		await s.chat.send('Creame una app de clientes con login, roles y base de datos', 'act');
		const suspended = s.chat.snapshot().suspended!;
		assert.deepEqual(suspended.map(item => ({ reason: item.reason, mode: item.mode })), [{ reason: 'preflight', mode: 'act' }]);
		answer = undefined;
		await s.chat.resumeSuspended(suspended[0].id);
		assert.equal(s.chat.snapshot().suspended, undefined);
		await assert.rejects(s.chat.resumeSuspended('deadbeefdead'), /HARNESS_CHAT_SUSPENDED_MISSING/);
	} finally { await s.cleanup(); }
});

/** A reviewer that answers with these `harness-review` blocks in order, recording what it was asked. */
const reviewer = (answers: string[], asked: Array<{ implementer: string; instruction: string; files: string[] }> = []): ChatRuntime['review'] => async (implementer, instruction, diff) => {
	asked.push({ implementer, instruction, files: diff.files.map(file => file.path) });
	return { provider: 'codex', status: 'passed', output: answers.shift() ?? '```harness-review\n{"findings":[],"score":9}\n```' };
};
const blockingReview = (text: string) => '```harness-review\n{"findings":[{"severity":"blocking","text":"' + text + '","file":"src/sum.ts"}],"score":4}\n```';

test('a verified change gets an independent review; blocking findings are corrected, verified and reviewed again', async () => {
	const asked: Array<{ implementer: string; instruction: string; files: string[] }> = [];
	const s = await session([passing(), passing()], { review: reviewer([blockingReview('La suma ignora los descuentos')], asked) });
	try {
		await s.chat.send('Corregí la suma del carrito', 'act');
		const notices = s.chat.snapshot().messages.filter(message => message.role === 'notice').map(message => message.text).join('\n');
		assert.deepEqual({ calls: s.calls.map(call => call.kind), reviews: asked.length, implementer: asked[0].implementer, files: asked[0].files, repair: runs(s.chat)[1].repair, ok: !s.chat.busy },
			{ calls: ['implement', 'implement'], reviews: 2, implementer: 'claude', files: ['src/sum.ts'], repair: { attempt: 1, max: 2 }, ok: true });
		assert.match(asked[0].instruction, /harness-review/);
		assert.match(s.calls[1].instruction, /Review correction 1 of 2[\s\S]*La suma ignora los descuentos/);
		assert.match(notices, /aprobada, puntaje 9 de 10/);
	} finally { await s.cleanup(); }
});

test('the review is bounded: findings left after the corrections are shown and the task is not called done', async () => {
	const s = await session([passing(), passing(), passing()], { review: reviewer([blockingReview('A'), blockingReview('B'), blockingReview('C')]) });
	try {
		await s.chat.send('Corregí la suma del carrito', 'act');
		const last = s.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({ calls: s.calls.length, tone: last.tone }, { calls: 3, tone: 'error' });
		assert.match(last.text, /todavía marca 1 problemas después de 2 correcciones[\s\S]*C/);
	} finally { await s.cleanup(); }
});

test('no review without changes, after failed gates, or when the reviewer cannot answer; a broken review never blocks a verified change', async () => {
	let reviews = 0;
	const avoided: string[] = [];
	const counting: ChatRuntime['review'] = async avoid => { reviews++; avoided.push(avoid); return { provider: 'codex', status: 'passed', output: 'sin bloque' }; };
	const unchanged = await session([passing(changed())], { review: counting });
	try { await unchanged.chat.send('Revisá el README', 'act'); } finally { await unchanged.cleanup(); }
	const failed = await session([failing('ECONNREFUSED 127.0.0.1:5432')], { review: counting });
	try { await failed.chat.send('Corregí la suma', 'act'); } finally { await failed.cleanup(); }
	assert.equal(reviews, 0);
	const invalid = await session([passing()], { review: counting });
	try {
		await invalid.chat.send('Corregí la suma', 'act');
		// The reviewer that answered without a valid block hands the review to the other provider once.
		assert.deepEqual({ reviews, avoided, calls: invalid.calls.length }, { reviews: 2, avoided: ['claude', 'codex'], calls: 1 });
		assert.match(invalid.chat.snapshot().messages.at(-1)!.text, /no devolvió un resultado válido/);
	} finally { await invalid.cleanup(); }
});

test('a reviewer that cannot run because of a usage limit says why instead of reporting an invalid answer', async () => {
	const limited: ChatRuntime['review'] = async () => ({ provider: 'codex', status: 'failed', output: 'You have hit your usage limit. Try again later.' });
	const s = await session([passing()], { review: limited });
	try {
		await s.chat.send('Corregi la suma', 'act');
		assert.match(s.chat.snapshot().messages.at(-1)!.text, /no se pudo hacer: You have hit your usage limit/);
	} finally { await s.cleanup(); }
});

test('a goal engine that fails to start says why and the request continues on the direct writer', async () => {
	const s = await session([], { startGoal: async () => { throw Error('HARNESS_SOMETHING_BROKE'); } });
	try {
		await s.chat.send('Creame una app de clientes con login, roles y base de datos', 'act');
		assert.deepEqual({ calls: s.calls.map(call => call.kind), suspended: s.chat.snapshot().suspended }, { calls: ['implement'], suspended: undefined });
		assert.match(s.chat.snapshot().messages.map(message => message.text).join('\n'), /HARNESS_SOMETHING_BROKE/);
	} finally { await s.cleanup(); }
});

test('in Act an instruction always reaches a writer, whatever it mentions; only a one-line question is answered read-only', async () => {
	const s = await session([]);
	try {
		await s.chat.send('Deploy\u00e1 la app a producci\u00f3n', 'act');
		await s.chat.send('\u00bfQu\u00e9 hace la funci\u00f3n total?', 'act');
		assert.deepEqual(s.calls.map(call => call.kind), ['implement', 'converse']);
		assert.match(s.calls[1].instruction, /Answer it read-only/);
	} finally { await s.cleanup(); }
});

test('Ask resolves the request: an answer, or the complete plan with assumptions; it asks only for a fact the project does not hold', async () => {
	const s = await session([]);
	try {
		await s.chat.send('Agregá un filtro por fecha al listado', 'ask');
		assert.deepEqual({ calls: s.calls.map(call => call.kind) }, { calls: ['converse'] });
		assert.match(s.calls[0].instruction, /propose the complete plan now, with reasonable assumptions/);
		assert.match(s.calls[0].instruction, /Never modify files now/);
	} finally { await s.cleanup(); }
});

test('J-13/J-12: a provider failure and a failed turn keep the request and the queue suspended across a restart, editable and discardable', async () => {
	const s = await session([]);
	let release!: () => void;
	s.runtime.converse = async (_provider, instruction, hooks) => {
		s.calls.push({ kind: 'converse', instruction });
		hooks.started(() => undefined);
		await new Promise<void>(resolve => { release = resolve; });
		return agent('', 'failed');
	};
	try {
		const first = s.chat.send('explicame el m\u00f3dulo de pagos');
		while (!s.chat.busy || !release) { await new Promise(resolve => setImmediate(resolve)); }
		await s.chat.send('y agreg\u00e1 un test para pagos', 'act');
		release(); await first;
		const held = s.chat.snapshot().suspended!;
		assert.deepEqual(held.map(item => [item.text, item.reason, item.mode]), [['explicame el m\u00f3dulo de pagos', 'previous-failed', 'ask'], ['y agreg\u00e1 un test para pagos', 'previous-failed', 'act']]);
		assert.equal(s.calls.length, 1);
		// A restarted IDE (a new session on the same store) adopts the requests; nothing runs by itself.
		const reopened = new HarnessChatSession(new ChatStore(s.directory), s.runtime, () => undefined, t);
		await reopened.open();
		assert.deepEqual(reopened.snapshot().suspended?.map(item => item.text), held.map(item => item.text));
		assert.equal(s.calls.length, 1);
		assert.equal(await reopened.dropSuspended(held[1].id), 'y agreg\u00e1 un test para pagos');
		assert.equal(await reopened.dropSuspended(held[0].id), 'explicame el m\u00f3dulo de pagos');
		assert.equal(reopened.snapshot().suspended, undefined);
	} finally { await s.cleanup(); }
});

test('J-12: an interrupted direct run says what stage it reached and keeps the request instead of re-running it', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-junior-crash-'));
	try {
		const now = new Date().toISOString();
		await fs.writeFile(path.join(directory, 'conversation.json'), JSON.stringify({
			schemaVersion: 1, provider: 'claude', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
			messages: [{ id: 'u1', role: 'user', text: 'Agreg\u00e1 validaci\u00f3n al alta', at: now }],
			pending: [{ kind: 'executing', startedAt: now, planVersion: 0, pid: 999999, stage: 'verifying' }]
		}));
		let implemented = 0;
		const runtime: ChatRuntime = {
			async context() { return { root: '/repo', writer: true, skills: [], guides: [] }; },
			async converse() { return agent(); },
			async implement() { implemented++; return passing(); }
		};
		const chat = new HarnessChatSession(new ChatStore(directory), runtime, () => undefined, t);
		await chat.open();
		const notice = chat.snapshot().messages.at(-1)!.text;
		assert.match(notice, /la verificaci\u00f3n qued\u00f3 incompleta y no cuenta como aprobada/);
		assert.deepEqual({ suspended: chat.snapshot().suspended?.map(item => [item.text, item.reason, item.mode]), implemented }, { suspended: [['Agreg\u00e1 validaci\u00f3n al alta', 'interrupted', 'act']], implemented: 0 });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('J-06/J-15/JUN-005: a "this task" grant covers the automatic correction without a new card; a deny is never turned into a grant', async () => {
	const card = { kind: 'run' as const, title: 'Run', detail: ['command: pnpm install --frozen-lockfile'], rule: 'run:pnpm install --frozen-lockfile' };
	for (const answer of ['task', 'deny'] as const) {
		const answers: string[] = [];
		const results = [failing('FAIL suma'), passing()];
		const s = await session([], {
			async implement(_request, hooks) {
				hooks.started(() => undefined);
				answers.push(await hooks.approval!(card));
				return results.shift()!;
			}
		});
		try {
			const running = s.chat.send('Correg\u00ed la suma', 'act');
			while (!s.chat.snapshot().approvals) { await new Promise(resolve => setImmediate(resolve)); }
			await s.chat.resolveApproval(s.chat.snapshot().approvals![0].id, answer);
			if (answer === 'deny') {
				// The correction asks again (the deny was for that call only) and is denied again by the user.
				while (!s.chat.snapshot().approvals) { await new Promise(resolve => setImmediate(resolve)); }
				await s.chat.resolveApproval(s.chat.snapshot().approvals![0].id, 'deny');
			}
			await running;
			assert.deepEqual(answers, answer === 'task' ? ['task', 'once'] : ['deny', 'deny']);
			// The task ended: its grant is gone, so the next request asks again.
			assert.equal(s.chat.snapshot().grants, undefined);
		} finally { await s.cleanup(); }
	}
});
