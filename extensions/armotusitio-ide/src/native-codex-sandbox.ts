/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * How Codex confines a writer. The user chooses it (switch in the chat, user-level setting `atsHarness.codexSandbox`);
 * a repository cannot widen it. Full access removes the Windows sandbox limits (links, junctions, network) and every
 * OS-level confinement with them, so the isolation report says `none`.
 */
export type CodexSandbox = 'workspace-write' | 'danger-full-access';

let current: CodexSandbox = 'workspace-write';

/** Fails closed: anything but the exact opt-in value keeps the sandbox. */
export function parseCodexSandbox(value: unknown): CodexSandbox {
	return value === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
}

export function codexSandbox(): CodexSandbox {
	return current;
}

/** Applies the user's setting to every Codex writer started from now on. */
export function useCodexSandbox(value: unknown): void {
	current = parseCodexSandbox(value);
}
