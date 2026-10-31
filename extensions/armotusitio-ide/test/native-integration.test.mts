/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeProjectConfig } from '../src/native-project.ts';
import { inspectHarnessAuthority } from '../src/native-authority.ts';
import { acquireSharedExecutionFence, inspectSharedExecutionFence } from '../src/native-shared-fence.ts';
import { installFakeCodex } from './native-fake-provider.mts';
import { referenceEngine } from './native-reference-engine.mts';

import { fixture } from './native-integration-fixture.mts';

test('native IDE flow preserves the full configured DAG and isolates two open roots', async () => {
	const f = await fixture();
	try {
		await fs.mkdir(path.join(f.roots[0], 'subproject'));
		await writeProjectConfig(f.roots[0], {
			schemaVersion: 1, runtime: 'ide-native', profile: 'custom', plan: {
				schemaVersion: 1, gates: [
					{ id: 'first', executable: 'node', args: ['--version'], cwd: 'subproject' },
					{ id: 'second', executable: 'node', args: ['--version'], dependsOn: ['first'] }
				]
			}
		});
		await f.invoke('nativeNewTask', f.roots[0]);
		await f.invoke('nativeRunTask', f.roots[0]);
		await f.invoke('nativeStatus', f.roots[0]);
		const outcome = JSON.parse(f.documents.at(-1)!.content)[0].attempts.at(-1);
		assert.deepEqual({ status: outcome.status, gates: outcome.results.map(result => result.id) }, { status: 'passed', gates: ['first', 'second'] });
		const rows = await f.controller.nativeProjects();
		assert.deepEqual(rows.map(row => row.tasks.length), [1, 0]);
		await f.invoke('nativeStatus', f.roots[0]);
		assert.equal(JSON.parse(f.documents.at(-1)!.content)[0].plan.gates[0].cwd, 'subproject');
	} finally { await f.cleanup(); }
});

test('restricted workspace, outside root and project authority cannot start a bundled task', async () => {
	const f = await fixture();
	try {
		f.vscode.workspace.isTrusted = false;
		await f.invoke('nativeNewTask', f.roots[0]);
		f.vscode.workspace.isTrusted = true;
		await f.invoke('nativeNewTask', path.dirname(f.roots[0]));
		await fs.mkdir(path.join(f.roots[0], '.harness'));
		await f.invoke('nativeNewTask', f.roots[0]);
		const rows = await f.controller.nativeProjects();
		assert.deepEqual(rows.map(row => ({ root: row.root, tasks: row.tasks.length })), [{ root: f.roots[1], tasks: 0 }]);
		assert.equal((await inspectHarnessAuthority(f.roots[0])).reason, 'project-marker');
	} finally { await f.cleanup(); }
});

test('project Harness symlink is blocked without reading or replacing its state', async () => {
	const f = await fixture();
	try {
		await fs.symlink(f.roots[1], path.join(f.roots[0], '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
		assert.deepEqual(await inspectHarnessAuthority(f.roots[0]), { engine: 'project', reason: 'project-path-unsafe' });
		await f.invoke('nativeConfigure', f.roots[0]);
		await assert.rejects(fs.stat(path.join(f.roots[0], '.ats-harness.json')), { code: 'ENOENT' });
	} finally { await f.cleanup(); }
});

test('hybrid project keeps its task engine but exposes native read-only agent review and skill catalog', async () => {
	const f = await fixture();
	try {
		const project = f.roots[0];
		await fs.mkdir(path.join(project, '.harness'));
		const skillDir = path.join(project, '.agents', 'skills', 'security');
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Review security boundaries');
		await f.invoke('nativeAgentReview', project);
		const preview = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(preview.hybrid, true);
		assert.equal(preview.executionEnabled, false);
		assert.deepEqual(preview.skills.map(skill => skill.name), ['security']);
		await f.invoke('nativeNewTask', project);
		const rows = await f.controller.nativeProjects();
		assert.deepEqual(rows.map(row => row.root), [f.roots[1]]);
	} finally { await f.cleanup(); }
});

test('hybrid projects block native writers before any provider invocation', async () => {
	const f = await fixture();
	try {
		await fs.mkdir(path.join(f.roots[0], '.harness'));
		f.vscode.window.showQuickPick = async (items, options) =>
			options?.title === 'Rol del agente' ? 'implementer' : items[0];
		await f.invoke('nativeAgentExecute', f.roots[0]);
		assert.ok(f.notices.some(notice => notice.includes('HARNESS_HYBRID_WRITER_UNAVAILABLE')));
		assert.equal(f.documents.length, 0);
	} finally { await f.cleanup(); }
});

test('new project harness during approval cannot enable an uncoordinated native writer', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		f.vscode.window.showQuickPick = async (items, options) =>
			options?.title === 'Rol del agente' ? 'implementer' : items[0];
		f.vscode.window.showWarningMessage = async (_, __, action) => {
			await fs.mkdir(path.join(root, '.harness'));
			return action;
		};
		await f.invoke('nativeAgentExecute', root);
		assert.ok(f.notices.some(notice => notice.includes('HARNESS_HYBRID_WRITER_UNAVAILABLE')));
		assert.equal((await fs.readdir(path.join(root, '.harness'))).length, 0);
	} finally { await f.cleanup(); }
});

test('hybrid skill selection refuses content changed during approval without launching provider', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		await fs.mkdir(path.join(root, '.harness'));
		const dir = path.join(root, '.agents', 'skills', 'go-api');
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, 'SKILL.md');
		await fs.writeFile(file, '# Approved conventions');
		f.vscode.window.showQuickPick = async (items, options) => {
			if (options?.title === 'Rol del agente') { return 'planner'; }
			if (options?.canPickMany) { return [items[0]]; }
			return items[0];
		};
		f.vscode.window.showWarningMessage = async (_, __, action) => {
			await fs.writeFile(file, '# Mutated conventions');
			return action;
		};
		await f.invoke('nativeAgentExecute', root);
		assert.ok(f.notices.some(notice => notice.includes('HARNESS_PROJECT_SKILL_CHANGED')));
		assert.ok(f.documents.length >= 1);
	} finally { await f.cleanup(); }
});

test('hybrid agent refuses more than eight project skills before launching provider', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		await fs.mkdir(path.join(root, '.harness'));
		for (let i = 0; i < 9; i++) {
			const dir = path.join(root, '.agents', 'skills', 'skill_' + i);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, 'SKILL.md'), '# Skill');
		}
		f.vscode.window.showQuickPick = async (items, options) => {
			if (options?.title === 'Rol del agente') { return 'planner'; }
			if (options?.canPickMany) { return items.slice(0, 9); }
			return items[0];
		};
		await f.invoke('nativeAgentExecute', root);
		assert.ok(f.notices.some(notice => notice.includes('HARNESS_PROJECT_SKILL_SELECTION_INVALID')));
		assert.equal(f.documents.length, 0);
	} finally { await f.cleanup(); }
});

test('Codex-only project exposes its skills to native agent review without a project Harness', async () => {
	const f = await fixture();
	try {
		const dir = path.join(f.roots[0], '.codex', 'skills', 'security');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'SKILL.md'), '# Codex security guidance');
		await f.invoke('nativeAgentReview', f.roots[0]);
		const preview = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(preview.hybrid, false);
		assert.equal(preview.executionEnabled, false);
		assert.deepEqual(preview.skills.map(skill => [skill.name, skill.source]), [['security', '.codex/skills']]);
	} finally { await f.cleanup(); }
});

test('native multi-skill selection rejects duplicated entries before provider invocation', async () => {
	const f = await fixture();
	try {
		const dir = path.join(f.roots[0], '.codex', 'skills', 'go-api');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'SKILL.md'), '# Codex');
		f.vscode.window.showQuickPick = async (items, options) => {
			if (options?.title === 'Rol del agente') { return 'planner'; }
			if (options?.canPickMany) { return [items[0], items[0]]; }
			return items[0];
		};
		await f.invoke('nativeAgentExecute', f.roots[0]);
		assert.ok(f.notices.some(notice => notice.includes('HARNESS_PROJECT_SKILL_SELECTION_INVALID')));
		assert.equal(f.documents.length, 0);
	} finally { await f.cleanup(); }
});

test('project guidance changed during consent prevents launching a native agent', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		const guide = path.join(root, 'AGENTS.md');
		await fs.writeFile(guide, '# First version');
		f.vscode.window.showQuickPick = async (items, options) =>
			options?.title === 'Rol del agente' ? 'planner' : items[0];
		f.vscode.window.showWarningMessage = async (_, __, action) => {
			await fs.writeFile(guide, '# Changed during approval');
			return action;
		};
		await f.invoke('nativeAgentExecute', root);
		assert.ok(f.notices.some(message => message.includes('HARNESS_PROJECT_GUIDANCE_CHANGED')));
		assert.ok(f.documents.length >= 1);
	} finally { await f.cleanup(); }
});

test('project guidance metadata is available for review without invoking a provider', async () => {
	const f = await fixture();
	try {
		await fs.writeFile(path.join(f.roots[0], 'AGENTS.md'), '# Team conventions');
		await f.invoke('nativeAgentReview', f.roots[0]);
		const review = JSON.parse(f.documents.at(-1)!.content);
		assert.deepEqual(review.guides.map(guide => guide.path), ['AGENTS.md']);
		assert.equal(f.documents.at(-1)!.content.includes('Team conventions'), false);
	} finally { await f.cleanup(); }
});

test('explicit project handshake displays advisory capability routing without enabling external execution', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		await fs.mkdir(path.join(root, '.harness', 'manifests'), { recursive: true });
		await fs.writeFile(path.join(root, '.harness', 'manifests', 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['parallel-gates', 'os-sandbox'] }));
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'),
			'console.log(JSON.stringify({ schemaVersion: 2, nonce: process.argv[process.argv.indexOf("--nonce") + 1], capabilities: ["parallel-gates", "os-sandbox"] }));');
		await f.invoke('nativeProjectHandshake', root);
		const displayed = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(displayed.executionEnabled, false);
		assert.equal(displayed.comparison.executionGranted, false);
		assert.ok(displayed.comparison.overlap.includes('parallel-gates'));
		assert.deepEqual(displayed.comparison.projectOnly, ['os-sandbox']);
	} finally { await f.cleanup(); }
});

test('explicit handshake displays project DAG gate metadata without granting execution', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		const manifests = path.join(root, '.harness', 'manifests');
		await fs.mkdir(manifests, { recursive: true });
		await fs.writeFile(path.join(manifests, 'ide-capabilities.json'), JSON.stringify({
			schemaVersion: 2, engine: 'project', capabilities: ['verification-gates']
		}));
		await fs.writeFile(path.join(manifests, 'ide-gates.json'), JSON.stringify({
			schemaVersion: 1, gates: [
				{ id: 'lint', dependsOn: [], resources: ['cpu'] },
				{ id: 'tests', dependsOn: ['lint'], resources: ['db'] }
			]
		}));
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'),
			'console.log(JSON.stringify({ schemaVersion: 2, nonce: process.argv[process.argv.indexOf("--nonce") + 1], capabilities: ["verification-gates"] }));');
		await f.invoke('nativeProjectHandshake', root);
		const preview = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(preview.executionEnabled, false);
		assert.equal(preview.gateCatalog.executionEnabled, false);
		assert.deepEqual(preview.gateCatalog.gates[1].dependsOn, ['lint']);
		assert.deepEqual(preview.simulatedGateWaves, [['lint'], ['tests']]);
		assert.equal(preview.gateReadiness.declarativeReady, true);
		assert.equal(preview.gateReadiness.executionEnabled, false);
		assert.ok(preview.gateReadiness.blockers.includes('shared-writer-fencing-unverified'));
		assert.ok(/^[a-f0-9]{64}$/.test(preview.gateCatalog.digest));
	} finally { await f.cleanup(); }
});

test('workflow history reports unresolved journal IDs without exposing uncertain record content', async () => {
	const f = await fixture();
	try {
		const root = f.roots[0];
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const store = path.join(path.dirname(root), 'private', 'native-harness', digest, 'workflows');
		await fs.mkdir(store, { recursive: true });
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
		await fs.writeFile(path.join(store, id + '.json.intent'), 'UNCERTAIN_PRIVATE_CONTENT');
		await f.invoke('nativeWorkflowHistory', root);
		const preview = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(preview.status, 'recovery-required');
		assert.equal(preview.executionEnabled, false);
		assert.deepEqual(preview.pendingJournalIds, [id]);
		assert.equal(f.documents.at(-1)!.content.includes('UNCERTAIN_PRIVATE_CONTENT'), false);
	} finally { await f.cleanup(); }
});

test('IDE shared-fence recovery refuses a live process without altering its lock', async () => {
	const f = await fixture();
	try {
		const root = await fs.realpath(f.roots[0]);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		const lease = await acquireSharedExecutionFence(root, storage, 'native-task');
		await f.invoke('nativeSharedFenceReconcile', root);
		assert.deepEqual(await inspectSharedExecutionFence(root, storage),
			{ held: true, epoch: lease.epoch, owner: 'native-task' });
		await lease.release();
		await f.invoke('nativeSharedFenceReconcile', root);
		assert.ok(f.notices.some(message => String(message).includes('No hay un fence')));
	} finally { await f.cleanup(); }
});

test('IDE quota diagnostics are read-only and disabled by default', async () => {
	const f = await fixture();
	try {
		await f.invoke('nativeProviderQuotaStatus', f.roots[0]);
		const status = JSON.parse(f.documents.at(-1)!.content);
		assert.equal(status.enabled, false);
		assert.equal(status.maxCallsPer24h, null);
		assert.deepEqual(status.providers.codex, { used: 0, remaining: null });
		assert.deepEqual(status.providers.claude, { used: 0, remaining: null });
	} finally { await f.cleanup(); }
});

test('IDE integrates a reviewed worktree into the primary checkout and rolls it back on request', async () => {
	const f = await fixture();
	try {
		const { execFileSync } = await import('node:child_process');
		const { createAgentWorktree, removeCleanAgentWorktree } = await import('../src/native-agent-worktree.ts');
		const { createWorktreeCheckpoint } = await import('../src/native-worktree-checkpoint.ts');
		const root = await fs.realpath(f.roots[0]);
		execFileSync('git', ['init', '-q', root]);
		execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
		await fs.writeFile(path.join(root, 'app.txt'), 'baseline\n');
		execFileSync('git', ['-C', root, 'add', '.']);
		execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed']);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		const managed = await createAgentWorktree(root, path.join(storage, 'isolated-worktrees'));
		const fence = await acquireSharedExecutionFence(root, storage, 'native-workflow');
		try { await createWorktreeCheckpoint(managed, path.join(storage, 'checkpoints'), fence); }
		finally { await fence.release(); }
		await fs.writeFile(path.join(managed.root, 'app.txt'), 'reviewed\n');
		await f.invoke('nativeWorktreeIntegrate', root);
		const integrated = JSON.parse(f.documents.at(-1)!.content);
		assert.deepEqual({ status: integrated.status, files: integrated.files, content: await fs.readFile(path.join(root, 'app.txt'), 'utf8') },
			{ status: 'applied', files: ['app.txt'], content: 'reviewed\n' });
		await f.invoke('nativeWorktreeIntegrationRollback', root);
		assert.equal(await fs.readFile(path.join(root, 'app.txt'), 'utf8'), 'baseline\n');
		assert.equal((await inspectSharedExecutionFence(root, storage)).held, false);
		execFileSync('git', ['-C', managed.root, 'checkout', '-q', '--', '.']);
		await removeCleanAgentWorktree(managed);
	} finally { await f.cleanup(); }
});

test('IDE token budget refuses an agent before launching its provider and releases the fence', async () => {
	const f = await fixture();
	try {
		const { recordProviderSpend } = await import('../src/native-provider-quota.ts');
		const root = await fs.realpath(f.roots[0]);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		const lease = await acquireSharedExecutionFence(root, storage, 'native-agent');
		try { await recordProviderSpend(storage, 'codex', lease, { usage: { inputTokens: 5, outputTokens: 5 } }); }
		finally { await lease.release(); }
		const settings: Record<string, number> = { providerTokensPer24h: 10 };
		f.vscode.workspace.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
		await f.invoke('nativeAgentExecute', root);
		assert.ok(f.notices.some(message => String(message).includes('HARNESS_PROVIDER_TOKEN_BUDGET_EXCEEDED')));
		assert.equal((await inspectSharedExecutionFence(root, storage)).held, false);
		await f.invoke('nativeProviderQuotaStatus', root);
		assert.deepEqual(JSON.parse(f.documents.at(-1)!.content).budget.providers.codex,
			{ tokens: 10, costUsd: 0, unmeteredCalls: 0, rateLimitedUntil: null });
	} finally { await f.cleanup(); }
});

test('IDE delegates a cataloged project gate under its shared fence and releases it afterwards', async () => {
	const f = await fixture();
	try {
		const root = await fs.realpath(f.roots[0]);
		const harness = path.join(root, '.harness');
		await fs.mkdir(path.join(harness, 'manifests'), { recursive: true });
		await fs.writeFile(path.join(harness, 'manifests', 'ide-capabilities.json'), JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['verification-gates', 'bounded-processes'] }));
		await fs.writeFile(path.join(harness, 'manifests', 'ide-gates.json'), JSON.stringify({ schemaVersion: 1, gates: [{ id: 'unit', dependsOn: [], resources: [] }] }));
		await fs.writeFile(path.join(harness, 'core.mjs'), [
			'const arg = name => process.argv[process.argv.indexOf(name) + 1];',
			'const nonce = arg("--nonce");',
			'if (process.argv[2] === "capabilities") { console.log(JSON.stringify({ schemaVersion: 2, nonce, capabilities: ["verification-gates", "bounded-processes"] })); }',
			'else if (process.argv[2] === "ide-gate") { console.log(JSON.stringify({ schemaVersion: 2, nonce, gate: arg("--gate"), status: "passed", durationMs: 1, fenceEpoch: Number(arg("--fence-epoch")), evidenceDigest: "a".repeat(64) })); }'
		].join('\n'));
		await f.invoke('nativeProjectGateDelegate', root);
		const result = JSON.parse(f.documents.at(-1)!.content);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		assert.deepEqual({ gate: result.gate, status: result.status, held: (await inspectSharedExecutionFence(root, storage)).held },
			{ gate: 'unit', status: 'passed', held: false });
	} finally { await f.cleanup(); }
});

test('IDE trace command exposes executed gate spans without task output', async () => {
	const f = await fixture();
	try {
		await writeProjectConfig(f.roots[0], { schemaVersion: 1, runtime: 'ide-native', profile: 'custom', plan: { schemaVersion: 1, gates: [{ id: 'version', executable: 'node', args: ['--version'] }] } });
		await f.invoke('nativeNewTask', f.roots[0]);
		await f.invoke('nativeRunTask', f.roots[0]);
		await f.invoke('nativeTrace', f.roots[0]);
		const trace = JSON.parse(f.documents.at(-1)!.content);
		assert.deepEqual({ kinds: trace.spans.map(span => span.kind), statuses: trace.spans.map(span => span.status), lines: trace.summary[0].length },
			{ kinds: ['task', 'gate'], statuses: ['ok', 'ok'], lines: 2 });
		assert.equal(f.documents.at(-1)!.content.includes(process.version), false);
	} finally { await f.cleanup(); }
});

test('chat runtime converses read-only, then implements an approved plan and runs configured gates under one fence', async () => {
	const f = await fixture();
	const originalPath = process.env.PATH;
	try {
		const root = await fs.realpath(f.roots[0]);
		await writeProjectConfig(root, { schemaVersion: 1, runtime: 'ide-native', profile: 'custom', plan: { schemaVersion: 1, gates: [{ id: 'exists', executable: 'node', args: ['-e', 'require("fs").accessSync("clients.txt")'] }] } });
		const bin = path.join(path.dirname(root), 'fake-bin');
		// Test-only provider: writes only when it receives the approved implementation instruction.
		await installFakeCodex(bin, [
			'#!/usr/bin/env node',
			'let input = ""; process.stdin.on("data", c => input += c);',
			'process.stdin.on("end", () => {',
			'  if (input.includes("Implement the approved plan")) { require("fs").writeFileSync("clients.txt", "crud"); console.log("Created clients.txt"); return; }',
			'  console.log(["Propuesta", "```harness-plan", JSON.stringify({ title: "CRUD", steps: ["Crear clients.txt"] }), "```"].join(String.fromCharCode(10)));',
			'});'
		].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const folder = f.vscode.workspace.workspaceFolders[0];
		const runtime = f.controller.nativeChatRuntime(folder);
		const context = await runtime.context();
		assert.deepEqual({ writer: context.writer, gates: context.verification.gates.map(gate => gate.id) }, { writer: true, gates: ['exists'] });
		const hooks = { started() { }, progress() { }, stage() { }, gates() { } };
		const turn = await runtime.converse('codex', 'Quiero agregar un CRUD de clientes', hooks);
		assert.equal(turn.status, 'passed');
		assert.match(turn.output, /harness-plan/);
		await assert.rejects(fs.access(path.join(root, 'clients.txt')));
		const { extractChatPlan } = await import('../src/native-chat.ts');
		const plan = extractChatPlan(turn.output, 1).plan!;
		const stages: string[] = [];
		const result = await runtime.implement({ provider: 'codex', instruction: 'Implement the approved plan v1', plan, verificationRevision: context.verification.revision }, { ...hooks, stage: stage => stages.push(stage) }, new AbortController().signal);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		assert.deepEqual({ agent: result.agent.status, verification: result.verification, stages, held: (await inspectSharedExecutionFence(root, storage)).held, file: await fs.readFile(path.join(root, 'clients.txt'), 'utf8') },
			{ agent: 'passed', verification: { status: 'passed', gates: [{ id: 'exists', status: 'passed' }] }, stages: ['agent', 'verifying'], held: false, file: 'crud' });
		// A changed verification plan invalidates the approval before any provider starts.
		await assert.rejects(runtime.implement({ provider: 'codex', instruction: 'Implement the approved plan v1', plan, verificationRevision: 'f'.repeat(64) }, hooks, new AbortController().signal), /HARNESS_CHAT_VERIFICATION_CHANGED/);
		// Project-owned Harness: conversation remains possible, writers are refused before launching the provider.
		await fs.rm(path.join(root, 'clients.txt'));
		await fs.mkdir(path.join(root, '.harness'));
		assert.equal((await runtime.context()).writer, false);
		await assert.rejects(runtime.implement({ provider: 'codex', instruction: 'Implement the approved plan v1', plan }, hooks, new AbortController().signal), /HARNESS_HYBRID_WRITER_UNAVAILABLE/);
		await assert.rejects(fs.access(path.join(root, 'clients.txt')));
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await f.cleanup();
	}
});

test('chat runtime streams real intermediate Codex messages, redacted, before the turn ends', async () => {
	const f = await fixture();
	const originalPath = process.env.PATH;
	try {
		const root = await fs.realpath(f.roots[0]);
		const bin = path.join(path.dirname(root), 'fake-stream-bin');
		// Test-only provider emitting Codex JSONL: one intermediate message, a pause, then the final answer.
		await installFakeCodex(bin, [
			'#!/usr/bin/env node',
			'const line = (type, item) => process.stdout.write(JSON.stringify({ type, item }) + String.fromCharCode(10));',
			'process.stdin.resume(); process.stdin.on("end", () => {',
			'  line("item.completed", { type: "agent_message", text: "Revisando con token=abc123secret" });',
			'  setTimeout(() => { line("item.completed", { type: "agent_message", text: "Listo" }); process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + String.fromCharCode(10)); }, 400);',
			'});'
		].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const runtime = f.controller.nativeChatRuntime(f.vscode.workspace.workspaceFolders[0]);
		const streamed: Array<{ text: string; at: number }> = [];
		const turn = await runtime.converse('codex', 'hola', { started() { }, progress() { }, message: text => streamed.push({ text, at: Date.now() }) });
		const finished = Date.now();
		assert.deepEqual({ status: turn.status, output: turn.output, streamed: streamed.map(item => item.text) },
			{ status: 'passed', output: 'Listo', streamed: ['Revisando con token=[redacted]', 'Listo'] });
		assert.ok(finished - streamed[0].at >= 300, 'the first message must arrive before the provider finishes');
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await f.cleanup();
	}
});

test('review #1/#3/#4: guidance edits keep the run, early cancel never spawns, late cancel marks gates cancelled', async () => {
	const f = await fixture();
	const originalPath = process.env.PATH;
	try {
		const root = await fs.realpath(f.roots[0]);
		await fs.writeFile(path.join(root, 'AGENTS.md'), '# Before');
		await writeProjectConfig(root, { schemaVersion: 1, runtime: 'ide-native', profile: 'custom', plan: { schemaVersion: 1, gates: [{ id: 'exists', executable: 'node', args: ['-e', 'require("fs").accessSync("clients.txt")'] }] } });
		const bin = path.join(path.dirname(root), 'fake-guidance-bin');
		const launches = path.join(path.dirname(root), 'launches.txt');
		// Test-only provider: records each launch, edits project guidance and reports through Codex JSONL.
		await installFakeCodex(bin, [
			'#!/usr/bin/env node',
			'const fs = require("fs");',
			'fs.appendFileSync(' + JSON.stringify(launches) + ', "x");',
			'process.stdin.resume(); process.stdin.on("end", () => {',
			'  fs.writeFileSync("AGENTS.md", "# Updated by the plan"); fs.writeFileSync("clients.txt", "crud");',
			'  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Actualic\\u00e9 AGENTS.md" } }) + String.fromCharCode(10));',
			'});'
		].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const runtime = f.controller.nativeChatRuntime(f.vscode.workspace.workspaceFolders[0]);
		const context = await runtime.context();
		const { extractChatPlan } = await import('../src/native-chat.ts');
		const plan = extractChatPlan('```harness-plan\n{"title":"Docs","steps":["Actualizar AGENTS.md"]}\n```', 1).plan!;
		const hooks = { started() { }, progress() { }, stage() { }, gates() { } };
		const request = { provider: 'codex' as const, instruction: 'Implement the approved plan v1', plan, verificationRevision: context.verification.revision };
		// #1: editing a guidance file is a legitimate plan; the run and its gates are reported, not discarded.
		const edited = await runtime.implement(request, hooks, new AbortController().signal);
		assert.deepEqual({ agent: edited.agent.status, output: edited.agent.output, verification: edited.verification.status }, { agent: 'passed', output: 'Actualic\u00e9 AGENTS.md', verification: 'passed' });
		// #3: a signal aborted before spawn never launches the provider, spends no quota credit and releases the fence.
		const settings: Record<string, number> = { providerCallsPer24h: 5 };
		f.vscode.workspace.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
		const before = (await fs.readFile(launches, 'utf8')).length;
		const aborted = new AbortController(); aborted.abort();
		await assert.rejects(runtime.converse('codex', 'hola', hooks, aborted.signal), /HARNESS_CANCELLED_BEFORE_START/);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		const storage = path.join(path.dirname(root), 'private', 'native-harness', digest);
		const { readProviderInvocationQuota } = await import('../src/native-provider-quota.ts');
		assert.deepEqual({ launches: (await fs.readFile(launches, 'utf8')).length - before, held: (await inspectSharedExecutionFence(root, storage)).held, used: (await readProviderInvocationQuota(storage, 5)).providers.codex?.used ?? 0 },
			{ launches: 0, held: false, used: 0 });
		// #4: Stop pressed after the writer finished but before gates ran reports them cancelled, never skipped.
		const late = new AbortController();
		const result = await runtime.implement(request, { ...hooks, message: () => late.abort() }, late.signal);
		assert.deepEqual({ agent: result.agent.status, verification: result.verification.status, gates: result.verification.gates.map(gate => gate.status) },
			{ agent: 'passed', verification: 'cancelled', gates: ['cancelled'] });
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await f.cleanup();
	}
});

test('a project with its own Harness accepts IDE writers only with the opt-in and a verified engine lease', async () => {
	const f = await fixture();
	const originalPath = process.env.PATH;
	const settings: Record<string, unknown> = {};
	f.vscode.workspace.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
	try {
		const root = await fs.realpath(f.roots[0]);
		const engine = await referenceEngine({ root });
		const bin = path.join(path.dirname(root), 'fake-hybrid-bin');
		// Test-only provider: writes a file and, like a competing scheduler, tries to start an engine task meanwhile.
		await installFakeCodex(bin, [
			'#!/usr/bin/env node',
			'let input = ""; process.stdin.on("data", c => input += c);',
			'process.stdin.on("end", () => {',
			'  try { require("child_process").execFileSync(process.execPath, [".harness/core.mjs", "start-task"], { stdio: "ignore" }); } catch { /* an honest engine refuses */ }',
			'  require("fs").writeFileSync("clients.txt", "crud"); console.log("Created clients.txt");',
			'});'
		].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const runtime = f.controller.nativeChatRuntime(f.vscode.workspace.workspaceFolders[0]);
		const hooks = { started() { }, progress() { }, stage() { }, gates() { } };
		const { extractChatPlan } = await import('../src/native-chat.ts');
		const plan = extractChatPlan('```harness-plan\n{"title":"CRUD","steps":["Crear clients.txt"]}\n```', 1).plan!;
		const request = { provider: 'codex' as const, instruction: 'Implement the approved plan v1', plan };
		const written = (): Promise<boolean> => fs.access(path.join(root, 'clients.txt')).then(() => true, () => false);
		const tasks = async (): Promise<number> => JSON.parse(await fs.readFile(path.join(root, '.harness', 'state', 'tasks.json'), 'utf8')).length;
		const leaseHeld = (): Promise<boolean> => fs.access(path.join(root, '.harness', 'state', 'lease.json')).then(() => true, () => false);

		// Default: the project engine keeps exclusive authority.
		assert.equal((await runtime.context()).writer, false);
		await assert.rejects(runtime.implement(request, hooks, new AbortController().signal), /HARNESS_HYBRID_WRITER_UNAVAILABLE/);
		assert.equal(await written(), false);

		// Opted in and honest: the lease is held while the agent writes, the engine's own task is refused, then released.
		settings.coordinatedProjectWriters = true;
		assert.equal((await runtime.context()).writer, true);
		const honest = await runtime.implement(request, hooks, new AbortController().signal);
		assert.deepEqual({ agent: honest.agent.status, written: await written(), tasks: await tasks(), leaseHeld: await leaseHeld() }, { agent: 'passed', written: true, tasks: 0, leaseHeld: false });

		// An engine that ignores the lease is caught: the agent already wrote, so the run is reported as a violation.
		await fs.rm(path.join(root, 'clients.txt'));
		await engine.setMode('ignore-lease');
		await assert.rejects(runtime.implement(request, hooks, new AbortController().signal), /HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED/);
		assert.deepEqual({ written: await written(), tasks: await tasks(), leaseHeld: await leaseHeld() }, { written: true, tasks: 1, leaseHeld: false });

		// The task it started keeps the project blocked for writers until the engine itself reconciles.
		await fs.rm(path.join(root, 'clients.txt'));
		await assert.rejects(runtime.implement(request, hooks, new AbortController().signal), /HARNESS_HYBRID_WRITER_PROJECT_BUSY/);
		assert.equal(await written(), false);

		// An engine that does not honour the fence epoch is refused before any provider starts.
		await fs.writeFile(path.join(root, '.harness', 'state', 'tasks.json'), '[]');
		await engine.setMode('ignore-fence');
		await assert.rejects(runtime.implement(request, hooks, new AbortController().signal), /HARNESS_HYBRID_WRITER_FENCE_IGNORED/);
		assert.equal(await written(), false);
		const digest = (await import('node:crypto')).createHash('sha256').update(root).digest('hex');
		assert.equal((await inspectSharedExecutionFence(root, path.join(path.dirname(root), 'private', 'native-harness', digest))).held, false);
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await f.cleanup();
	}
});

test('the required writer isolation blocks providers that cannot offer it before anything starts', async () => {
	const f = await fixture();
	const originalPath = process.env.PATH;
	const settings: Record<string, unknown> = {};
	f.vscode.workspace.getConfiguration = () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback });
	try {
		const root = await fs.realpath(f.roots[0]);
		const bin = path.join(path.dirname(root), 'fake-isolation-bin');
		await installFakeCodex(bin, ['#!/usr/bin/env node', 'process.stdin.resume(); process.stdin.on("end", () => { require("fs").writeFileSync("written.txt", "x"); console.log("done"); });'].join('\n'));
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const runtime = f.controller.nativeChatRuntime(f.vscode.workspace.workspaceFolders[0]);
		const hooks = { started() { }, progress() { }, stage() { }, gates() { } };
		const { extractChatPlan } = await import('../src/native-chat.ts');
		const plan = extractChatPlan('```harness-plan\n{"title":"X","steps":["Escribir"]}\n```', 1).plan!;
		const written = (): Promise<boolean> => fs.access(path.join(root, 'written.txt')).then(() => true, () => false);
		const implement = (provider: 'codex' | 'claude') => runtime.implement({ provider, instruction: 'Implement the approved plan v1', plan }, hooks, new AbortController().signal);

		// The default accepts the provider's tool permissions; the context tells the UI what confines each writer.
		assert.deepEqual((await runtime.context()).isolation, { codex: { writes: 'provider-sandbox', allowed: true }, claude: { writes: 'tool-allowlist', allowed: true } });
		settings.writerIsolation = 'provider-sandbox';
		assert.deepEqual((await runtime.context()).isolation, { codex: { writes: 'provider-sandbox', allowed: true }, claude: { writes: 'tool-allowlist', allowed: false } });
		await assert.rejects(implement('claude'), /HARNESS_AGENT_ISOLATION_INSUFFICIENT/);
		assert.equal(await written(), false);
		assert.equal((await implement('codex')).agent.status, 'passed');
		assert.equal(await written(), true);

		// A requirement no provider can meet, and any unrecognised value, block every writer.
		await fs.rm(path.join(root, 'written.txt'));
		for (const value of ['os-kernel', 'banana']) {
			settings.writerIsolation = value;
			await assert.rejects(implement('codex'), /HARNESS_AGENT_ISOLATION_INSUFFICIENT/);
		}
		assert.equal(await written(), false);
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await f.cleanup();
	}
});
