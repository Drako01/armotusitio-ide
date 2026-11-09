/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Permission decisions for native agent transports. Claude keeps its own Bash and editing tools, and each permission prompt
 * comes here (`--permission-prompt-tool mcp__ats-runner__approve`); Codex app-server approvals reuse the same verdicts
 * (`commandVerdict`, `editVerdict`). Every call is decided by the same rules as the structured transport: the command
 * policy floor and the user's/project's permission rules, and the user's card for anything that asks. Nothing hard becomes
 * approvable: a compound shell line is a shell operator unless it runs inside the provider's own sandbox.
 */
import * as path from 'node:path';
import { requestApproval, type ApprovalAsk, type ApprovalDraft, type ApprovalSubject } from './native-approval.ts';
import { denialText, type CommandPolicy } from './native-command-policy.ts';
import { projectFilePath } from './native-file-tools.ts';
import type { PermissionSet } from './native-permissions.ts';
import type { AgentQuestion, QuestionAnswers } from './runtime/contracts.ts';

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
	/** Agent questions (`AskUserQuestion`) shown as a card; without it they are denied and the agent decides by itself. */
	question?: (questions: AgentQuestion[]) => Promise<QuestionAnswers | undefined>;
	/** Names of the user-added MCP servers wired into this run; a tool of any other server is not available. */
	mcpServers?: readonly string[];
}
/** The IDE's decision about one normalized call, before the user is asked (shared by every provider). */
export type CallVerdict = { verdict: 'allow' } | { verdict: 'deny'; message: string } | { verdict: 'ask'; draft: ApprovalDraft & ApprovalSubject };

const EDIT_TOOLS = new Map([['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path']]);
const READ_TOOLS = new Map<string, string | undefined>([['Read', 'file_path'], ['Glob', 'path'], ['Grep', 'path'], ['LS', 'path'], ['TodoWrite', undefined]]);
const CHANGE_DIRECTORY = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl']);
const CHANGE_DIRECTORY_DENIAL = 'POLICY_DENIED: change-directory\nNext: Bash stays in the project root: pass the folder to the tool instead (pnpm --dir apps/web lint, npm --prefix apps/web test) or use the run tool with cwd.';
const BACKGROUND_DENIAL = 'POLICY_DENIED: background\nNext: run the command in the foreground; background processes outlive the IDE\'s control.';
const MAX_QUESTIONS = 4;
const MAX_COMPOUND_LINE = 4000;

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
const refuse = (message: string): CallVerdict => ({ verdict: 'deny', message });

/**
 * One shell command line. A plain line goes through the command policy (floor, Harness delegation, permission rules). A
 * compound line (pipes, operators) is refused unless it runs inside the provider's own sandbox (`sandboxed`, Codex): then
 * the user sees the exact line and may allow it once; it never becomes a remembered rule.
 */
export function commandVerdict(context: Pick<ApproveContext, 'policy'>, line: string, options: { sandboxed?: boolean; background?: boolean } = {}): CallVerdict {
	if (options.background) { return refuse(BACKGROUND_DENIAL); }
	const words = plainCommandWords(line);
	if (!words) {
		if (!options.sandboxed || !line.trim() || line.length > MAX_COMPOUND_LINE) { return refuse(denialText('shell-operator')); }
		return { verdict: 'ask', draft: { kind: 'run', title: 'Run command', rule: '', noRemember: 'inexact', command: line.slice(0, 300), args: [], cwd: '.', detail: ['command: ' + line.slice(0, 300), 'cwd: .', 'shell: provider sandbox'] } };
	}
	if (CHANGE_DIRECTORY.has(words[0].toLowerCase())) { return refuse(CHANGE_DIRECTORY_DENIAL); }
	const decision = context.policy.decide(words[0], words.slice(1), '.');
	if (decision.allowed === true) { return { verdict: 'allow' }; }
	if (decision.reason !== 'needs-approval') { return refuse(denialText(decision.reason)); }
	return { verdict: 'ask', draft: { kind: 'run', title: 'Run command', rule: decision.rule, command: words[0], args: words.slice(1), cwd: '.', detail: ['command: ' + words.join(' ').slice(0, 300), 'cwd: .'] } };
}

/** Files a tool wants to change: each must pass the file floor, and `edit:` rules decide (deny wins, any ask asks). */
export async function editVerdict(context: Pick<ApproveContext, 'root' | 'permissions'>, raws: readonly unknown[]): Promise<CallVerdict> {
	if (!raws.length) { return refuse('POLICY_DENIED: invalid-path'); }
	const files: string[] = [];
	let ask = false;
	for (const raw of raws) {
		const relative = await projectPath(context.root, raw);
		const verdict = context.permissions.decide({ kind: 'edit', path: relative });
		if (verdict.decision === 'deny') { return refuse('POLICY_DENIED: ' + (verdict.rule ?? 'denied by permissions')); }
		ask ||= verdict.decision === 'ask';
		files.push(relative);
	}
	return ask ? { verdict: 'ask', draft: { kind: 'edit', title: 'Edit file', detail: files.slice(0, 10).map(file => 'edit: ' + file), rule: '', path: files[0] } } : { verdict: 'allow' };
}

/** `undefined` when allowed; otherwise the denial text the model receives. Asking goes through the user's card. */
export async function settleVerdict(context: Pick<ApproveContext, 'ask'>, verdict: CallVerdict): Promise<string | undefined> {
	if (verdict.verdict === 'allow') { return undefined; }
	if (verdict.verdict === 'deny') { return verdict.message; }
	return requestApproval(context.ask, verdict.draft);
}

async function bash(context: ApproveContext, input: Record<string, unknown>): Promise<PromptDecision> {
	if (typeof input.command !== 'string') { return deny(denialText('invalid')); }
	const denial = await settleVerdict(context, commandVerdict(context, input.command, { background: input.run_in_background === true }));
	return denial ? deny(denial) : allow(input);
}

async function edit(context: ApproveContext, input: Record<string, unknown>, field: string): Promise<PromptDecision> {
	const denial = await settleVerdict(context, await editVerdict(context, [input[field]]));
	return denial ? deny(denial) : allow(input);
}

/** Claude's `AskUserQuestion` input, bounded and validated; `undefined` when malformed. */
export function parseClaudeQuestions(input: Record<string, unknown>): AgentQuestion[] | undefined {
	const raw = input.questions;
	if (!Array.isArray(raw) || !raw.length || raw.length > MAX_QUESTIONS) { return undefined; }
	const questions: AgentQuestion[] = [];
	for (const [index, item] of raw.entries()) {
		const value = (item ?? {}) as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
		if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 1000 || !Array.isArray(value.options) || value.options.length > 8) { return undefined; }
		const options = value.options.map(option => (option ?? {}) as { label?: unknown; description?: unknown })
			.filter(option => typeof option.label === 'string' && option.label.trim())
			.map(option => ({ label: (option.label as string).slice(0, 200), ...(typeof option.description === 'string' ? { description: option.description.slice(0, 400) } : {}) }));
		questions.push({ id: 'q' + index, header: typeof value.header === 'string' ? value.header.slice(0, 60) : '', question: value.question, options, multiSelect: value.multiSelect === true, allowOther: true, secret: false });
	}
	return questions;
}

/** Claude names a server's tool `mcp__<server>__<tool>`; server names have no underscores (see `native-mcp-servers.ts`). */
const MCP_TOOL = /^mcp__(?<server>[a-z0-9-]+)__(?<tool>[A-Za-z0-9_.-]+)$/;

/** What the user sees of a call's arguments: key names and short values, never an unbounded blob. */
function argumentLines(input: Record<string, unknown>): string[] {
	return Object.entries(input).slice(0, 6).map(([key, value]) => 'arg ' + key.slice(0, 40) + ': ' + (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, 200));
}

/** Hosts that name this machine or a private network are never fetched: a page request must not become a way into the LAN. */
function publicHost(host: string): boolean {
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host) && !/\.(?:local|internal|localdomain|lan|home|corp)$/.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

async function webFetch(context: ApproveContext, input: Record<string, unknown>): Promise<PromptDecision> {
	let url: URL | undefined;
	try { url = new URL(String(input.url)); } catch { url = undefined; }
	if (!url || url.protocol !== 'https:' || url.username || url.password || !publicHost(url.hostname)) { return deny('POLICY_DENIED: web-host\nNext: only https pages on public host names can be fetched.'); }
	const verdict = context.permissions.decide({ kind: 'web', host: url.hostname });
	if (verdict.decision === 'deny') { return deny('POLICY_DENIED: ' + (verdict.rule ?? 'web fetch denied by permissions')); }
	const denial = verdict.decision === 'allow' ? undefined
		: await settleVerdict(context, { verdict: 'ask', draft: { kind: 'web', title: 'Fetch web page', rule: '', host: url.hostname, detail: ['host: ' + url.hostname, 'url: ' + (url.origin + url.pathname).slice(0, 300)] } });
	return denial ? deny(denial) : allow(input);
}

async function mcpTool(context: ApproveContext, server: string, tool: string, input: Record<string, unknown>): Promise<PromptDecision> {
	const verdict = context.permissions.decide({ kind: 'mcp', server, tool });
	if (verdict.decision === 'deny') { return deny('POLICY_DENIED: ' + (verdict.rule ?? 'mcp tool denied by permissions')); }
	const denial = verdict.decision === 'allow' ? undefined
		: await settleVerdict(context, { verdict: 'ask', draft: { kind: 'mcp', title: 'Use MCP tool', rule: '', server, tool, detail: ['server: ' + server, 'tool: ' + tool, ...argumentLines(input)] } });
	return denial ? deny(denial) : allow(input);
}

async function question(context: ApproveContext, input: Record<string, unknown>): Promise<PromptDecision> {
	const questions = parseClaudeQuestions(input);
	if (!questions) { return deny('POLICY_DENIED: invalid-question'); }
	if (!context.question) { return deny('DENIED: the user cannot be asked in this run; decide with the information you have and say what you assumed.'); }
	const answers = await context.question(questions).catch(() => undefined);
	if (!answers || !questions.every(item => answers[item.id]?.length)) { return deny('DENIED: the user did not answer; decide with the information you have and say what you assumed.'); }
	// Claude reads the answers keyed by question text, several choices joined by commas.
	return allow({ ...input, answers: Object.fromEntries(questions.map(item => [item.question, answers[item.id].join(', ')])) });
}

/** Decide one permission prompt. Unknown tools are denied: native transport only grants what the structured one grants. */
export async function decidePermissionPrompt(context: ApproveContext, value: unknown): Promise<PromptDecision> {
	const request = (value ?? {}) as { tool_name?: unknown; input?: unknown };
	const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input as Record<string, unknown> : undefined;
	if (typeof request.tool_name !== 'string' || !input) { return deny(denialText('invalid')); }
	try {
		if (request.tool_name === 'Bash') { return await bash(context, input); }
		if (request.tool_name === 'AskUserQuestion') { return await question(context, input); }
		if (request.tool_name === 'WebFetch') { return await webFetch(context, input); }
		const mcp = MCP_TOOL.exec(request.tool_name)?.groups;
		if (mcp && context.mcpServers?.includes(mcp.server)) { return await mcpTool(context, mcp.server, mcp.tool, input); }
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
