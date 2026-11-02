/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/native-chat.ts';
import { HarnessChatSession, type ChatRuntime, type ChatSnapshot } from '../src/native-chat-session.ts';
import { APPROVAL_TIMEOUT_MS, type ApprovalDraft } from '../src/native-approval.ts';
import type { ApprovalAnswer } from '../src/native-permissions-types.ts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
const CARD: ApprovalDraft = { kind: 'run', title: 'Run', detail: ['command: pnpm test', 'cwd: .'], rule: 'run:pnpm test' };

/** A writer that asks for approval mid-run and waits for the answer, like `ats-runner` does through the channel. */
async function actingSession(options: { remember?: (rule: string) => Promise<void>; card?: ApprovalDraft } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-approvals-'));
	const snapshots: ChatSnapshot[] = [];
	const remembered: string[] = [];
	let asked: Promise<ApprovalAnswer> | undefined, release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const runtime: ChatRuntime = {
		async context() { return { root: '/repo', writer: true, skills: [], guides: [] }; },
		async converse() { throw Error('unused'); },
		rememberApproval: options.remember ?? (async rule => { remembered.push(rule); }),
		async implement(_request, hooks) {
			hooks.started(() => undefined);
			asked = hooks.approval!(options.card ?? CARD);
			await gate;
			const agent = { status: 'passed' as const, exitCode: 0, durationMs: 1, output: 'listo', truncated: false };
			return { agent, verification: { status: 'skipped' as const, gates: [] }, diff: { available: false, files: [], count: 0 } };
		}
	};
	const chat = new HarnessChatSession(new ChatStore(directory), runtime, snapshot => snapshots.push(snapshot), t);
	await chat.open();
	const running = chat.send('subi los cambios', 'act');
	// The writer is waiting on its approval card once the snapshot lists it.
	while (!chat.snapshot().approvals) { await new Promise(resolve => setImmediate(resolve)); }
	return { chat, snapshots, remembered, answer: () => asked!, release, running, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('an approval requested by the writer is a card in the snapshot until the user answers', async () => {
	const s = await actingSession();
	try {
		const [card] = s.chat.snapshot().approvals!;
		assert.deepEqual({ ...card, id: card.id.startsWith('ap-') && card.id.length <= 64 }, { id: true, kind: 'run', title: 'Ejecutar un comando', detail: CARD.detail, rule: 'run:pnpm test' });
		await s.chat.resolveApproval(card.id, 'once');
		assert.deepEqual({ answer: await s.answer(), left: s.chat.snapshot().approvals, remembered: s.remembered, busy: s.chat.busy }, { answer: 'once', left: undefined, remembered: [], busy: true });
		s.release(); await s.running;
		assert.equal(s.chat.snapshot().messages.at(-1)?.role, 'run');
	} finally { s.release(); await s.running.catch(() => undefined); await s.cleanup(); }
});

test('"always" stores the rule in the user permissions and tells the user, "deny" stores nothing', async () => {
	const always = await actingSession();
	try {
		await always.chat.resolveApproval(always.chat.snapshot().approvals![0].id, 'always');
		always.release(); await always.running;
		const notice = always.chat.snapshot().messages.find(message => message.role === 'notice' && /permissions\.json/.test(message.text));
		assert.deepEqual({ answer: await always.answer(), remembered: always.remembered, notice: notice?.text.includes('«run:pnpm test»') }, { answer: 'always', remembered: ['run:pnpm test'], notice: true });
	} finally { await always.cleanup(); }
	const denied = await actingSession();
	try {
		await denied.chat.resolveApproval(denied.chat.snapshot().approvals![0].id, 'deny');
		denied.release(); await denied.running;
		assert.deepEqual({ answer: await denied.answer(), remembered: denied.remembered }, { answer: 'deny', remembered: [] });
	} finally { await denied.cleanup(); }
});

test('when the rule cannot be saved the action is allowed only once and the user is told', async () => {
	const s = await actingSession({ remember: async () => { throw Error('PERMISSIONS_FILE_UNSAFE'); } });
	try {
		await s.chat.resolveApproval(s.chat.snapshot().approvals![0].id, 'always');
		s.release(); await s.running;
		const notice = s.chat.snapshot().messages.find(message => message.role === 'notice');
		assert.deepEqual({ answer: await s.answer(), tone: notice?.tone, text: /solo esta vez/.test(notice?.text ?? '') }, { answer: 'once', tone: 'error', text: true });
	} finally { await s.cleanup(); }
});

test('unknown ids and answers outside the closed list change nothing', async () => {
	const s = await actingSession();
	try {
		const { id } = s.chat.snapshot().approvals![0];
		await s.chat.resolveApproval('ap-unknown', 'once');
		await s.chat.resolveApproval(id, 'sure' as ApprovalAnswer);
		assert.deepEqual(s.chat.snapshot().approvals?.map(card => card.id), [id]);
		await s.chat.resolveApproval(id, 'deny');
		await s.chat.resolveApproval(id, 'once');
		assert.equal(await s.answer(), 'deny');
	} finally { s.release(); await s.running.catch(() => undefined); await s.cleanup(); }
});

test('cancelling the turn denies the pending approvals at once', async () => {
	const s = await actingSession();
	try {
		s.chat.cancel();
		assert.deepEqual({ answer: await s.answer(), left: s.chat.snapshot().approvals }, { answer: 'deny', left: undefined });
	} finally { s.release(); await s.running.catch(() => undefined); await s.cleanup(); }
});

test('an approval still pending when the turn ends is denied and dropped', async () => {
	const s = await actingSession();
	try {
		s.release(); await s.running;
		assert.deepEqual({ answer: await s.answer(), left: s.chat.snapshot().approvals }, { answer: 'deny', left: undefined });
		assert.equal(s.snapshots.at(-1)?.approvals, undefined);
	} finally { await s.cleanup(); }
});

test('nobody answering for ten minutes is a denial', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	const s = await actingSession();
	try {
		mock.timers.tick(APPROVAL_TIMEOUT_MS);
		assert.deepEqual({ answer: await s.answer(), left: s.chat.snapshot().approvals }, { answer: 'deny', left: undefined });
	} finally { mock.timers.reset(); s.release(); await s.running.catch(() => undefined); await s.cleanup(); }
});

test('without a running turn there is nothing to approve', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-approvals-'));
	try {
		let hooks: Parameters<ChatRuntime['converse']>[2] | undefined;
		const runtime: ChatRuntime = {
			async context() { return { root: '/repo', writer: true, skills: [], guides: [] }; },
			async converse(_provider, _instruction, given) { hooks = given; return { status: 'passed', exitCode: 0, durationMs: 1, output: 'ok', truncated: false }; },
			async implement() { throw Error('unused'); }
		};
		const chat = new HarnessChatSession(new ChatStore(directory), runtime, () => undefined, t);
		await chat.open();
		await chat.send('hola', 'ask');
		assert.equal(await hooks!.approval!(CARD), 'deny');
		assert.equal(chat.snapshot().approvals, undefined);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});


test('git approvals without a rememberable rule reject always and still allow once', async () => {
	const s = await actingSession({ card: { kind: 'git_push', title: 'Push', detail: ['branch: feat/x'], rule: '' } });
	try {
		const card = s.chat.snapshot().approvals![0];
		await s.chat.resolveApproval(card.id, 'always');
		assert.equal(s.chat.snapshot().approvals?.length, 1);
		await s.chat.resolveApproval(card.id, 'once');
		assert.deepEqual({ answer: await s.answer(), remembered: s.remembered }, { answer: 'once', remembered: [] });
	} finally { s.release(); await s.running; await s.cleanup(); }
});

test('cancelling while a rule is being persisted cannot approve the pending command', async () => {
	let saved!: () => void;
	const writing = new Promise<void>(resolve => { saved = resolve; });
	const s = await actingSession({ remember: () => writing });
	try {
		const resolving = s.chat.resolveApproval(s.chat.snapshot().approvals![0].id, 'always');
		s.chat.cancel();
		saved(); await resolving;
		assert.equal(await s.answer(), 'deny');
	} finally { saved(); s.release(); await s.running; await s.cleanup(); }
});
