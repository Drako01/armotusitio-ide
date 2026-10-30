/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Explicit, bounded project-engine status query. This invokes trusted project
 * code only after a separate user consent. No project execution authority,
 * writer lease or gate dispatch can be obtained from a status response.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { inspectHarnessAuthority } from './native-authority.ts';
import { probeProjectHandshake, readProjectCapabilities } from './native-engine-contract.ts';

export interface ProjectEngineTaskStatus {
	id: string;
	status: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
}
export interface ProjectEngineObservation {
	schemaVersion: 2;
	tasks: ProjectEngineTaskStatus[];
	executionEnabled: false;
}
const MAX_BYTES = 16 * 1024;
const VALID_STATES = ['running', 'passed', 'failed', 'cancelled', 'interrupted'];

function validateStatusOutput(raw: string, nonce: string): ProjectEngineObservation {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); }
	catch { throw Error('HARNESS_PROJECT_STATUS_INVALID'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw Error('HARNESS_PROJECT_STATUS_INVALID');
	}
	const status = parsed as { schemaVersion?: unknown; nonce?: unknown; executionEnabled?: unknown; tasks?: unknown };
	if (Object.keys(status).sort().join(',') !== 'executionEnabled,nonce,schemaVersion,tasks' ||
		status.schemaVersion !== 2 || status.nonce !== nonce || status.executionEnabled !== false ||
		!Array.isArray(status.tasks) || status.tasks.length > 32 || status.tasks.some(task =>
			!task || typeof task !== 'object' || Array.isArray(task) ||
			Object.keys(task).sort().join(',') !== 'id,status' ||
			typeof task.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(task.id) ||
			!VALID_STATES.includes(task.status)) ||
		new Set(status.tasks.map(task => task.id)).size !== status.tasks.length) {
		throw Error('HARNESS_PROJECT_STATUS_INVALID');
	}
	return { schemaVersion: 2, executionEnabled: false, tasks: status.tasks };
}

/** Read-only contract observation is advisory, not an OS sandbox or permission grant. */
export async function queryProjectEngineStatus(root: string, consent: boolean, trusted: () => boolean): Promise<ProjectEngineObservation> {
	if (!consent) { throw Error('HARNESS_PROJECT_STATUS_CONSENT_REQUIRED'); }
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_STATUS_ROOT_CHANGED'); }
	const authority = await inspectHarnessAuthority(canonical);
	if (authority.engine !== 'project' || !authority.entry || authority.reason !== 'project-entry') {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_UNAVAILABLE');
	}
	// A versioned capability handshake precedes optional status transport.
	const handshake = await probeProjectHandshake(canonical, trusted);
	const declared = await readProjectCapabilities(canonical);
	if (!handshake.reported.includes('durable-tasks') || !declared.includes('durable-tasks')) {
		throw Error('HARNESS_PROJECT_STATUS_UNSUPPORTED');
	}
	const entry = path.join(canonical, authority.entry);
	const stat = await fs.lstat(entry);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 ||
		await fs.realpath(entry) !== entry) {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_UNSAFE');
	}
	const digest = createHash('sha256').update(await fs.readFile(entry)).digest('hex');
	const nonce = randomBytes(16).toString('hex');
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
		if (process.env[key]) { env[key] = process.env[key]; }
	}
	env.ELECTRON_RUN_AS_NODE = '1';
	const output = await new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, [entry, 'ide-status', '--ide-protocol', '2', '--nonce', nonce], {
			cwd: canonical, shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
		});
		let buffer = '', size = 0, finished = false;
		const finish = (error?: Error): void => {
			if (finished) { return; }
			finished = true;
			clearTimeout(timer);
			if (error) { child.kill(); reject(error); } else { resolve(buffer); }
		};
		const timer = setTimeout(() => finish(Error('HARNESS_PROJECT_STATUS_TIMEOUT')), 5000);
		timer.unref();
		child.stdout?.on('data', (part: Buffer) => {
			size += part.length;
			if (size > MAX_BYTES) { finish(Error('HARNESS_PROJECT_STATUS_OVERSIZED')); }
			else { buffer += part.toString('utf8'); }
		});
		child.stderr?.on('data', (part: Buffer) => {
			size += part.length;
			if (size > MAX_BYTES) { finish(Error('HARNESS_PROJECT_STATUS_OVERSIZED')); }
		});
		child.once('error', () => finish(Error('HARNESS_PROJECT_STATUS_PROCESS')));
		child.once('close', code => finish(code === 0 ? undefined : Error('HARNESS_PROJECT_STATUS_FAILED')));
	});
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	const current = await fs.lstat(entry);
	if (!current.isFile() || current.isSymbolicLink() || current.size > 16 * 1024 * 1024 ||
		await fs.realpath(entry) !== entry ||
		createHash('sha256').update(await fs.readFile(entry)).digest('hex') !== digest) {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_CHANGED');
	}
	const currentDeclared = await readProjectCapabilities(canonical);
	if (JSON.stringify(currentDeclared) !== JSON.stringify(declared)) {
		throw Error('HARNESS_PROJECT_STATUS_CAPABILITIES_CHANGED');
	}
	return validateStatusOutput(output, nonce);
}
