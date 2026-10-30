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
	commandCompatibility: 'verified' | 'unsupported' | 'unknown';
	missingFlags: string[];
	reason: 'cli-found' | 'cli-unavailable' | 'version-command-failed';
}
const VERSION_TIMEOUT = 5000;
const MAX_CAPTURE = 4096;
const REQUIRED_FLAGS: Record<NativeProvider, readonly string[]> = {
	codex: ['--sandbox', '--skip-git-repo-check', '--ask-for-approval', '--ephemeral', '--json'],
	claude: ['--permission-mode', '--allowedTools', '--disallowedTools', '--max-turns', '--output-format']
};

/** A CLI's help text is evidence of supported flags, never proof of authentication or sandbox enforcement. */
export function inspectProviderHelp(provider: NativeProvider, help: string): { compatibility: 'verified' | 'unsupported' | 'unknown'; missingFlags: string[] } {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	if (typeof help !== 'string' || help.length > 32 * 1024 || help.trim().length < 20) { return { compatibility: 'unknown', missingFlags: [] }; }
	const flags = new Set(help.match(/--[A-Za-z][A-Za-z-]*/g) || []);
	const missingFlags = REQUIRED_FLAGS[provider].filter(flag => !flags.has(flag));
	return { compatibility: missingFlags.length ? 'unsupported' : 'verified', missingFlags };
}


/** Queries local static help only; this operation never passes a prompt to a provider. */
export async function probeProviderCommandFlags(provider: NativeProvider): Promise<{ compatibility: 'verified' | 'unsupported' | 'unknown'; missingFlags: string[] }> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	let resolved;
	try { resolved = await resolveNativeCommand(provider, provider === 'codex' ? ['exec', '--help'] : ['--help']); }
	catch { return { compatibility: 'unknown', missingFlags: [] }; }
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
		if (process.env[key]) { env[key] = process.env[key]; }
	}
	if (resolved.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	return await new Promise(resolve => {
		let settled = false;
		let help = '';
		let bytes = 0;
		const child = spawn(resolved.executable, resolved.args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const finish = (compatible: boolean): void => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (!compatible) { child.kill(); }
			resolve(compatible ? inspectProviderHelp(provider, help) : { compatibility: 'unknown', missingFlags: [] });
		};
		const timer = setTimeout(() => finish(false), VERSION_TIMEOUT);
		timer.unref();
		child.stdout?.on('data', (part: Buffer) => { bytes += part.length; help += part.toString('utf8'); if (bytes > 32 * 1024) { finish(false); } });
		child.stderr?.on('data', (part: Buffer) => { bytes += part.length; help += part.toString('utf8'); if (bytes > 32 * 1024) { finish(false); } });
		child.once('error', () => finish(false));
		child.once('close', code => finish(code === 0));
	});
}

export async function diagnoseProvider(provider: NativeProvider): Promise<ProviderDiagnostic> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	let resolved;
	try { resolved = await resolveNativeCommand(provider, ['--version']); }
	catch { return { provider, installed: false, version: null, protocolVerified: false, modelAuthenticated: false, commandCompatibility: 'unknown', missingFlags: [], reason: 'cli-unavailable' }; }
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
	const command = version ? await probeProviderCommandFlags(provider) : { compatibility: 'unknown' as const, missingFlags: [] as string[] };
	return {
		provider, installed: true, version,
		protocolVerified: false, modelAuthenticated: false,
		commandCompatibility: command.compatibility, missingFlags: command.missingFlags,
		reason: version ? 'cli-found' : 'version-command-failed'
	};
}
