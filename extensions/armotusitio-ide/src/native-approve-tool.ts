/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Native transport pilot (`atsHarness.agentTransport: native`, Claude only): Claude keeps its own Bash and editing tools,
 * and each permission prompt comes here (`--permission-prompt-tool mcp__ats-runner__approve`). Every prompt is decided by
 * the same rules as the structured transport: the command policy floor and the user's/project's permission rules, and the
 * user's card for anything that asks. Nothing hard becomes approvable: a compound shell line is still a shell operator.
 */
import * as path from 'node:path';
import { requestApproval, type ApprovalAsk } from './native-approval.ts';
import { denialText, type CommandPolicy } from './native-command-policy.ts';
import { projectFilePath } from './native-file-tools.ts';
import type { PermissionSet } from './native-permissions.ts';

export const APPROVE_TOOL = {
	name: 'approve',
	description: 'Permission prompts of the IDE host. Called by the CLI, not by the agent.',
	inputSchema: {
		type: 'object',
		properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
		required: ['tool_name', 'input']
	}
};

/** What Claude's permission prompt tool must answer, as the JSON text of its result. */
export type PromptDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };
export interface ApproveContext {
	root: string;
	/** The run's command policy, built with the same permissions as `permissions`. */
	policy: CommandPolicy;
	permissions: PermissionSet;
	ask?: ApprovalAsk;
}

const EDIT_TOOLS = new Map([['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path']]);
const READ_TOOLS = new Map<string, string | undefined>([['Read', 'file_path'], ['Glob', 'path'], ['Grep', 'path'], ['LS', 'path'], ['TodoWrite', undefined]]);
const CHANGE_DIRECTORY = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl']);
const CHANGE_DIRECTORY_DENIAL = 'POLICY_DENIED: change-directory\nNext: Bash stays in the project root: pass the folder to the tool instead (pnpm --dir apps/web lint, npm --prefix apps/web test) or use the run tool with cwd.';

/**
 * The words of a plain command line, or `undefined` when a shell would interpret anything in it (operators, expansions,
 * globs, escapes, redirections, env assignments). Quotes only group words; `$`, backticks and `\` are refused even inside
 * double quotes, because the shell would expand them there too.
 */
export function plainCommandWords(line: string): string[] | undefined {
	const words: string[] = [];
	let current = '', quote: '"' | '\'' | undefined, started = false;
	for (const char of line.trim()) {
		if (quote) {
			if (char === quote) { quote = undefined; } else if (quote === '"' && /[$`\\]/.test(char)) { return undefined; } else { current += char; }
			continue;
		}
		if (char === '"' || char === '\'') { quote = char; started = true; continue; }
		if (char === ' ' || char === '\t') { if (started) { words.push(current); current = ''; started = false; } continue; }
		if (/[|&;<>()$`\\*?~{}[\]!#\r\n]/.test(char)) { return undefined; }
		current += char; started = true;
	}
	if (quote) { return undefined; }
	if (started) { words.push(current); }
	return words.length && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) ? words : undefined;
}

/** Project-relative path of a tool's file argument (absolute or relative), under the file floor; throws `POLICY_DENIED`. */
async function projectPath(root: string, raw: unknown): Promise<string> {
	if (typeof raw !== 'string' || !raw) { throw Error('POLICY_DENIED: invalid-path'); }
	const relative = path.isAbsolute(raw) ? path.relative(root, raw) : raw;
	if (path.isAbsolute(relative)) { throw Error('POLICY_DENIED: path-outside-project'); }
	return projectFilePath(root, relative.split(path.sep).join('/'));
}

const allow = (input: Record<string, unknown>): PromptDecision => ({ behavior: 'allow', updatedInput: input });
const deny = (message: string): PromptDecision => ({ behavior: 'deny', message });

async function bash(context: ApproveContext, input: Record<string, unknown>): Promise<PromptDecision> {
	if (typeof input.command !== 'string') { return deny(denialText('invalid')); }
	if (input.run_in_background === true) { return deny('POLICY_DENIED: background\nNext: run the command in the foreground; background processes outlive the IDE\'s control.'); }
	const words = plainCommandWords(input.command);
	if (!words) { return deny(denialText('shell-operator')); }
	if (CHANGE_DIRECTORY.has(words[0].toLowerCase())) { return deny(CHANGE_DIRECTORY_DENIAL); }
	const decision = context.policy.decide(words[0], words.slice(1), '.');
	if (decision.allowed === true) { return allow(input); }
	if (decision.reason !== 'needs-approval') { return deny(denialText(decision.reason)); }
	const denial = await requestApproval(context.ask, {
		kind: 'run', title: 'Run command', rule: decision.rule, command: words[0], args: words.slice(1), cwd: '.', detail: ['command: ' + words.join(' ').slice(0, 300), 'cwd: .']
	});
	return denial ? deny(denial) : allow(input);
}

async function edit(context: ApproveContext, input: Record<string, unknown>, field: string): Promise<PromptDecision> {
	const relative = await projectPath(context.root, input[field]);
	const verdict = context.permissions.decide({ kind: 'edit', path: relative });
	if (verdict.decision === 'deny') { return deny('POLICY_DENIED: ' + (verdict.rule ?? 'denied by permissions')); }
	if (verdict.decision === 'allow') { return allow(input); }
	const denial = await requestApproval(context.ask, { kind: 'edit', title: 'Edit file', detail: ['edit: ' + relative], rule: '', path: relative });
	return denial ? deny(denial) : allow(input);
}

/** Decide one permission prompt. Unknown tools are denied: the pilot only grants what the structured transport grants. */
export async function decidePermissionPrompt(context: ApproveContext, value: unknown): Promise<PromptDecision> {
	const request = (value ?? {}) as { tool_name?: unknown; input?: unknown };
	const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input as Record<string, unknown> : undefined;
	if (typeof request.tool_name !== 'string' || !input) { return deny(denialText('invalid')); }
	try {
		if (request.tool_name === 'Bash') { return await bash(context, input); }
		const editField = EDIT_TOOLS.get(request.tool_name);
		if (editField) { return await edit(context, input, editField); }
		if (READ_TOOLS.has(request.tool_name)) {
			const field = READ_TOOLS.get(request.tool_name);
			// Reads stay inside the project, like the structured transport's working directory.
			if (field && input[field] !== undefined && input[field] !== '.') { await projectPath(context.root, input[field]); }
			return allow(input);
		}
	} catch (error) {
		const message = (error as Error).message;
		return deny(message.startsWith('POLICY_DENIED: ') ? message : 'POLICY_DENIED: invalid-path');
	}
	return deny('POLICY_DENIED: tool-unavailable\nNext: ' + request.tool_name + ' is not available in this run; use Read, Glob, Grep, Edit, Write, Bash or the ats-runner tools.');
}
