/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `@file` mention syntax shared by the extension host (resolves mentions) and the chat webview (autocomplete).
 * Pure text functions with no imports, so the webview bundle never pulls in Node modules.
 * A mention is `@path` or, when the path has spaces, `@"path with spaces"`; it must start a word, so e-mail addresses are not mentions.
 */
export const MAX_MENTION_PATH_LENGTH = 300;
const WORD_START = '(?<![^\\s(])';
const MENTION = new RegExp(WORD_START + '@(?:"(?<quoted>[^"\\r\\n]{1,' + MAX_MENTION_PATH_LENGTH + '})"|(?<bare>[^\\s"\'`,;:!?)\\]}]{1,' + MAX_MENTION_PATH_LENGTH + '}))', 'g');
const ACTIVE_MENTION = new RegExp(WORD_START + '@(?<token>"[^"\\r\\n]*|[^\\s"]*)$');

/** Distinct mentioned paths in order of appearance, exactly as typed (not yet validated against the project). */
export function parseMentions(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(MENTION)) {
		// A sentence-ending dot after a bare mention is punctuation, not part of the file name.
		const mentioned = match.groups!.quoted ?? match.groups!.bare.replace(/\.+$/, '');
		if (mentioned) { found.add(mentioned); }
	}
	return [...found];
}

/** The mention being typed right before `caret`, if any: where it starts and the text typed after the `@`. */
export function activeMention(text: string, caret: number): { start: number; query: string } | undefined {
	const before = text.slice(0, caret);
	const match = ACTIVE_MENTION.exec(before);
	if (!match) { return undefined; }
	const token = match.groups!.token;
	// The word-start lookbehind is zero-width, so the match begins at the `@`.
	return { start: match.index, query: token.startsWith('"') ? token.slice(1) : token };
}

/** The text that inserts `path` as a mention. */
export function formatMention(path: string): string {
	return /\s/.test(path) ? '@"' + path + '"' : '@' + path;
}
