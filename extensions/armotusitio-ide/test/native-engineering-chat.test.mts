/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fixture as hostFixture, vscodeFsPath } from './native-integration-fixture.mts';
import { installFakeCodex } from './native-fake-provider.mts';
import { registerNativeHarness } from '../src/native-integration.ts';
import { ChatStore, directPlan } from '../src/native-chat.ts';
import { HarnessChatSession, type ChatRuntime, type TurnTransport } from '../src/native-chat-session.ts';
import { resolveSkillInvocation, skillsListing } from '../src/native-chat-skills.ts';
import { runSessionCommand, type SessionCommandDeps } from '../src/native-chat-commands.ts';
import { ENGINEERING_SKILL_NAMES, engineeringContext, listEngineeringSkills, readEngineeringSkill } from '../src/native-engineering-skills.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';
import type { NativeProvider } from '../src/native-providers.ts';

const shipped = path.resolve(import.meta.dirname, '../resources/engineering-skills');
const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
const passed = (): AgentOutcome => ({ status: 'passed', exitCode: 0, durationMs: 1, output: 'Reviewed the requested scope.', truncated: false });
async function withProject(work: (root: string, storage: string) => Promise<void>): Promise<void> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engineering-chat-')));
	const root = path.join(base, 'project');
	const storage = path.join(base, 'chat');
	await fs.mkdir(root); await fs.mkdir(storage);
	try { await work(root, storage); }
	finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
async function projectSkill(root: string, name: string, content: string): Promise<string> {
	const directory = path.join(root, '.agents', 'skills', name);
	await fs.mkdir(directory, { recursive: true });
	const file = path.join(directory, 'SKILL.md');
	await fs.writeFile(file, content);
	return file;
}
interface RecordedCall { kind: 'converse' | 'implement'; provider: NativeProvider; instruction: string; transport?: TurnTransport }
async function session(root: string, storage: string, provider: NativeProvider, native = false) {
	const calls: RecordedCall[] = [];
	let selected = 0;
	let lastInputRef: string | undefined;
	const runtime: ChatRuntime = {
		async context() { return { root, writer: true, skills: [], guides: [] }; },
		async skills(input) { selected++; return engineeringContext(root, shipped, input); },
		async transport() { return { native, lastInputRef }; },
		async converse(current, instruction, hooks, _signal, transport) {
			calls.push({ kind: 'converse', provider: current, instruction, transport });
			hooks.started(() => undefined);
			lastInputRef = transport?.inputRef;
			return passed();
		},
		async implement(request, hooks) {
			calls.push({ kind: 'implement', provider: request.provider, instruction: request.instruction, transport: request.transport });
			hooks.started(() => undefined);
			return { agent: passed(), verification: { status: 'skipped', gates: [] }, diff: { available: true, count: 0, files: [] } };
		}
	};
	const chat = new HarnessChatSession(new ChatStore(storage), runtime, () => undefined, t, provider);
	await chat.open();
	return { chat, calls, runtime, selections: () => selected };
}

test('the installed catalog contains ten readable skills independent of project configuration', async () => {
	await withProject(async root => {
		const catalog = await listEngineeringSkills(root, shipped);
		const content = await Promise.all(catalog.map(skill => readEngineeringSkill(root, skill, shipped)));
		assert.deepEqual({ names: catalog.map(skill => skill.name).sort(), readable: content.every(body => body.startsWith('---\n') || body.startsWith('---\r\n')), sources: [...new Set(catalog.map(skill => skill.source))] }, {
			names: [...ENGINEERING_SKILL_NAMES].sort(), readable: true, sources: ['native']
		});
	});
});

test('/skills dispatcher and /skill invocation use the shipped catalog and keep project precedence', async () => {
	await withProject(async (root, storage) => {
		const s = await session(root, storage, 'claude');
		const deps: SessionCommandDeps = { t, nativeSkillsDirectory: shipped, chatMode: () => 'ask', setChatMode: async () => undefined, permissionsPreset: () => undefined, openFile: async () => undefined, confirmDiscard: async () => false };
		const listed = await runSessionCommand(deps, 'skills', [], root, s.chat);
		assert.equal(listed, await skillsListing(root, t, shipped));
		assert.equal(listed?.split('\n').filter(line => line.includes('(native)')).length, 10);
		const invoked = await resolveSkillInvocation(root, 'SAFE-REFACTORING Preserve this API', t, shipped);
		assert.ok(typeof invoked !== 'string');
		assert.deepEqual({ message: invoked.message, native: invoked.context.includes('source="native"'), notice: invoked.notice }, { message: 'Preserve this API', native: true, notice: 'Apliqué la skill safe-refactoring (native).' });
		await projectSkill(root, 'safe-refactoring', '# Workspace refactoring contract\nPreserve the project event order.');
		const project = await resolveSkillInvocation(root, 'safe-refactoring', t, shipped);
		assert.ok(typeof project !== 'string');
		assert.deepEqual({ source: project.context.includes('source=".agents/skills"'), ownContract: project.context.includes('Preserve the project event order.'), duplicates: (await skillsListing(root, t, shipped)).split('\n').filter(line => line.includes('safe-refactoring')).length }, { source: true, ownContract: true, duplicates: 1 });
		assert.equal(await resolveSkillInvocation(root, 'unknown-skill', t, shipped), 'No encontré la skill «unknown-skill». Mirá las disponibles con /skills.');
	});
});

for (const provider of ['claude', 'codex'] as const) {
	test(provider + ' ask and act receive relevant engineering guidance through the shared session boundary', async () => {
		await withProject(async (root, storage) => {
			const s = await session(root, storage, provider);
			await s.chat.send('Revisá las abstracciones de este servicio.', 'ask');
			await s.chat.send('Refactorizá este módulo sin romper nada.', 'act');
			assert.deepEqual(s.calls.map(call => ({ kind: call.kind, provider: call.provider, skills: [...call.instruction.matchAll(/<skill name="([^"]+)"/g)].map(match => match[1]) })), [
				{ kind: 'converse', provider, skills: ['abstraction-auditor', 'engineering-principles'] },
				{ kind: 'implement', provider, skills: ['safe-refactoring', 'architecture-guardian'] }
			]);
			assert.equal(s.selections(), 2);
			assert.ok(s.calls.every(call => call.instruction.includes('cannot grant permissions')));
		});
	});

	test(provider + ' explicit /skill guidance suppresses automatic selection for that turn', async () => {
		await withProject(async (root, storage) => {
			const s = await session(root, storage, provider);
			const invocation = await resolveSkillInvocation(root, 'security-by-design Review abstractions in this service', t, shipped);
			assert.ok(typeof invocation !== 'string');
			await s.chat.send(invocation.message, 'ask', { context: invocation.context, notice: invocation.notice });
			assert.deepEqual({ selected: s.selections(), skills: [...s.calls[0].instruction.matchAll(/<skill name="([^"]+)"/g)].map(match => match[1]), recorded: s.chat.snapshot().messages.some(message => message.role === 'notice' && message.text === invocation.notice) }, { selected: 0, skills: ['security-by-design'], recorded: true });
		});
	});

	test(provider + ' native follow-up deduplicates identical guidance and preserves it in fresh-session fallback', async () => {
		await withProject(async (root, storage) => {
			const s = await session(root, storage, provider, true);
			await s.chat.send('Revisá las abstracciones de este servicio.', 'ask');
			await s.chat.send('Revisá las abstracciones de otro servicio.', 'ask');
			assert.deepEqual({ firstGuidance: s.calls[0].instruction.includes('<skill name="abstraction-auditor"'), secondGuidance: s.calls[1].instruction.includes('<skill '), freshGuidance: s.calls[1].transport?.fresh?.includes('<skill name="abstraction-auditor"'), freshFull: s.calls[1].transport?.fresh?.includes('Revisá las abstracciones de otro servicio.') }, { firstGuidance: true, secondGuidance: false, freshGuidance: true, freshFull: true });
		});
	});

	test(provider + ' native session rereads changed workspace skill content and resends updated guidance', async () => {
		await withProject(async (root, storage) => {
			const file = await projectSkill(root, 'engineering-principles', '# FIRST_PROJECT_GUIDANCE\nUse the existing adapter.');
			const s = await session(root, storage, provider, true);
			await s.chat.send('Review abstractions in this service', 'ask');
			await fs.writeFile(file, '# SECOND_PROJECT_GUIDANCE\nUse the verified dependency boundary.');
			await s.chat.send('Review abstractions in another service', 'ask');
			assert.deepEqual({ first: s.calls[0].instruction.includes('FIRST_PROJECT_GUIDANCE'), updated: s.calls[1].instruction.includes('SECOND_PROJECT_GUIDANCE'), stale: s.calls[1].instruction.includes('FIRST_PROJECT_GUIDANCE'), fallbackUpdated: s.calls[1].transport?.fresh?.includes('SECOND_PROJECT_GUIDANCE') }, { first: true, updated: true, stale: false, fallbackUpdated: true });
		});
	});
}


test('the actual host runtime preserves supplied direct and explicit skill blocks without a second selection', async () => {
	const f = await hostFixture();
	const originalPath = process.env.PATH;
	const subscriptions: Array<{ dispose(): void }> = [];
	try {
		const root = await fs.realpath(f.roots[0]);
		const bin = path.join(path.dirname(root), 'engineering-provider');
		await installFakeCodex(bin, [
			'#!/usr/bin/env node',
			'let input = ""; process.stdin.on("data", c => input += c);',
			'process.stdin.on("end", () => {',
			'  const names = [...input.matchAll(/<skill name="([^"]+)"/g)].map(match => match[1]);',
			'  console.log(JSON.stringify({ names }));',
			'});'
		].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const controller: { refresh(): void; nativeChatRuntime?: (folder: typeof f.vscode.workspace.workspaceFolders[number]) => ChatRuntime } = { refresh() { } };
		registerNativeHarness({
			subscriptions, extensionPath: path.resolve(shipped, '../..'),
			globalStorageUri: { fsPath: vscodeFsPath(path.join(path.dirname(root), 'engineering-private')) },
			globalState: { get: () => undefined, update: async () => undefined }
		}, f.vscode, controller);
		const runtime = controller.nativeChatRuntime!(f.vscode.workspace.workspaceFolders[0]);
		const context = await runtime.context();
		const hooks = { started() { }, progress() { }, stage() { }, gates() { } };
		const direct = await engineeringContext(root, shipped, { request: 'Refactor this module preserving behavior' });
		const explicit = await resolveSkillInvocation(root, 'performance-engineering Refactor this module', t, shipped);
		assert.ok(typeof explicit !== 'string');
		const observed: Array<{ names: string[] }> = [];
		for (const guidance of [direct.context, explicit.context]) {
			const result = await runtime.implement({
				provider: 'codex', instruction: 'Execute this request.\n\n' + guidance,
				plan: directPlan('Refactor this module preserving behavior'), verificationRevision: context.verification?.revision
			}, hooks, new AbortController().signal);
			assert.equal(result.agent.status, 'passed');
			observed.push(JSON.parse(result.agent.output));
		}
		assert.deepEqual(observed, [
			{ names: ['safe-refactoring', 'architecture-guardian'] },
			{ names: ['performance-engineering'] }
		]);
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		for (const disposable of subscriptions) { disposable.dispose(); }
		await f.cleanup();
	}
});

for (const mode of ['ask', 'act'] as const) {
	test('small prompt budget preserves user and mention attachments while keeping only complete skill blocks in ' + mode, async () => {
		await withProject(async (root, storage) => {
			const s = await session(root, storage, 'codex', true);
			s.runtime.context = async () => ({ root, writer: true, skills: [], guides: [], promptBudget: 13 * 1024 });
			const request = 'Review abstractions in this service. ' + 'x'.repeat(4500);
			const attachment = 'MENTION-CONTENT-BEGIN ' + 'm'.repeat(1300) + ' MENTION-CONTENT-END';
			await s.chat.send(request, mode, { context: attachment });
			assert.equal(s.calls.length, 1);
			const instruction = s.calls[0].instruction;
			const blocks = [...instruction.matchAll(/<skill name="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/skill>/g)];
			const expected = await engineeringContext(root, shipped, { request });
			assert.deepEqual({
				withinBudget: Buffer.byteLength(instruction) <= 13 * 1024,
				userIntact: instruction.includes(request), attachmentsIntact: instruction.includes(attachment),
				complete: (instruction.match(/<skill /g)?.length ?? 0) === blocks.length,
				bodiesIntact: blocks.every(block => expected.context.includes(block[0]))
			}, { withinBudget: true, userIntact: true, attachmentsIntact: true, complete: true, bodiesIntact: true });
			if (mode === 'ask') {
				await s.chat.send(request + ' Continue.', mode, { context: attachment });
				const fresh = s.calls[1].transport?.fresh;
				assert.ok(fresh);
				assert.deepEqual({ withinBudget: Buffer.byteLength(fresh) <= 13 * 1024, userIntact: fresh.includes(request + ' Continue.'), attachmentsIntact: fresh.includes(attachment), complete: (fresh.match(/<skill /g)?.length ?? 0) === (fresh.match(/<\/skill>/g)?.length ?? 0) }, { withinBudget: true, userIntact: true, attachmentsIntact: true, complete: true });
			}
		});
	});
}
