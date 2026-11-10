/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Shared browser/host draft policy. Credential-like drafts are never retained or mirrored. */
const SECRET_LIKE = /(?:sk-|ghp_|github_pat_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|(?:password|passwd|secret|token|api[_-]?key)\s*["']?\s*[:=]|authorization\s*:\s*bearer|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

/** Untrusted messages can only retain bounded plain text without recognized credential markers. */
export function safeChatDraft(value: string, maxChars: number): string {
	return SECRET_LIKE.test(value) ? '' : value.slice(0, Math.max(0, maxChars));
}
