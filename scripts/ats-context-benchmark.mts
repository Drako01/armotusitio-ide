/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Reproducible local retrieval fixtures, without providers, credentials, embeddings or network. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const { IncrementalContextIndex } = createRequire(import.meta.url)('../extensions/armotusitio-ide/src/context.ts');

const query = 'verifyInvoice';
const scenarios = [{ name: 'small-typescript', files: 50 }, { name: 'medium-go', files: 500 }, { name: 'large-monorepo', files: 2000 }];
const report: Record<string, object> = {};
const repository = path.resolve(import.meta.dirname, '..');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true, encoding: 'utf8' }).trim();
const sourceInputs: Record<string, string> = {};
for (const file of ['extensions/armotusitio-ide/src/context.ts', 'extensions/armotusitio-ide/src/native-git.ts', 'scripts/ats-context-benchmark.mts']) { sourceInputs[file] = createHash('sha256').update(await fs.readFile(path.join(repository, file))).digest('hex'); }
const percentile = (values: number[], fraction: number): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
for (const scenario of scenarios) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-context-bench-')));
	try {
		const paths: string[] = [];
		for (let index = 0; index < scenario.files; index++) {
			const go = scenario.name === 'medium-go' || (scenario.name === 'large-monorepo' && index % 2 === 0);
			const directory = scenario.name === 'large-monorepo' ? go ? 'code/apps/api' : 'code/apps/web' : 'code';
			const file = directory + '/file' + String(index).padStart(4, '0') + (go ? '.go' : '.ts');
			paths.push(file);
			await fs.mkdir(path.join(root, directory), { recursive: true });
			const target = index === 0 || index === scenario.files - 1;
			await fs.writeFile(path.join(root, file), go ? 'package fixture\nfunc ' + (target ? 'VerifyInvoice' : 'Module' + index) + '() {}\n' : 'export function ' + (target ? 'verifyInvoice' : 'module' + index) + '() {}\n');
		}
		const index = new IncrementalContextIndex(root);
		const samples: Array<{ mode: string; durationMs: number; rssBytes: number; heapUsedBytes: number; stats: object; recall: number; precision: number }> = [];
		const expected = [paths[0], paths.at(-1)!];
		let grep: { status: string; files?: string[] };
		try {
			const files = execFileSync('rg', ['--files-with-matches', '--fixed-strings', '--ignore-case', query, 'code'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/).map(file => file.replace(/\\/g, '/')).sort();
			grep = { status: 'PASS', files };
		} catch { grep = { status: 'BLOCKED' }; }
		for (let run = 0; run < 3; run++) {
			const started = performance.now();
			const result = await index.search(query, { symbols: [{ path: paths.at(-1)!, name: 'verifyInvoice' }] });
			const durationMs = performance.now() - started;
			const hits = result.files.filter((file: string) => expected.includes(file)).length;
			const memory = process.memoryUsage();
			samples.push({ mode: run === 0 ? 'cold' : 'cached', durationMs, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, stats: result.stats, recall: hits / expected.length, precision: result.files.length ? hits / result.files.length : 0 });
		}
		const durations = samples.map(sample => sample.durationMs);
		report[scenario.name] = { files: scenario.files, samples, p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95), p99Ms: percentile(durations, .99), exhaustiveLiteralGrep: grep };
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
console.log(JSON.stringify({ kind: 'synthetic-local-context-retrieval', sourceRevision, sourceInputs, node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, ramBytes: os.totalmem(), providerCalls: 0, firstTokenMs: null, note: 'Three samples per fixture; cold and cached timings are separate. These are not installed IDE or provider latency measurements.', scenarios: report }, null, 2));
