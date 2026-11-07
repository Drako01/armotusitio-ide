/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * The IDE's decision for a provider-initiated approval (Codex app-server server requests), with the same verdicts Claude's
 * permission prompts use (`commandVerdict`, `editVerdict`). Order: workspace trust, the immovable floor and explicit
 * denials, the project's Harness delegation and permission rules, then the user's card. A sandbox escalation (network,
 * writes outside the project) is always asked and never remembered. Nothing here turns a missing answer into `allow`.
 */
import { commandVerdict, editVerdict, type ApproveContext, type CallVerdict } from '../native-approve-tool.ts';
import type { ApprovalDraft, ApprovalSubject } from '../native-approval.ts';
import type { ApprovalAnswer } from '../native-permissions-types.ts';
import type { ApprovalVerdict, ToolCall } from './contracts.ts';

export interface ProviderPolicyContext extends Pick<ApproveContext, 'root' | 'policy' | 'permissions'> {
	/** Workspace Trust, read at decision time. */
	trusted(): boolean;
	/** The provider confines commands in its own sandbox, so a compound line may be offered to the user once. */
	sandboxed: boolean;
	/** The user's card (with the broker's task/session grants in front of it). */
	ask(draft: ApprovalDraft & ApprovalSubject): Promise<ApprovalAnswer>;
}

const SHELL_WRAPPERS = [
	/^"?(?:[^"]*[\\/])?(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+)*-(?:Command|c)\s+(?<line>[\s\S]+)$/i,
	/^"?(?:[^"]*[\\/])?(?:bash|zsh|sh)(?:\.exe)?"?\s+-l?c\s+(?<line>[\s\S]+)$/i,
	/^"?(?:[^"]*[\\/])?cmd(?:\.exe)?"?\s+\/[cC]\s+(?<line>[\s\S]+)$/
];

/** The command line inside a provider's shell wrapper (`pwsh -Command "..."`, `bash -lc '...'`), quotes removed once. */
export function unwrapShell(command: string): string {
	const trimmed = command.trim();
	for (const wrapper of SHELL_WRAPPERS) {
		const line = wrapper.exec(trimmed)?.groups?.line.trim();
		if (line) {
			const quoted = /^(?<quote>["'])(?<inner>[\s\S]*)\k<quote>$/.exec(line);
			return quoted ? quoted.groups!.inner : line;
		}
	}
	return trimmed;
}

/** How long a user answer reaches; a reaching answer without an exact rule is downgraded to this action only. */
export function verdictOf(answer: ApprovalAnswer, rule: string): ApprovalVerdict {
	if (answer === 'deny') { return { allowed: false, scope: 'once', reason: 'DENIED: the user did not allow it' }; }
	if (answer === 'once' || !rule) { return { allowed: true, scope: 'once' }; }
	return { allowed: true, scope: answer };
}

async function settle(context: ProviderPolicyContext, verdict: CallVerdict): Promise<ApprovalVerdict> {
	if (verdict.verdict === 'allow') { return { allowed: true, scope: 'once' }; }
	if (verdict.verdict === 'deny') { return { allowed: false, scope: 'once', reason: verdict.message }; }
	const answer = await context.ask(verdict.draft).catch(() => 'deny' as const);
	return verdictOf(answer, verdict.draft.rule);
}

export async function decideProviderCall(context: ProviderPolicyContext, call: ToolCall): Promise<ApprovalVerdict> {
	if (!context.trusted()) { return { allowed: false, scope: 'once', reason: 'POLICY_DENIED: untrusted-workspace' }; }
	try {
		switch (call.kind) {
			case 'command': return await settle(context, commandVerdict(context, unwrapShell(call.command ?? ''), { sandboxed: context.sandboxed }));
			case 'file_change': return await settle(context, await editVerdict(context, call.paths ?? []));
			case 'permissions': {
				const detail = ['escalation: ' + (call.reason ?? 'more access than the sandbox allows').slice(0, 300), ...(call.paths ?? []).slice(0, 5).map(file => 'path: ' + file), ...(call.cwd ? ['cwd: ' + call.cwd] : [])];
				return await settle(context, { verdict: 'ask', draft: { kind: 'sandbox', title: 'Expand sandbox permissions', rule: '', noRemember: 'inexact', detail } });
			}
			default:
				return { allowed: false, scope: 'once', reason: 'POLICY_DENIED: tool-unavailable' };
		}
	} catch (error) {
		const message = (error as Error).message;
		return { allowed: false, scope: 'once', reason: message.startsWith('POLICY_DENIED: ') ? message : 'POLICY_DENIED: invalid-path' };
	}
}
