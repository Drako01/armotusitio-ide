/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `ats-runner`: the IDE's command tool server (block A), a stdio MCP server the provider CLI starts for one run.
 * Its only input of authority is the configuration file the extension wrote outside the project for that run;
 * nothing in the project, the user's MCP settings or the agent's requests can widen the policy.
 */
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { createCommandPolicy, type CommandPolicyConfig } from './native-command-policy.ts';
import { runCommand, MAX_COMMAND_TIMEOUT_SEC } from './native-command-runner.ts';
import { callToolChannel } from './native-tool-server.ts';
import { EDITOR_TOOLS } from './native-editor-tools.ts';
import { secretVariants } from './native-dev-secrets.ts';
import { channelApprover, requestApproval, type ApprovalAsk } from './native-approval.ts';
import { GIT_TOOLS, endsGitDelivery, handleGitTool } from './native-git-tools.ts';
import { FILE_TOOLS, handleFileTool } from './native-file-tools.ts';
import { loadPermissions, type PermissionSet } from './native-permissions.ts';
import type { PermissionPreset } from './native-permissions-types.ts';
import { projectPermissionsDigest } from './native-run-integrity.ts';
import { MCP_TOOL_PREFIX, type WorkMcpTool } from './native-mcp-bridge.ts';

export interface RunnerConfig {
	schemaVersion: 1;
	root: string;
	policy: CommandPolicyConfig;
	delegateEntry?: string;
	env: NodeJS.ProcessEnv;
	logDirectory: string;
	/** Claude's turn budget; the runner reminds the agent to wrap up at 80% of it (block F). */
	maxTurns?: number;
	/** Channel to the extension for editor tools (S) and development secrets (V); secrets never go in this file. */
	channel?: { address: string; token: string };
	/** Work Management schemas only; the credential and HTTP client stay in the extension. */
	mcpTools?: WorkMcpTool[];
	/** Permission rules are read from their files by this process on every call, so an "always" answer applies at once; only the preset travels here. */
	permissions?: { preset?: PermissionPreset };
	/** Offers structured branch/commit/push/PR tools; set only for runs that can ask the user (the chat). */
	git?: boolean;
	/** Offers the structured delete/move tools; set only for runs that can ask the user (the chat). */
	files?: boolean;
	/** Integrity snapshots captured by the extension before the provider starts. */
	projectPermissionsBaseline?: string;
	repoBaseline?: string;
	protectedBranches?: string[];
}

/** Seams for tests; in production the permissions come from the files and approvals from the channel. */
export interface RunnerDeps { permissions?: PermissionSet; ask?: ApprovalAsk }

const loadRunnerPermissions = (config: RunnerConfig, deps: RunnerDeps): Promise<PermissionSet> =>
	deps.permissions ? Promise.resolve(deps.permissions) : loadPermissions(config.root, undefined, undefined, { preset: config.permissions?.preset });
const approverOf = (config: RunnerConfig, deps: RunnerDeps): ApprovalAsk | undefined => deps.ask ?? (config.channel ? channelApprover(config.channel) : undefined);

const permissionsUntouched = async (config: RunnerConfig): Promise<boolean> => config.projectPermissionsBaseline === undefined ||
	(config.projectPermissionsBaseline !== 'unreadable' && await projectPermissionsDigest(config.root) === config.projectPermissionsBaseline);

const TOOL = {
	name: 'run',
	description: 'Run one command in the project, without a shell, under the IDE command policy. Pass the executable in `command`, each argument separately in `args`, ' +
		'and a project-relative `cwd` for subprojects (for example "apps/api"). No shell operators, inline code, git changes, publishing, network tools or deletions ' +
		'(use the delete_path, move_path and git_* tools when they are listed). ' +
		'A denied command returns `POLICY_DENIED: <reason>`; do not retry it in another form.',
	inputSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'Executable, e.g. "go", "pnpm", "python".' },
			args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one per item, e.g. ["test", "./..."].' },
			cwd: { type: 'string', description: 'Project-relative folder; "." by default.' },
			timeoutSec: { type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_SEC }
		},
		required: ['command'],
		additionalProperties: false
	}
};

/** Answer one `tools/call`; exported for tests. */
export async function handleRun(config: RunnerConfig, input: unknown, calls: number, deps: RunnerDeps = {}): Promise<{ isError: boolean; text: string }> {
	if (!await permissionsUntouched(config)) { return { isError: true, text: 'POLICY_DENIED: project-permissions-changed' }; }
	const value = (input ?? {}) as { command?: unknown; args?: unknown; cwd?: unknown; timeoutSec?: unknown };
	const args = value.args ?? [];
	if (typeof value.command !== 'string' || !value.command.trim() || !Array.isArray(args) || !args.every(arg => typeof arg === 'string') ||
		(value.cwd !== undefined && typeof value.cwd !== 'string') || (value.timeoutSec !== undefined && !Number.isSafeInteger(value.timeoutSec))) {
		return { isError: true, text: 'Invalid input: { command: string, args?: string[], cwd?: string, timeoutSec?: integer }' };
	}
	const permissions = config.permissions || deps.permissions ? await loadRunnerPermissions(config, deps) : undefined;
	let decision = createCommandPolicy({ ...config.policy, ...(permissions ? { permissions } : {}) }).decide(value.command, args as string[], (value.cwd as string | undefined) ?? '.');
	const audit = { at: new Date().toISOString(), command: value.command, args, cwd: value.cwd ?? '.' };
	if (decision.allowed === false && decision.reason === 'needs-approval') {
		// A permission rule said `ask`: the user decides; an unanswered or refused request is a denial the agent must not retry.
		const denial = await requestApproval(approverOf(config, deps), { kind: 'run', title: 'Run command', rule: decision.rule, command: value.command, args: args as string[], cwd: decision.cwd, detail: ['command: ' + [value.command, ...(args as string[])].join(' ').slice(0, 300), 'cwd: ' + decision.cwd] });
		if (denial) {
			await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, denied: 'not-approved' }) + '\n').catch(() => undefined);
			return { isError: true, text: denial };
		}
		decision = { allowed: true, executable: decision.executable, cwd: decision.cwd, delegate: decision.delegate };
	}
	if (decision.allowed === false) {
		await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, denied: decision.reason }) + '\n').catch(() => undefined);
		return { isError: true, text: 'POLICY_DENIED: ' + decision.reason };
	}
	// Secrets allowed for this exact command come from the keychain through the channel, only into this process.
	const secrets = config.channel ? await callToolChannel(config.channel.address, config.channel.token, 'secrets', { command: value.command, args, cwd: decision.cwd }).catch(() => ({})) as Record<string, string> : {};
	if (!await permissionsUntouched(config)) { return { isError: true, text: 'POLICY_DENIED: project-permissions-changed' }; }
	const result = await runCommand({
		root: config.root, cwd: decision.cwd, command: value.command, args: args as string[], timeoutSec: value.timeoutSec as number | undefined,
		env: { ...config.env, ...secrets }, logDirectory: config.logDirectory, ...(decision.delegate && config.delegateEntry ? { delegateEntry: config.delegateEntry } : {})
	}).catch((error: Error) => error);
	if (!(result instanceof Error)) {
		for (const variant of Object.values(secrets).flatMap(secretVariants)) { result.output = result.output.split(variant).join('[REDACTED]'); }
	}
	if (result instanceof Error) {
		const systemCode = (result as NodeJS.ErrnoException).code;
		const code = /^HARNESS_[A-Z_]+$/.test(result.message) ? result.message : 'HARNESS_COMMAND_FAILED';
		const text = code + '\n[ats-runner] command: ' + value.command + (systemCode ? '; system error: ' + systemCode : '') +
			(code === 'HARNESS_COMMAND_FAILED' ? '. The command could not be prepared; this does not establish that the tool is missing.' : '');
		await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, error: code, systemCode }) + '\n').catch(() => undefined);
		return { isError: true, text };
	}
	await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut }) + '\n').catch(() => undefined);
	const status = result.timedOut ? 'timed out' : 'exit ' + result.exitCode;
	const budget = config.maxTurns && calls >= Math.floor(config.maxTurns * 0.8)
		? '\n[ats-runner] Budget: about ' + Math.max(0, config.maxTurns - calls) + ' turns left. Leave the work consistent and write the report now.' : '';
	return {
		isError: result.exitCode !== 0,
		text: status + ' \u00b7 ' + (result.durationMs / 1000).toFixed(1) + ' s' + (result.truncated ? ' \u00b7 output truncated, full log: ' + result.logFile : '') + '\n' + (result.output || '(no output)') + budget
	};
}

/** One audit line per structured tool call; the outcome is the first word of the result (`COMMITTED`, `POLICY_DENIED:`, ...). */
const auditTool = (config: RunnerConfig, tool: string, result: { isError: boolean; text: string }): Promise<void> =>
	fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ at: new Date().toISOString(), tool, isError: result.isError, outcome: result.text.split(/[\s\n]/, 1)[0] }) + '\n').catch(() => undefined);

/** Answer one structured delete/move call; exported for tests. */
export async function handleFiles(config: RunnerConfig, name: string, input: unknown, deps: RunnerDeps = {}): Promise<{ isError: boolean; text: string }> {
	if (!config.files) { return { isError: true, text: 'Unknown tool' }; }
	if (!await permissionsUntouched(config)) { return { isError: true, text: 'POLICY_DENIED: project-permissions-changed' }; }
	const result = await handleFileTool({ root: config.root, permissions: await loadRunnerPermissions(config, deps), ask: approverOf(config, deps) }, name, input);
	await auditTool(config, name, result);
	return result;
}

/** Answer one structured git delivery tool call; exported for tests. */
export async function handleGit(config: RunnerConfig, name: string, input: unknown, deps: RunnerDeps = {}, signal?: AbortSignal): Promise<{ isError: boolean; text: string }> {
	if (!config.git) { return { isError: true, text: 'Unknown tool' }; }
	if (!await permissionsUntouched(config)) { return { isError: true, text: 'POLICY_DENIED: project-permissions-changed' }; }
	const permissions = await loadRunnerPermissions(config, deps);
	const result = await handleGitTool({ root: config.root, env: config.env, logDirectory: config.logDirectory, permissions, ask: approverOf(config, deps), repoBaseline: config.repoBaseline, protectedBranches: config.protectedBranches, checkPermissions: () => permissionsUntouched(config), signal }, name, input);
	// The structured branch creation and first upstream push may legitimately update git config.
	// Only the tool can refresh this in-memory run snapshot after verifying hooks/config.
	if (!result.isError && result.repoBaseline) { config.repoBaseline = result.repoBaseline; }
	await auditTool(config, name, result);
	return result;
}

async function main(): Promise<void> {
	const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as RunnerConfig;
	if (config.schemaVersion !== 1 || typeof config.root !== 'string') { throw Error('HARNESS_CONFIG_SCHEMA'); }
	if (((config.permissions || config.files) && typeof config.projectPermissionsBaseline !== 'string') || (config.git && typeof config.repoBaseline !== 'string')) { throw Error('HARNESS_CONFIG_SCHEMA'); }
	let calls = 0;
	const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + '\n'); };
	const stopped = new AbortController();
	let gitQueue = Promise.resolve();
	let gitDenied = false;
	const input = readline.createInterface({ input: process.stdin });
	input.on('close', () => stopped.abort());
	input.on('line', async line => {
		let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
		try { request = JSON.parse(line); } catch { return; }
		if (request.id === undefined) { return; }
		const reply = (result: unknown): void => send({ jsonrpc: '2.0', id: request.id, result });
		if (request.method === 'initialize') { return reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ats-runner', version: '1.0.0' } }); }
		if (request.method === 'tools/list') { return reply({ tools: [TOOL, ...(config.git ? GIT_TOOLS : []), ...(config.files ? FILE_TOOLS : []), ...(config.channel ? EDITOR_TOOLS : []), ...(config.channel ? config.mcpTools ?? [] : [])] }); }
		if (request.method === 'ping') { return reply({}); }
		if (request.method === 'tools/call' && config.channel && request.params?.name?.startsWith(MCP_TOOL_PREFIX) && config.mcpTools?.some(tool => tool.name === request.params!.name)) {
			calls++;
			if (!await permissionsUntouched(config)) { return reply({ isError: true, content: [{ type: 'text', text: 'POLICY_DENIED: project-permissions-changed' }] }); }
			try {
				const result = await callToolChannel(config.channel.address, config.channel.token, 'work-mcp', { name: request.params.name, input: request.params.arguments ?? {} }, 11 * 60 * 1000);
				return reply(result);
			} catch (error) {
				const message = (error as Error).message;
				return reply({ isError: true, content: [{ type: 'text', text: /^HARNESS_[A-Z_]+$/.test(message) ? message : 'HARNESS_MCP_FAILED' }] });
			}
		}
		if (request.method === 'tools/call' && request.params?.name === TOOL.name) {
			const result = await handleRun(config, request.params.arguments, ++calls);
			return reply({ isError: result.isError, content: [{ type: 'text', text: result.text }] });
		}
		if (request.method === 'tools/call' && config.git && GIT_TOOLS.some(tool => tool.name === request.params?.name)) {
			calls++;
			// A provider can issue several MCP calls concurrently. Git state transitions must be serialized.
			const task = gitQueue.then(async () => {
				if (gitDenied) {
					const result = { isError: true, text: 'POLICY_DENIED: prior-git-denial' };
					await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ at: new Date().toISOString(), tool: request.params!.name, isError: true, outcome: 'POLICY_DENIED' }) + '\n').catch(() => undefined);
					return result;
				}
				const result = await handleGit(config, request.params!.name!, request.params!.arguments, {}, stopped.signal);
				// A user denial or an integrity refusal is final; a correctable input refusal lets the agent fix its call.
				if (endsGitDelivery(result.text)) { gitDenied = true; }
				return result;
			});
			gitQueue = task.then(() => undefined, () => undefined);
			const result = await task;
			return reply({ isError: result.isError, content: [{ type: 'text', text: result.text }] });
		}
		if (request.method === 'tools/call' && config.files && FILE_TOOLS.some(tool => tool.name === request.params?.name)) {
			calls++;
			const result = await handleFiles(config, request.params!.name!, request.params!.arguments);
			return reply({ isError: result.isError, content: [{ type: 'text', text: result.text }] });
		}
		const editor = EDITOR_TOOLS.find(tool => tool.name === request.params?.name);
		if (request.method === 'tools/call' && editor && config.channel) {
			calls++;
			const text = await callToolChannel(config.channel.address, config.channel.token, 'editor', { name: editor.name, input: request.params!.arguments ?? {} }).then(value => String(value), (error: Error) => error.message);
			return reply({ isError: text.startsWith('HARNESS_') || text.startsWith('POLICY_DENIED'), content: [{ type: 'text', text }] });
		}
		send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
	});
}

if (process.argv[1] && /ats-runner\.(js|ts)$/.test(process.argv[1])) { void main().catch(() => process.exit(1)); }
