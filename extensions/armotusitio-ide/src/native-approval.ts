/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Approval requests of the tool server (plan r6). When a permission verdict is `ask`, `ats-runner` sends the request through
 * the run's channel to the extension, which shows a card in the chat and answers with the user's choice. Anything other than
 * an explicit yes (no channel, no UI, timeout, cancellation, error) is a denial: this module fails closed.
 */
import { callToolChannel } from './native-tool-server.ts';
import type { ApprovalAnswer, ApprovalRequest } from './native-permissions-types.ts';

/** Without an answer the request is denied after this long. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const ANSWERS: readonly ApprovalAnswer[] = ['once', 'always', 'deny'];

/** What the tool server asks; the extension assigns the id. */
export type ApprovalDraft = Omit<ApprovalRequest, 'id'>;
export type ApprovalAsk = (request: ApprovalDraft) => Promise<ApprovalAnswer>;

/** True for a value that can be shown as an approval card; the extension validates what the runner process sends. */
export function parseApprovalDraft(value: unknown): ApprovalDraft | undefined {
	const draft = (value ?? {}) as Partial<ApprovalDraft>;
	if (!['run', 'edit', 'git_commit', 'git_push'].includes(draft.kind as string) || typeof draft.title !== 'string' || typeof draft.rule !== 'string' ||
		!Array.isArray(draft.detail) || draft.detail.length > 12 || !draft.detail.every(line => typeof line === 'string')) { return undefined; }
	return { kind: draft.kind!, title: draft.title.slice(0, 200), rule: draft.rule.slice(0, 300), detail: draft.detail.map(line => line.slice(0, 400)) };
}

/** Asks through the run's channel. The client waits slightly longer than the extension, which answers `deny` on its own timeout. */
export function channelApprover(channel: { address: string; token: string }, timeoutMs = APPROVAL_TIMEOUT_MS): ApprovalAsk {
	return async request => {
		const answer = await callToolChannel(channel.address, channel.token, 'approval', request, timeoutMs + 5000);
		return ANSWERS.includes(answer as ApprovalAnswer) ? answer as ApprovalAnswer : 'deny';
	};
}

/** `undefined` when the user approved; otherwise the `DENIED: <reason>` text the model receives. */
export async function requestApproval(ask: ApprovalAsk | undefined, request: ApprovalDraft): Promise<string | undefined> {
	if (!ask) { return 'DENIED: this run has no way to ask the user'; }
	try {
		return (await ask(request)) === 'deny' ? 'DENIED: the user did not allow it' : undefined;
	} catch (error) {
		return (error as Error).message === 'HARNESS_TIMEOUT' ? 'DENIED: the user did not answer in time' : 'DENIED: the approval could not be requested';
	}
}
