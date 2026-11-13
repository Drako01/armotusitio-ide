/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * "Ver cambios" of a run: a read-only diff between the committed content (HEAD) and the file now. HEAD is the run's
 * "before" only when the user had no uncommitted edits in that file already; otherwise the file is simply opened.
 */
import * as path from 'node:path';
import { gitOutput } from './native-git.ts';
import { isProjectRelative } from './native-chat.ts';
import type { RunFileChange } from './native-run-diff.ts';

export const RUN_DIFF_COMMAND = 'atsIde.openRunDiff';
export const CHECKPOINT_DIFF_COMMAND = 'atsIde.openCheckpointDiff';
const BASE_SCHEME = 'ats-run-base';
const CHECKPOINT_SCHEME = 'ats-checkpoint-before';
const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PATH = 4096;

/** A path a webview or command argument may name: project-relative, bounded, no NUL. */
export function validRunPath(file: unknown): file is string {
	return typeof file === 'string' && !!file && file.length <= MAX_PATH && !file.includes('\0') && isProjectRelative(file);
}

type Translate = (message: string, ...args: string[]) => string;
interface Folder { uri: { toString(): string; fsPath: string } }
/** Exact bytes a file had before a tool checkpoint, behind the controller's trust gate; null when the tool created it. */
export type CheckpointBefore = (folder: Folder, id: string, file: string) => Promise<Buffer | null>;

/** Register the content provider of the "before" side and the command that opens the diff. Both are inert for unknown folders. */
export function registerRunDiffView(vscode: any, context: { subscriptions: Array<{ dispose(): void }> }, folders: () => readonly Folder[], t: Translate, checkpointBefore?: CheckpointBefore): void {
	const folderOf = (folderUri: unknown): Folder | undefined => folders().find(folder => folder.uri.toString() === folderUri);
	const rootOf = (folderUri: unknown): string | undefined => folderOf(folderUri)?.uri.fsPath;
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
		async provideTextDocumentContent(uri: { path: string; query: string; fragment: string }): Promise<string> {
			const root = rootOf(uri.query);
			const file = uri.path.slice(1);
			if (uri.fragment === 'empty' || !root || !validRunPath(file)) { return ''; }
			try { return (await gitOutput(root, ['show', 'HEAD:' + file])).toString('utf8'); }
			catch { return ''; }
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand(RUN_DIFF_COMMAND, async (folderUri: unknown, file: unknown, change: RunFileChange['change'], preexisting: unknown) => {
		const root = rootOf(folderUri);
		if (!root || !validRunPath(file) || !['added', 'modified', 'deleted'].includes(change)) { return; }
		const target = path.resolve(root, file);
		if (path.relative(root, target).startsWith('..')) { return; }
		const now = vscode.Uri.file(target);
		const before = (empty: boolean) => vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + file, query: String(folderUri), fragment: empty ? 'empty' : '' });
		// No trustworthy "before": the user's own earlier edits would be shown as the run's. Open the file instead.
		if (preexisting === true) {
			if (change === 'deleted') { void vscode.window.showInformationMessage(t('El archivo {0} se borr\u00f3 en esta ejecuci\u00f3n y ya ten\u00eda cambios tuyos, as\u00ed que no hay una versi\u00f3n anterior confiable para comparar.', file)); return; }
			await vscode.window.showTextDocument(now);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', before(change === 'added'), change === 'deleted' ? before(true) : now, t('{0} (cambios de la ejecuci\u00f3n)', file));
	}));
	if (!checkpointBefore) { return; }
	// "Antes" of a tool checkpoint: served from the checkpoint record in memory, never written to disk.
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, {
		async provideTextDocumentContent(uri: { path: string; query: string; fragment: string }): Promise<string> {
			const folder = folderOf(uri.query);
			const [id, empty] = uri.fragment.split(':');
			const file = uri.path.slice(1);
			if (empty === 'empty' || !folder || !CHECKPOINT_ID.test(id) || !validRunPath(file)) { return ''; }
			return (await checkpointBefore(folder, id, file))?.toString('utf8') ?? '';
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand(CHECKPOINT_DIFF_COMMAND, async (folderUri: unknown, id: unknown, file: unknown, change: unknown) => {
		const root = rootOf(folderUri);
		if (!root || typeof id !== 'string' || !CHECKPOINT_ID.test(id) || !validRunPath(file) || !['added', 'modified', 'deleted'].includes(change as string)) { return; }
		const target = path.resolve(root, file);
		if (path.relative(root, target).startsWith('..')) { return; }
		const side = (empty: boolean) => vscode.Uri.from({ scheme: CHECKPOINT_SCHEME, path: '/' + file, query: String(folderUri), fragment: id + (empty ? ':empty' : '') });
		await vscode.commands.executeCommand('vscode.diff', side(change === 'added'), change === 'deleted' ? side(true) : vscode.Uri.file(target), t('{0} (antes de la herramienta \u2194 ahora)', file));
	}));
}
