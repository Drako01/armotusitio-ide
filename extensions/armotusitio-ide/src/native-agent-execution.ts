/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Explicitly approved, bounded agent CLI execution. No shell, no bypass-permissions modes. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveNativeCommand, stopProcess } from './native-runtime.ts';
import { captureAgentScope, scopeChanged } from './native-agent-scope.ts';
import { parseProviderOutput, ClaudeEventAccumulator, CodexEventAccumulator, type ProviderUsage } from './native-provider-output.ts';
import type { ProviderQuota } from './native-quota.ts';
import type { ChatStep } from './native-run-steps.ts';
import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from './native-redact.ts';
import { currentToolchainEnvironment } from './native-toolchain-env.ts';
import { codexSandbox } from './native-codex-sandbox.ts';
import { readonlyCodexSubagentOverrides } from './native-codex-subagents.ts';
import { agentContract, RUN_MINUTES } from './native-agent-contract.ts';
import { reviewAgentDraft, validateReviewedAgent, type AgentDraft, type AgentReview } from './native-providers.ts';
import { APPROVAL_TIMEOUT_MS } from './native-approval.ts';

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
	/** Usage windows (session, weekly) the provider reported during the run. */
	quota?: ProviderQuota;
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
	/** The server also offers branch creation, commit/push and PR upsert (chat runs with IDE approval). */
	git?: boolean;
	/** The server also offers delete_path and move_path (chat runs with IDE approval). */
	files?: boolean;
	/** Native transport pilot (Claude): the server offers `approve`, and Claude's prompts go to it instead of being denied. */
	approve?: boolean;
}
/** Every tool of the IDE's own server (commands and editor), and no other MCP server. */
const RUNNER_TOOL = 'mcp__ats-runner';
/** TOML basic string; JSON escaping is a valid subset for paths and arguments. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * `writableRoots` are toolchain caches a Codex writer may also write to (block B); readers never get them.
 * `toolServer` gives a writer the `ats-runner` command tool; Claude's own shell stays disallowed.
 */
export function buildAgentInvocation(draft: AgentDraft, writableRoots: readonly string[] = [], toolServer?: ToolServerLaunch, isolatedReadOnly = false): AgentInvocation {
	if (isolatedReadOnly && (draft.provider !== 'claude' || !draft.readOnly || draft.role === 'implementer' || draft.resumeSession || draft.webSearch || toolServer)) { throw Error('HARNESS_DELEGATION_ISOLATION_UNSUPPORTED'); }
	reviewAgentDraft(draft);
	if (draft.role !== 'implementer' && !draft.readOnly) { throw Error('HARNESS_READ_ONLY_ROLE_REQUIRED'); }
	if (draft.role === 'implementer' && draft.readOnly) { throw Error('HARNESS_IMPLEMENTER_MODE_MISMATCH'); }
	const runner = !draft.readOnly && !!toolServer;
	// Native transport pilot: Claude keeps Bash, Edit and Write, and each permission prompt is answered by the IDE's `approve` tool.
	const native = runner && draft.provider === 'claude' && !!toolServer?.approve;
	const instruction = (isolatedReadOnly ? 'This child has no tools. Analyze only the context supplied below; do not claim to inspect files, run tests or delegate.\n\n' : agentContract({ provider: draft.provider, role: draft.role, maxTurns: draft.maxTurns, runner, webSearch: draft.webSearch, git: runner && !!toolServer?.git, files: runner && !!toolServer?.files, nativeShell: native }) + '\n\n') + draft.instruction;
	const model = draft.model ? ['--model', draft.model] : [];
	// Keep effort as a reviewed, per-invocation override. Never modify CLI config files.
	const effort = draft.effort ? draft.provider === 'codex'
		? ['--config', 'model_reasoning_effort="' + draft.effort + '"']
		: ['--effort', draft.effort] : [];
	if (draft.provider === 'codex') {
		// Native children inherit the parent's read-only sandbox and never receive independent grants.
		// A single parent process owns their lifetime and usage; the limit is per approved review.
		const nativeSubagents = readonlyCodexSubagentOverrides(draft.nativeSubagents === true);
		const sandbox = draft.readOnly ? 'read-only' : codexSandbox();
		const caches = sandbox === 'workspace-write' ? writableRoots.flatMap(root => ['--add-dir', root]) : [];
		// Codex's native search tool; it is off unless the project enabled web search (D9).
		const search = draft.webSearch ? ['--config', 'tools.web_search=true'] : [];
		// Codex keeps its sandboxed shell (D1) and also gets the runner as the recommended path. Under `--ask-for-approval never`
		// Codex cancels MCP tool calls that need approval, so the runner is pre-approved: its own policy floor still decides every command.
		const server = runner ? ['--config', 'mcp_servers.ats-runner.default_tools_approval_mode="approve"', '--config', 'mcp_servers.ats-runner.tool_timeout_sec=' + String(Math.ceil(APPROVAL_TIMEOUT_MS / 1000) + MAX_DURATION_MS / 1000 + 60), '--config', 'mcp_servers.ats-runner.command=' + toml(toolServer!.command), '--config', 'mcp_servers.ats-runner.args=[' + toolServer!.args.map(toml).join(',') + ']',
			'--config', 'mcp_servers.ats-runner.env={' + Object.entries(toolServer!.env).map(([key, value]) => key + '=' + toml(value)).join(',') + '}'] : [];
		return {
			executable: 'codex',
			// The approval flag is global and must precede the exec subcommand on current Codex CLIs.
			args: ['--ask-for-approval', 'never', ...effort, ...search, ...nativeSubagents, ...server, 'exec', ...model, '--sandbox', sandbox, ...caches, '--skip-git-repo-check', '--ephemeral', '--json', '-'],
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
	const prompts = native ? ['--permission-prompts', 'host', '--permission-prompt-tool', RUNNER_TOOL + '__approve'] : [];
	return {
		executable: 'claude',
		args: ['--print', ...resume, ...model, ...effort, ...server, ...prompts, ...claudeToolArgs({ readOnly: draft.readOnly, runner, native, webSearch: draft.webSearch }),
			...(isolatedReadOnly ? ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : []),
			'--max-turns', String(draft.maxTurns ?? READ_ONLY_MAX_TURNS), '--output-format', 'stream-json', '--verbose'],
		stdin: draft.resumeSession ? draft.instruction : instruction
	};
}

/**
 * Claude Code approves shell commands it judges read-only (`docker ps`, `cat .env`) without consulting the permission prompt tool.
 * An `ask` rule outranks that heuristic, so every shell call reaches the IDE policy. Passed inline: user, project and local settings stay off.
 */
const MEDIATE_SHELL_SETTINGS = JSON.stringify({ permissions: { ask: ['Bash'] } });

/**
 * Claude's permission mode and tool lists, shared by one-shot runs and native sessions (r8). WebFetch is denied outright except in native sessions, where it asks per host;
 * WebSearch only when the project enabled it (D9). Native: Bash, Edit and Write are not pre-allowed, so every use reaches
 * the IDE's `approve` tool, which also answers `AskUserQuestion` through the IDE's card.
 */
export function claudeToolArgs(options: { readOnly: boolean; runner: boolean; native: boolean; webSearch?: boolean }): string[] {
	const { readOnly, runner, native, webSearch } = options;
	const tools = (readOnly ? 'Read,Glob,Grep' : native ? 'Read,Glob,Grep,' + RUNNER_TOOL : 'Read,Glob,Grep,Edit,Write' + (runner ? ',' + RUNNER_TOOL : '')) + (webSearch ? ',WebSearch' : '');
	// Native: WebFetch reaches `approve` (a card per host, public https hosts only); the structured transport still denies it.
	const denied = native ? (webSearch ? '' : 'WebSearch') : 'Bash,' + (webSearch ? 'WebFetch' : 'WebFetch,WebSearch');
	const mode = readOnly ? 'plan' : native ? 'default' : 'dontAsk';
	return ['--permission-mode', mode, '--allowedTools', tools, ...(denied ? ['--disallowedTools', denied] : []), ...(native ? ['--settings', MEDIATE_SHELL_SETTINGS] : [])];
}

/**
 * Caller MUST verify Workspace Trust, project authority and consent immediately before invoking.
 * `onMessage` receives redacted intermediate assistant messages as the provider streams them (Codex JSONL, Claude stream-json).
 */
export async function executeReviewedAgent(review: AgentReview, current: AgentDraft, durationMs = MAX_DURATION_MS, onProgress?: (progress: Readonly<AgentProgress>) => void, onMessage?: (text: string) => void, toolServer?: ToolServerLaunch, sensitive?: (text: string) => boolean, onStep?: (step: ChatStep) => void, profileEnvironment?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv, isolatedReadOnly = false): Promise<AgentExecution> {
	validateReviewedAgent(review, current);
	if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) { throw Error('HARNESS_AGENT_TIMEOUT_INVALID'); }
	const canonical = await fs.realpath(current.projectRoot);
	if (canonical !== current.projectRoot || !(await fs.stat(canonical)).isDirectory()) { throw Error('HARNESS_AGENT_ROOT_CHANGED'); }
	const toolchain = await currentToolchainEnvironment();
	// An AI profile replaces the provider credentials of the IDE environment with its own private directory.
	const base = profileEnvironment ? profileEnvironment(toolchain.env) : toolchain.env;
	const invocation = buildAgentInvocation(current, toolchain.writableRoots, toolServer, isolatedReadOnly);
	if (isolatedReadOnly) {
		const probe = await resolveNativeCommand(current.provider, ['--help'], base);
		const { stdout } = await promisify(execFile)(probe.executable, probe.args, { env: { ...base, ...(probe.embeddedNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
		if (!['--tools', '--setting-sources', '--strict-mcp-config', '--mcp-config'].every(flag => stdout.includes(flag))) { throw Error('HARNESS_DELEGATION_ISOLATION_UNSUPPORTED'); }
	}
	const initialScope = current.readOnly ? await captureAgentScope(canonical) : undefined;
	// Native child sessions cannot claim read-only isolation if the Git baseline
	// or the sensitive-file scan is incomplete. Deny before starting Codex.
	if (current.nativeSubagents && (initialScope?.source !== 'git' || initialScope.unscanned.length !== 0)) {
		throw Error('HARNESS_DELEGATION_ISOLATION_UNSUPPORTED');
	}
	const command = await resolveNativeCommand(invocation.executable, invocation.args, base);
	const env: NodeJS.ProcessEnv = base;
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
	const stepSink = onStep && { root: canonical, emit: onStep };
	const events = current.provider === 'codex' ? new CodexEventAccumulator(observe, onSearch, stepSink) : new ClaudeEventAccumulator(observe, onSearch, stepSink);
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
				// A parent with native child threads needs an auditable scope and
				// provider usage to report success; parent usage alone is not a
				// per-child cost receipt (strict budgets remain disabled).
				if (current.nativeSubagents && (!scopeVerified || !!scopeUnscanned?.length || !parsed.structured || !parsed.usage)) {
					status = 'failed';
				}
				resolve({
					status, exitCode, durationMs: Date.now() - started, truncated,
					output: redactSecrets(parsed.structured ? parsed.message : stdout + (stderr ? '\n' + stderr : '')),
					scopeViolation, scopeVerified, ...(scopeUnscanned?.length ? { scopeUnscanned } : {}), structuredOutput: parsed.structured, usage: parsed.usage,
					...(parsed.rateLimited ? { rateLimited: true as const } : {}),
					...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
					...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
					...(parsed.searches?.length ? { searches: parsed.searches.map(redactSecrets) } : {}),
					...(parsed.quota ? { quota: parsed.quota } : {}),
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
