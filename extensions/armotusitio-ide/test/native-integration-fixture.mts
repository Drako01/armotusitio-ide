/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Shared fake VS Code host around the real native Harness: the integration and end-to-end tests use the same wiring. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerNativeHarness } from '../src/native-integration.ts';

/** VS Code reports `Uri.fsPath` with a lower-case drive letter on Windows; tests must use the same shape. */
export function vscodeFsPath(value: string): string {
	return process.platform === 'win32' && /^[A-Z]:/.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
}

export async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-ui-'));
	const roots = [path.join(directory, 'project one'), path.join(directory, 'project two')];
	await Promise.all(roots.map(root => fs.mkdir(root)));
	const commands = new Map();
	const documents: Array<{ content: string }> = [];
	const notices: string[] = [];
	const state = new Map();
	const context = { subscriptions: [], globalStorageUri: { fsPath: vscodeFsPath(path.join(directory, 'private')) }, globalState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } } };
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
