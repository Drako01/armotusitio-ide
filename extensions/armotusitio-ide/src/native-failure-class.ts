/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * One classification of why a tool or command failed, shared by every recovery path so the agent (and the user) hear the same cause,
 * whether a retry can help and what to do next. The classes decide behaviour: only `auto-recoverable` may be retried blindly, and
 * never an operation that is not idempotent.
 */
export type FailureClass = 'auto-recoverable' | 'needs-approval' | 'change-strategy' | 'security-blocked' | 'unrecoverable';
export interface Failure { kind: string; class: FailureClass; hint: string }

/** First match wins; ordered from "stop, do not try around it" to "just retry". */
const RULES: ReadonlyArray<readonly [RegExp, Failure]> = [
	[/POLICY_DENIED|DENIED: the user did not allow|DENIED: this run has no way to ask|not-approved/i,
		{ kind: 'policy', class: 'security-blocked', hint: 'A policy or the user refused it; do not retry or look for another way around it.' }],
	[/ENOSPC|no space left on device|disk (is )?full/i,
		{ kind: 'disk-full', class: 'unrecoverable', hint: 'The disk is full; free space before anything else.' }],
	[/ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*(out of date|not up to date|needs to be updated)|frozen-lockfile|EUSAGE.*package-lock|yarn.lock.*needs/i,
		{ kind: 'lockfile-out-of-date', class: 'needs-approval', hint: 'The lockfile does not match package.json; updating it changes tracked files, so ask the user.' }],
	[/EBUSY|EPERM|EACCES|resource busy|unknown error, open|WinError (32|145)|ENOTEMPTY|being used by another process/i,
		{ kind: 'locked-files', class: 'change-strategy', hint: 'Another process (antivirus, indexer, editor, dev server) holds files; stop it or exclude the folder from the antivirus, then repair again.' }],
	[/ENOENT|command not found|is not recognized as|not found in PATH/i,
		{ kind: 'tool-missing', class: 'change-strategy', hint: 'The tool is not installed or not on PATH; use another tool or tell the user what to install.' }],
	[/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(429|502|503|504)\b/i,
		{ kind: 'network', class: 'auto-recoverable', hint: 'A network or registry failure; a bounded retry with backoff is reasonable.' }],
	[/timed? ?out|timeout/i,
		{ kind: 'timeout', class: 'change-strategy', hint: 'It ran out of time; narrow the work or raise the timeout instead of repeating it.' }]
];
const UNKNOWN: Failure = { kind: 'unknown', class: 'unrecoverable', hint: 'The cause is not recognised; report it with its output instead of retrying.' };

export function classifyFailure(text: string): Failure {
	return RULES.find(([pattern]) => pattern.test(text))?.[1] ?? UNKNOWN;
}
