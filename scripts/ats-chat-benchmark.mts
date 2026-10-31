/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Repeatable Chat Harness micro-benchmark: in-process timings and payload sizes. No provider, network or UI. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ChatStore, buildConversationInstruction, chatMessage, extractChatPlan, type ChatMessage, type ChatProjectContext } from '../extensions/armotusitio-ide/src/native-chat.ts';
import { HarnessChatSession, type ChatRuntime, type ChatSnapshot } from '../extensions/armotusitio-ide/src/native-chat-session.ts';

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] || 20);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 200) { throw Error('HARNESS_BENCHMARK_ARGUMENTS_INVALID'); }

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const p95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function time(work: () => Promise<unknown> | unknown): Promise<{ medianMs: number; p95Ms: number }> {
	const samples: number[] = [];
	for (let index = 0; index < runs; index++) {
		const started = performance.now();
		await work();
		samples.push(performance.now() - started);
	}
	return { medianMs: Number(median(samples).toFixed(3)), p95Ms: Number(p95(samples).toFixed(3)) };
}

const paragraph = 'El servicio de clientes valida CUIT, email y nombre, y expone endpoints REST paginados. '.repeat(24);
const history: ChatMessage[] = Array.from({ length: 200 }, (_, index) => chatMessage(index % 2 ? 'assistant' : 'user', index + ' ' + paragraph));
const context: ChatProjectContext = { root: '/repo', writer: true, guides: ['AGENTS.md'], skills: [{ name: 'api', source: '.agents/skills' }], verification: { revision: 'a'.repeat(64), gates: [{ id: 'test', command: 'npm test' }] } };
const planAnswer = paragraph.repeat(8) + '\n```harness-plan\n' + JSON.stringify({ title: 'CRUD', summary: 'API', steps: Array.from({ length: 30 }, (_, index) => 'Paso ' + index), files: ['a.ts'] }) + '\n```';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-bench-'));
try {
	const store = new ChatStore(directory);
	await store.load('claude');
	const save = await time(() => store.save({ schemaVersion: 1, provider: 'claude', messages: history }));
	const load = await time(() => store.load('claude'));
	const stateBytes = (await fs.stat(path.join(directory, 'conversation.json'))).size;
	const prompt = await time(() => buildConversationInstruction([...history, chatMessage('user', 'Quiero agregar un CRUD de clientes')], context));
	const promptBytes = Buffer.byteLength(buildConversationInstruction([...history, chatMessage('user', 'Quiero agregar un CRUD de clientes')], context));
	const extract = await time(() => extractChatPlan(planAnswer, 1));

	// Full turn overhead with a scripted runtime: persistence, prompt building, parsing and snapshot emission.
	const snapshots: ChatSnapshot[] = [];
	const runtime: ChatRuntime = {
		async context() { return context; },
		async converse(_provider, _instruction, hooks) { hooks.started(() => undefined); for (let bytes = 8192; bytes <= 65536; bytes += 8192) { hooks.progress(bytes); } return { status: 'passed', exitCode: 0, durationMs: 0, output: planAnswer, truncated: false }; },
		async implement() { throw Error('HARNESS_BENCHMARK_NO_WRITES'); }
	};
	const turnStore = new ChatStore(path.join(directory, 'turns'));
	await turnStore.save({ schemaVersion: 1, provider: 'claude', messages: history.slice(-150) });
	const session = new HarnessChatSession(turnStore, runtime, snapshot => snapshots.push(snapshot), text => text);
	await session.open();
	const turn = await time(() => session.send('Agregar validaciones'));
	const progress = snapshots.filter(snapshot => snapshot.activity?.observedBytes);
	const full = Buffer.byteLength(JSON.stringify(progress.at(-1)));
	const omitted = Buffer.byteLength(JSON.stringify({ ...progress.at(-1), messages: undefined }));
	process.stdout.write(JSON.stringify({
		schemaVersion: 1, mode: 'observed-local', runs, platform: process.platform, arch: process.arch, node: process.version,
		store: { messages: 200, stateBytes, save, load },
		prompt: { historyMessages: 200, instructionBytes: promptBytes, build: prompt },
		planParsing: { answerBytes: Buffer.byteLength(planAnswer), extract },
		turnOverhead: { ...turn, note: 'excludes provider time; includes 2 atomic saves and snapshot emission' },
		progressEvent: { fullSnapshotBytes: full, historyOmittedBytes: omitted, eventsPerTurn: progress.length / runs },
		heapUsedBytes: process.memoryUsage().heapUsed
	}, null, 2) + '\n');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
