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
import { suggestRule } from './native-permissions.ts';
import { redactSecrets } from './native-redact.ts';
import type { ApprovalAnswer, ApprovalRequest, PermissionRequest } from './native-permissions-types.ts';

/** Without an answer the request is denied after this long. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const ANSWERS: readonly ApprovalAnswer[] = ['once', 'always', 'deny'];

/** What the tool server asks; the extension assigns the id. */
export type ApprovalDraft = Omit<ApprovalRequest, 'id'>;
/** The structured fields the extension derives the "always" rule from; the runner's own `rule` is only a hint and is never trusted. */
export interface ApprovalSubject { command?: string; args?: string[]; cwd?: string; path?: string; repo?: string; branch?: string; from?: string; base?: string; prTitle?: string; prBody?: string; action?: string }
export type ApprovalAsk = (request: ApprovalDraft & ApprovalSubject) => Promise<ApprovalAnswer>;

const MAX_PENDING_ARGS = 100;

/** The permission request an approval is about, rebuilt from structured fields; `undefined` when they are missing or malformed. */
function subjectRequest(draft: Partial<ApprovalDraft> & ApprovalSubject): PermissionRequest | undefined {
	switch (draft.kind) {
		case 'run': {
			const { command, args, cwd } = draft;
			if (typeof command !== 'string' || !command || command.length > 300 || (cwd !== undefined && typeof cwd !== 'string') ||
				!Array.isArray(args) || args.length > MAX_PENDING_ARGS || !args.every(arg => typeof arg === 'string' && arg.length <= 1000)) { return undefined; }
			return { kind: 'run', command, args, cwd: cwd ?? '.' };
		}
		case 'edit': return typeof draft.path === 'string' && draft.path ? { kind: 'edit', path: draft.path } : undefined;
		case 'git_commit': return { kind: 'git_commit', branch: '', files: [], message: '' };
		case 'git_push': return { kind: 'git_push', branch: '', remote: '' };
		case 'git_branch_create': {
			if (![draft.repo, draft.branch, draft.from].every(value => typeof value === 'string' && value.length > 0 && value.length <= 250)) { return undefined; }
			return { kind: 'git_branch_create', repo: draft.repo!, branch: draft.branch!, from: draft.from! };
		}
		case 'git_pr_upsert': {
			if (![draft.repo, draft.branch, draft.base, draft.prTitle].every(value => typeof value === 'string' && value.length > 0 && value.length <= 250) ||
				typeof draft.prBody !== 'string' || draft.prBody.length > 2000 || !/^(?:create|update #[1-9][0-9]*)$/.test(draft.action ?? '')) { return undefined; }
			return { kind: 'git_pr_upsert', repo: draft.repo!, branch: draft.branch!, base: draft.base!, title: draft.prTitle!, body: draft.prBody };
		}
		default: return undefined;
	}
}

/**
 * A value that can be shown as an approval card, or `undefined`. The extension validates what the runner process sends and
 * computes the "always" rule itself from the structured subject (a runner could otherwise show one thing and persist another).
 * An empty `rule` means the action cannot be remembered. A command's lines are rebuilt from the same subject so card and rule agree.
 * `root` is the project the run belongs to, known by the extension: git approvals are remembered only for it.
 */
export function parseApprovalDraft(value: unknown, root?: string): ApprovalDraft | undefined {
	const draft = (value ?? {}) as Partial<ApprovalDraft> & ApprovalSubject;
	if (typeof draft.title !== 'string' || !Array.isArray(draft.detail) || draft.detail.length > 12 || !draft.detail.every(line => typeof line === 'string')) { return undefined; }
	const request = subjectRequest(draft);
	if (!request) { return undefined; }
	const detail = request.kind === 'run'
		? ['command: ' + [request.command, ...request.args].join(' ').slice(0, 300), 'cwd: ' + request.cwd.slice(0, 300)]
		: request.kind === 'git_branch_create'
			? ['repository: ' + request.repo, 'new branch: ' + request.branch, 'from: ' + request.from]
			: request.kind === 'git_pr_upsert'
				? ['repository: ' + request.repo, 'head: ' + request.branch, 'base: ' + request.base, 'action: ' + draft.action, 'title: ' + request.title,
				...((request.body.match(/[\s\S]{1,300}/g) ?? ['']).map((part, index) => 'body ' + (index + 1) + ': ' + part))]
				: draft.detail.map(line => line.slice(0, 400));
	const rule = suggestRule(request, root);
	return { kind: request.kind, title: redactSecrets(draft.title.slice(0, 200)), rule: redactSecrets(rule) === rule ? rule : '', detail: detail.map(redactSecrets) };
}

/** Asks through the run's channel. The client waits slightly longer than the extension, which answers `deny` on its own timeout. */
export function channelApprover(channel: { address: string; token: string }, timeoutMs = APPROVAL_TIMEOUT_MS): ApprovalAsk {
	return async request => {
		const answer = await callToolChannel(channel.address, channel.token, 'approval', request, timeoutMs + 5000);
		return ANSWERS.includes(answer as ApprovalAnswer) ? answer as ApprovalAnswer : 'deny';
	};
}

/** `undefined` when the user approved; otherwise the `DENIED: <reason>` text the model receives. */
export async function requestApproval(ask: ApprovalAsk | undefined, request: ApprovalDraft & ApprovalSubject): Promise<string | undefined> {
	if (!ask) { return 'DENIED: this run has no way to ask the user'; }
	try {
		const answer = await ask(request);
		return answer === 'once' || (answer === 'always' && !!request.rule) ? undefined : 'DENIED: the user did not allow it';
	} catch (error) {
		return (error as Error).message === 'HARNESS_TIMEOUT' ? 'DENIED: the user did not answer in time' : 'DENIED: the approval could not be requested';
	}
}
