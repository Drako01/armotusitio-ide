/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What actually confines an agent that can write. The IDE never announces stronger isolation than the one
 * that was demonstrated, and a Git worktree is not a security boundary, so it is not listed as one.
 *
 * - `os-kernel`: the IDE itself runs the agent under a kernel policy (bubblewrap, Seatbelt). Not available
 *   for model providers, which need an authenticated network path; only offline gates use it.
 * - `provider-sandbox`: the provider CLI applies its own operating system sandbox. Measured on Windows 11 with
 *   `codex sandbox`: writes outside the workspace are denied, reads outside it are not.
 * - `tool-allowlist`: only the provider's tool permissions restrict the agent; nothing at operating system level.
 */
import type { NativeProvider } from './native-providers.ts';

export type IsolationLevel = 'os-kernel' | 'provider-sandbox' | 'tool-allowlist' | 'none';
const RANK: Record<IsolationLevel, number> = { none: 0, 'tool-allowlist': 1, 'provider-sandbox': 2, 'os-kernel': 3 };
export const WRITER_ISOLATION_SETTINGS: readonly IsolationLevel[] = ['tool-allowlist', 'provider-sandbox', 'os-kernel'];

export interface AgentIsolation {
	/** What stops the agent from writing outside the project. */
	writes: IsolationLevel;
	/** What stops the agent from reading outside the project. Providers do not confine reads at OS level. */
	reads: IsolationLevel;
}

export function describeAgentIsolation(provider: NativeProvider): AgentIsolation {
	return provider === 'codex'
		? { writes: 'provider-sandbox', reads: 'none' }
		: { writes: 'tool-allowlist', reads: 'tool-allowlist' };
}

/** True when the isolation of this provider's writers is at least the level the user requires. */
export function meetsWriterIsolation(provider: NativeProvider, required: IsolationLevel): boolean {
	return RANK[describeAgentIsolation(provider).writes] >= RANK[required];
}

/** Fails closed: an unknown setting value is treated as the strictest requirement. */
export function parseWriterIsolation(value: unknown): IsolationLevel {
	return WRITER_ISOLATION_SETTINGS.includes(value as IsolationLevel) ? value as IsolationLevel : 'os-kernel';
}
