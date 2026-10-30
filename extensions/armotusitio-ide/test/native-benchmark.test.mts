/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { summarizeBenchmark } from '../../../scripts/ats-harness-benchmark.mts';

test('benchmark reports only measured durations, including failed samples', () => {
	assert.deepEqual(summarizeBenchmark([]), {
		runs: 0, passed: 0, failed: 0, minWallMs: null, medianWallMs: null, p95WallMs: null, maxWallMs: null
	});
	assert.deepEqual(summarizeBenchmark([
		{ wallMs: 19, passed: true }, { wallMs: 4, passed: false }, { wallMs: 10, passed: true }
	]), {
		runs: 3, passed: 2, failed: 1, minWallMs: 4, medianWallMs: 10, p95WallMs: 19, maxWallMs: 19
	});
	assert.throws(() => summarizeBenchmark([{ wallMs: Number.NaN, passed: true }]), /HARNESS_BENCHMARK_SAMPLE_INVALID/);
	assert.throws(() => summarizeBenchmark(Array.from({ length: 11 }, () => ({ wallMs: 1, passed: true }))),
		/HARNESS_BENCHMARK_SAMPLE_INVALID/);
});

test('benchmark CLI is opt-in and rejects arbitrary commands without execution', () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
	const script = path.join(root, 'scripts', 'ats-harness-benchmark.mts');
	const help = spawnSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Commands: check, test/);
	const unsafe = spawnSync(process.execPath, [script, '--command', 'deploy', '--runs', '1'], {
		cwd: root, encoding: 'utf8'
	});
	assert.equal(unsafe.status, 1);
	assert.match(unsafe.stderr, /HARNESS_BENCHMARK_ARGUMENTS_INVALID/);
});
