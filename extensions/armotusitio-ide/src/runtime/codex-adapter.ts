/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Codex adapter: one `codex app-server` process per session, JSON-RPC over stdio, typed with the bindings generated from
 * the installed CLI. Threads are durable (never `ephemeral`), so a session resumes by `threadId` after an IDE restart.
 * Every approval and question Codex sends goes to the host, which applies the IDE's policy and the user's card; an
 * unanswered or failed request is a denial. Codex keeps its own sandbox; the IDE never widens it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveNativeCommand } from '../native-runtime.ts';
import { validateChatImages } from '../native-chat-images.ts';
import { readonlyCodexSubagentOverrides } from '../native-codex-subagents.ts';
import { captureAgentScope } from '../native-agent-scope.ts';
import {
	CODEX_PROTOCOL_VERSION,
	type AskForApproval, type CommandExecutionRequestApprovalParams, type CommandExecutionRequestApprovalResponse, type FileChangeRequestApprovalParams,
	type FileChangeRequestApprovalResponse, type InitializeParams, type InitializeResponse, type ItemCompletedNotification, type ItemStartedNotification,
	type McpServerElicitationRequestResponse, type PermissionsRequestApprovalParams, type PermissionsRequestApprovalResponse, type SandboxPolicy,
	type ThreadForkResponse, type ThreadResumeResponse, type ThreadStartParams, type ThreadStartResponse, type ThreadTokenUsageUpdatedNotification,
	type ToolRequestUserInputParams, type ToolRequestUserInputResponse, type TurnCompletedNotification, type TurnStartParams, type TurnStartResponse,
	type TurnSteerResponse, type UserInput
} from './codex-protocol.generated.ts';
import { RuntimeError, type AdapterHost, type AgentAdapter, type AgentConnection, type AgentQuestion, type RuntimeCapabilities, type SessionOpenOptions, type SessionRole, type ToolCall, type TurnInput, type TurnResult } from './contracts.ts';
import { MAX_TEXT_CHARS } from './event-bridge.ts';
import { JsonRpcConnection, ProviderRequestError } from './json-rpc.ts';
import { startProviderProcess, type ProviderProcess } from './provider-process.ts';

const run = promisify(execFile);
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Notifications the adapter does not use; opting out keeps the stream small. */
const IGNORED_NOTIFICATIONS = ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'rawResponseItem/completed', 'rawResponse/completed', 'item/plan/delta', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted'];
/** Methods that are part of the session's normal life but carry nothing for the chat. */
const QUIET_NOTIFICATIONS = new Set(['warning', 'account/rateLimits/updated', 'thread/started', 'thread/status/changed', 'account/updated', 'remoteControl/status/changed', 'mcpServer/startupStatus/updated', 'skills/changed', 'thread/settings/updated', 'serverRequest/resolved', 'hook/started', 'hook/completed', 'turn/diff/updated', 'turn/plan/updated', 'thread/name/updated', 'model/safetyBuffering/updated', 'thread/readState/changed', 'app/list/updated', 'thread/queue/changed']);

/** `major.minor` of a version string; the generated bindings are trusted within the same minor version. */
export function minorOf(version: string): string { return /(?<major>\d+)\.(?<minor>\d+)/.exec(version)?.slice(1, 3).join('.') ?? ''; }

/** TOML basic string; JSON escaping is a valid subset for paths and arguments. */
const toml = (value: string): string => JSON.stringify(value);

function sandboxPolicy(role: SessionRole, writableRoots: readonly string[], fullAccess: boolean): SandboxPolicy {
	if (role === 'conversation') { return { type: 'readOnly', networkAccess: false }; }
	if (fullAccess) { return { type: 'dangerFullAccess' }; }
	return { type: 'workspaceWrite', writableRoots: [...writableRoots], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** A conversation never escalates; a writer asks for every command Codex does not consider safe, and the IDE decides. */
const approvalPolicy = (role: SessionRole): AskForApproval => role === 'conversation' ? 'never' : 'untrusted';

function textInput(text: string): UserInput[] { return [{ type: 'text', text, text_elements: [] }]; }

function questionsOf(params: ToolRequestUserInputParams): AgentQuestion[] {
	return params.questions.slice(0, 8).map(question => ({
		id: question.id, header: question.header, question: question.question,
		options: (question.options ?? []).map(option => ({ label: option.label, description: option.description })),
		multiSelect: false, allowOther: question.isOther, secret: question.isSecret
	}));
}

export interface CodexAdapterOptions {
	/** `atsHarness.codexSandbox: danger-full-access`: the user removed Codex's sandbox for writers. */
	fullAccess?: () => boolean;
	clientVersion?: string;
}

export class CodexAdapter implements AgentAdapter {
	readonly provider = 'codex' as const;
	private readonly options: CodexAdapterOptions;
	constructor(options: CodexAdapterOptions = {}) { this.options = options; }

	async capabilities(env: NodeJS.ProcessEnv): Promise<RuntimeCapabilities> {
		const command = await resolveNativeCommand('codex', ['--version'], env);
		const { stdout } = await run(command.executable, command.args, { env: command.embeddedNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env, windowsHide: true, timeout: 15_000 });
		const version = stdout.trim().replace(/^codex-cli\s+/, '');
		const compatible = minorOf(version) === minorOf(CODEX_PROTOCOL_VERSION);
		return {
			provider: 'codex', version, transport: 'app-server', compatible,
			...(compatible ? {} : { incompatibility: 'Codex ' + version + ' habla una versi\u00f3n del protocolo app-server distinta de la validada (' + CODEX_PROTOCOL_VERSION + ').' }),
			features: {
				session: 'supported', streaming: 'supported', resume: 'supported', fork: 'supported', interrupt: 'supported', steer: 'supported',
				approvals: 'supported', questions: 'experimental', commandOutput: 'supported', mcp: 'supported', usage: 'supported'
			}
		};
	}

	async open(options: SessionOpenOptions, host: AdapterHost): Promise<AgentConnection> {
		const server = options.toolServer;
		// The IDE's tool server, pre-approved inside Codex: its own policy floor and the IDE's cards decide every call.
		const mcp = server ? ['-c', 'mcp_servers.ats-runner.command=' + toml(server.command), '-c', 'mcp_servers.ats-runner.args=[' + server.args.map(toml).join(',') + ']',
			'-c', 'mcp_servers.ats-runner.env={' + Object.entries(server.env).map(([key, value]) => key + '=' + toml(value)).join(',') + '}',
			'-c', 'mcp_servers.ats-runner.default_tools_approval_mode="approve"', '-c', 'mcp_servers.ats-runner.tool_timeout_sec=1800'] : [];
		if (options.nativeSubagents && (options.role !== 'conversation' || options.toolServer || options.webSearch || this.options.fullAccess?.())) {
			throw new RuntimeError('RUNTIME_SUBAGENTS_UNSAFE');
		}
		if (options.nativeSubagents) {
			// Do not start any provider subprocess if read-only scope cannot be
			// attested locally. Native sandboxing remains the primary boundary.
			const scope = await captureAgentScope(options.identity.root).catch(() => undefined);
			if (scope?.source !== 'git' || scope.unscanned.length !== 0) {
				throw new RuntimeError('HARNESS_DELEGATION_ISOLATION_UNSUPPORTED');
			}
		}
		const search = options.webSearch ? ['-c', 'tools.web_search=true'] : [];
		const child = await startProviderProcess('codex', [...readonlyCodexSubagentOverrides(options.nativeSubagents === true), 'app-server', ...mcp, ...search], options.identity.root, options.env);
		const connection = new CodexConnection(child, options, host, !!this.options.fullAccess?.());
		try {
			await connection.handshake(this.options.clientVersion ?? '0');
			return connection;
		} catch (error) {
			child.stop();
			throw error;
		}
	}
}

interface ActiveTurn { id?: string; clientTurnId: string; output: string; resolve(result: TurnResult): void; usage?: TurnResult['usage'] }

class CodexConnection implements AgentConnection {
	nativeSessionId = '';
	resumed = false;
	readonly exited: Promise<{ code: number | null; expected: boolean }>;
	private readonly rpc: JsonRpcConnection;
	private readonly child: ProviderProcess;
	private readonly options: SessionOpenOptions;
	private readonly host: AdapterHost;
	private readonly fullAccess: boolean;
	private turn?: ActiveTurn;
	/** Paths of file-change items, so their approval card can say which files. */
	private readonly changePaths = new Map<string, string[]>();
	private readonly messages = new Map<string, string>();

	constructor(child: ProviderProcess, options: SessionOpenOptions, host: AdapterHost, fullAccess: boolean) {
		this.child = child; this.options = options; this.host = host; this.fullAccess = fullAccess;
		this.rpc = new JsonRpcConnection(child.child.stdin, child.child.stdout, {
			request: (method, params) => this.serverRequest(method, params),
			notification: (method, params) => this.notification(method, params),
			malformed: (reason, sample) => host.emit({ payload: { type: 'diagnostic', source: 'codex', text: reason + ': ' + sample } })
		});
		this.exited = child.exited.then(exit => {
			this.rpc.close(new RuntimeError('RUNTIME_CONNECTION_LOST', true));
			this.finishTurn({ status: 'failed', error: exit.expected ? 'RUNTIME_CONNECTION_CLOSED' : 'RUNTIME_CONNECTION_LOST' });
			return exit;
		});
	}

	async handshake(clientVersion: string): Promise<void> {
		const init: InitializeParams = {
			clientInfo: { name: 'armotusitio_ide', title: 'ArmoTuSitio IDE', version: clientVersion },
			capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: IGNORED_NOTIFICATIONS }
		};
		await this.rpc.request<InitializeResponse>('initialize', init, HANDSHAKE_TIMEOUT_MS);
		this.rpc.notify('initialized');
		const { identity, role, resume, fork } = this.options;
		const common = {
			cwd: identity.root, approvalPolicy: approvalPolicy(role), sandbox: role === 'conversation' ? 'read-only' as const : this.fullAccess ? 'danger-full-access' as const : 'workspace-write' as const,
			...(this.options.model ? { model: this.options.model } : {}), developerInstructions: this.options.instructions,
			...(this.options.effort ? { config: { model_reasoning_effort: this.options.effort } } : {})
		};
		let response: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse;
		if (resume && fork) {
			response = await this.rpc.request<ThreadForkResponse>('thread/fork', { threadId: resume, ...common }, HANDSHAKE_TIMEOUT_MS);
		} else if (resume) {
			response = await this.rpc.request<ThreadResumeResponse>('thread/resume', { threadId: resume, ...common, excludeTurns: true }, HANDSHAKE_TIMEOUT_MS);
			this.resumed = true;
		} else {
			const params: ThreadStartParams = { ...common, ephemeral: false, serviceName: 'armotusitio_ide' };
			response = await this.rpc.request<ThreadStartResponse>('thread/start', params, HANDSHAKE_TIMEOUT_MS);
		}
		this.nativeSessionId = response.thread.id;
		this.host.emit({ payload: { type: 'session.ready', nativeSessionId: this.nativeSessionId, resumed: this.resumed, model: response.model } });
	}

	startTurn(input: TurnInput): Promise<TurnResult> {
		if (input.images) { validateChatImages(input.images); }
		if (this.turn) { return Promise.reject(new RuntimeError('RUNTIME_TURN_ALREADY_RUNNING')); }
		return new Promise<TurnResult>((resolve, reject) => {
			this.turn = { clientTurnId: input.clientTurnId, output: '', resolve };
			const params: TurnStartParams = {
				threadId: this.nativeSessionId, input: [...textInput(input.text), ...(input.images ?? []).map(image => ({ type: 'image' as const, url: 'data:' + image.mime + ';base64,' + image.data }))], clientUserMessageId: input.clientTurnId,
				approvalPolicy: approvalPolicy(input.role), sandboxPolicy: sandboxPolicy(input.role, [this.options.identity.root, ...(this.options.writableRoots ?? [])], this.fullAccess)
			};
			this.rpc.request<TurnStartResponse>('turn/start', params).then(
				response => { if (this.turn && !this.turn.id) { this.turn.id = response.turn.id; } },
				error => { this.turn = undefined; reject(error); }
			);
		});
	}

	async steer(text: string): Promise<boolean> {
		if (!this.turn?.id) { return false; }
		try {
			await this.rpc.request<TurnSteerResponse>('turn/steer', { threadId: this.nativeSessionId, input: textInput(text), expectedTurnId: this.turn.id });
			return true;
		} catch (error) {
			if (error instanceof ProviderRequestError) { return false; }
			throw error;
		}
	}

	async interrupt(): Promise<void> {
		const turn = this.turn;
		if (!turn) { return; }
		// The process owns every native child; stopping it prevents orphaned subagent work.
		if (this.options.nativeSubagents) {
			this.finishTurn({ status: 'interrupted' }); this.child.stop(); return;
		}
		if (!turn.id) { this.finishTurn({ status: 'interrupted' }); return; }
		try { await this.rpc.request('turn/interrupt', { threadId: this.nativeSessionId, turnId: turn.id }, 10_000); }
		catch {
			// A provider that cannot interrupt is stopped; the thread stays on disk and resumes on the next turn.
			this.child.stop();
		}
	}

	async close(): Promise<void> {
		this.child.stop();
		await this.exited;
	}

	private finishTurn(result: Omit<TurnResult, 'turnId' | 'output'> & { output?: string }): void {
		const turn = this.turn;
		if (!turn) { return; }
		this.turn = undefined;
		// An exhausted plan or throttling is reported as such, so the chat can say when to retry or suggest the other provider.
		const limited = result.error && /usage limit|rate limit|too many requests/i.test(result.error);
		turn.resolve({ turnId: turn.id ?? turn.clientTurnId, output: result.output ?? turn.output, ...(turn.usage ? { usage: turn.usage } : {}), ...result, ...(limited ? { output: result.error, error: 'RUNTIME_RATE_LIMITED' } : {}) });
	}

	private notification(method: string, params: unknown): void {
		const value = (params ?? {}) as Record<string, unknown>;
		const turnId = typeof value.turnId === 'string' ? value.turnId : this.turn?.id;
		// Another thread's traffic (a shared server) is never mixed into this session.
		if (typeof value.threadId === 'string' && this.nativeSessionId && value.threadId !== this.nativeSessionId) { return; }
		switch (method) {
			case 'turn/started': {
				if (this.turn && !this.turn.id) { this.turn.id = turnId; }
				this.host.emit({ turnId, nativeKey: 'turn/started:' + turnId, payload: { type: 'turn.started' } });
				return;
			}
			case 'item/agentMessage/delta': {
				const { itemId, delta } = value as { itemId: string; delta: string };
				// A runaway stream stops growing at the event bound (like the Claude adapter) and says so once.
				const before = this.messages.get(itemId) ?? '';
				if (before.length >= MAX_TEXT_CHARS) { return; }
				const text = (before + delta).slice(0, MAX_TEXT_CHARS);
				this.messages.set(itemId, text);
				this.host.emit({ turnId, payload: { type: 'message.delta', itemId, text } });
				if (text.length >= MAX_TEXT_CHARS) { this.host.emit({ turnId, payload: { type: 'diagnostic', source: 'codex', text: 'message-truncated' } }); }
				return;
			}
			case 'item/commandExecution/outputDelta': {
				const { itemId, delta } = value as { itemId: string; delta: string };
				this.host.emit({ turnId, toolCallId: itemId, payload: { type: 'tool.output', chunk: delta } });
				return;
			}
			case 'item/started': return this.itemStarted(value as unknown as ItemStartedNotification);
			case 'item/completed': return this.itemCompleted(value as unknown as ItemCompletedNotification);
			case 'thread/tokenUsage/updated': {
				const usage = (value as unknown as ThreadTokenUsageUpdatedNotification).tokenUsage.last;
				const reported = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens };
				if (this.turn) { this.turn.usage = reported; }
				this.host.emit({ turnId, payload: { type: 'usage', usage: reported } });
				return;
			}
			case 'error': {
				const { error, willRetry } = value as { error?: { message?: string }; willRetry?: boolean };
				this.host.emit({ turnId, payload: { type: 'diagnostic', source: 'codex', text: (willRetry ? 'retrying: ' : '') + (error?.message ?? 'error') } });
				return;
			}
			case 'turn/completed': {
				const { turn } = value as unknown as TurnCompletedNotification;
				if (this.turn?.id && turn.id !== this.turn.id) { return; }
				const status = turn.status === 'completed' ? 'completed' as const : turn.status === 'interrupted' ? 'interrupted' as const : 'failed' as const;
				this.host.emit({ turnId: turn.id, nativeKey: 'turn/completed:' + turn.id, payload: { type: 'turn.completed', status, output: this.turn?.output ?? '', ...(turn.error ? { error: turn.error.message } : {}) } });
				this.finishTurn({ status, ...(turn.error ? { error: turn.error.message } : {}) });
				return;
			}
			default:
				if (!QUIET_NOTIFICATIONS.has(method)) { this.host.emit({ turnId, payload: { type: 'diagnostic', source: 'codex', text: 'unhandled notification ' + method } }); }
		}
	}

	private itemStarted({ item, turnId }: ItemStartedNotification): void {
		const call = this.callOf(item as unknown as Record<string, unknown>);
		if (call) { this.host.emit({ turnId, toolCallId: item.id, nativeKey: 'item/started:' + item.id, payload: { type: 'tool.started', call } }); }
	}

	private itemCompleted({ item, turnId }: ItemCompletedNotification): void {
		const value = item as unknown as Record<string, unknown>;
		if (item.type === 'agentMessage') {
			const text = typeof value.text === 'string' ? value.text : this.messages.get(item.id) ?? '';
			this.messages.delete(item.id);
			if (this.turn) { this.turn.output = text; }
			this.host.emit({ turnId, nativeKey: 'item/completed:' + item.id, payload: { type: 'message.completed', itemId: item.id, text } });
			return;
		}
		if (!this.callOf(value)) { return; }
		const status = value.status === 'failed' ? 'failed' as const : value.status === 'declined' ? 'declined' as const : 'completed' as const;
		const exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined;
		this.changePaths.delete(item.id);
		this.host.emit({ turnId, toolCallId: item.id, nativeKey: 'item/completed:' + item.id, payload: { type: 'tool.completed', status: exitCode !== undefined && exitCode !== 0 && status === 'completed' ? 'failed' : status, ...(exitCode !== undefined ? { exitCode } : {}) } });
	}

	/** The normalized call of a tool item, or `undefined` for items that are not tools (messages, reasoning). */
	private callOf(item: Record<string, unknown>): ToolCall | undefined {
		switch (item.type) {
			case 'commandExecution': return { kind: 'command', name: 'commandExecution', command: String(item.command ?? ''), cwd: typeof item.cwd === 'string' ? item.cwd : undefined };
			case 'fileChange': {
				const paths = (Array.isArray(item.changes) ? item.changes : []).map(change => (change as { path?: unknown }).path).filter((file): file is string => typeof file === 'string');
				this.changePaths.set(String(item.id), paths);
				return { kind: 'file_change', name: 'fileChange', paths };
			}
			case 'mcpToolCall': return { kind: 'mcp', name: 'mcpToolCall', server: String(item.server ?? ''), tool: String(item.tool ?? '') };
			case 'dynamicToolCall': return { kind: 'other', name: String(item.tool ?? 'dynamicToolCall') };
			case 'webSearch': return { kind: 'web_search', name: 'webSearch', command: typeof item.query === 'string' ? item.query : undefined };
			case 'collabAgentToolCall': return { kind: 'other', name: 'subagents.' + (typeof item.tool === 'string' ? item.tool : 'activity') };
			default: return undefined;
		}
	}

	private async serverRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case 'item/commandExecution/requestApproval': {
				const request = params as CommandExecutionRequestApprovalParams;
				const verdict = await this.host.approve({ kind: 'command', name: 'commandExecution', command: request.command ?? '', ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.reason ? { reason: request.reason } : {}) }, request.turnId);
				// "This session" maps to Codex's own session grant; task and always stay in the IDE (Codex has no equivalent).
				const response: CommandExecutionRequestApprovalResponse = { decision: !verdict.allowed ? 'decline' : verdict.scope === 'session' ? 'acceptForSession' : 'accept' };
				return response;
			}
			case 'item/fileChange/requestApproval': {
				const request = params as FileChangeRequestApprovalParams;
				const call: ToolCall = request.grantRoot
					? { kind: 'permissions', name: 'fileChange.grantRoot', paths: [request.grantRoot], ...(request.reason ? { reason: request.reason } : {}) }
					: { kind: 'file_change', name: 'fileChange', paths: this.changePaths.get(request.itemId) ?? [], ...(request.reason ? { reason: request.reason } : {}) };
				const verdict = await this.host.approve(call, request.turnId);
				const response: FileChangeRequestApprovalResponse = { decision: !verdict.allowed ? 'decline' : verdict.scope === 'session' && !request.grantRoot ? 'acceptForSession' : 'accept' };
				return response;
			}
			case 'item/permissions/requestApproval': {
				const request = params as PermissionsRequestApprovalParams;
				const verdict = await this.host.approve({ kind: 'permissions', name: 'permissions', cwd: request.cwd, reason: request.reason ?? JSON.stringify(request.permissions).slice(0, 500) }, request.turnId);
				// A denial grants nothing; an approval grants exactly what was requested, for this turn only.
				const response: PermissionsRequestApprovalResponse = verdict.allowed
					? { permissions: { ...(request.permissions.network ? { network: request.permissions.network } : {}), ...(request.permissions.fileSystem ? { fileSystem: request.permissions.fileSystem } : {}) }, scope: 'turn' }
					: { permissions: {}, scope: 'turn' };
				return response;
			}
			case 'item/tool/requestUserInput': {
				const request = params as ToolRequestUserInputParams;
				const answers = await this.host.ask(questionsOf(request), request.turnId);
				const response: ToolRequestUserInputResponse = { answers: Object.fromEntries(Object.entries(answers ?? {}).map(([id, values]) => [id, { answers: values }])) };
				return response;
			}
			case 'mcpServer/elicitation/request': {
				// MCP servers other than the IDE's own cannot collect input through the IDE.
				const response: McpServerElicitationRequestResponse = { action: 'decline', content: null, _meta: null };
				return response;
			}
			default:
				// Legacy v1 approvals, dynamic tools, auth refresh and attestation are not offered by this client.
				this.host.emit({ payload: { type: 'diagnostic', source: 'codex', text: 'declined server request ' + method } });
				throw new RuntimeError('RUNTIME_REQUEST_UNSUPPORTED');
		}
	}
}
