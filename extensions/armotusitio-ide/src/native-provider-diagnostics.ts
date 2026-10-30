/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** CLI diagnostics only. Never logs in, invokes a model, or assumes compatibility from version output. */
import { spawn } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';
import type { NativeProvider } from './native-providers.ts';

export interface ProviderDiagnostic {
	provider: NativeProvider;
	installed: boolean;
	version: string | null;
	protocolVerified: false;
	modelAuthenticated: false;
	reason: 'cli-found' | 'cli-unavailable' | 'version-command-failed';
}
const VERSION_TIMEOUT = 5000;
const MAX_CAPTURE = 4096;

export async function diagnoseProvider(provider: NativeProvider): Promise<ProviderDiagnostic> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	let resolved;
	try { resolved = await resolveNativeCommand(provider, ['--version']); }
	catch { return { provider, installed: false, version: null, protocolVerified: false, modelAuthenticated: false, reason: 'cli-unavailable' }; }
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
		if (process.env[key]) { env[key] = process.env[key]; }
	}
	if (resolved.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	const version = await new Promise<string | null>(resolve => {
		let done = false, stdout = '', bytes = 0;
		let child;
		try {
			child = spawn(resolved.executable, resolved.args, {
				env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch { resolve(null); return; }
		const finish = (value: string | null): void => {
			if (done) { return; }
			done = true; clearTimeout(timer); resolve(value);
		};
		const timer = setTimeout(() => { child.kill(); finish(null); }, VERSION_TIMEOUT);
		timer.unref();
		child.stdout?.on('data', (part: Buffer) => {
			bytes += part.length;
			if (bytes > MAX_CAPTURE) { child.kill(); finish(null); return; }
			stdout += part.toString('utf8');
		});
		child.stderr?.on('data', (part: Buffer) => {
			bytes += part.length;
			if (bytes > MAX_CAPTURE) { child.kill(); finish(null); }
		});
		child.once('error', () => finish(null));
		child.once('close', code => {
			const match = stdout.match(/(?:^|[^\d])(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-.][a-z0-9.]+)?)/i);
			finish(code === 0 ? match?.[1] || null : null);
		});
	});
	return {
		provider, installed: true, version,
		protocolVerified: false, modelAuthenticated: false,
		reason: version ? 'cli-found' : 'version-command-failed'
	};
}
