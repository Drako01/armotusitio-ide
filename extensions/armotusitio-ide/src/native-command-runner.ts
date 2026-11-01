/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Run one policy-approved agent command (block A): no shell, bounded time and output, the whole process tree stopped. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveNativeCommand, stopProcess } from './native-runtime.ts';
import { redactSecrets } from './native-redact.ts';

/** Last part of the output returned to the agent; the full output goes to the log file. */
export const RETURNED_OUTPUT_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_SEC = 600;
export const MAX_COMMAND_TIMEOUT_SEC = 1800;

export interface CommandRequest {
	root: string;
	/** Project-relative folder already validated by the policy. */
	cwd: string;
	command: string;
	args: readonly string[];
	timeoutSec?: number;
	env: NodeJS.ProcessEnv;
	/** Folder for full logs, outside the project. */
	logDirectory: string;
	/** The project's Harness entry that runs the command itself (`ide-run`), when it declares `command-runner`. */
	delegateEntry?: string;
	signal?: AbortSignal;
}
export interface CommandResult {
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	durationMs: number;
	/** Redacted tail of stdout and stderr, in arrival order. */
	output: string;
	truncated: boolean;
	logFile: string;
}

/** An executable named by path (`./gradlew`, `vendor/bin/phpunit`) must be a regular file inside the project. */
async function projectExecutable(root: string, cwd: string, command: string): Promise<string | undefined> {
	if (!/[\\/]/.test(command)) { return undefined; }
	const candidate = path.resolve(root, cwd, command);
	const canonical = await fsp.realpath(candidate).catch(() => undefined);
	if (!canonical || (canonical !== root && !canonical.startsWith(root + path.sep)) || !(await fsp.stat(canonical)).isFile()) { throw Error('HARNESS_EXECUTABLE_UNAVAILABLE'); }
	return canonical;
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
	const started = Date.now();
	const timeoutSec = Math.min(MAX_COMMAND_TIMEOUT_SEC, Math.max(1, request.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC));
	const cwd = path.resolve(request.root, request.cwd);
	const realCwd = await fsp.realpath(cwd).catch(() => undefined);
	if (!realCwd || (realCwd !== request.root && !realCwd.startsWith(request.root + path.sep))) { throw Error('HARNESS_INVALID_CWD'); }
	let resolved: { executable: string; args: string[]; embeddedNode: boolean };
	if (request.delegateEntry) {
		resolved = { executable: process.execPath, args: [request.delegateEntry, 'ide-run', '--ide-protocol', '2', '--cwd', request.cwd, '--', request.command, ...request.args], embeddedNode: true };
	} else {
		const local = await projectExecutable(request.root, request.cwd, request.command);
		resolved = local ? { executable: local, args: [...request.args], embeddedNode: false } : await resolveNativeCommand(request.command, [...request.args]);
	}
	await fsp.mkdir(request.logDirectory, { recursive: true });
	const logFile = path.join(request.logDirectory, new Date(started).toISOString().replace(/[:.]/g, '-') + '-' + path.basename(request.command).replace(/[^\w.-]/g, '_') + '.log');
	const log = fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
	const env = { ...request.env, ...(resolved.embeddedNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
	return new Promise(resolve => {
		const child = spawn(resolved.executable, resolved.args, { cwd: realCwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
		let tail = '', logged = 0, truncated = false, timedOut = false, cancelled = false, done = false;
		const decoder = new StringDecoder('utf8');
		const collect = (chunk: Buffer): void => {
			if (logged < MAX_LOG_BYTES) { log.write(chunk.subarray(0, MAX_LOG_BYTES - logged)); logged += chunk.length; }
			tail += decoder.write(chunk);
			if (tail.length > RETURNED_OUTPUT_BYTES) { tail = tail.slice(-RETURNED_OUTPUT_BYTES); truncated = true; }
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeoutSec * 1000);
		timer.unref();
		const onAbort = (): void => { cancelled = true; stopProcess(child); };
		request.signal?.addEventListener('abort', onAbort, { once: true });
		const finish = (exitCode: number | null): void => {
			if (done) { return; }
			done = true; clearTimeout(timer); request.signal?.removeEventListener('abort', onAbort);
			log.end();
			resolve({ exitCode, timedOut, cancelled, durationMs: Date.now() - started, output: redactSecrets(tail + decoder.end()), truncated, logFile });
		};
		child.once('error', () => { tail += '\n[ats-runner] the executable could not be started'; finish(null); });
		child.once('close', code => finish(code));
	});
}
