/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerNativeHarness } from '../src/native-integration.ts';
import { writeProjectConfig } from '../src/native-project.ts';
import { inspectHarnessAuthority } from '../src/native-authority.ts';
import { acquireSharedExecutionFence, inspectSharedExecutionFence } from '../src/native-shared-fence.ts';

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-ui-'));
	const roots = [path.join(directory, 'project one'), path.join(directory, 'project two')];
	await Promise.all(roots.map(root => fs.mkdir(root)));
	const commands = new Map();
	const documents: Array<{ content: string }> = [];
	const notices: string[] = [];
	const state = new Map();
	const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(directory, 'private') }, globalState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } } };
	const vscode = {
		l10n: { t: (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[index]) },
		commands: { registerCommand: (id, command) => { commands.set(id, command); return { dispose() { } }; } },
		workspace: {
			isTrusted: true, getConfiguration: () => ({ get: (_, fallback) => fallback }),
			workspaceFolders: roots.map(root => ({ name: path.basename(root), uri: { fsPath: root, toString: () => root } })),
			openTextDocument: async document => { documents.push(document); return document; }
		},
		window: {
			showTextDocument: async () => { }, showQuickPick: async items => items[0], showInputBox: async () => 'Fixture task',
			showWarningMessage: async (_, __, action) => action,
			showInformationMessage: async message => { notices.push(message); }, showErrorMessage: async message => { notices.push(message); }
		}
	};
	const controller = { refresh() { }, nativeProjects: async () => [] };
	registerNativeHarness(context, vscode, controller);
	return { roots, vscode, documents, notices, controller, invoke: (command: string, root: string) => commands.get('atsHarness.' + command)(root), cleanup: async () => { for (const disposable of context.subscriptions) { disposable.dispose(); } await fs.rm(directory, { recursive: true, force: true }); } };
}

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
