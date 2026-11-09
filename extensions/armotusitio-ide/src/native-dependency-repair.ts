/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `repair_dependencies`: diagnose a project's dependency install and repair it with the least invasive step, so a corrupt
 * `node_modules` no longer ends in "delete it by hand". Every effect goes through an injected step (the command policy for installs,
 * the file policy for the one deletion), so this module adds no authority of its own. The lockfile-respecting install is the one the
 * IDE already uses (`syncCommands`: frozen lockfile, no install scripts).
 *
 * Ladder: diagnose; healthy means nothing changes; otherwise reinstall in place (bounded retries for network failures only); if that
 * does not leave a healthy tree, delete the dependency folder once (approval and the protected-folder scan come from `delete_path`)
 * and install again. Two installs at most, never a loop.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Subproject } from './native-ecosystems.ts';
import type { SyncCommand } from './native-dependency-sync.ts';
import { classifyFailure } from './native-failure-class.ts';
import { redactSecrets } from './native-redact.ts';

export interface RepairStepResult { isError: boolean; text: string }
export interface RepairDeps {
	subprojects: readonly Subproject[];
	/** The lockfile-respecting install of every subproject (see `syncCommands`). */
	installCommands(): Promise<SyncCommand[]>;
	/** Runs a command under the command policy, from a project-relative folder. */
	run(command: string, args: string[], cwd: string): Promise<RepairStepResult>;
	/** `delete_path` under the file policy. */
	remove(relative: string): Promise<RepairStepResult>;
	root: string;
	sleep?(ms: number): Promise<void>;
}
export interface RepairInput { path?: unknown; mode?: unknown }
interface Diagnosis { installed: boolean; missing: string[]; unreadable: string[] }

const MAX_CHECKED_PACKAGES = 3000;
const NETWORK_RETRY_DELAYS_MS = [1000, 4000];
const TAIL_CHARS = 600;
const SKIP_DELETE_CLASSES = ['security-blocked', 'needs-approval', 'unrecoverable'];

const healthy = (diagnosis: Diagnosis): boolean => diagnosis.installed && !diagnosis.missing.length && !diagnosis.unreadable.length;
const describe = (diagnosis: Diagnosis): string => !diagnosis.installed ? 'node_modules is missing' :
	healthy(diagnosis) ? 'every declared package is installed and readable' :
		[diagnosis.missing.length ? 'missing: ' + diagnosis.missing.slice(0, 8).join(', ') : '', diagnosis.unreadable.length ? 'unreadable: ' + diagnosis.unreadable.slice(0, 8).join(', ') : ''].filter(Boolean).join('; ');

/** Declared dependencies whose `package.json` is absent or unreadable in `node_modules`: the cheapest reliable integrity signal. */
async function diagnose(root: string, projectPath: string): Promise<Diagnosis> {
	const folder = path.join(root, projectPath);
	const modules = path.join(folder, 'node_modules');
	if (!await fs.lstat(modules).then(stat => stat.isDirectory(), () => false)) { return { installed: false, missing: [], unreadable: [] }; }
	let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = {};
	try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); } catch { /* No readable manifest: nothing declared to verify. */ }
	const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].slice(0, MAX_CHECKED_PACKAGES);
	const missing: string[] = [], unreadable: string[] = [];
	await Promise.all(names.map(async name => {
		try { JSON.parse(await fs.readFile(path.join(modules, name, 'package.json'), 'utf8')); } catch (error) {
			((error as NodeJS.ErrnoException).code === 'ENOENT' ? missing : unreadable).push(name);
		}
	}));
	return { installed: true, missing: missing.sort(), unreadable: unreadable.sort() };
}

const tail = (text: string): string => redactSecrets(text.trim()).slice(-TAIL_CHARS);

function failed(projectPath: string, attempts: string[], last: RepairStepResult): RepairStepResult {
	const failure = classifyFailure(last.text);
	return { isError: true, text: 'FAILED ' + projectPath + ' [' + failure.kind + ', ' + failure.class + ']. Attempts: ' + attempts.join('; ') + '.\nCause: ' + tail(last.text) + '\nNext: ' + failure.hint };
}

/**
 * Go, Rust, .NET, Python (uv) and PHP have no `node_modules`-style integrity probe and their caches are not deleted by the agent: the
 * repair is the lockfile-exact install again (bounded retries for network failures), judged by its exit code.
 */
async function repairOtherEcosystem(deps: RepairDeps, project: Subproject, projectPath: string, mode: unknown): Promise<RepairStepResult> {
	const install = (await deps.installCommands()).find(command => command.cwd === projectPath);
	if (!install) { return { isError: true, text: 'BLOCKED no-lockfile: ' + projectPath + ' (' + project.ecosystem + ') has no lockfile, so an exact repair is not possible. Ask the user whether to generate one.' }; }
	if (mode === 'diagnose') { return { isError: false, text: 'DIAGNOSIS ' + projectPath + ' (' + project.ecosystem + '): no integrity check exists for this ecosystem; a repair runs "' + [install.command, ...install.args].join(' ') + '".' }; }
	const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const attempts: string[] = [];
	let result = await deps.run(install.command, install.args, install.cwd);
	for (const delay of NETWORK_RETRY_DELAYS_MS) {
		if (!result.isError || classifyFailure(result.text).kind !== 'network') { break; }
		attempts.push('install failed (network), retrying in ' + delay / 1000 + ' s');
		await sleep(delay);
		result = await deps.run(install.command, install.args, install.cwd);
	}
	attempts.push(result.isError ? 'install failed' : 'install ran');
	return result.isError ? failed(projectPath, attempts, result) : { isError: false, text: 'REPAIRED ' + projectPath + ' (' + project.ecosystem + ' reinstall from the lockfile). ' + attempts.join('; ') + '. The ecosystem cannot verify the result: run the relevant tests next.' };
}

export async function repairDependencies(deps: RepairDeps, input: RepairInput): Promise<RepairStepResult> {
	const projectPath = typeof input.path === 'string' && input.path.trim() ? path.posix.normalize(input.path.replace(/\\/g, '/')).replace(/\/+$/, '') || '.' : '.';
	const mode = input.mode === undefined ? 'repair' : input.mode;
	if (mode !== 'repair' && mode !== 'diagnose') { return { isError: true, text: 'Invalid input: { path?: string, mode?: "repair" | "diagnose" }' }; }
	const project = deps.subprojects.find(candidate => candidate.path === projectPath);
	if (!project) { return { isError: true, text: 'BLOCKED no-project: no project at "' + projectPath + '". Known: ' + (deps.subprojects.map(p => p.path).join(', ') || 'none') + '.' }; }
	if (project.ecosystem !== 'node') { return await repairOtherEcosystem(deps, project, projectPath, mode); }

	const before = await diagnose(deps.root, projectPath);
	if (mode === 'diagnose') { return { isError: false, text: 'DIAGNOSIS ' + projectPath + ' (' + (project.packageManager ?? 'npm') + '): ' + describe(before) + '.' }; }
	if (healthy(before)) { return { isError: false, text: 'HEALTHY ' + projectPath + ': ' + describe(before) + '. Nothing changed; if commands still fail the cause is not the install.' }; }

	const install = (await deps.installCommands()).find(command => command.cwd === projectPath && !command.cacheOnly);
	if (!install) { return { isError: true, text: 'BLOCKED no-lockfile: ' + projectPath + ' has no lockfile for ' + (project.packageManager ?? 'npm') + ', so an exact repair is not possible. Ask the user whether to generate one.' }; }

	const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const attempts: string[] = [];
	// Only a network failure is retried as is: the install is idempotent (frozen lockfile) and the failure is transient.
	const runInstall = async (label: string): Promise<RepairStepResult> => {
		let result = await deps.run(install.command, install.args, install.cwd);
		for (const delay of NETWORK_RETRY_DELAYS_MS) {
			if (!result.isError || classifyFailure(result.text).kind !== 'network') { break; }
			attempts.push(label + ' failed (network), retrying in ' + delay / 1000 + ' s');
			await sleep(delay);
			result = await deps.run(install.command, install.args, install.cwd);
		}
		attempts.push(label + (result.isError ? ' failed' : ' ran'));
		return result;
	};
	const verified = async (how: string, last: RepairStepResult): Promise<RepairStepResult | undefined> => {
		const after = await diagnose(deps.root, projectPath);
		return !last.isError && healthy(after)
			? { isError: false, text: 'REPAIRED ' + projectPath + ' (' + how + '). ' + attempts.join('; ') + '. Run the relevant tests next to confirm the project works.' }
			: undefined;
	};

	const first = await runInstall('reinstall in place');
	const repaired = await verified('reinstall in place, folder kept', first);
	if (repaired) { return repaired; }
	// Do not delete what a policy refused to touch, what needs the user, or what a full disk will not fix.
	if (first.isError && SKIP_DELETE_CLASSES.includes(classifyFailure(first.text).class)) { return failed(projectPath, attempts, first); }

	const removed = await deps.remove(path.posix.join(projectPath, 'node_modules'));
	attempts.push('delete node_modules ' + (removed.isError ? 'refused' : 'done'));
	if (removed.isError) { return failed(projectPath, attempts, removed); }
	const second = await runInstall('clean install');
	return await verified('clean reinstall', second) ?? failed(projectPath, attempts, second);
}
