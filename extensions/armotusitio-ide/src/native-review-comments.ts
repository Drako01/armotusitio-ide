/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Inline review of a delivery (block Z): comments anchored to file and line become correction tasks with their exact
 * context; a thread is resolved when its task passes verification, or marked outdated when the line moved.
 */

export interface ReviewComment { id: string; file: string; line: number; text: string; lineText?: string }
export interface ReviewTask { id: string; title: string; files: string[]; instruction: string }

/** One correction task per comment, with the file, the line and what the reviewer asked. */
export function reviewTasks(comments: readonly ReviewComment[]): ReviewTask[] {
	return comments.filter(comment => comment.text.trim()).map((comment, index) => ({
		id: 'R' + (index + 1), title: comment.file + ':' + comment.line, files: [comment.file],
		instruction: 'Review comment on ' + comment.file + ' line ' + comment.line + (comment.lineText ? ' (`' + comment.lineText.trim().slice(0, 200) + '`)' : '') + ': ' + comment.text.trim().slice(0, 2000)
	}));
}

/** The objective of the correction cycle on the same branch. */
export function reviewObjective(original: string, tasks: readonly ReviewTask[]): string {
	return 'Address the review of the delivery for: ' + original.split('\n')[0].slice(0, 200) + '\n\n' + tasks.map(task => task.id + ': ' + task.instruction).join('\n') + '\n\nChange only what each comment asks.';
}

/** After the cycle: resolved when its file changed and verification passed; outdated when the commented line no longer exists. */
export function threadStates(comments: readonly ReviewComment[], changedFiles: ReadonlySet<string>, verified: boolean, currentLine: (comment: ReviewComment) => string | undefined): Record<string, 'resolved' | 'open' | 'outdated'> {
	return Object.fromEntries(comments.map(comment => {
		const now = currentLine(comment);
		const state = verified && changedFiles.has(comment.file) ? 'resolved' : comment.lineText !== undefined && now !== undefined && now.trim() !== comment.lineText.trim() ? 'outdated' : 'open';
		return [comment.id, state];
	}));
}
