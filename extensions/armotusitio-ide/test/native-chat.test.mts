/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	pendingAlive, ChatStore, buildConversationInstruction, buildImplementationInstruction, chatMessage, chatPlanDigest, extractChatPlan, latestPlan,
	type ChatProjectContext
} from '../src/native-chat.ts';

const context: ChatProjectContext = {
	root: '/repo', writer: true, guides: ['AGENTS.md'], skills: [{ name: 'api', source: '.agents/skills' }],
	verification: { revision: 'a'.repeat(64), gates: [{ id: 'test', command: 'npm run test' }] }
};
const block = (value: object) => '```harness-plan\n' + JSON.stringify(value) + '\n```';

test('the current message is always sent whole: project detail and history give way to it, never the reverse', () => {
	// The reported case: a 3.4 KB message in a project with many skills and guides, on the smallest budget.
	const crowded: ChatProjectContext = {
		...context, guides: Array.from({ length: 30 }, (_, index) => 'docs/guide-' + index + '.md'),
		skills: Array.from({ length: 80 }, (_, index) => ({ name: 'redevent-skill-' + index, source: '.agents/skills' }))
	};
	const message = 'Plan de cobertura: ' + 'tanda con tests de caracterización '.repeat(95);
	const history = [...Array.from({ length: 40 }, (_, index) => chatMessage(index % 2 ? 'assistant' : 'user', 'mensaje anterior ' + index + ' ' + 'x'.repeat(900))), chatMessage('user', message)];
	const small = buildConversationInstruction(history, crowded);
	const large = buildConversationInstruction(history, { ...crowded, promptBudget: 64 * 1024 });
	assert.deepEqual({
		whole: small.endsWith('[user] ' + message), fits: Buffer.byteLength(small, 'utf8') <= 13 * 1024, compact: small.includes('(+40 more)'),
		largeKeepsDetail: large.includes('.agents/skills/redevent-skill-79/SKILL.md'), largeHasMoreHistory: large.split('mensaje anterior').length > small.split('mensaje anterior').length
	}, { whole: true, fits: true, compact: true, largeKeepsDetail: true, largeHasMoreHistory: true });
	// Only a message that cannot fit even alone is rejected.
	assert.throws(() => buildConversationInstruction([chatMessage('user', 'z'.repeat(14 * 1024))], crowded), /HARNESS_CHAT_MESSAGE_TOO_LARGE/);
});

test('assistant answers keep Markdown visible and expose only the last valid versioned plan', () => {
	const answer = 'Te propongo esto:\n\n' + block({ title: 'Draft', steps: ['a'] }) + '\n\nY ajustado:\n' +
		block({ title: 'CRUD de clientes', summary: 'API y UI', steps: ['Modelo', 'Endpoints'], files: ['src/clients.ts'], skills: ['api'] }) +
		'\n```harness-plan\n{not json}\n```';
	const { text, plan } = extractChatPlan(answer, 3);
	assert.deepEqual({ title: plan?.title, version: plan?.version, steps: plan?.steps, risks: plan?.risks, digest: plan?.digest === chatPlanDigest(plan!) },
		{ title: 'CRUD de clientes', version: 3, steps: ['Modelo', 'Endpoints'], risks: [], digest: true });
	assert.equal(text.includes('harness-plan\n{"title"'), false);
	assert.match(text, /\{not json\}/);
	// Plans without steps, oversized lists or more than eight skills are never approvable.
	for (const invalid of [{ title: 'x', steps: [] }, { title: 'x', steps: ['a'], skills: Array(9).fill('s') }, { steps: ['a'] }, { title: 'x', steps: Array(31).fill('a') }]) {
		assert.equal(extractChatPlan(block(invalid), 1).plan, undefined);
	}
});

test('conversation prompts are read-only, bounded and carry project facts and the current plan', () => {
	const plan = extractChatPlan(block({ title: 'Plan', steps: ['Uno'] }), 1).plan!;
	const messages = [...Array.from({ length: 60 }, (_, index) => chatMessage(index % 2 ? 'assistant' : 'user', 'mensaje ' + index + ' ' + 'x'.repeat(900))), chatMessage('user', 'Quiero agregar un CRUD de clientes')];
	const instruction = buildConversationInstruction(messages, context, plan);
	assert.ok(Buffer.byteLength(instruction) < 14 * 1024);
	assert.match(instruction, /Never modify files now/);
	assert.match(instruction, /Current plan \(v1\)/);
	assert.match(instruction, /npm run test/);
	assert.match(instruction, /api \(\.agents\/skills\/api\/SKILL\.md\)/);
	assert.ok(instruction.trimEnd().endsWith('[user] Quiero agregar un CRUD de clientes'));
	assert.equal(instruction.includes('mensaje 0 '), false);
	assert.throws(() => buildConversationInstruction([chatMessage('assistant', 'hola')], context), /HARNESS_CHAT_TURN_INVALID/);
	assert.match(buildConversationInstruction([chatMessage('user', 'hola')], { ...context, writer: false }), /governed by its own Harness/);
	const implementation = buildImplementationInstruction(plan, messages);
	assert.match(implementation, /Implement the approved plan v1/);
	assert.ok(Buffer.byteLength(implementation) < 14 * 1024);
});

test('chat store persists per project, trims history and quarantines corrupt state', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-store-'));
	try {
		const store = new ChatStore(path.join(directory, 'chat'));
		assert.deepEqual((await store.load('codex')).conversation, { schemaVersion: 1, provider: 'codex', messages: [] });
		const plan = extractChatPlan(block({ title: 'Plan', steps: ['Uno'] }), 1).plan!;
		const messages = Array.from({ length: 205 }, (_, index) => chatMessage('user', 'm' + index));
		messages.push(chatMessage('assistant', 'ok', { provider: 'claude', plan }));
		await store.save({ schemaVersion: 1, provider: 'claude', messages });
		const loaded = (await store.load('codex')).conversation;
		assert.deepEqual({ provider: loaded.provider, count: loaded.messages.length, last: latestPlan(loaded.messages)?.digest }, { provider: 'claude', count: 200, last: plan.digest });
		// A tampered plan breaks its digest: the whole state is quarantined, not partially trusted.
		const file = path.join(directory, 'chat', 'conversation.json');
		const raw = JSON.parse(await fs.readFile(file, 'utf8'));
		raw.messages.at(-1).plan.steps = ['rm -rf'];
		await fs.writeFile(file, JSON.stringify(raw));
		const recovered = await store.load('codex');
		assert.deepEqual({ recovered: recovered.recovered, messages: recovered.conversation.messages.length }, { recovered: true, messages: 0 });
		assert.ok((await fs.readdir(path.join(directory, 'chat'))).some(name => name.endsWith('.corrupt')));
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('chat store accepts the lower-case drive letter that VS Code reports for global storage on Windows', { skip: process.platform !== 'win32' }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-drive-'));
	try {
		const lower = directory[0].toLowerCase() + directory.slice(1);
		const store = new ChatStore(path.join(lower, 'chat'));
		await store.save({ schemaVersion: 1, provider: 'codex', messages: [chatMessage('user', 'hola')] });
		assert.equal((await store.load('claude')).conversation.messages.length, 1);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('two IDE windows on one project never drop each other messages and respect a reset', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-windows-'));
	try {
		const first = new ChatStore(directory), second = new ChatStore(directory);
		const seed = chatMessage('user', 'seed');
		await first.load('claude'); await first.save({ schemaVersion: 1, provider: 'claude', messages: [seed] });
		const a = (await first.load('claude')).conversation, b = (await second.load('claude')).conversation;
		const fromA = chatMessage('user', 'desde A'), fromB = chatMessage('user', 'desde B');
		await first.save({ ...a, messages: [...a.messages, fromA] });
		const merged = await second.save({ ...b, messages: [...b.messages, fromB] });
		assert.deepEqual(merged.map(message => message.text), ['seed', 'desde A', 'desde B']);
		// Window A starts a new conversation; B's next message must not resurrect the old history.
		await first.save({ schemaVersion: 1, provider: 'claude', messages: [] }, { replace: true });
		const afterReset = await second.save({ schemaVersion: 1, provider: 'claude', messages: [...merged, chatMessage('user', 'nuevo en B')] });
		assert.deepEqual(afterReset.map(message => message.text), ['nuevo en B']);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('review #2: interleaved saves from two windows never lose a message', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-race-'));
	try {
		const first = new ChatStore(directory), second = new ChatStore(directory);
		await first.load('claude'); await second.load('claude');
		const sent: string[] = [];
		// Each window adopts what `save` returns, exactly as the session does, while both save concurrently.
		let windowA: ReturnType<typeof chatMessage>[] = [], windowB: ReturnType<typeof chatMessage>[] = [];
		for (let index = 0; index < 20; index++) {
			sent.push('A' + index, 'B' + index);
			[windowA, windowB] = await Promise.all([
				first.save({ schemaVersion: 1, provider: 'claude', messages: [...windowA, chatMessage('user', 'A' + index)] }),
				second.save({ schemaVersion: 1, provider: 'claude', messages: [...windowB, chatMessage('user', 'B' + index)] })
			]);
		}
		const stored = new Set((await new ChatStore(directory).load('claude')).conversation.messages.map(message => message.text));
		assert.deepEqual(sent.filter(text => !stored.has(text)), []);
		assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.lock')), false);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('verification: legacy pending marker, lock ownership and expired markers', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-verify-'));
	const { spawn } = await import('node:child_process');
	const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
	try {
		const file = path.join(directory, 'conversation.json');
		// A conversation written by an earlier build with a single marker object stays readable.
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, provider: 'codex', messages: [chatMessage('user', 'hola')], pending: { kind: 'thinking', startedAt: new Date().toISOString() } }));
		const legacy = await new ChatStore(directory).load('claude');
		assert.deepEqual({ recovered: legacy.recovered, messages: legacy.conversation.messages.length, pending: legacy.conversation.pending?.length }, { recovered: false, messages: 1, pending: 1 });
		// A lock left by a dead process is removed; a lock held by a live process is never stolen.
		const store = new ChatStore(directory);
		await store.load('claude');
		await fs.writeFile(file + '.lock', '999999999:abandoned');
		await store.save({ schemaVersion: 1, provider: 'claude', messages: [] });
		assert.equal((await fs.readdir(directory)).some(name => name.includes('.lock')), false);
		await fs.writeFile(file + '.lock', live.pid + ':held');
		await assert.rejects(store.save({ schemaVersion: 1, provider: 'claude', messages: [] }), /HARNESS_CHAT_STATE_BUSY/);
		assert.equal(await fs.readFile(file + '.lock', 'utf8'), live.pid + ':held');
		// A marker is live only with a living owner and a plausible age: a reused pid cannot hide an interruption forever.
		const now = Date.now();
		assert.deepEqual([
			pendingAlive({ kind: 'executing', startedAt: new Date(now).toISOString(), pid: live.pid }, now),
			pendingAlive({ kind: 'executing', startedAt: new Date(now - 7 * 3600 * 1000).toISOString(), pid: live.pid }, now),
			pendingAlive({ kind: 'thinking', startedAt: new Date(now).toISOString() }, now)
		], [true, false, false]);
	} finally {
		live.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
