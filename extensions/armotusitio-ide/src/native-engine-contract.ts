/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Conservative v2 capability contract. A project runner is never executed merely to inspect it. */
import { inspectHarnessAuthority } from './native-authority.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const ENGINE_CONTRACT_VERSION = 2 as const;
export type Capability =
	| 'verification-gates' | 'durable-tasks' | 'durable-workflows' | 'provider-execution'
	| 'agent-handoffs' | 'reconciliation' | 'bounded-processes' | 'parallel-gates'
	| 'worktree-isolation' | 'os-sandbox' | 'network-policy' | 'token-accounting'
	| 'cost-accounting' | 'autonomous-repair';
export interface EngineCapabilities {
	schemaVersion: typeof ENGINE_CONTRACT_VERSION;
	engine: 'ide-native' | 'project';
	authority: 'ide' | 'project';
	supported: Capability[];
	projectDeclared?: Capability[];
	unavailable: Capability[];
	requiresExternalHandshake: boolean;
	executionEnabled: boolean;
}

const ALL: Capability[] = [
	'verification-gates', 'durable-tasks', 'durable-workflows', 'provider-execution',
	'agent-handoffs', 'reconciliation', 'bounded-processes', 'parallel-gates',
	'worktree-isolation', 'os-sandbox', 'network-policy', 'token-accounting',
	'cost-accounting', 'autonomous-repair'
];
const VERIFIED_NATIVE: Capability[] = [
	'verification-gates', 'durable-tasks', 'durable-workflows', 'provider-execution',
	'agent-handoffs', 'reconciliation', 'bounded-processes', 'parallel-gates', 'worktree-isolation'
];

/** Native capability inventory independent from the opened project's authority. */
export function verifiedNativeCapabilities(): Capability[] { return [...VERIFIED_NATIVE]; }

/** Read-only disclosure; a declaration never grants execution authority or counts as verified support. */
export async function readProjectCapabilities(root: string): Promise<Capability[]> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_CAPABILITIES_ROOT_CHANGED'); }
	const projectDir = path.join(canonical, '.harness');
	const directory = path.join(projectDir, 'manifests');
	const target = path.join(directory, 'ide-capabilities.json');
	let info;
	try { info = await fs.lstat(target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
		throw error;
	}
	const projectStat = await fs.lstat(projectDir);
	const directoryStat = await fs.lstat(directory);
	if (!projectStat.isDirectory() || projectStat.isSymbolicLink() ||
		!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
		!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ||
		await fs.realpath(projectDir) !== projectDir ||
		await fs.realpath(directory) !== directory || await fs.realpath(target) !== target) {
		throw Error('HARNESS_CAPABILITIES_UNSAFE');
	}
	const bytes = await fs.readFile(target);
	if (bytes.length > 16 * 1024) { throw Error('HARNESS_CAPABILITIES_UNSAFE'); }
	let value: unknown;
	try { value = JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_CAPABILITIES_INVALID'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('HARNESS_CAPABILITIES_INVALID'); }
	const manifest = value as { schemaVersion?: number; engine?: string; capabilities?: unknown };
	if (Object.keys(value).sort().join(',') !== 'capabilities,engine,schemaVersion' ||
		manifest.schemaVersion !== ENGINE_CONTRACT_VERSION || manifest.engine !== 'project' ||
		!Array.isArray(manifest.capabilities) || manifest.capabilities.length > ALL.length ||
		!manifest.capabilities.every(c => typeof c === 'string' && ALL.includes(c as Capability)) ||
		new Set(manifest.capabilities).size !== manifest.capabilities.length) {
		throw Error('HARNESS_CAPABILITIES_INVALID');
	}
	return manifest.capabilities as Capability[];
}

export async function describeEngine(root: string): Promise<EngineCapabilities> {
	const authority = await inspectHarnessAuthority(root);
	const isProject = authority.engine === 'project';
	// Never infer project features from the presence of a directory. Only an explicit
	// versioned handshake can extend the supported set in a future protocol adapter.
	const supported = isProject ? [] : VERIFIED_NATIVE;
	const projectDeclared = isProject ? await readProjectCapabilities(root) : undefined;
	return {
		schemaVersion: ENGINE_CONTRACT_VERSION,
		engine: authority.engine,
		authority: isProject ? 'project' : 'ide',
		supported: [...supported],
		projectDeclared,
		unavailable: ALL.filter(capability => !supported.includes(capability)),
		requiresExternalHandshake: isProject,
		executionEnabled: !isProject
	};
}

export interface HybridCapabilityComparison {
	nativeVerified: Capability[];
	projectReported: Capability[];
	overlap: Capability[];
	projectOnly: Capability[];
	nativeOnly: Capability[];
	executionGranted: false;
}

/** Handshake output is advisory: never convert self-reported features into execution rights. */
export function compareHybridCapabilities(native: readonly Capability[], reported: readonly Capability[]): HybridCapabilityComparison {
	const known = new Set<Capability>(ALL);
	if (new Set(native).size !== native.length || new Set(reported).size !== reported.length ||
		![...native, ...reported].every(capability => known.has(capability))) {
		throw Error('HARNESS_HYBRID_CAPABILITY_INVALID');
	}
	return {
		nativeVerified: [...native], projectReported: [...reported],
		overlap: native.filter(capability => reported.includes(capability)),
		projectOnly: reported.filter(capability => !native.includes(capability)),
		nativeOnly: native.filter(capability => !reported.includes(capability)),
		executionGranted: false
	};
}

/**
 * Explicit opt-in project handshake. A self-reported response is NOT an OS
 * attestation and does not grant authority to execute project operations.
 * Never call from discovery, workspace opening or untrusted workspaces.
 */
export async function probeProjectHandshake(root: string, trusted: () => boolean): Promise<{ protocol: 2; reported: Capability[] }> {
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_HANDSHAKE_ROOT_CHANGED'); }
	const authority = await inspectHarnessAuthority(canonical);
	if (authority.engine !== 'project' || !authority.entry || authority.reason !== 'project-entry') { throw Error('HARNESS_HANDSHAKE_ENTRY_UNAVAILABLE'); }
	const target = path.join(canonical, authority.entry);
	const entry = await fs.lstat(target);
	if (!entry.isFile() || entry.isSymbolicLink() || await fs.realpath(target) !== target) { throw Error('HARNESS_HANDSHAKE_ENTRY_UNSAFE'); }
	const declared = await readProjectCapabilities(canonical);
	const nonce = randomBytes(16).toString('hex');
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
		if (process.env[key]) { environment[key] = process.env[key]; }
	}
	environment.ELECTRON_RUN_AS_NODE = '1';
	const output = await new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, [target, 'capabilities', '--ide-protocol', '2', '--nonce', nonce], {
			cwd: canonical, shell: false, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let bytes = 0;
		let finished = false;
		const finish = (error?: Error): void => {
			if (finished) { return; }
			finished = true;
			clearTimeout(timer);
			if (error) { child.kill(); reject(error); } else { resolve(stdout); }
		};
		const timer = setTimeout(() => finish(Error('HARNESS_HANDSHAKE_TIMEOUT')), 5000);
		timer.unref();
		child.stdout?.on('data', (data: Buffer) => {
			bytes += data.length;
			if (bytes > 16 * 1024) { finish(Error('HARNESS_HANDSHAKE_OVERSIZED')); return; }
			stdout += data.toString('utf8');
		});
		child.stderr?.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 16 * 1024) { finish(Error('HARNESS_HANDSHAKE_OVERSIZED')); } });
		child.once('error', () => finish(Error('HARNESS_HANDSHAKE_PROCESS')));
		child.once('close', code => finish(code === 0 ? undefined : Error('HARNESS_HANDSHAKE_FAILED')));
	});
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	let parsed: unknown;
	try { parsed = JSON.parse(output); } catch { throw Error('HARNESS_HANDSHAKE_INVALID'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw Error('HARNESS_HANDSHAKE_INVALID'); }
	const result = parsed as { schemaVersion?: unknown; nonce?: unknown; capabilities?: unknown };
	if (Object.keys(parsed).sort().join(',') !== 'capabilities,nonce,schemaVersion' ||
		result.schemaVersion !== ENGINE_CONTRACT_VERSION || result.nonce !== nonce ||
		!Array.isArray(result.capabilities) || result.capabilities.length > declared.length ||
		!result.capabilities.every(cap => typeof cap === 'string' && declared.includes(cap as Capability)) ||
		new Set(result.capabilities).size !== result.capabilities.length) {
		throw Error('HARNESS_HANDSHAKE_INVALID');
	}
	const currentDeclaration = await readProjectCapabilities(canonical);
	if (JSON.stringify(currentDeclaration) !== JSON.stringify(declared)) {
		throw Error('HARNESS_HANDSHAKE_CAPABILITIES_CHANGED');
	}
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	return { protocol: 2, reported: result.capabilities as Capability[] };
}
