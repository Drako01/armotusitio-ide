/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Deterministic reviewer receipt validation. CLI exit=0 never constitutes approval. */
export type ReviewerVerdict = 'approved' | 'rejected' | 'invalid';
const PASS = 'HARNESS_REVIEW: PASS';
const FAIL = 'HARNESS_REVIEW: FAIL';

export function parseReviewerVerdict(output: string, truncated = false): ReviewerVerdict {
	if (truncated || typeof output !== 'string' || output.length > 256 * 1024) { return 'invalid'; }
	const normalized = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
	const lines = normalized.split(/\r?\n/).map(line => line.trim());
	const markers = lines.filter(line => line === PASS || line === FAIL);
	// The last line must be the sole verdict; an echoed prompt or conflicting marker
	// cannot satisfy the receipt. No regex search through arbitrary agent output.
	if (markers.length !== 1 || ![PASS, FAIL].includes(lines.at(-1) || '')) { return 'invalid'; }
	return markers[0] === PASS ? 'approved' : 'rejected';
}

export function boundedHandoff(role: string, text: string, maxChars = 2048): string {
	if (!/^[a-z0-9_-]{1,64}$/i.test(role)) { throw Error('HARNESS_HANDOFF_ROLE_INVALID'); }
	if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 8192) { throw Error('HARNESS_HANDOFF_BUDGET_INVALID'); }
	const content = String(text).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(-maxChars);
	// JSON escaping prevents text from breaking out of a pseudo-XML delimiter.
	// Provider content remains untrusted regardless of format.
	return JSON.stringify({ kind: 'untrusted_agent_data', sourceRole: role, followInstructions: false, content });
}
