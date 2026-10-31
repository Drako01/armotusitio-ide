/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Repeatable engine benchmark: cold and warm start, agent preparation, gate latency, sequential versus parallel
 * gates, persistence overhead and history growth. Everything is measured locally with real processes; no
 * provider, network or UI is involved and no percentage is invented. Use `--ext <dir>` to measure another
 * checkout of the extension and `--baseline <json>` to print real deltas against an earlier measurement.
 *
 *   node scripts/ats-engine-benchmark.mts [--runs 5] [--ext extensions/armotusitio-ide] [--baseline before.json]
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const arg = (name: string, fallback: string): string => { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1]; };
const runs = Number(arg('--runs', '5'));
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 50) { throw Error('HARNESS_BENCHMARK_ARGUMENTS_INVALID'); }
const extension = path.resolve(arg('--ext', 'extensions/armotusitio-ide'));
const load = (file: string): Promise<any> => import(pathToFileURL(path.join(extension, 'src', file)).href);

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const round = (value: number): number => Number(value.toFixed(2));
async function sample(work: () => Promise<unknown> | unknown): Promise<{ medianMs: number; maxMs: number }> {
	const values: number[] = [];
	for (let index = 0; index < runs; index++) { const started = performance.now(); await work(); values.push(performance.now() - started); }
	return { medianMs: round(median(values)), maxMs: round(Math.max(...values)) };
}

/** Cold start: a fresh Node process that only loads the engine modules; the first load pays compilation and I/O. */
function coldStart(): { medianMs: number; maxMs: number } {
	const script = `const s = performance.now(); await import(${JSON.stringify(pathToFileURL(path.join(extension, 'src', 'native-harness.ts')).href)}); console.log(performance.now() - s);`;
	const values = Array.from({ length: runs }, () => Number(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).stdout.trim()));
	return { medianMs: round(median(values)), maxMs: round(Math.max(...values)) };
}

const harnessModule = await load('native-harness.ts');
const providersModule = await load('native-providers.ts');
const executionModule = await load('native-agent-execution.ts');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-bench-')));
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-bench-state-'));
const sleeper = (id: string, extra: object = {}) => ({ id, executable: 'node', args: ['-e', 'setTimeout(() => {}, 300)'], ...extra });
async function runPlan(gates: object[]): Promise<number> {
	const engine = new harnessModule.NativeHarness(root, state);
	const task = await engine.create('bench', { schemaVersion: 1, gates });
	const started = performance.now();
	const result = await engine.execute(task.id, await engine.reviewDigest(task.plan), () => true);
	if (result.attempts.at(-1)?.status !== 'passed') { throw Error('HARNESS_BENCHMARK_GATE_FAILED'); }
	return performance.now() - started;
}

try {
	const cpuBefore = process.cpuUsage();
	const memoryBefore = process.memoryUsage().rss;
	const cold = coldStart();
	const trivial = await sample(() => runPlan([{ id: 'version', executable: 'node', args: ['--version'] }]));
	// Agent preparation: validation, review fingerprint and command resolution, without starting a provider.
	const draft = { schemaVersion: 1, provider: 'codex', role: 'planner', projectRoot: root, instruction: 'Read-only assessment of the repository.', readOnly: true };
	const preparation = await sample(() => { providersModule.reviewAgentDraft(draft); return executionModule.buildAgentInvocation(draft); });
	const sequential = await sample(() => runPlan(Array.from({ length: 4 }, (_, index) => sleeper('gate' + index, index ? { dependsOn: ['gate' + (index - 1)] } : {}))));
	const parallel = await sample(() => runPlan(Array.from({ length: 4 }, (_, index) => sleeper('gate' + index, { parallelSafe: true, resources: ['r' + index] }))));

	// Persistence overhead and history growth through the chat store (the same code path the chat uses).
	const chat = await load('native-chat.ts');
	const growth: Record<string, { bytes: number; saveMs: number }> = {};
	for (const count of [50, 100, 200]) {
		const directory = path.join(state, 'chat-' + count);
		const store = new chat.ChatStore(directory);
		await store.load('claude');
		const messages = Array.from({ length: count }, (_, index) => chat.chatMessage(index % 2 ? 'assistant' : 'user', index + ' ' + 'El servicio valida CUIT, email y nombre. '.repeat(24)));
		const { medianMs } = await sample(() => store.save({ schemaVersion: 1, provider: 'claude', messages }));
		growth[String(count)] = { bytes: (await fs.stat(path.join(directory, 'conversation.json'))).size, saveMs: medianMs };
	}
	const cpu = process.cpuUsage(cpuBefore);
	const report = {
		schemaVersion: 1, mode: 'observed-local', runs, platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length,
		coldStartMs: cold, gateLatency: trivial, agentPreparation: preparation,
		fourGates: { sequential, parallel, speedup: round(sequential.medianMs / parallel.medianMs) },
		historyGrowth: growth,
		resources: { cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000), rssDeltaMB: round((process.memoryUsage().rss - memoryBefore) / 1048576), heapUsedMB: round(process.memoryUsage().heapUsed / 1048576) },
		tokensAndCost: 'not measured: no provider is called; only provider-reported data would be recorded'
	};
	const baselinePath = arg('--baseline', '');
	if (baselinePath) {
		const before = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
		const delta = (now: number, then: number): string => (then ? ((now - then) / then * 100).toFixed(1) + '%' : 'n/a');
		(report as Record<string, unknown>).comparedToBaseline = {
			coldStart: delta(report.coldStartMs.medianMs, before.coldStartMs.medianMs), gateLatency: delta(trivial.medianMs, before.gateLatency.medianMs),
			agentPreparation: delta(preparation.medianMs, before.agentPreparation.medianMs), sequentialFourGates: delta(sequential.medianMs, before.fourGates.sequential.medianMs),
			parallelFourGates: delta(parallel.medianMs, before.fourGates.parallel.medianMs), save200: delta(growth['200'].saveMs, before.historyGrowth['200'].saveMs),
			note: 'negative is faster; both runs are real measurements on the same machine, so differences below the run-to-run noise are not improvements'
		};
	}
	process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(state, { recursive: true, force: true });
}
