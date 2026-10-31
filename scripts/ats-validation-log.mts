/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Runs the mandatory Harness gates on the current commit and writes a reproducible record to script_test.log:
 * date, system, versions, commit, every command with its exit code, test counts, warnings and failure excerpts.
 * Nothing is simulated and no provider is contacted. The record refuses to claim a clean tree it did not see.
 *
 *   node scripts/ats-validation-log.mts [--output script_test.log] [--note "text"]
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, fallback: string): string => { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1]; };
const output = path.resolve(root, arg('--output', 'script_test.log'));
const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && command === 'npm' });
const git = (...args: string[]): string => run('git', args).stdout.trim();

const gates = [
	{ name: 'Harness focused verifier', command: process.execPath, args: ['scripts/ats-harness-check.mts'] },
	{ name: 'Extension tests', command: 'npm', args: ['test', '--prefix', 'extensions/armotusitio-ide'] },
	{ name: 'Extension typecheck and resources', command: 'npm', args: ['run', 'check', '--prefix', 'extensions/armotusitio-ide'] },
	{ name: 'Repository hygiene', command: 'npm', args: ['run', 'hygiene'] },
	{ name: 'Whitespace check', command: 'git', args: ['diff', '--check'] }
];
/** `node:test` summary lines: "\u2139 tests 363", "\u2139 pass 359"... */
const counts = (text: string): string => ['tests', 'pass', 'fail', 'skipped'].map(key => key + ' ' + (text.match(new RegExp('^\\u2139 ' + key + ' (\\d+)', 'm'))?.[1] ?? 'n/a')).join(', ');

const status = git('status', '--porcelain');
const lines: string[] = [
	'ArmoTuSitio IDE Harness validation record',
	'date: ' + new Date().toISOString(),
	'system: ' + os.type() + ' ' + os.release() + ' ' + process.arch + ', ' + os.cpus().length + ' logical CPUs',
	'node: ' + process.version,
	'commit: ' + git('rev-parse', 'HEAD') + ' (' + git('rev-parse', '--abbrev-ref', 'HEAD') + ')',
	'working tree: ' + (status ? 'NOT CLEAN, results describe uncommitted changes:\n' + status : 'clean'),
	...(arg('--note', '') ? ['note: ' + arg('--note', '')] : []),
	''
];
let failed = 0;
for (const gate of gates) {
	const started = Date.now();
	const result = run(gate.command, gate.args);
	const text = (result.stdout ?? '') + (result.stderr ?? '');
	const warnings = [...new Set(text.split(/\r?\n/).filter(line => /\bwarning\b/i.test(line)).map(line => line.trim().slice(0, 200)))];
	const exit = result.status ?? -1;
	if (exit !== 0) { failed++; }
	lines.push(
		'== ' + gate.name,
		'command: ' + [path.basename(gate.command), ...gate.args].join(' '),
		'exit code: ' + exit + ' (' + (exit === 0 ? 'PASS' : 'FAIL') + '), ' + ((Date.now() - started) / 1000).toFixed(1) + ' s',
		...(/\u2139 tests \d+/.test(text) ? ['tests: ' + counts(text)] : []),
		...[...text.matchAll(/^(PASS|FAIL[^|]*) \| (.+)$/gm)].map(match => 'stage: ' + match[1] + ' | ' + match[2]),
		...(/Hygiene checked \d+ files/.test(text) ? ['hygiene: ' + text.match(/Hygiene checked \d+ files/)![0]] : []),
		'warnings: ' + warnings.length + (warnings.length ? '\n  ' + warnings.slice(0, 10).join('\n  ') : ''),
		...(exit === 0 ? [] : ['failure excerpt:', ...text.split(/\r?\n/).filter(line => /\u2716|not ok|error|FAIL/i.test(line)).slice(0, 25).map(line => '  ' + line.slice(0, 220))]),
		''
	);
}
lines.push('summary: ' + (failed ? failed + ' of ' + gates.length + ' gates FAILED' : 'all ' + gates.length + ' gates PASSED') + ' on commit ' + git('rev-parse', '--short', 'HEAD'));
await fs.writeFile(output, lines.join('\n') + '\n');
process.stdout.write(lines.slice(-1)[0] + '\n');
process.exitCode = failed ? 1 : 0;
