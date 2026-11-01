/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Explicitly approved, bounded agent CLI execution. No shell, no bypass-permissions modes. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveNativeCommand, stopProcess } from './native-runtime.ts';
import { captureAgentScope, scopeChanged } from './native-agent-scope.ts';
import { parseProviderOutput, ClaudeEventAccumulator, CodexEventAccumulator, type ProviderUsage } from './native-provider-output.ts';
import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from './native-redact.ts';
import { currentToolchainEnvironment } from './native-toolchain-env.ts';
import { agentContract, RUN_MINUTES } from './native-agent-contract.ts';
import { reviewAgentDraft, validateReviewedAgent, type AgentDraft, type AgentReview } from './native-providers.ts';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_RETAINED = 512 * 1024;
const MAX_STDERR_RETAINED = 64 * 1024;
const MAX_DURATION_MS = RUN_MINUTES * 60 * 1000;
/** Conversation and review turns are read-only and short; implementers get `atsHarness.implementerMaxTurns`. */
const READ_ONLY_MAX_TURNS = 12;
export interface AgentInvocation {
	executable: 'codex' | 'claude';
	args: string[];
	stdin: string;
}
export interface AgentOutcome {
	status: 'passed' | 'failed' | 'cancelled' | 'timeout';
	exitCode: number | null;
	durationMs: number;
	output: string;
	truncated: boolean;
	scopeViolation?: boolean;
	scopeVerified?: boolean;
	/** Folders the sensitive-file scan could not analyze (too large or deep); empty or absent when fully scanned. */
	scopeUnscanned?: string[];
	usage?: ProviderUsage;
	structuredOutput?: boolean;
	rateLimited?: true;
	/** The provider used its whole turn budget: the run is incomplete and can be continued. */
	stopReason?: 'max-turns';
	/** Provider session that a continuation can resume (Claude only). */
	sessionId?: string;
	/** Redacted web search queries of the run (decision D9), for the report. */
	searches?: string[];
	/** A web search query carried a secret: the run was stopped (EC-145). The query already reached the provider's search engine. */
	searchLeak?: true;
}
export interface AgentExecution {
	outcome: Promise<AgentOutcome>;
	cancel(): void;
}
/** Non-content progress: never contains tokens, credentials or provider output. */
export interface AgentProgress {
	observedBytes: number;
	at: string;
}

/** How the provider starts the IDE's command tool server for one run (block A). */
export interface ToolServerLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	/** Claude `--mcp-config` file holding the same launch. */
	mcpConfigFile: string;
}
/** Every tool of the IDE's own server (commands and editor), and no other MCP server. */
const RUNNER_TOOL = 'mcp__ats-runner';
/** TOML basic string; JSON escaping is a valid subset for paths and arguments. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * `writableRoots` are toolchain caches a Codex writer may also write to (block B); readers never get them.
 * `toolServer` gives a writer the `ats-runner` command tool; Claude's own shell stays disallowed.
 */
export function buildAgentInvocation(draft: AgentDraft, writableRoots: readonly string[] = [], toolServer?: ToolServerLaunch): AgentInvocation {
	reviewAgentDraft(draft);
	if (draft.role !== 'implementer' && !draft.readOnly) { throw Error('HARNESS_READ_ONLY_ROLE_REQUIRED'); }
	if (draft.role === 'implementer' && draft.readOnly) { throw Error('HARNESS_IMPLEMENTER_MODE_MISMATCH'); }
	const runner = !draft.readOnly && !!toolServer;
	const instruction = agentContract({ provider: draft.provider, role: draft.role, maxTurns: draft.maxTurns, runner, webSearch: draft.webSearch }) + '\n\n' + draft.instruction;
	const model = draft.model ? ['--model', draft.model] : [];
	// Keep effort as a reviewed, per-invocation override. Never modify CLI config files.
	const effort = draft.effort ? draft.provider === 'codex'
		? ['--config', 'model_reasoning_effort="' + draft.effort + '"']
		: ['--effort', draft.effort] : [];
	if (draft.provider === 'codex') {
		const caches = draft.readOnly ? [] : writableRoots.flatMap(root => ['--add-dir', root]);
		// Codex's native search tool; it is off unless the project enabled web search (D9).
		const search = draft.webSearch ? ['--config', 'tools.web_search=true'] : [];
		// Codex keeps its sandboxed shell (D1) and also gets the runner as the recommended path.
		const server = runner ? ['--config', 'mcp_servers.ats-runner.command=' + toml(toolServer!.command), '--config', 'mcp_servers.ats-runner.args=[' + toolServer!.args.map(toml).join(',') + ']',
			'--config', 'mcp_servers.ats-runner.env={' + Object.entries(toolServer!.env).map(([key, value]) => key + '=' + toml(value)).join(',') + '}'] : [];
		return {
			executable: 'codex',
			// The approval flag is global and must precede the exec subcommand on current Codex CLIs.
			args: ['--ask-for-approval', 'never', ...effort, ...search, ...server, 'exec', ...model, '--sandbox', draft.readOnly ? 'read-only' : 'workspace-write', ...caches, '--skip-git-repo-check', '--ephemeral', '--json', '-'],
			stdin: instruction
		};
	}
	// dontAsk denies tools that are not explicitly allowed, rather than silently bypassing permissions.
	// plan mode is strictly read-only; don'tAsk is fail-closed if required tools lack an allow rule.
	// stream-json (which requires --verbose in print mode) reports each assistant message as it is produced.
	// A resumed session already holds the scoped preamble; its stdin is only the continuation request.
	const resume = draft.resumeSession ? ['--resume', draft.resumeSession] : [];
	// Only the IDE's server: `--strict-mcp-config` ignores user and project MCP configuration.
	const server = runner ? ['--mcp-config', toolServer!.mcpConfigFile, '--strict-mcp-config'] : [];
	// WebFetch is never allowed; WebSearch only when the project enabled it (D9).
	const tools = (draft.readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write' + (runner ? ',' + RUNNER_TOOL : '')) + (draft.webSearch ? ',WebSearch' : '');
	const denied = draft.webSearch ? 'Bash,WebFetch' : 'Bash,WebFetch,WebSearch';
	return {
		executable: 'claude',
		args: ['--print', ...resume, ...model, ...effort, ...server, '--permission-mode', draft.readOnly ? 'plan' : 'dontAsk', '--allowedTools', tools, '--disallowedTools', denied, '--max-turns', String(draft.maxTurns ?? READ_ONLY_MAX_TURNS), '--output-format', 'stream-json', '--verbose'],
		stdin: draft.resumeSession ? draft.instruction : instruction
	};
}

/**
 * Caller MUST verify Workspace Trust, project authority and consent immediately before invoking.
 * `onMessage` receives redacted intermediate assistant messages as the provider streams them (Codex JSONL, Claude stream-json).
 */
export async function executeReviewedAgent(review: AgentReview, current: AgentDraft, durationMs = MAX_DURATION_MS, onProgress?: (progress: Readonly<AgentProgress>) => void, onMessage?: (text: string) => void, toolServer?: ToolServerLaunch, sensitive?: (text: string) => boolean): Promise<AgentExecution> {
	validateReviewedAgent(review, current);
	if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) { throw Error('HARNESS_AGENT_TIMEOUT_INVALID'); }
	const canonical = await fs.realpath(current.projectRoot);
	if (canonical !== current.projectRoot || !(await fs.stat(canonical)).isDirectory()) { throw Error('HARNESS_AGENT_ROOT_CHANGED'); }
	const toolchain = await currentToolchainEnvironment();
	const invocation = buildAgentInvocation(current, toolchain.writableRoots, toolServer);
	const initialScope = current.readOnly ? await captureAgentScope(canonical) : undefined;
	const command = await resolveNativeCommand(invocation.executable, invocation.args);
	const env: NodeJS.ProcessEnv = toolchain.env;
	if (command.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	if (current.provider === 'claude') { env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'; }
	const started = Date.now();
	let cancelled = false, timedOut = false, truncated = false;
	let stdout = '', stderr = '', size = 0;
	let lastProgress = 0;
	let stdoutOverflow = false;
	let searchLeak = false;
	const observe = onMessage && ((text: string) => onMessage(redactSecrets(text)));
	// A query is checked as soon as it is reported: the run stops, but what was sent cannot be recalled (EC-145).
	const leaks = (query: string): boolean => redactSecrets(query) !== query || !!sensitive?.(query);
	const onSearch = (query: string): void => { if (!searchLeak && leaks(query)) { searchLeak = true; cancel(); } };
	const events = current.provider === 'codex' ? new CodexEventAccumulator(observe, onSearch) : new ClaudeEventAccumulator(observe, onSearch);
	const stdoutDecoder = new StringDecoder('utf8');
	const child = spawn(command.executable, command.args, {
		cwd: canonical, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const cancel = (): void => { cancelled = true; stopProcess(child); };
	const collect = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
		size += chunk.length;
		if (size > MAX_OUTPUT_BYTES) { truncated = true; cancel(); return; }
		if (size - lastProgress >= 8192) {
			lastProgress = size;
			try { onProgress?.(Object.freeze({ observedBytes: size, at: new Date().toISOString() })); }
			catch { /* Observers have no authority over process execution. */ }
		}
		if (channel === 'stdout') {
			const piece = stdoutDecoder.write(chunk);
			events.push(piece);
			if (stdout.length + piece.length <= MAX_STDOUT_RETAINED) { stdout += piece; }
			else { stdoutOverflow = true; }
		} else if (stderr.length < MAX_STDERR_RETAINED) {
			stderr += chunk.toString('utf8').slice(0, MAX_STDERR_RETAINED - stderr.length);
		}
	};
	child.stdout?.on('data', chunk => collect(chunk, 'stdout'));
	child.stderr?.on('data', chunk => collect(chunk, 'stderr'));
	const outcome = new Promise<AgentOutcome>(resolve => {
		const timer = setTimeout(() => { timedOut = true; cancel(); }, durationMs);
		timer.unref();
		let ended = false;
		const finish = (exitCode: number | null): void => {
			if (ended) { return; }
			ended = true; clearTimeout(timer);
			void (async () => {
				const tail = stdoutDecoder.end();
				if (tail) { events.push(tail); if (!stdoutOverflow && stdout.length + tail.length <= MAX_STDOUT_RETAINED) { stdout += tail; } }
				const parsed = events.finish() || parseProviderOutput(current.provider, stdout);
				if (stdoutOverflow && !parsed.structured) { truncated = true; }
				// Claude exits non-zero when it runs out of turns; that is reported through `stopReason`, not as passed.
				let status: AgentOutcome['status'] = searchLeak ? 'failed' : timedOut ? 'timeout' : cancelled ? 'cancelled' : exitCode === 0 && !parsed.providerError && !parsed.stopReason && !truncated ? 'passed' : 'failed';
				let scopeViolation = false;
				let scopeVerified = false;
				let scopeUnscanned: string[] | undefined;
				if (initialScope) {
					try {
						const finalScope = await captureAgentScope(canonical);
						scopeViolation = scopeChanged(initialScope, finalScope);
						scopeVerified = initialScope.source === 'git' && finalScope.source === 'git';
						scopeUnscanned = [...new Set([...initialScope.unscanned, ...finalScope.unscanned])].sort();
						if (scopeViolation) { status = 'failed'; }
					} catch {
						// Fail closed: a reader that cannot be checked is never reported as successful.
						status = 'failed';
					}
				}
				resolve({
					status, exitCode, durationMs: Date.now() - started, truncated,
					output: redactSecrets(parsed.structured ? parsed.message : stdout + (stderr ? '\n' + stderr : '')),
					scopeViolation, scopeVerified, ...(scopeUnscanned?.length ? { scopeUnscanned } : {}), structuredOutput: parsed.structured, usage: parsed.usage,
					...(parsed.rateLimited ? { rateLimited: true as const } : {}),
					...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
					...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
					...(parsed.searches?.length ? { searches: parsed.searches.map(redactSecrets) } : {}),
					...(searchLeak ? { searchLeak: true as const } : {})
				});
			})();
		};
		child.once('error', () => finish(null));
		child.once('close', finish);
	});
	child.stdin?.on('error', () => { /* The provider may exit before consuming the prompt. */ });
	child.stdin?.end(invocation.stdin);
	return { cancel, outcome };
}
