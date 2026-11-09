/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FILE_TOOLS, handleFileTool, type FileToolsContext } from '../src/native-file-tools.ts';
import type { ApprovalDraft } from '../src/native-approval.ts';
import type { ApprovalAnswer, PermissionDecision } from '../src/native-permissions-types.ts';

const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8' }).trim();
const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

interface Fixture { root: string; base: string; context: FileToolsContext; asked: ApprovalDraft[]; set(decision: PermissionDecision, answer?: ApprovalAnswer): void }

/** A repository with committed `src/a.ts`, `src/b.ts` and `docs/guide.md`; `set` picks the fake `edit:` verdict and the user's answer. */
async function withProject(work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-file-tools-')));
	const root = path.join(base, 'project');
	try {
		await fs.mkdir(path.join(root, 'src'), { recursive: true });
		await fs.mkdir(path.join(root, 'docs'));
		execFileSync('git', ['init', '-q', root]);
		for (const file of ['src/a.ts', 'src/b.ts', 'docs/guide.md']) { await fs.writeFile(path.join(root, file), file + '\n'); }
		git(root, 'add', '.');
		git(root, 'commit', '-qm', 'seed');
		let decision: PermissionDecision = 'allow', answer: ApprovalAnswer = 'once';
		const asked: ApprovalDraft[] = [];
		const context: FileToolsContext = {
			root,
			permissions: { decide: () => ({ decision, source: 'preset' }) },
			ask: async request => { asked.push(request); return answer; }
		};
		await work({ root, base, context, asked, set: (next, reply = 'once') => { decision = next; answer = reply; } });
	} finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('the file tools are described to the model as the replacement for shell deletions and moves', () => {
	assert.deepEqual(FILE_TOOLS.map(tool => [tool.name, /instead of (rm|mv)/.test(tool.description)]), [['delete_path', true], ['move_path', true]]);
});

test('deleting tracked, unmodified files needs no question; untracked or modified ones ask, and a refusal keeps them', async () => {
	await withProject(async ({ root, context, asked, set }) => {
		const clean = await handleFileTool(context, 'delete_path', { path: 'docs' });
		await fs.writeFile(path.join(root, 'notes.txt'), 'local only\n');
		await fs.writeFile(path.join(root, 'src/a.ts'), 'edited\n');
		set('allow', 'deny');
		const refusedUntracked = await handleFileTool(context, 'delete_path', { path: 'notes.txt' });
		const refusedModified = await handleFileTool(context, 'delete_path', { path: 'src/a.ts' });
		set('allow', 'once');
		const approved = await handleFileTool(context, 'delete_path', { path: 'notes.txt' });
		assert.deepEqual({
			clean, refusedUntracked, refusedModified, approved,
			asked: asked.map(card => [card.kind, card.rule, card.detail.join(' | ')]),
			left: await Promise.all(['docs', 'notes.txt', 'src/a.ts'].map(file => exists(path.join(root, file))))
		}, {
			clean: { isError: false, text: 'DELETED docs (2 entries)' },
			refusedUntracked: { isError: true, text: 'DENIED: the user did not allow it' },
			refusedModified: { isError: true, text: 'DENIED: the user did not allow it' },
			approved: { isError: false, text: 'DELETED notes.txt' },
			asked: [
				['edit', '', 'delete: notes.txt | NOT recoverable with git'],
				['edit', '', 'delete: src/a.ts | NOT recoverable with git'],
				['edit', '', 'delete: notes.txt | NOT recoverable with git']
			],
			left: [false, false, true]
		});
	});
});

test('the floor refuses repository internals, permission files, the root and paths outside the project, whatever the rules say', async () => {
	await withProject(async ({ root, base, context, asked }) => {
		await fs.mkdir(path.join(root, '.armotusitio'));
		await fs.writeFile(path.join(root, '.armotusitio', 'permissions.json'), '{}');
		await fs.writeFile(path.join(base, 'outside.txt'), 'x');
		const results = await Promise.all([
			{ path: '.git' }, { path: 'src/../.git/config' }, { path: '.armotusitio/permissions.json' }, { path: '.' }, { path: '../outside.txt' },
			{ path: path.join(base, 'outside.txt') }, { path: 'C:/Windows' }, { path: '' }, { path: 'missing.txt' }, {}
		].map(input => handleFileTool(context, 'delete_path', input).then(result => result.text)));
		assert.deepEqual({ results, asked: asked.length, outside: await exists(path.join(base, 'outside.txt')), git: await exists(path.join(root, '.git')) }, {
			results: ['POLICY_DENIED: protected-path', 'POLICY_DENIED: protected-path', 'POLICY_DENIED: protected-path', 'POLICY_DENIED: project-root', 'POLICY_DENIED: path-outside-project',
				'POLICY_DENIED: absolute-path', 'POLICY_DENIED: absolute-path', 'POLICY_DENIED: invalid-path', 'POLICY_DENIED: path-not-found', 'POLICY_DENIED: invalid-path'],
			asked: 0, outside: true, git: true
		});
	});
});

test('a folder that hides a nested repository is refused, and a link is removed without touching its target', async () => {
	await withProject(async ({ root, base, context }) => {
		await fs.mkdir(path.join(root, 'vendor', 'lib', '.git'), { recursive: true });
		const nested = await handleFileTool(context, 'delete_path', { path: 'vendor' });
		await fs.mkdir(path.join(base, 'target'));
		await fs.writeFile(path.join(base, 'target', 'keep.txt'), 'keep');
		let linked = true;
		try { await fs.symlink(path.join(base, 'target'), path.join(root, 'link'), 'junction'); } catch { linked = false; }
		const escape = linked ? await handleFileTool(context, 'delete_path', { path: 'link/keep.txt' }) : { isError: true, text: 'POLICY_DENIED: path-outside-project' };
		const link = linked ? await handleFileTool(context, 'delete_path', { path: 'link' }) : { isError: false, text: 'DELETED link' };
		assert.deepEqual({ nested: nested.text, link: link.text, escape: escape.text, kept: await exists(path.join(base, 'target', 'keep.txt')), vendor: await exists(path.join(root, 'vendor', 'lib', '.git')) },
			{ nested: 'POLICY_DENIED: protected-path', link: 'DELETED link', escape: 'POLICY_DENIED: path-outside-project', kept: true, vendor: true });
	});
});

test('moves rename inside the project, never overwrite, honour edit rules and ask for sensitive targets', async () => {
	await withProject(async ({ root, context, asked, set }) => {
		const renamed = await handleFileTool(context, 'move_path', { from: 'src/a.ts', to: 'lib/deep/a.ts' });
		const overwrite = await handleFileTool(context, 'move_path', { from: 'src/b.ts', to: 'docs/guide.md' });
		const into = await handleFileTool(context, 'move_path', { from: 'src', to: 'src/inner' });
		const outside = await handleFileTool(context, 'move_path', { from: 'src/b.ts', to: '../b.ts' });
		set('allow', 'deny');
		const sensitive = await handleFileTool(context, 'move_path', { from: 'src/b.ts', to: '.env' });
		set('deny');
		const denied = await handleFileTool(context, 'move_path', { from: 'src/b.ts', to: 'src/c.ts' });
		set('ask', 'once');
		const askedMove = await handleFileTool(context, 'move_path', { from: 'src/b.ts', to: 'src/c.ts' });
		assert.deepEqual({
			results: [renamed, overwrite, into, outside, sensitive, denied, askedMove].map(result => result.text),
			asked: asked.map(card => card.detail[0]),
			files: await Promise.all(['lib/deep/a.ts', 'src/a.ts', 'src/c.ts', 'docs/guide.md'].map(file => exists(path.join(root, file))))
		}, {
			results: ['MOVED src/a.ts -> lib/deep/a.ts', 'POLICY_DENIED: destination-exists', 'POLICY_DENIED: invalid-destination', 'POLICY_DENIED: path-outside-project',
				'DENIED: the user did not allow it', 'POLICY_DENIED: denied by permissions', 'MOVED src/b.ts -> src/c.ts'],
			asked: ['move: src/b.ts -> .env', 'move: src/b.ts -> src/c.ts'],
			files: [true, false, true, true]
		});
	});
});

test('without a way to ask the user, an irreversible deletion is denied instead of performed', async () => {
	await withProject(async ({ root, context }) => {
		await fs.writeFile(path.join(root, 'scratch.txt'), 'x');
		const result = await handleFileTool({ ...context, ask: undefined }, 'delete_path', { path: 'scratch.txt' });
		assert.deepEqual([result.text, await exists(path.join(root, 'scratch.txt'))], ['DENIED: this run has no way to ask the user', true]);
	});
});

test('a corrupt, git-ignored node_modules with a lockfile can be deleted whatever its size, so the agent can repair an install', async () => {
	await withProject(async ({ root, context, asked }) => {
		await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
		await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
		await Promise.all(Array.from({ length: 2100 }, (_, index) => fs.writeFile(path.join(root, 'node_modules', 'pkg', index + '.js'), 'x')));
		// Without a lockfile the folder is not provably reinstallable, so the entry cap still applies.
		const noLockfile = await handleFileTool(context, 'delete_path', { path: 'node_modules' });
		await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		const repaired = await handleFileTool(context, 'delete_path', { path: 'node_modules' });
		assert.deepEqual({ noLockfile: noLockfile.text, repaired: repaired.text, asked: asked.length, left: await exists(path.join(root, 'node_modules')) },
			{ noLockfile: 'POLICY_DENIED: too-many-entries', repaired: 'DELETED node_modules', asked: 0, left: false });
	});
});

test('a node_modules that git does not ignore is still capped, because reinstalling would not restore local changes', async () => {
	await withProject(async ({ root, context }) => {
		await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
		await Promise.all(Array.from({ length: 2100 }, (_, index) => fs.writeFile(path.join(root, 'node_modules', 'pkg', index + '.js'), 'x')));
		await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		const result = await handleFileTool(context, 'delete_path', { path: 'node_modules' });
		assert.deepEqual([result.text, await exists(path.join(root, 'node_modules'))], ['POLICY_DENIED: too-many-entries', true]);
	});
});

test('a dependency folder is refused when a protected folder hides inside it, accepted with the lockfile at a workspace root, and links are never followed', async () => {
	await withProject(async ({ root, base, context }) => {
		await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
		await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		await fs.mkdir(path.join(root, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep', '.git'), { recursive: true });
		const nested = await handleFileTool(context, 'delete_path', { path: 'node_modules' });
		await fs.rm(path.join(root, 'node_modules'), { recursive: true });

		const outside = path.join(base, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'keep.txt'), 'mine');
		await fs.mkdir(path.join(root, 'apps', 'web', 'node_modules'), { recursive: true });
		await fs.symlink(outside, path.join(root, 'apps', 'web', 'node_modules', 'linked'), 'junction');
		const workspace = await handleFileTool(context, 'delete_path', { path: 'apps/web/node_modules' });
		assert.deepEqual({
			nested: nested.text,
			workspace: workspace.text,
			kept: await exists(path.join(outside, 'keep.txt')),
			gone: !await exists(path.join(root, 'apps', 'web', 'node_modules'))
		}, { nested: 'POLICY_DENIED: protected-path', workspace: 'DELETED apps/web/node_modules', kept: true, gone: true });
	});
});

test('on Windows an alternate data stream, a trailing dot or space and a short name cannot reach a protected folder', { skip: process.platform !== 'win32' }, async () => {
	await withProject(async ({ root, context }) => {
		const aliases = ['.git::$INDEX_ALLOCATION', '.git.', '.git ', 'GIT~1', '.armotusitio::$INDEX_ALLOCATION', 'src/a.ts:hidden'];
		const results = await Promise.all(aliases.map(alias => handleFileTool(context, 'delete_path', { path: alias })));
		const moved = await handleFileTool(context, 'move_path', { from: 'src/a.ts', to: '.git::$DATA' });
		assert.deepEqual({ results: results.map(result => result.text), moved: moved.text, git: await exists(path.join(root, '.git')), file: await exists(path.join(root, 'src/a.ts')) },
			{ results: aliases.map(() => 'POLICY_DENIED: invalid-path'), moved: 'POLICY_DENIED: invalid-path', git: true, file: true });
	});
});

test('a protected folder planted in a dependency folder while the approval is pending stops the deletion', async () => {
	await withProject(async ({ root, context, set }) => {
		await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
		await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
		set('ask');
		const result = await handleFileTool({ ...context, ask: async () => { await fs.mkdir(path.join(root, 'node_modules', 'pkg', '.git')); return 'once'; } }, 'delete_path', { path: 'node_modules' });
		assert.deepEqual([result.text, await exists(path.join(root, 'node_modules', 'pkg', '.git'))], ['POLICY_DENIED: protected-path', true]);
	});
});
