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
}

const TOOL = {
	name: 'run',
	description: 'Run one command in the project, without a shell, under the IDE command policy. Pass the executable in `command`, each argument separately in `args`, ' +
		'and a project-relative `cwd` for subprojects (for example "apps/api"). No shell operators, inline code, git changes, publishing, network tools or deletions. ' +
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
export async function handleRun(config: RunnerConfig, input: unknown, calls: number): Promise<{ isError: boolean; text: string }> {
	const value = (input ?? {}) as { command?: unknown; args?: unknown; cwd?: unknown; timeoutSec?: unknown };
	const args = value.args ?? [];
	if (typeof value.command !== 'string' || !value.command.trim() || !Array.isArray(args) || !args.every(arg => typeof arg === 'string') ||
		(value.cwd !== undefined && typeof value.cwd !== 'string') || (value.timeoutSec !== undefined && !Number.isSafeInteger(value.timeoutSec))) {
		return { isError: true, text: 'Invalid input: { command: string, args?: string[], cwd?: string, timeoutSec?: integer }' };
	}
	const decision = createCommandPolicy(config.policy).decide(value.command, args as string[], (value.cwd as string | undefined) ?? '.');
	const audit = { at: new Date().toISOString(), command: value.command, args, cwd: value.cwd ?? '.' };
	if (decision.allowed === false) {
		await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, denied: decision.reason }) + '\n').catch(() => undefined);
		return { isError: true, text: 'POLICY_DENIED: ' + decision.reason };
	}
	// Secrets allowed for this exact command come from the keychain through the channel, only into this process.
	const secrets = config.channel ? await callToolChannel(config.channel.address, config.channel.token, 'secrets', { command: value.command, args, cwd: decision.cwd }).catch(() => ({})) as Record<string, string> : {};
	const result = await runCommand({
		root: config.root, cwd: decision.cwd, command: value.command, args: args as string[], timeoutSec: value.timeoutSec as number | undefined,
		env: { ...config.env, ...secrets }, logDirectory: config.logDirectory, ...(decision.delegate && config.delegateEntry ? { delegateEntry: config.delegateEntry } : {})
	}).catch((error: Error) => error);
	if (!(result instanceof Error)) {
		for (const variant of Object.values(secrets).flatMap(secretVariants)) { result.output = result.output.split(variant).join('[REDACTED]'); }
	}
	if (result instanceof Error) {
		return { isError: true, text: /^HARNESS_[A-Z_]+$/.test(result.message) ? result.message : 'HARNESS_EXECUTABLE_UNAVAILABLE' };
	}
	await fs.appendFile(config.logDirectory + '/commands.jsonl', JSON.stringify({ ...audit, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut }) + '\n').catch(() => undefined);
	const status = result.timedOut ? 'timed out' : 'exit ' + result.exitCode;
	const budget = config.maxTurns && calls >= Math.floor(config.maxTurns * 0.8)
		? '\n[ats-runner] Budget: about ' + Math.max(0, config.maxTurns - calls) + ' turns left. Leave the work consistent and write the report now.' : '';
	return {
		isError: result.exitCode !== 0,
		text: status + ' · ' + (result.durationMs / 1000).toFixed(1) + ' s' + (result.truncated ? ' · output truncated, full log: ' + result.logFile : '') + '\n' + (result.output || '(no output)') + budget
	};
}

async function main(): Promise<void> {
	const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as RunnerConfig;
	if (config.schemaVersion !== 1 || typeof config.root !== 'string') { throw Error('HARNESS_CONFIG_SCHEMA'); }
	let calls = 0;
	const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + '\n'); };
	readline.createInterface({ input: process.stdin }).on('line', async line => {
		let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
		try { request = JSON.parse(line); } catch { return; }
		if (request.id === undefined) { return; }
		const reply = (result: unknown): void => send({ jsonrpc: '2.0', id: request.id, result });
		if (request.method === 'initialize') { return reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ats-runner', version: '1.0.0' } }); }
		if (request.method === 'tools/list') { return reply({ tools: config.channel ? [TOOL, ...EDITOR_TOOLS] : [TOOL] }); }
		if (request.method === 'ping') { return reply({}); }
		if (request.method === 'tools/call' && request.params?.name === TOOL.name) {
			const result = await handleRun(config, request.params.arguments, ++calls);
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
