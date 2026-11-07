/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Supervised provider process for a long-lived session: no shell, the whole tree stopped on close, stderr bounded and
 * redacted, and one `exited` promise that tells an expected close from a crash.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveNativeCommand, stopProcess } from '../native-runtime.ts';
import { redactSecrets } from '../native-redact.ts';

const MAX_STDERR = 16 * 1024;

export interface ProviderProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<{ code: number | null; expected: boolean }>;
	/** Last stderr text, redacted and bounded, for diagnostics. */
	stderr(): string;
	stop(): void;
}

export async function startProviderProcess(executable: 'claude' | 'codex', args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProviderProcess> {
	const command = await resolveNativeCommand(executable, args, env);
	const childEnv: NodeJS.ProcessEnv = { ...env };
	if (command.embeddedNode) { childEnv.ELECTRON_RUN_AS_NODE = '1'; }
	const child = spawn(command.executable, command.args, { cwd, env: childEnv, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
	let expected = false;
	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR); });
	child.stdin.on('error', () => { /* The provider may exit while a message is being written; `exited` reports it. */ });
	const exited = new Promise<{ code: number | null; expected: boolean }>(resolve => {
		child.once('error', () => resolve({ code: null, expected }));
		child.once('close', code => resolve({ code, expected }));
	});
	return {
		child, exited,
		stderr: () => redactSecrets(stderr),
		stop: () => { expected = true; stopProcess(child); }
	};
}
