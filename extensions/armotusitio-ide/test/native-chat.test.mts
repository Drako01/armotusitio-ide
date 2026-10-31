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
	ChatStore, buildConversationInstruction, buildImplementationInstruction, chatMessage, chatPlanDigest, extractChatPlan, latestPlan,
	type ChatProjectContext
} from '../src/native-chat.ts';

const context: ChatProjectContext = {
	root: '/repo', writer: true, guides: ['AGENTS.md'], skills: [{ name: 'api', source: '.agents/skills' }],
	verification: { revision: 'a'.repeat(64), gates: [{ id: 'test', command: 'npm run test' }] }
};
const block = (value: object) => '```harness-plan\n' + JSON.stringify(value) + '\n```';

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
