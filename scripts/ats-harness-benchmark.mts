/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Repeatable local benchmark: observed timings only, no provider, network or release. */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BenchmarkSample { wallMs: number; passed: boolean }
export interface BenchmarkSummary {
	runs: number;
	passed: number;
	failed: number;
	minWallMs: number | null;
	medianWallMs: number | null;
	p95WallMs: number | null;
	maxWallMs: number | null;
}
export function summarizeBenchmark(samples: readonly BenchmarkSample[]): BenchmarkSummary {
	if (samples.length > 10 || !samples.every(s => Number.isFinite(s.wallMs) && s.wallMs >= 0 && typeof s.passed === 'boolean')) {
		throw Error('HARNESS_BENCHMARK_SAMPLE_INVALID');
	}
	const wall = samples.map(s => s.wallMs).sort((a, b) => a - b);
	return {
		runs: wall.length, passed: samples.filter(s => s.passed).length,
		failed: samples.filter(s => !s.passed).length,
		minWallMs: wall[0] ?? null,
		medianWallMs: wall.length ? wall[Math.ceil(wall.length * .5) - 1] : null,
		p95WallMs: wall.length ? wall[Math.ceil(wall.length * .95) - 1] : null,
		maxWallMs: wall.at(-1) ?? null
	};
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands: Record<string, string[]> = {
	check: ['scripts/ats-harness-check.mts'],
	test: ['--test', 'extensions/armotusitio-ide/test/native-*.test.mts']
};

function run(args: string[]): Promise<BenchmarkSample> {
	return new Promise(resolve => {
		const started = process.hrtime.bigint();
		const child = spawn(process.execPath, args, {
			cwd: root, shell: false, windowsHide: true, stdio: 'ignore'
		});
		let done = false;
		const finish = (passed: boolean): void => {
			if (done) { return; }
			done = true;
			resolve({ passed, wallMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) });
		};
		child.once('error', () => finish(false));
		child.once('close', code => finish(code === 0));
	});
}

async function main(args: string[]): Promise<void> {
	if (args.length === 1 && args[0] === '--help') {
		process.stdout.write('Usage: node scripts/ats-harness-benchmark.mts --command check --runs 3\nCommands: check, test. Runs: 1-10. No providers, release or network.\n');
		return;
	}
	if (args.length !== 4 || args[0] !== '--command' || !Object.hasOwn(commands, args[1]) ||
		args[2] !== '--runs' || !/^(?:[1-9]|10)$/.test(args[3])) {
		throw Error('HARNESS_BENCHMARK_ARGUMENTS_INVALID');
	}
	const samples: BenchmarkSample[] = [];
	for (let i = 0; i < Number(args[3]); i++) { samples.push(await run(commands[args[1]])); }
	const summary = summarizeBenchmark(samples);
	process.stdout.write(JSON.stringify({
		schemaVersion: 1, command: args[1], platform: process.platform, arch: process.arch,
		node: process.version, mode: 'observed-local', samples, summary
	}, null, 2) + '\n');
	if (summary.failed) { process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main(process.argv.slice(2)).catch(error => {
		process.stderr.write(error instanceof Error ? error.message + '\n' : 'HARNESS_BENCHMARK_FAILED\n');
		process.exitCode = 1;
	});
}
