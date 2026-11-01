/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validateNativePlan, type Plan } from './native-harness.ts';
import { inspectHarnessAuthority } from './native-authority.ts';
import { detectEcosystems } from './native-ecosystems.ts';
import { suggestGates } from './native-gate-suggestions.ts';

export const PROJECT_CONFIG = '.ats-harness.json';
export interface ProjectConfig {
	schemaVersion: 1;
	runtime: 'ide-native';
	profile: 'node' | 'go' | 'php' | 'custom';
	plan: Plan;
}
export interface ProjectProposal {
	config: ProjectConfig;
	signals: string[];
	caveats: string[];
	existing: boolean;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PROJECT_FILE_BYTES = 256 * 1024;
const SAFE_SCRIPT = /^(test|lint|check|typecheck|build)(:[a-zA-Z0-9_-]+)*$/;

async function readRegular(root: string, name: string, limit: number): Promise<string | undefined> {
	const target = path.join(root, name);
	try {
		const stat = await fs.lstat(target);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
			throw new Error('HARNESS_PROJECT_FILE_UNSAFE');
		}
		return await fs.readFile(target, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

export function validateProjectConfig(value: unknown): ProjectConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('HARNESS_CONFIG_SCHEMA');
	}
	const config = value as ProjectConfig;
	if (config.schemaVersion !== 1 || config.runtime !== 'ide-native' || !['node', 'go', 'php', 'custom'].includes(config.profile)) {
		throw new Error('HARNESS_CONFIG_SCHEMA');
	}
	validateNativePlan(config.plan);
	return config;
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig | undefined> {
	const canonical = await fs.realpath(root);
	const raw = await readRegular(canonical, PROJECT_CONFIG, MAX_CONFIG_BYTES);
	return raw === undefined ? undefined : validateProjectConfig(JSON.parse(raw));
}

export async function proposeProjectConfig(root: string): Promise<ProjectProposal> {
	const canonical = await fs.realpath(root);
	const existing = await loadProjectConfig(canonical);
	if (existing) {
		return { config: existing, existing: true, signals: [PROJECT_CONFIG], caveats: ['Existing configuration is authoritative; no overwrite'] };
	}
	const signals: string[] = [];
	const caveats = ['Detected tooling is a suggestion, not a successful tool check', 'No commands or providers are invoked during detection'];
	let profile: ProjectConfig['profile'] = 'custom';
	let executable = 'node';
	let args = ['--version'];
	const packageText = await readRegular(canonical, 'package.json', MAX_PROJECT_FILE_BYTES);
	if (packageText !== undefined) {
		signals.push('package.json');
		const pkg = JSON.parse(packageText) as { scripts?: Record<string, unknown> };
		const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
		const script = ['test', 'check', 'typecheck', 'lint', 'build'].find(s => typeof scripts[s] === 'string')
			|| Object.keys(scripts).sort().find(s => SAFE_SCRIPT.test(s) && typeof scripts[s] === 'string');
		if (script) {
			profile = 'node';
			executable = 'npm';
			args = ['run', script];
		} else {
			caveats.push('Node project has no recognized verification script');
		}
	}
	if (profile === 'custom' && await readRegular(canonical, 'go.mod', MAX_PROJECT_FILE_BYTES) !== undefined) {
		signals.push('go.mod');
		profile = 'go';
		executable = 'go';
		args = ['test', './...'];
	}
	if (profile === 'custom' && await readRegular(canonical, 'composer.json', MAX_PROJECT_FILE_BYTES) !== undefined) {
		signals.push('composer.json');
		profile = 'php';
		executable = 'php';
		args = ['-v'];
		caveats.push('php -v checks runtime availability, not project correctness');
	}
	if (profile === 'custom') {
		caveats.push('Custom fallback only checks the bundled runtime; configure project verifications explicitly');
	}
	// Monorepos get one suggested gate per subproject (block H); the single root gate stays the fallback.
	const suggested = suggestGates(await detectEcosystems(canonical));
	if (suggested.length > 1) { signals.push(...suggested.map(gate => gate.cwd + ': ' + gate.executable)); }
	const gates = suggested.length > 1 ? suggested : [{ id: 'verify', executable, args, cwd: '.' }];
	const config: ProjectConfig = { schemaVersion: 1, runtime: 'ide-native', profile, plan: { schemaVersion: 1, gates } };
	validateProjectConfig(config);
	return { config, signals, caveats, existing: false };
}

export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<string> {
	validateProjectConfig(config);
	const canonical = await fs.realpath(root);
	if ((await inspectHarnessAuthority(canonical)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
	const target = path.join(canonical, PROJECT_CONFIG);
	const raw = JSON.stringify(config, null, 2) + '\n';
	if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) {
		throw new Error('HARNESS_CONFIG_TOO_LARGE');
	}
	const handle = await fs.open(target, 'wx', 0o600);
	try {
		await handle.writeFile(raw, 'utf8');
	} finally {
		await handle.close();
	}
	return target;
}

export function generatedConfigDigest(config: ProjectConfig): string {
	return createHash('sha256').update(JSON.stringify(config, null, 2) + '\n').digest('hex');
}

/** Remove only the byte-identical configuration whose creation this IDE recorded. */
export async function removeGeneratedProjectConfig(root: string, expectedDigest: string): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest)) { throw Error('HARNESS_CONFIG_NOT_GENERATED'); }
	const canonical = await fs.realpath(root);
	if ((await inspectHarnessAuthority(canonical)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
	const raw = await readRegular(canonical, PROJECT_CONFIG, MAX_CONFIG_BYTES);
	if (raw === undefined || createHash('sha256').update(raw).digest('hex') !== expectedDigest) { throw Error('HARNESS_CONFIG_CHANGED'); }
	await fs.unlink(path.join(canonical, PROJECT_CONFIG));
}
