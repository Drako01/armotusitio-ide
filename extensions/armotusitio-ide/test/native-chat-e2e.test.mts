/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * End to end flow of the Chat Harness: conversation, plan, approval, implementation, verification gates and result,
 * through the real session, store, guarded launch, shared fence and a real provider process.
 *
 * Three tiers, so quota is never consumed by accident:
 *  1. Simulated provider (always): a scripted executable stands in for the CLI. The whole IDE side is real.
 *  2. CLI transport without a model call: lives in native-provider-diagnostics and native-isolation (opt-in).
 *  3. Authenticated provider (opt-in): ATS_E2E_PROVIDER=codex|claude plus ATS_E2E_ACKNOWLEDGE_REAL_MODEL_CALLS=1.
 *     It spends real quota in a throwaway project, bounded by ATS_E2E_MAX_CALLS (default 3). Never run by CI or by default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatStore } from '../src/native-chat.ts';
import { HarnessChatSession, type ChatRuntime } from '../src/native-chat-session.ts';
import { writeProjectConfig } from '../src/native-project.ts';
import { inspectSharedExecutionFence } from '../src/native-shared-fence.ts';
import { createHash } from 'node:crypto';
import { installFakeCodex } from './native-fake-provider.mts';
import { fixture } from './native-integration-fixture.mts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);

/** The session on top of the real runtime of one throwaway project, with a hard cap on provider calls. */
async function chatOver(maxCalls: number) {
	const f = await fixture();
	const root = await fs.realpath(f.roots[0]);
	await writeProjectConfig(root, { schemaVersion: 1, runtime: 'ide-native', profile: 'custom', plan: { schemaVersion: 1, gates: [{ id: 'file', executable: 'node', args: ['-e', 'require("fs").accessSync("clients.txt")'] }] } });
	const runtime = f.controller.nativeChatRuntime(f.vscode.workspace.workspaceFolders[0]) as ChatRuntime;
	let calls = 0;
	const counted: ChatRuntime = {
		context: () => runtime.context(),
		converse: (...args) => { if (++calls > maxCalls) { throw Error('HARNESS_E2E_CALL_BUDGET_EXCEEDED'); } return runtime.converse(...args); },
		implement: (...args) => { if (++calls > maxCalls) { throw Error('HARNESS_E2E_CALL_BUDGET_EXCEEDED'); } return runtime.implement(...args); }
	};
	const directory = path.join(path.dirname(root), 'chat-state');
	const chat = new HarnessChatSession(new ChatStore(directory), counted, () => undefined, t);
	await chat.open();
	const storage = path.join(path.dirname(root), 'private', 'native-harness', createHash('sha256').update(root).digest('hex'));
	return { f, root, chat, calls: () => calls, fenceHeld: async () => (await inspectSharedExecutionFence(root, storage)).held };
}

/** A scripted stand-in for the CLI: proposes a plan when asked to converse, writes the file when told to implement. */
const SCRIPTED = [
	'#!/usr/bin/env node',
	'let input = ""; process.stdin.on("data", c => input += c);',
	'process.stdin.on("end", () => {',
	'  if (input.includes("Implement the approved plan")) { if (input.includes("SLOW")) { setTimeout(() => {}, 60000); return; } require("fs").writeFileSync("clients.txt", "crud"); console.log("Created clients.txt"); return; }',
	'  console.log(["Propongo esto.", "```harness-plan", JSON.stringify({ title: input.includes("lento") ? "SLOW plan" : "CRUD de clientes", steps: ["Crear clients.txt"], files: ["clients.txt"] }), "```"].join(String.fromCharCode(10)));',
	'});'
].join('\n');

test('end to end with a scripted provider: conversation, plan, approval, implementation, gates and result', async () => {
	const e2e = await chatOver(5);
	const originalPath = process.env.PATH;
	try {
		const bin = path.join(path.dirname(e2e.root), 'scripted-bin');
		await installFakeCodex(bin, SCRIPTED);
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		await e2e.chat.selectProvider('codex');
		await e2e.chat.send('Quiero agregar un CRUD de clientes');
		const plan = e2e.chat.snapshot().plan!;
		// Conversing never wrote anything.
		await assert.rejects(fs.access(path.join(e2e.root, 'clients.txt')));
		await e2e.chat.approve(plan.digest);
		const last = e2e.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({
			role: last.role, run: [last.run?.status, last.run?.verification.status, last.run?.verification.gates], file: await fs.readFile(path.join(e2e.root, 'clients.txt'), 'utf8'),
			calls: e2e.calls(), fenceHeld: await e2e.fenceHeld(), approvableAfter: e2e.chat.snapshot().plan?.approvable
		}, { role: 'run', run: ['passed', 'passed', [{ id: 'file', status: 'passed' }]], file: 'crud', calls: 2, fenceHeld: false, approvableAfter: false });
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await e2e.f.cleanup();
	}
});

test('end to end: stopping a running implementation cancels it, skips the gates, releases the fence and allows another attempt', async () => {
	const e2e = await chatOver(5);
	const originalPath = process.env.PATH;
	try {
		const bin = path.join(path.dirname(e2e.root), 'scripted-bin');
		await installFakeCodex(bin, SCRIPTED);
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		await e2e.chat.selectProvider('codex');
		await e2e.chat.send('Quiero un cambio lento');
		const plan = e2e.chat.snapshot().plan!;
		// The scripted CLI stalls on this plan; the user stops it once the writer is running.
		const approval = e2e.chat.approve(plan.digest);
		for (let waited = 0; waited < 8000 && e2e.chat.snapshot().activity?.stage !== 'agent'; waited += 25) { await new Promise(resolve => setTimeout(resolve, 25)); }
		assert.equal(e2e.chat.snapshot().activity?.stage, 'agent');
		e2e.chat.cancel();
		await approval;
		const last = e2e.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({
			status: last.run?.status, gates: last.run?.verification.gates, written: await fs.access(path.join(e2e.root, 'clients.txt')).then(() => true, () => false),
			fenceHeld: await e2e.fenceHeld(), retryable: e2e.chat.snapshot().plan?.approvable
		}, { status: 'cancelled', gates: [{ id: 'file', status: 'cancelled' }], written: false, fenceHeld: false, retryable: true });
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await e2e.f.cleanup();
	}
});

const realProvider = process.env.ATS_E2E_PROVIDER;
const realAllowed = (realProvider === 'codex' || realProvider === 'claude') && process.env.ATS_E2E_ACKNOWLEDGE_REAL_MODEL_CALLS === '1';
test('end to end with an authenticated provider in a throwaway project (opt-in, spends real quota)', { skip: realAllowed ? false : 'set ATS_E2E_PROVIDER=codex|claude and ATS_E2E_ACKNOWLEDGE_REAL_MODEL_CALLS=1' }, async () => {
	const budget = Number(process.env.ATS_E2E_MAX_CALLS ?? 3);
	assert.ok(Number.isSafeInteger(budget) && budget >= 2 && budget <= 5, 'ATS_E2E_MAX_CALLS must be between 2 and 5');
	const e2e = await chatOver(budget);
	try {
		await e2e.chat.selectProvider(realProvider as 'codex' | 'claude');
		await e2e.chat.send('Create a file named clients.txt containing exactly the word crud. Propose a plan with a harness-plan block that lists that single step and the file clients.txt.');
		const plan = e2e.chat.snapshot().plan;
		assert.ok(plan?.approvable, 'the provider proposed an approvable plan');
		await e2e.chat.approve(plan.digest);
		const last = e2e.chat.snapshot().messages.at(-1)!;
		assert.deepEqual({ status: last.run?.status, gates: last.run?.verification.gates.map(gate => gate.status), fenceHeld: await e2e.fenceHeld(), within: e2e.calls() <= budget }, { status: 'passed', gates: ['passed'], fenceHeld: false, within: true });
	} finally { await e2e.f.cleanup(); }
});
