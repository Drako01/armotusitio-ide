/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyRun, parseRunBlock, validRunOutcome } from '../src/native-run-outcome.ts';
import { captureWorkingTree, diffWorkingTree, discardRunChanges, fingerprintFiles, type RunDiffSummary } from '../src/native-run-diff.ts';
import { offlineEnvironment, syncCommands } from '../src/native-dependency-sync.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';

const agent = (status: AgentOutcome['status'], output = 'Informe', extra: Partial<AgentOutcome> = {}): AgentOutcome => ({ status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, output, truncated: false, ...extra });
const diff = (count: number): RunDiffSummary => ({ available: true, files: Array.from({ length: count }, (_, index) => ({ path: 'f' + index, change: 'modified' as const, preexisting: false })), count });
const noGit: RunDiffSummary = { available: false, files: [], count: 0 };

test('runs are classified from objective signals; only a completed run applies the plan', () => {
	const blocked = 'No pude seguir.\nharness-blocked: {"reason":"PostgreSQL no responde","needs":"service","detail":"localhost:5432"}';
	const cases = [
		classifyRun({ agent: agent('passed'), verification: 'passed', diff: diff(2) }),
		classifyRun({ agent: agent('passed'), verification: 'skipped', diff: noGit }),
		classifyRun({ agent: agent('passed'), verification: 'passed', diff: diff(0) }),
		classifyRun({ agent: agent('failed', 'x', { stopReason: 'max-turns', sessionId: '8b725e4b-cd27-430d-beca-a8a5e83257b3' }), verification: 'skipped', diff: diff(1) }),
		classifyRun({ agent: agent('timeout'), verification: 'skipped', diff: diff(1) }),
		classifyRun({ agent: agent('cancelled'), verification: 'skipped', diff: diff(0) }),
		classifyRun({ agent: agent('passed', blocked), verification: 'skipped', diff: diff(0) }),
		classifyRun({ agent: agent('passed'), verification: 'failed', diff: diff(1) }),
		classifyRun({ agent: agent('failed'), verification: 'skipped', diff: diff(0) }),
		classifyRun({ agent: agent('failed', 'x', { searchLeak: true }), verification: 'skipped', diff: diff(2) })
	].map(outcome => [outcome.kind, outcome.reason, outcome.needs, outcome.sessionId]);
	assert.deepEqual(cases, [
		['completed', undefined, undefined, undefined],
		['completed', undefined, undefined, undefined],
		['unchanged', undefined, undefined, undefined],
		['partial', 'max-turns', undefined, '8b725e4b-cd27-430d-beca-a8a5e83257b3'],
		['partial', 'timeout', undefined, undefined],
		['unchanged', 'cancelled', undefined, undefined],
		['blocked', 'PostgreSQL no responde', 'service', undefined],
		['failed', 'verification', undefined, undefined],
		['failed', 'provider', undefined, undefined],
		['failed', 'web-search-secret', undefined, undefined]
	]);
});

test('a blocked block must be valid JSON with a known need; anything else stays plain text', () => {
	assert.deepEqual([
		parseRunBlock('harness-blocked: {"reason":"x","needs":"teleport"}'),
		parseRunBlock('harness-blocked: not json'),
		parseRunBlock('texto `harness-blocked: {"reason":"x","needs":"disk"}` en línea'),
		parseRunBlock('harness-blocked: {"reason":"Sin espacio","needs":"disk"}')
	], [undefined, undefined, undefined, { reason: 'Sin espacio', needs: 'disk' }]);
	assert.deepEqual([validRunOutcome({ kind: 'partial', diff: diff(1) }), validRunOutcome({ kind: 'done' as 'partial', diff: diff(1) }), validRunOutcome({ kind: 'partial', diff: diff(1), sessionId: '--resume' })], [true, false, false]);
});

test('the run diff separates files the run changed from the user\'s earlier edits', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-run-diff-')));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
	try {
		git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'core.autocrlf', 'false');
		for (const name of ['kept.txt', 'edited.txt', 'removed.txt', 'mine.txt']) { await fs.writeFile(path.join(root, name), name); }
		git('add', '.'); git('commit', '-qm', 'base');
		await fs.writeFile(path.join(root, 'mine.txt'), 'edición del usuario');
		await fs.writeFile(path.join(root, 'draft.txt'), 'borrador del usuario');
		const before = await captureWorkingTree(root);
		// The run edits a clean file, removes one, adds one, builds on the user's edit and leaves the user's draft untouched.
		await fs.writeFile(path.join(root, 'edited.txt'), 'cambio');
		await fs.rm(path.join(root, 'removed.txt'));
		await fs.mkdir(path.join(root, 'src'));
		await fs.writeFile(path.join(root, 'src', 'new.ts'), 'export {};');
		await fs.writeFile(path.join(root, 'mine.txt'), 'edición del usuario + agente');
		const summary = diffWorkingTree(before, await captureWorkingTree(root));
		assert.deepEqual(summary, {
			available: true, count: 4, files: [
				{ path: 'edited.txt', change: 'modified', preexisting: false },
				{ path: 'mine.txt', change: 'modified', preexisting: true },
				{ path: 'removed.txt', change: 'deleted', preexisting: false },
				{ path: 'src/new.ts', change: 'added', preexisting: false }
			]
		});
		// Discard restores only what this run touched and the user has not edited since.
		const after = await fingerprintFiles(root, summary.files);
		await fs.writeFile(path.join(root, 'src', 'new.ts'), 'export const touched = 1;');
		assert.deepEqual(await discardRunChanges(root, summary, new Map(Object.entries(after))), { discarded: ['edited.txt', 'removed.txt'], skipped: ['mine.txt', 'src/new.ts'] });
		assert.deepEqual(await Promise.all(['edited.txt', 'removed.txt', 'mine.txt', 'draft.txt'].map(name => fs.readFile(path.join(root, name), 'utf8'))), ['edited.txt', 'removed.txt', 'edición del usuario + agente', 'borrador del usuario']);
		const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-run-diff-nogit-')));
		try { assert.deepEqual(diffWorkingTree(await captureWorkingTree(outside), await captureWorkingTree(outside)), noGit); }
		finally { await fs.rm(outside, { recursive: true, force: true }); }
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('dependency sync installs only from lockfiles without scripts, and cache-only steps never touch the checkout', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sync-')));
	try {
		for (const file of ['apps/api/go.sum', 'web/pnpm-lock.yaml', 'tools/package.json']) {
			await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await fs.writeFile(path.join(root, file), '{}');
		}
		const commands = await syncCommands(root, [
			{ path: 'apps/api', ecosystem: 'go' }, { path: 'web', ecosystem: 'node', packageManager: 'pnpm' }, { path: 'tools', ecosystem: 'node' }
		]);
		assert.deepEqual(commands, [
			{ command: 'go', args: ['mod', 'download'], cwd: 'apps/api', cacheOnly: true },
			{ command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'], cwd: 'web', cacheOnly: false }
		]);
		assert.deepEqual([offlineEnvironment().GOPROXY, offlineEnvironment().npm_config_offline], ['off', 'true']);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
