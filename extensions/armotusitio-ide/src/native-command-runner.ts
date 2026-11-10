/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Run one policy-approved agent command (block A): no shell, bounded time and output, the whole process tree stopped. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolveNativeCommand, stopProcess } from './native-runtime.ts';
import { redactSecrets, StreamingSecretRedactor } from './native-redact.ts';
import { withNodeRuntime } from './native-toolchain-env.ts';

/** Last part of the output returned to the agent; the full output goes to the log file. */
export const RETURNED_OUTPUT_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_SEC = 600;
export const MAX_COMMAND_TIMEOUT_SEC = 1800;
/** A command silent this long with an unfinished prompt line is waiting for an answer nobody can type (stdin is closed). */
export const PROMPT_IDLE_MS = 20_000;
/** The unfinished last line of a prompt: a question, a colon or caret, a yes/no choice or a secret request. */
const PROMPT_LINE = /[?:>]\s*$|\([yYnN]\/[yYnN]\)|\[[yYnN]\/[yYnN]\]|pass(word|phrase)/i;
/** The prompt a command is stuck at, or undefined when the output ends in a finished line or looks like ordinary progress. */
export function pendingPrompt(output: string): string | undefined {
	const last = output.split(/\r?\n/).at(-1)?.trim() ?? '';
	return last && last.length <= 200 && PROMPT_LINE.test(last) ? last : undefined;
}

/** A person at the other end: the command's output is shown to them and their typed lines reach its stdin. */
export interface InteractiveIo {
	onOutput(text: string): void;
	/** Registers the sink for typed input; the returned function stops it. */
	onInput(write: (data: string) => void): () => void;
}

export interface CommandRequest {
	root: string;
	/** Project-relative folder already validated by the policy. */
	cwd: string;
	command: string;
	args: readonly string[];
	timeoutSec?: number;
	/** Silence before an unfinished prompt line stops the command; for tests. */
	promptIdleMs?: number;
	env: NodeJS.ProcessEnv;
	/** Folder for full logs, outside the project. */
	logDirectory: string;
	/** The project's Harness entry that runs the command itself (`ide-run`), when it declares `command-runner`. */
	delegateEntry?: string;
	signal?: AbortSignal;
	/** With a person attached stdin is open and an unanswered prompt is theirs to answer, not a hang. */
	interactive?: InteractiveIo;
	/** Called with every piece of output as it arrives (background jobs show the live tail). */
	observe?: (text: string) => void;
}
export interface CommandResult {
	exitCode: number | null;
	timedOut: boolean;
	/** Stopped at a prompt that stdin cannot answer; the prompt text is in `prompt`. */
	prompt?: string;
	cancelled: boolean;
	durationMs: number;
	/** Redacted tail of stdout and stderr, in arrival order. */
	output: string;
	truncated: boolean;
	logFile: string;
	/** Persistence failed; process outcome and sanitized output are still available. */
	logError?: string;
}

/** An executable named by path (`./gradlew`, `vendor/bin/phpunit`) must be a regular file inside the project. */
async function projectExecutable(root: string, cwd: string, command: string): Promise<string | undefined> {
	if (!/[\\/]/.test(command)) { return undefined; }
	const candidate = path.resolve(root, cwd, command);
	const canonical = await fsp.realpath(candidate).catch(() => undefined);
	if (!canonical || (canonical !== root && !canonical.startsWith(root + path.sep)) || !(await fsp.stat(canonical)).isFile()) { throw Error('HARNESS_EXECUTABLE_UNAVAILABLE'); }
	return canonical;
}

export async function runCommand(request: CommandRequest, createLog: (file: string) => fs.WriteStream = file => fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })): Promise<CommandResult> {
	const started = Date.now();
	const timeoutSec = Math.min(MAX_COMMAND_TIMEOUT_SEC, Math.max(1, request.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC));
	const cwd = path.resolve(request.root, request.cwd);
	const realCwd = await fsp.realpath(cwd).catch(() => undefined);
	if (!realCwd || (realCwd !== request.root && !realCwd.startsWith(request.root + path.sep))) { throw Error('HARNESS_INVALID_CWD'); }
	const toolchainEnv = await withNodeRuntime(request.env);
	let resolved: { executable: string; args: string[]; embeddedNode: boolean };
	if (request.delegateEntry) {
		resolved = await resolveNativeCommand('node', [request.delegateEntry, 'ide-run', '--ide-protocol', '2', '--cwd', request.cwd, '--', request.command, ...request.args], toolchainEnv);
	} else {
		const local = await projectExecutable(request.root, request.cwd, request.command);
		const args = request.command.replace(/\.exe$/i, '').toLowerCase() === 'rg' ? ['--no-config', ...request.args] : [...request.args];
		resolved = local ? { executable: local, args, embeddedNode: false } : await resolveNativeCommand(request.command, args, toolchainEnv);
	}
	await fsp.mkdir(request.logDirectory, { recursive: true });
	const logFile = path.join(request.logDirectory, new Date(started).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex') + '-' + path.basename(request.command).replace(/[^\w.-]/g, '_') + '.log');
	const log = createLog(logFile);
	// A full disk or a vanished folder must cost the log, never the run: the output tail still reaches the agent.
	let logError: string | undefined;
	log.on('error', (error: NodeJS.ErrnoException) => { logError = error.code ?? 'LOG_WRITE_FAILED'; });
	const env = { ...toolchainEnv, ...(resolved.embeddedNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
	// A project Harness resolves `--cwd` against its own root, which it may take from the process directory (for example
	// `Path.cwd()` in a Python `ide-run`): starting it inside the subfolder made it look for `<cwd>/<cwd>`.
	const processCwd = request.delegateEntry ? request.root : realCwd;
	return new Promise(resolve => {
		const child = spawn(resolved.executable, resolved.args, { cwd: processCwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [request.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
		let tail = '', outputTail = '', logged = 0, truncated = false, timedOut = false, cancelled = false, done = false, lastOutputAt = Date.now(), prompt: string | undefined;
		const streams = [0, 1].map(() => ({ decoder: new StringDecoder('utf8'), redactor: new StreamingSecretRedactor() }));
		const persist = (text: string): void => {
			if (!text) { return; }
			request.observe?.(text);
			outputTail += text;
			if (Buffer.byteLength(outputTail) > RETURNED_OUTPUT_BYTES) { outputTail = Buffer.from(outputTail).subarray(-RETURNED_OUTPUT_BYTES).toString('utf8'); truncated = true; }
			if (logged < MAX_LOG_BYTES && !logError) {
				const bytes = Buffer.from(text, 'utf8').subarray(0, MAX_LOG_BYTES - logged);
				log.write(bytes); logged += bytes.length;
			}
		};
		const collect = (chunk: Buffer, stream: typeof streams[number]): void => {
			const text = stream.decoder.write(chunk);
			// A person attached to stdin needs prompts immediately; observers and disk receive only redacted records.
			request.interactive?.onOutput(text);
			persist(stream.redactor.write(text));
			tail += text;
			lastOutputAt = Date.now();
			if (tail.length > RETURNED_OUTPUT_BYTES) { tail = tail.slice(-RETURNED_OUTPUT_BYTES); truncated = true; }
		};
		child.stdout?.on('data', (chunk: Buffer) => collect(chunk, streams[0]));
		child.stderr?.on('data', (chunk: Buffer) => collect(chunk, streams[1]));
		const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeoutSec * 1000);
		timer.unref();
		const stopInput = request.interactive?.onInput(data => { child.stdin?.write(data, () => undefined); });
		child.stdin?.on('error', () => undefined);
		const idleMs = request.promptIdleMs ?? PROMPT_IDLE_MS;
		const watcher = setInterval(() => {
			const waiting = !request.interactive && Date.now() - lastOutputAt >= idleMs ? pendingPrompt(tail) : undefined;
			if (waiting) { prompt = redactSecrets(waiting); stopProcess(child); }
		}, Math.max(50, Math.min(1000, idleMs / 4)));
		watcher.unref();
		const onAbort = (): void => { cancelled = true; stopProcess(child); };
		request.signal?.addEventListener('abort', onAbort, { once: true });
		// The caller may have stopped it while the command was still being resolved; an abort that already happened raises no event.
		if (request.signal?.aborted) { onAbort(); }
		const finish = (exitCode: number | null): void => {
			if (done) { return; }
			done = true; clearTimeout(timer); clearInterval(watcher); stopInput?.(); request.signal?.removeEventListener('abort', onAbort);
			for (const stream of streams) { persist(stream.redactor.write(stream.decoder.end()) + stream.redactor.end()); }
			const complete = (): void => { resolve({ exitCode, timedOut, ...(prompt ? { prompt } : {}), cancelled, durationMs: Date.now() - started, output: outputTail, truncated, logFile, ...(logError ? { logError } : {}) }); };
			// Resolve only after bytes have reached the stream, so callers can inspect the saved log immediately.
			if (log.destroyed) { complete(); } else { log.once('close', complete); log.end(); }
		};
		child.once('error', (error: NodeJS.ErrnoException) => {
			const failure = '\n[ats-runner] could not start ' + path.basename(resolved.executable) + ' (' + (error.code ?? 'UNKNOWN') + '). ' +
				(error.code === 'ENOENT' ? 'The executable or working directory was not found.' : 'The process failed to start; this does not establish that the tool is missing.');
			persist(redactSecrets(failure));
			finish(null);
		});
		child.once('close', code => finish(code));
	});
}
