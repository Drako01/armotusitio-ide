/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Claude adapter (route A: the installed CLI, no Agent SDK). One `claude --print --input-format stream-json` process keeps
 * the session open across turns; each user message is one stdin line and each turn ends with a `result` event. A new
 * session gets an id chosen by the IDE (`--session-id`), so it is journaled before the first turn; an IDE restart resumes
 * it with `--resume`. Permission prompts and `AskUserQuestion` go to the IDE through `--permission-prompt-tool` (the
 * `ats-runner` approve tool), never to a bypass mode. Interrupting stops the process; the session stays on disk and the
 * next turn resumes it.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { claudeToolArgs } from '../native-agent-execution.ts';
import { ClaudeEventAccumulator, validSessionId } from '../native-provider-output.ts';
import { resolveNativeCommand } from '../native-runtime.ts';
import { RuntimeError, type AdapterHost, type AgentAdapter, type AgentConnection, type RuntimeCapabilities, type SessionOpenOptions, type ToolCall, type TurnInput, type TurnResult } from './contracts.ts';
import { ProviderRequestError } from './json-rpc.ts';
import { startProviderProcess, type ProviderProcess } from './provider-process.ts';

const run = promisify(execFile);
/** Same bound as the one-shot transport: a session never takes more than this many agent turns per user message. */
const DEFAULT_MAX_TURNS = 40;
const MAX_LINE = 4 * 1024 * 1024;
/** How long a CLI process must stay up before the first message is written; a refused resume takes longer to report. */
const STARTUP_GRACE_MS = 300;
const RESUME_GRACE_MS = 2500;
const RUNNER = 'mcp__ats-runner';

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

/** The normalized call of one Claude `tool_use` block. */
export function claudeToolCall(name: string, input: Record<string, unknown>): ToolCall {
	if (name === 'Bash') { return { kind: 'command', name, command: typeof input.command === 'string' ? input.command : '' }; }
	if (FILE_TOOLS.has(name)) { return { kind: 'file_change', name, paths: [input.file_path ?? input.notebook_path].filter((file): file is string => typeof file === 'string') }; }
	if (READ_TOOLS.has(name)) { return { kind: 'read', name, paths: [input.file_path ?? input.path ?? input.pattern].filter((file): file is string => typeof file === 'string') }; }
	if (name === 'WebSearch') { return { kind: 'web_search', name, command: typeof input.query === 'string' ? input.query : '' }; }
	if (name === 'AskUserQuestion') { return { kind: 'question', name }; }
	const mcp = /^mcp__(?<server>[^_]+(?:-[^_]+)*)__(?<tool>.+)$/.exec(name);
	if (mcp) { return { kind: 'mcp', name, server: mcp.groups!.server, tool: mcp.groups!.tool }; }
	return { kind: 'other', name };
}

export class ClaudeAdapter implements AgentAdapter {
	readonly provider = 'claude' as const;

	async capabilities(env: NodeJS.ProcessEnv): Promise<RuntimeCapabilities> {
		const command = await resolveNativeCommand('claude', ['--help'], env);
		const childEnv = command.embeddedNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
		const [help, version] = await Promise.all([
			run(command.executable, command.args, { env: childEnv, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).then(result => result.stdout),
			run(command.executable, [...command.args.slice(0, -1), '--version'], { env: childEnv, windowsHide: true, timeout: 20_000 }).then(result => result.stdout.trim().split(' ')[0])
		]);
		// Every flag the session relies on must be documented by the installed CLI; nothing is assumed.
		const required = ['--input-format', '--session-id', '--resume', '--permission-prompt-tool', '--permission-prompts', '--include-partial-messages'];
		const missing = required.filter(flag => !help.includes(flag));
		return {
			provider: 'claude', version, transport: 'stream-json', compatible: !missing.length,
			...(missing.length ? { incompatibility: 'Claude Code ' + version + ' no ofrece ' + missing.join(', ') + '.' } : {}),
			features: {
				session: 'supported', streaming: 'supported', resume: 'supported', fork: help.includes('--fork-session') ? 'supported' : 'unavailable',
				interrupt: 'supported', steer: 'unavailable', approvals: 'supported', questions: 'supported', commandOutput: 'unavailable', mcp: 'supported', usage: 'supported'
			}
		};
	}

	async open(options: SessionOpenOptions, host: AdapterHost): Promise<AgentConnection> {
		const connection = new ClaudeConnection(options, host);
		await connection.start();
		return connection;
	}
}

interface ActiveTurn {
	clientTurnId: string;
	resolve(result: TurnResult): void;
	accumulator: ClaudeEventAccumulator;
	itemId: string;
	partial: string;
	interrupted: boolean;
}

class ClaudeConnection implements AgentConnection {
	nativeSessionId: string;
	readonly resumed: boolean;
	private process?: ProviderProcess;
	private readonly options: SessionOpenOptions;
	private readonly host: AdapterHost;
	private turn?: ActiveTurn;
	private buffer = '';
	private decoder = new StringDecoder('utf8');
	private messages = 0;
	private closed = false;
	/** The CLI reported the session id: it is stored and `--resume` can find it. */
	private persisted = false;
	/** The first process of a fork reports the new id; later processes resume that id. */
	private forking: boolean;
	private exitedResolve!: (exit: { code: number | null; expected: boolean }) => void;
	readonly exited = new Promise<{ code: number | null; expected: boolean }>(resolve => { this.exitedResolve = resolve; });

	constructor(options: SessionOpenOptions, host: AdapterHost) {
		this.options = options; this.host = host;
		this.forking = !!(options.resume && options.fork);
		this.resumed = !!options.resume && !options.fork;
		this.nativeSessionId = options.resume && !options.fork ? options.resume : options.fork ? '' : randomUUID();
		if (options.resume && !validSessionId(options.resume)) { throw new RuntimeError('RUNTIME_SESSION_ID_INVALID'); }
	}

	/** Spawn the CLI for this session; a stopped process (interrupt, crash) is replaced on the next turn. */
	async start(): Promise<void> {
		const options = this.options;
		const writer = options.role === 'writer';
		const runner = !!options.toolServer;
		// A session exists on disk once the CLI reported it; until then a replacement process starts it again with the same id.
		const fresh = !options.resume && !this.persisted;
		const identity = this.forking ? ['--resume', options.resume!, '--fork-session'] : fresh ? ['--session-id', this.nativeSessionId] : ['--resume', this.nativeSessionId];
		const args = [
			'--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...identity,
			...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', options.effort] : []),
			...(runner ? ['--mcp-config', options.toolServer!.mcpConfigFile, '--strict-mcp-config'] : []),
			// No user, project or local Claude settings: their allow rules would approve tools without the IDE ever being asked.
			'--setting-sources', '',
			// Questions and permission prompts reach the IDE in both roles; a conversation still cannot edit or run commands.
			...(runner ? ['--permission-prompts', 'host', '--permission-prompt-tool', RUNNER + '__approve'] : []),
			...claudeToolArgs({ readOnly: !writer, runner, native: writer && runner, webSearch: options.webSearch }),
			'--max-turns', String(options.maxTurns ?? DEFAULT_MAX_TURNS),
			// The appended system prompt is not part of the stored transcript: every process of the session gets it again.
			...(options.instructions ? ['--append-system-prompt', options.instructions] : [])
		];
		// A native session must be stored by the CLI to be resumable, so prompt history is not skipped here (r7 one-shot runs still skip it).
		const env: NodeJS.ProcessEnv = { ...options.env };
		const child = await startProviderProcess('claude', args, options.identity.root, env);
		this.process = child;
		this.buffer = ''; this.decoder = new StringDecoder('utf8');
		child.child.stdout.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
		void child.exited.then(exit => this.processExited(child, exit));
		// The CLI prints nothing until the first message, so a process that dies right away (bad flags, missing session, auth)
		// is caught here, before any input is written: the start can be retried without risking a duplicated turn.
		const early = await Promise.race([child.exited.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), fresh ? STARTUP_GRACE_MS : RESUME_GRACE_MS).unref())]);
		if (early) {
			const stderr = child.stderr();
			// A CLI that explains itself (unknown session, authentication) is not retried; a silent death is, once.
			throw stderr.trim() ? new ProviderRequestError(1, stderr.trim().slice(-300)) : new RuntimeError('RUNTIME_START_FAILED', true);
		}
		if (!this.forking) { this.host.emit({ payload: { type: 'session.ready', nativeSessionId: this.nativeSessionId, resumed: !fresh, ...(options.model ? { model: options.model } : {}) } }); }
	}

	async startTurn(input: TurnInput): Promise<TurnResult> {
		if (this.closed) { throw new RuntimeError('RUNTIME_CONNECTION_CLOSED'); }
		if (this.turn) { throw new RuntimeError('RUNTIME_TURN_ALREADY_RUNNING'); }
		if (!this.process) { await this.start(); }
		const child = this.process!;
		return new Promise<TurnResult>(resolve => {
			this.turn = {
				clientTurnId: input.clientTurnId, resolve, itemId: 'm' + ++this.messages, partial: '', interrupted: false,
				accumulator: new ClaudeEventAccumulator(undefined, undefined, undefined)
			};
			this.host.emit({ turnId: input.clientTurnId, payload: { type: 'turn.started' } });
			const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input.text }] }, parent_tool_use_id: null, session_id: this.nativeSessionId || undefined });
			child.child.stdin.write(line + '\n');
		});
	}

	async interrupt(): Promise<void> {
		if (!this.turn || !this.process) { return; }
		this.turn.interrupted = true;
		this.process.stop();
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.process;
		if (!child) { this.exitedResolve({ code: null, expected: true }); return; }
		child.child.stdin.end();
		child.stop();
		await child.exited;
	}

	private processExited(child: ProviderProcess, exit: { code: number | null; expected: boolean }): void {
		if (this.process !== child) { return; }
		this.process = undefined;
		const turn = this.turn;
		if (turn) {
			this.turn = undefined;
			const status = turn.interrupted ? 'interrupted' as const : 'failed' as const;
			const error = turn.interrupted ? undefined : 'RUNTIME_CONNECTION_LOST';
			const stderr = child.stderr().trim();
			if (!turn.interrupted && stderr) { this.host.emit({ turnId: turn.clientTurnId, payload: { type: 'diagnostic', source: 'claude', text: stderr.slice(-500) } }); }
			this.host.emit({ turnId: turn.clientTurnId, payload: { type: 'turn.completed', status, output: turn.partial, ...(error ? { error } : {}) } });
			turn.resolve({ turnId: turn.clientTurnId, status, output: turn.partial, ...(error ? { error } : {}) });
		}
		// Only an explicit close ends the connection; an interrupted or crashed process is replaced on the next turn.
		if (this.closed) { this.exitedResolve(exit); }
	}

	private receive(text: string): void {
		this.buffer += text;
		if (this.buffer.length > MAX_LINE && this.buffer.indexOf('\n') === -1) {
			this.host.emit({ payload: { type: 'diagnostic', source: 'claude', text: 'line-too-long' } });
			this.buffer = '';
			return;
		}
		let boundary = this.buffer.indexOf('\n');
		while (boundary !== -1) {
			const line = this.buffer.slice(0, boundary).trim();
			this.buffer = this.buffer.slice(boundary + 1);
			if (line) { this.line(line); }
			boundary = this.buffer.indexOf('\n');
		}
	}

	private line(line: string): void {
		let event: Record<string, unknown>;
		try { event = JSON.parse(line); }
		catch { this.host.emit({ payload: { type: 'diagnostic', source: 'claude', text: 'invalid-json: ' + line.slice(0, 200) } }); return; }
		if (!event || typeof event !== 'object') { return; }
		if (validSessionId(event.session_id) && !this.forking) { this.persisted = true; }
		if (this.forking && validSessionId(event.session_id)) {
			this.persisted = true;
			this.forking = false;
			this.nativeSessionId = event.session_id;
			this.host.emit({ payload: { type: 'session.ready', nativeSessionId: this.nativeSessionId, resumed: false } });
		}
		const turn = this.turn;
		if (!turn) { return; }
		turn.accumulator.push(line + '\n');
		const turnId = turn.clientTurnId;
		switch (event.type) {
			case 'stream_event': {
				const inner = (event.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
				if (inner.type === 'message_start') { turn.itemId = 'm' + ++this.messages; turn.partial = ''; }
				if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
					turn.partial += inner.delta.text;
					this.host.emit({ turnId, payload: { type: 'message.delta', itemId: turn.itemId, text: turn.partial } });
				}
				return;
			}
			case 'assistant': {
				const blocks = ((event.message as { content?: unknown })?.content ?? []) as Array<Record<string, unknown>>;
				if (!Array.isArray(blocks)) { return; }
				const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n');
				if (text.trim()) { this.host.emit({ turnId, payload: { type: 'message.completed', itemId: turn.itemId, text } }); }
				for (const block of blocks) {
					if (block?.type !== 'tool_use' || typeof block.id !== 'string') { continue; }
					const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
					this.host.emit({ turnId, toolCallId: block.id, nativeKey: 'tool_use:' + block.id, payload: { type: 'tool.started', call: claudeToolCall(String(block.name ?? ''), input) } });
				}
				return;
			}
			case 'user': {
				const blocks = ((event.message as { content?: unknown })?.content ?? []) as Array<Record<string, unknown>>;
				if (!Array.isArray(blocks)) { return; }
				for (const block of blocks) {
					if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') { continue; }
					const failed = block.is_error === true;
					const detail = failed ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')).split('\n', 1)[0].slice(0, 300) : undefined;
					this.host.emit({ turnId, toolCallId: block.tool_use_id, nativeKey: 'tool_result:' + block.tool_use_id, payload: { type: 'tool.completed', status: failed ? 'failed' : 'completed', ...(detail ? { detail } : {}) } });
				}
				return;
			}
			case 'result': {
				const parsed = turn.accumulator.finish();
				const maxTurns = parsed?.stopReason === 'max-turns';
				const failed = !parsed || (parsed.providerError && !maxTurns);
				const output = parsed?.message ?? '';
				this.turn = undefined;
				const result: TurnResult = {
					turnId, status: failed ? 'failed' : 'completed', output, ...(failed ? { error: parsed?.rateLimited ? 'RUNTIME_RATE_LIMITED' : 'RUNTIME_PROVIDER_ERROR' } : {}),
					...(parsed?.usage ? { usage: parsed.usage } : {}), ...(parsed?.quota ? { quota: parsed.quota } : {}), ...(maxTurns ? { stopReason: 'max-turns' as const } : {})
				};
				if (parsed?.usage || parsed?.quota) { this.host.emit({ turnId, payload: { type: 'usage', ...(parsed.usage ? { usage: parsed.usage } : {}), ...(parsed.quota ? { quota: parsed.quota } : {}) } }); }
				this.host.emit({ turnId, payload: { type: 'turn.completed', status: result.status, output, ...(result.error ? { error: result.error } : {}), ...(maxTurns ? { stopReason: 'max-turns' as const } : {}) } });
				turn.resolve(result);
				return;
			}
			default:
				return;
		}
	}
}
