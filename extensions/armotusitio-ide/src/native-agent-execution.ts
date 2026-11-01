/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Explicitly approved, bounded agent CLI execution. No shell, no bypass-permissions modes. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';
import { captureAgentScope, scopeChanged } from './native-agent-scope.ts';
import { parseProviderOutput, ClaudeEventAccumulator, CodexEventAccumulator, type ProviderUsage } from './native-provider-output.ts';
import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from './native-redact.ts';
import { reviewAgentDraft, validateReviewedAgent, type AgentDraft, type AgentReview } from './native-providers.ts';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_RETAINED = 512 * 1024;
const MAX_STDERR_RETAINED = 64 * 1024;
const MAX_DURATION_MS = 30 * 60 * 1000;
const AUTH_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
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

export function buildAgentInvocation(draft: AgentDraft): AgentInvocation {
	reviewAgentDraft(draft);
	if (draft.role !== 'implementer' && !draft.readOnly) { throw Error('HARNESS_READ_ONLY_ROLE_REQUIRED'); }
	if (draft.role === 'implementer' && draft.readOnly) { throw Error('HARNESS_IMPLEMENTER_MODE_MISMATCH'); }
	const instruction = [
		'You are a scoped software engineering agent. Operate only in the supplied project root.',
		'Do not commit, push, publish, deploy, modify secrets or alter files outside the project.',
		draft.role === 'implementer'
			? 'Make only changes required by the instruction; report files touched and validation.'
			: 'This is a read-only assignment. Do not modify project files.',
		draft.instruction
	].join('\n\n');
	const model = draft.model ? ['--model', draft.model] : [];
	// Keep effort as a reviewed, per-invocation override. Never modify CLI config files.
	const effort = draft.effort ? draft.provider === 'codex'
		? ['--config', 'model_reasoning_effort="' + draft.effort + '"']
		: ['--effort', draft.effort] : [];
	if (draft.provider === 'codex') {
		return {
			executable: 'codex',
			// The approval flag is global and must precede the exec subcommand on current Codex CLIs.
			args: ['--ask-for-approval', 'never', ...effort, 'exec', ...model, '--sandbox', draft.readOnly ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--json', '-'],
			stdin: instruction
		};
	}
	// dontAsk denies tools that are not explicitly allowed, rather than silently bypassing permissions.
	// plan mode is strictly read-only; don'tAsk is fail-closed if required tools lack an allow rule.
	// stream-json (which requires --verbose in print mode) reports each assistant message as it is produced.
	return {
		executable: 'claude',
		args: ['--print', ...model, ...effort, '--permission-mode', draft.readOnly ? 'plan' : 'dontAsk', '--allowedTools', draft.readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write', '--disallowedTools', 'Bash,WebFetch,WebSearch', '--max-turns', '12', '--output-format', 'stream-json', '--verbose'],
		stdin: instruction
	};
}

function stopProcess(child: ChildProcess): void {
	if (!child.pid) { return; }
	if (process.platform === 'win32') {
		const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		killer.on('error', () => { /* Cannot terminate unavailable process. */ });
	} else {
		try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ }
		}, 1500);
		timer.unref();
		child.once('close', () => clearTimeout(timer));
	}
}

/**
 * Caller MUST verify Workspace Trust, project authority and consent immediately before invoking.
 * `onMessage` receives redacted intermediate assistant messages as the provider streams them (Codex JSONL, Claude stream-json).
 */
export async function executeReviewedAgent(review: AgentReview, current: AgentDraft, durationMs = MAX_DURATION_MS, onProgress?: (progress: Readonly<AgentProgress>) => void, onMessage?: (text: string) => void): Promise<AgentExecution> {
	validateReviewedAgent(review, current);
	if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) { throw Error('HARNESS_AGENT_TIMEOUT_INVALID'); }
	const canonical = await fs.realpath(current.projectRoot);
	if (canonical !== current.projectRoot || !(await fs.stat(canonical)).isDirectory()) { throw Error('HARNESS_AGENT_ROOT_CHANGED'); }
	const invocation = buildAgentInvocation(current);
	const initialScope = current.readOnly ? await captureAgentScope(canonical) : undefined;
	const command = await resolveNativeCommand(invocation.executable, invocation.args);
	const env: NodeJS.ProcessEnv = {};
	for (const key of AUTH_ENV) { if (process.env[key]) { env[key] = process.env[key]; } }
	if (command.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	if (current.provider === 'claude') { env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'; }
	const started = Date.now();
	let cancelled = false, timedOut = false, truncated = false;
	let stdout = '', stderr = '', size = 0;
	let lastProgress = 0;
	let stdoutOverflow = false;
	const observe = onMessage && ((text: string) => onMessage(redactSecrets(text)));
	const events = current.provider === 'codex' ? new CodexEventAccumulator(observe) : new ClaudeEventAccumulator(observe);
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
				let status: AgentOutcome['status'] = timedOut ? 'timeout' : cancelled ? 'cancelled' : exitCode === 0 && !parsed.providerError && !truncated ? 'passed' : 'failed';
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
					...(parsed.rateLimited ? { rateLimited: true as const } : {})
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
