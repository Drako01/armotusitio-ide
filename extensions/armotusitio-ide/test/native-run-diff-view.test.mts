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
import { registerRunDiffView, validRunPath, RUN_DIFF_COMMAND } from '../src/native-run-diff-view.ts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-run-diff-view-'));
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
	git('init', '-q');
	await fs.writeFile(path.join(root, 'a.ts'), 'committed content\n');
	git('add', '.'); git('commit', '-q', '-m', 'init');
	await fs.writeFile(path.join(root, 'a.ts'), 'changed by the run\n');
	let provider: { provideTextDocumentContent(uri: unknown): Promise<string> } | undefined;
	let command: ((...args: unknown[]) => Promise<void>) | undefined;
	const diffs: unknown[][] = [], opened: unknown[] = [], messages: string[] = [];
	const vscode = {
		Uri: { file: (value: string) => ({ scheme: 'file', fsPath: value }), from: (parts: object) => ({ ...parts }) },
		workspace: { registerTextDocumentContentProvider: (_scheme: string, value: typeof provider) => { provider = value; return { dispose() { } }; } },
		commands: { registerCommand: (id: string, fn: typeof command) => { assert.equal(id, RUN_DIFF_COMMAND); command = fn; return { dispose() { } }; }, executeCommand: async (...args: unknown[]) => { diffs.push(args); } },
		window: { showTextDocument: async (uri: unknown) => { opened.push(uri); }, showInformationMessage: async (text: string) => { messages.push(text); } }
	};
	registerRunDiffView(vscode, { subscriptions: [] }, () => [{ uri: { fsPath: root, toString: () => 'file:///project' } }], t);
	return { root, provider: provider!, command: command!, diffs, opened, messages, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('Ver cambios diffs the committed content against the file now; added files compare against an empty side', async () => {
	const f = await fixture();
	try {
		await f.command('file:///project', 'a.ts', 'modified', false);
		const [id, before, after, title] = f.diffs[0] as [string, { scheme: string; path: string; query: string; fragment: string }, { fsPath: string }, string];
		assert.deepEqual({ id, before: { ...before }, after: after.fsPath, title }, { id: 'vscode.diff', before: { scheme: 'ats-run-base', path: '/a.ts', query: 'file:///project', fragment: '' }, after: path.join(f.root, 'a.ts'), title: 'a.ts (cambios de la ejecuci\u00f3n)' });
		assert.equal((await f.provider.provideTextDocumentContent(before)).replace(/\r\n/g, '\n'), 'committed content\n');
		await f.command('file:///project', 'new.ts', 'added', false);
		const added = f.diffs[1][1] as typeof before;
		assert.equal(await f.provider.provideTextDocumentContent(added), '');
		await f.command('file:///project', 'a.ts', 'deleted', false);
		assert.equal((f.diffs[2][2] as typeof before).fragment, 'empty');
	} finally { await f.cleanup(); }
});

test('a file the user had already edited is opened, not diffed against HEAD, and hostile arguments do nothing', async () => {
	const f = await fixture();
	try {
		await f.command('file:///project', 'a.ts', 'modified', true);
		assert.deepEqual({ diffs: f.diffs.length, opened: (f.opened as Array<{ fsPath: string }>).map(uri => uri.fsPath) }, { diffs: 0, opened: [path.join(f.root, 'a.ts')] });
		await f.command('file:///project', 'a.ts', 'deleted', true);
		assert.equal(f.messages.length, 1);
		for (const args of [['file:///elsewhere', 'a.ts', 'modified', false], ['file:///project', '../a.ts', 'modified', false], ['file:///project', '/etc/passwd', 'modified', false], ['file:///project', 'a.ts', 'renamed', false], ['file:///project', 42, 'modified', false]]) { await f.command(...args); }
		assert.equal(f.diffs.length, 0);
		// The content provider is inert for unknown folders and invalid paths.
		assert.deepEqual(await Promise.all([{ path: '/a.ts', query: 'file:///elsewhere', fragment: '' }, { path: '/../a.ts', query: 'file:///project', fragment: '' }, { path: '/missing.ts', query: 'file:///project', fragment: '' }].map(uri => f.provider.provideTextDocumentContent(uri))), ['', '', '']);
		assert.deepEqual(['a/b.ts', '../x', '/abs', 'C:\\x', 'a\0b', '', 'x'.repeat(5000)].map(validRunPath), [true, false, false, false, false, false, false]);
	} finally { await f.cleanup(); }
});
