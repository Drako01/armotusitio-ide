/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const extension = 'extensions/armotusitio-ide';
const formatTargets = [
	'src/native-integration.ts',
	'src/native-agent-execution.ts',
	'src/native-agent-metrics.ts',
	'src/native-agent-workflow.ts',
	'src/native-agent-worktree.ts',
	'src/native-agent-scope.ts',
	'src/native-provider-output.ts'
].map(file => `${extension}/${file}`);
const fixRequested = process.argv.includes('--fix');
const logPath = path.join(root, 'test.log');
const log = fs.createWriteStream(logPath, { flags: 'w' });
const results: Array<{ name: string; result: string }> = [];
const write = (value: string): void => { process.stdout.write(value); log.write(value); };

async function run(name: string, args: string[], executable = process.execPath): Promise<boolean> {
	write(`\n--- ${name} ---\n`);
	return new Promise(resolve => {
		const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.on('data', chunk => write(chunk.toString()));
		child.stderr.on('data', chunk => write(chunk.toString()));
		child.once('error', error => write(`No se pudo iniciar: ${error.message}\n`));
		child.once('close', code => {
			const passed = code === 0;
			results.push({ name, result: passed ? 'PASS' : `FAIL (exit ${code})` });
			resolve(passed);
		});
	});
}

write(`Harness checks | ${new Date().toISOString()} | ${process.platform}/${process.arch} | ${process.version}\n`);
write(fixRequested ? 'Explicit --fix: format selected Harness sources locally before validation. No commits, remote CI or providers.\n' : 'Focused checks only. No release, Git mutation, remote CI or AI provider is invoked.\n');
try {
	if (fixRequested) { await run('Format Harness sources', ['build/lib/formatter.ts', '--replace', ...formatTargets]); }
	await run('TypeScript', ['node_modules/@typescript/native/bin/tsc', '--project', `${extension}/tsconfig.json`]);
	await run('Webview resources', [`${extension}/check-resources.mts`]);
	await run('UI bridge and renderer', ['--test', `${extension}/test/home.test.cts`, `${extension}/test/renderer.test.cts`, `${extension}/test/native-integration.test.mts`, `${extension}/test/native-harness.test.mts`, `${extension}/test/native-providers.test.mts`, `${extension}/test/native-agent-execution.test.mts`, `${extension}/test/native-agent-metrics.test.mts`, `${extension}/test/native-agent-workflow.test.mts`, `${extension}/test/native-agent-scope.test.mts`, `${extension}/test/native-agent-worktree.test.mts`, `${extension}/test/native-engine-contract.test.mts`, `${extension}/test/native-performance.test.mts`, `${extension}/test/native-review.test.mts`, `${extension}/test/native-agent-corrective.test.mts`, `${extension}/test/native-sensitive-scope.test.mts`, `${extension}/test/native-provider-diagnostics.test.mts`, `${extension}/test/native-provider-output.test.mts`]);
	const compiled = await run('Extension bundle', [`${extension}/esbuild.mts`]);
	if (compiled) { await run('Native package resources', [`${extension}/check-native-package.mts`]); }
	else { results.push({ name: 'Native package resources', result: 'SKIP (bundle failed)' }); }
	const files = ['extension.ts', 'src/home.ts', 'resources/home.ts', 'src/native-integration.ts', 'src/native-evidence.ts', 'src/native-harness.ts', 'src/native-agent-execution.ts', 'src/native-agent-metrics.ts', 'src/native-agent-workflow.ts', 'src/native-agent-worktree.ts', 'src/native-agent-scope.ts', 'src/native-engine-contract.ts', 'src/native-performance.ts', 'src/native-review.ts', 'src/native-sensitive-scope.ts', 'src/native-provider-diagnostics.ts', 'src/native-provider-output.ts', 'src/native-providers.ts', 'src/native-runtime.ts', 'test/native-agent-execution.test.mts', 'test/native-agent-workflow.test.mts', 'test/native-agent-worktree.test.mts', 'test/native-agent-scope.test.mts', 'test/native-engine-contract.test.mts', 'test/native-performance.test.mts', 'test/native-review.test.mts', 'test/native-agent-corrective.test.mts', 'test/native-sensitive-scope.test.mts', 'test/native-provider-diagnostics.test.mts', 'test/native-provider-output.test.mts', 'test/native-agent-metrics.test.mts', 'test/renderer.test.cts'].map(file => `${extension}/${file}`);
	await run('Focused hygiene', ['build/hygiene.ts', ...files, `${extension}/resources/home.css`, 'scripts/ats-harness-check.mts']);
	await run('Diff whitespace', ['diff', '--check'], 'git');
} catch (error) {
	results.push({ name: 'Runner', result: 'FAIL' });
	write(`${error instanceof Error ? error.message : 'Unexpected runner error'}\n`);
} finally {
	write('\nRESULTS\n' + results.map(result => `${result.result} | ${result.name}`).join('\n') + '\n');
	write(`\nLog: ${logPath}\n`);
	await new Promise<void>(resolve => log.end(resolve));
	if (results.some(result => result.result !== 'PASS')) { process.exitCode = 1; }
}
