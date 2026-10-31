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
	localSession: 'authenticated' | 'unauthenticated' | 'unknown';
	commandCompatibility: 'verified' | 'unsupported' | 'unknown';
	missingFlags: string[];
	reason: 'cli-found' | 'cli-unavailable' | 'version-command-failed';
}
const VERSION_TIMEOUT = 5000;
const MAX_CAPTURE = 4096;
const MAX_HELP = 64 * 1024;
/**
 * Flags that must be documented in help. Claude's `--max-turns` is accepted but hidden from
 * `claude --help` (2.1.x), so its absence there cannot prove incompatibility.
 */
const REQUIRED_FLAGS: Record<NativeProvider, readonly string[]> = {
	codex: ['--sandbox', '--skip-git-repo-check', '--ask-for-approval', '--ephemeral', '--json'],
	claude: ['--permission-mode', '--allowedTools', '--disallowedTools', '--output-format']
};
/** Codex documents global flags such as `--ask-for-approval` only in top-level help, and exec flags in `exec --help`. */
const HELP_COMMANDS: Record<NativeProvider, readonly string[][]> = {
	codex: [['--help'], ['exec', '--help']],
	claude: [['--help']]
};

/** A CLI's help text is evidence of supported flags, never proof of authentication or sandbox enforcement. */
export function inspectProviderHelp(provider: NativeProvider, help: string): { compatibility: 'verified' | 'unsupported' | 'unknown'; missingFlags: string[] } {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	if (typeof help !== 'string' || help.length > MAX_HELP || help.trim().length < 20) { return { compatibility: 'unknown', missingFlags: [] }; }
	const flags = new Set(help.match(/--[A-Za-z][A-Za-z-]*/g) || []);
	const missingFlags = REQUIRED_FLAGS[provider].filter(flag => !flags.has(flag));
	return { compatibility: missingFlags.length ? 'unsupported' : 'verified', missingFlags };
}


/** Never persist raw auth status output: it can contain account identifiers. */
export function parseLocalAuthStatus(provider: NativeProvider, stdout: string, exitCode: number): 'authenticated' | 'unauthenticated' | 'unknown' {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	if (stdout.length > 4096) { return 'unknown'; }
	if (provider === 'claude') {
		try {
			const value = JSON.parse(stdout) as { loggedIn?: unknown };
			if (value.loggedIn === true && exitCode === 0) { return 'authenticated'; }
			if (value.loggedIn === false) { return 'unauthenticated'; }
		} catch { /* Unknown output from older CLI versions. */ }
		return 'unknown';
	}
	if (/not logged in|not authenticated/i.test(stdout)) { return 'unauthenticated'; }
	if (exitCode === 0 && /logged in using|logged in with/i.test(stdout)) { return 'authenticated'; }
	return 'unknown';
}

/** Local login probe; never sends a model prompt or stores account status output. */
export async function probeProviderLocalAuth(provider: NativeProvider): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
	let resolved;
	try { resolved = await resolveNativeCommand(provider, args); }
	catch { return 'unknown'; }
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'CODEX_HOME']) {
		if (process.env[key]) { env[key] = process.env[key]; }
	}
	if (resolved.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	return await new Promise(resolve => {
		let settled = false;
		let stdout = '';
		let bytes = 0;
		const child = spawn(resolved.executable, resolved.args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const finish = (code: number): void => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (code < 0) { child.kill(); }
			resolve(code >= 0 ? parseLocalAuthStatus(provider, stdout, code) : 'unknown');
		};
		const timer = setTimeout(() => finish(-1), VERSION_TIMEOUT);
		timer.unref();
		child.stdout?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_CAPTURE) { finish(-1); return; } stdout += chunk.toString('utf8'); });
		// Codex prints `login status` to stderr; Claude's JSON stays on stdout and must not be mixed.
		child.stderr?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_CAPTURE) { finish(-1); return; } if (provider === 'codex') { stdout += chunk.toString('utf8'); } });
		child.once('error', () => finish(-1));
		child.once('close', code => finish(code ?? -1));
	});
}

/** Static help text of one subcommand, or null when it cannot be read within bounds. */
async function readProviderHelp(provider: NativeProvider, args: readonly string[]): Promise<string | null> {
	let resolved;
	try { resolved = await resolveNativeCommand(provider, [...args]); }
	catch { return null; }
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
			resolve(compatible ? help : null);
		};
		const timer = setTimeout(() => finish(false), VERSION_TIMEOUT);
		timer.unref();
		const collect = (part: Buffer): void => { bytes += part.length; help += part.toString('utf8'); if (bytes > MAX_HELP / 2) { finish(false); } };
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		child.once('error', () => finish(false));
		child.once('close', code => finish(code === 0));
	});
}

/** Queries local static help only; this operation never passes a prompt to a provider. */
export async function probeProviderCommandFlags(provider: NativeProvider): Promise<{ compatibility: 'verified' | 'unsupported' | 'unknown'; missingFlags: string[] }> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	const helps = await Promise.all(HELP_COMMANDS[provider].map(args => readProviderHelp(provider, args)));
	if (helps.some(help => help === null)) { return { compatibility: 'unknown', missingFlags: [] }; }
	return inspectProviderHelp(provider, helps.join('\n'));
}

export async function diagnoseProvider(provider: NativeProvider): Promise<ProviderDiagnostic> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
	let resolved;
	try { resolved = await resolveNativeCommand(provider, ['--version']); }
	catch { return { provider, installed: false, version: null, protocolVerified: false, modelAuthenticated: false, localSession: 'unknown', commandCompatibility: 'unknown', missingFlags: [], reason: 'cli-unavailable' }; }
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
	const localSession = version ? await probeProviderLocalAuth(provider) : 'unknown';
	return {
		provider, installed: true, version,
		protocolVerified: false, modelAuthenticated: false, localSession,
		commandCompatibility: command.compatibility, missingFlags: command.missingFlags,
		reason: version ? 'cli-found' : 'version-command-failed'
	};
}
