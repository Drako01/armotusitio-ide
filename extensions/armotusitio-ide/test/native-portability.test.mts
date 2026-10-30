/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeHarness } from '../src/native-harness.ts';
import { proposeProjectConfig } from '../src/native-project.ts';
import { resolveNativeCommand } from '../src/native-runtime.ts';

/** Detect, configure and execute the proposed gate with the real toolchain. */
async function runProposal(files: Record<string, string>): Promise<{ profile: string; gate: string; status: string | undefined }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-portability-')));
	try {
		for (const [name, content] of Object.entries(files)) {
			await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
			await fs.writeFile(path.join(root, name), content);
		}
		const proposal = await proposeProjectConfig(root);
		const engine = new NativeHarness(root, path.join(root, '.state'));
		const task = await engine.create('Portability', proposal.config.plan);
		const result = await engine.execute(task.id, await engine.reviewDigest(task.plan), () => true);
		const gate = proposal.config.plan.gates[0];
		return { profile: proposal.config.profile, gate: [gate.executable, ...gate.args].join(' '), status: result.attempts.at(-1)?.status };
	} finally { await fs.rm(root, { recursive: true, force: true }); }
}
const available = async (tool: string): Promise<boolean> => resolveNativeCommand(tool, ['--version']).then(() => true, () => false);

test('Node project: detected npm script runs through the native engine', { skip: await available('npm') ? false : 'npm unavailable' }, async () => {
	assert.deepEqual(await runProposal({
		'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } })
	}), { profile: 'node', gate: 'npm run test', status: 'passed' });
});

test('Go project: detected go test runs real package tests', { skip: await available('go') ? false : 'go toolchain unavailable' }, async () => {
	assert.deepEqual(await runProposal({
		'go.mod': 'module example.com/fixture\n\ngo 1.21\n',
		'sum.go': 'package fixture\n\nfunc Sum(a, b int) int { return a + b }\n',
		'sum_test.go': 'package fixture\n\nimport "testing"\n\nfunc TestSum(t *testing.T) { if Sum(2, 3) != 5 { t.Fatal("sum") } }\n'
	}), { profile: 'go', gate: 'go test ./...', status: 'passed' });
});

test('Go project: a failing real test fails the gate', { skip: await available('go') ? false : 'go toolchain unavailable' }, async () => {
	assert.equal((await runProposal({
		'go.mod': 'module example.com/fixture\n\ngo 1.21\n',
		'bad_test.go': 'package fixture\n\nimport "testing"\n\nfunc TestBad(t *testing.T) { t.Fatal("expected failure") }\n'
	})).status, 'failed');
});

test('PHP project: detected runtime check runs with the real interpreter', { skip: await available('php') ? false : 'php unavailable' }, async () => {
	assert.deepEqual(await runProposal({ 'composer.json': JSON.stringify({ name: 'acme/fixture', require: {} }) }),
		{ profile: 'php', gate: 'php -v', status: 'passed' });
});

test('engine detection is independent from RedEvent conventions', async () => {
	const sources = await fs.readdir(path.join(import.meta.dirname, '..', 'src'));
	const offenders: string[] = [];
	for (const name of sources.filter(file => file.startsWith('native-'))) {
		if (/redevent/i.test(await fs.readFile(path.join(import.meta.dirname, '..', 'src', name), 'utf8'))) { offenders.push(name); }
	}
	assert.deepEqual(offenders, []);
});
