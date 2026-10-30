/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Explicit, bounded project-engine protocol v2: read-only status queries and
 * single-gate delegation under the IDE shared fence. Both invoke trusted project
 * code only after a separate user consent. No project execution authority or
 * writer lease can be obtained from a response.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspectHarnessAuthority } from './native-authority.ts';
import { entryDigest, probeProjectHandshake, readProjectCapabilities, runProjectEntry, type Capability } from './native-engine-contract.ts';
import { readProjectGateCatalog, validateProjectGateCatalog } from './native-project-gates.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';

export interface ProjectEngineTaskStatus {
	id: string;
	status: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
}
export interface ProjectEngineObservation {
	schemaVersion: 2;
	tasks: ProjectEngineTaskStatus[];
	executionEnabled: false;
}
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
	const digest = await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_UNSAFE');
	const nonce = randomBytes(16).toString('hex');
	const { output } = await runProjectEntry(canonical, entry, ['ide-status', '--ide-protocol', '2', '--nonce', nonce], 5000, 'HARNESS_PROJECT_STATUS');
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	if (await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_CHANGED').catch(() => '') !== digest) {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_CHANGED');
	}
	const currentDeclared = await readProjectCapabilities(canonical);
	if (JSON.stringify(currentDeclared) !== JSON.stringify(declared)) {
		throw Error('HARNESS_PROJECT_STATUS_CAPABILITIES_CHANGED');
	}
	return validateStatusOutput(output, nonce);
}

/** Evidence returned by a project engine for one delegated gate; never contains logs. */
export interface DelegatedGateResult {
	schemaVersion: 2;
	gate: string;
	status: 'passed' | 'failed' | 'cancelled';
	durationMs: number;
	fenceEpoch: number;
	evidenceDigest: string | null;
}

function validateGateOutput(raw: string, nonce: string, gate: string, epoch: number): DelegatedGateResult {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); }
	catch { throw Error('HARNESS_PROJECT_GATE_INVALID'); }
	const value = parsed as Record<string, unknown>;
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== 'durationMs,evidenceDigest,fenceEpoch,gate,nonce,schemaVersion,status' ||
		value.schemaVersion !== 2 || value.nonce !== nonce || value.gate !== gate ||
		(value.status !== 'passed' && value.status !== 'failed') ||
		!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0 ||
		typeof value.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidenceDigest)) {
		throw Error('HARNESS_PROJECT_GATE_INVALID');
	}
	// Echoing the IDE epoch proves the engine observed the shared writer fence.
	if (value.fenceEpoch !== epoch) { throw Error('HARNESS_PROJECT_GATE_FENCE_IGNORED'); }
	return { schemaVersion: 2, gate, status: value.status, durationMs: value.durationMs as number, fenceEpoch: epoch, evidenceDigest: value.evidenceDigest };
}

/**
 * Protocol v2 gate delegation: the IDE holds the shared fence, the project engine
 * runs ONE gate declared in its catalog and must echo nonce, gate and fence epoch.
 * Requires explicit consent and both declared and handshake-reported
 * `verification-gates` + `bounded-processes`. The entrypoint, capability manifest
 * and gate catalog must be unchanged afterwards. Cancellation kills the process.
 */
export async function delegateProjectGate(
	root: string, gateId: string, consent: boolean, trusted: () => boolean,
	fence: SharedExecutionFence, signal?: AbortSignal, timeoutMs = 120_000
): Promise<DelegatedGateResult> {
	if (!consent) { throw Error('HARNESS_PROJECT_GATE_CONSENT_REQUIRED'); }
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60_000) { throw Error('HARNESS_PROJECT_GATE_INVALID'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_STATUS_ROOT_CHANGED'); }
	const authority = await inspectHarnessAuthority(canonical);
	if (authority.engine !== 'project' || !authority.entry || authority.reason !== 'project-entry') {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_UNAVAILABLE');
	}
	const catalog = await readProjectGateCatalog(canonical);
	if (!catalog?.gates.some(gate => gate.id === gateId)) { throw Error('HARNESS_PROJECT_GATE_UNKNOWN'); }
	const handshake = await probeProjectHandshake(canonical, trusted);
	const declared = await readProjectCapabilities(canonical);
	const required: Capability[] = ['verification-gates', 'bounded-processes'];
	if (!required.every(capability => handshake.reported.includes(capability) && declared.includes(capability))) {
		throw Error('HARNESS_PROJECT_GATE_UNSUPPORTED');
	}
	const entry = path.join(canonical, authority.entry);
	const digest = await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_UNSAFE');
	const nonce = randomBytes(16).toString('hex');
	await fence.assertCurrent();
	const started = Date.now();
	const { output, cancelled } = await runProjectEntry(canonical, entry, [
		'ide-gate', '--ide-protocol', '2', '--nonce', nonce, '--gate', gateId, '--fence-epoch', String(fence.epoch)
	], timeoutMs, 'HARNESS_PROJECT_GATE', signal);
	await fence.assertCurrent();
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	if (await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_CHANGED').catch(() => '') !== digest) {
		throw Error('HARNESS_PROJECT_STATUS_ENTRY_CHANGED');
	}
	if (JSON.stringify(await readProjectCapabilities(canonical)) !== JSON.stringify(declared)) {
		throw Error('HARNESS_PROJECT_STATUS_CAPABILITIES_CHANGED');
	}
	await validateProjectGateCatalog(canonical, catalog.digest);
	if (cancelled) {
		return { schemaVersion: 2, gate: gateId, status: 'cancelled', durationMs: Date.now() - started, fenceEpoch: fence.epoch, evidenceDigest: null };
	}
	return validateGateOutput(output, nonce, gateId, fence.epoch);
}
