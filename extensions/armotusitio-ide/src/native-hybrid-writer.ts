/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Coordinated writes in a project governed by its own Harness. An IDE agent may modify such a project only
 * while the project engine has acknowledged an exclusive writer lease, under the shared fence, through the
 * authenticated protocol v2 (`ide-writer-lease` / `ide-writer-release`, each echoing nonce and fence epoch).
 * Nothing the engine reports is trusted blindly: the IDE also checks, before and after the agent, that the
 * engine has no running task, created no task during the lease and did not change its entrypoint, capability
 * manifest or gate catalog. Any doubt fails closed and leaves the project blocked for writers.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspectHarnessAuthority } from './native-authority.ts';
import { entryDigest, probeProjectHandshake, ProjectEngineError, readProjectCapabilities, runProjectEntry } from './native-engine-contract.ts';
import { queryProjectEngineStatus, type ProjectEngineObservation } from './native-engine-interop.ts';
import { readProjectGateCatalog } from './native-project-gates.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';

/** Verifiable record of one lease; contains identifiers and counts only, never logs or file contents. */
export interface WriterLeaseEvidence {
	leaseId: string;
	fenceEpoch: number;
	tasksBefore: string[];
	tasksAfter: string[];
	/** The engine had no lease to release (it expired, or the engine removed it); the IDE's own checks still passed. */
	leaseLost?: boolean;
}
export interface WriterLease {
	readonly leaseId: string;
	/** Fails closed with HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED when the engine broke the lease. */
	verify(): Promise<void>;
	/** Idempotent: tells the engine the writer finished, then verifies the whole lease once more. */
	release(): Promise<WriterLeaseEvidence>;
}

const LEASE_TIMEOUT_MS = 15_000;
const LEASE_QUERY_TIMEOUT_MS = 10_000;
const LEASE_ID = /^[a-f0-9]{32}$/;

function parseEcho(raw: string, nonce: string, action: 'lease' | 'release', epoch: number, leaseId?: string): { leaseId: string } {
	let value: Record<string, unknown>;
	try { value = JSON.parse(raw); } catch { throw Error('HARNESS_HYBRID_WRITER_RESPONSE_INVALID'); }
	const keys = action === 'lease' ? 'action,fenceEpoch,leaseId,nonce,runningTasks,schemaVersion,state' : 'action,fenceEpoch,leaseId,nonce,schemaVersion';
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys ||
		value.schemaVersion !== 2 || value.nonce !== nonce || value.action !== action || typeof value.leaseId !== 'string' || !LEASE_ID.test(value.leaseId) ||
		(leaseId !== undefined && value.leaseId !== leaseId)) {
		throw Error('HARNESS_HYBRID_WRITER_RESPONSE_INVALID');
	}
	// Echoing the IDE epoch proves the engine observed the shared writer fence.
	if (value.fenceEpoch !== epoch) { throw Error('HARNESS_HYBRID_WRITER_FENCE_IGNORED'); }
	if (action === 'lease' && (value.state !== 'quiescent' || value.runningTasks !== 0)) { throw Error('HARNESS_HYBRID_WRITER_PROJECT_BUSY'); }
	return { leaseId: value.leaseId };
}

/** Task ids when none is running; a running task means the engine may be writing right now. */
function quiescent(observation: ProjectEngineObservation): string[] {
	if (observation.tasks.some(task => task.status === 'running')) { throw Error('HARNESS_HYBRID_WRITER_PROJECT_BUSY'); }
	return observation.tasks.map(task => task.id).sort();
}

/** The canonical root and entrypoint of a project that is governed by its own Harness; anything else fails closed. */
async function engineEntry(root: string, trusted: () => boolean): Promise<{ canonical: string; entry: string }> {
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_STATUS_ROOT_CHANGED'); }
	const authority = await inspectHarnessAuthority(canonical);
	if (authority.engine !== 'project' || !authority.entry || authority.reason !== 'project-entry') { throw Error('HARNESS_HYBRID_WRITER_ENTRY_UNAVAILABLE'); }
	return { canonical, entry: path.join(canonical, authority.entry) };
}

export type EngineLeaseState = 'none' | 'valid' | 'expired' | 'foreign' | 'invalid';
const LEASE_STATES: readonly string[] = ['none', 'valid', 'expired', 'foreign', 'invalid'];
export interface EngineLease { state: EngineLeaseState; /** Local time the engine reports for a valid lease. */ expiresAt?: string }

/** `ide-lease` is the engine's operator command: it reports (or, with `clear`, removes) this clone's lease. */
async function leaseOperator(canonical: string, entry: string, args: string[]): Promise<Record<string, unknown>> {
	const { output } = await runProjectEntry(canonical, entry, ['ide-lease', ...args], LEASE_QUERY_TIMEOUT_MS, 'HARNESS_HYBRID_WRITER');
	let value: unknown;
	try { value = JSON.parse(output); } catch { throw Error('HARNESS_HYBRID_WRITER_RESPONSE_INVALID'); }
	if (!value || typeof value !== 'object' || Array.isArray(value) || typeof Reflect.get(value, 'state') !== 'string') { throw Error('HARNESS_HYBRID_WRITER_RESPONSE_INVALID'); }
	return { ...value };
}

/** The engine's view of this clone's writer lease; the IDE never infers it from files. */
export async function readWriterLease(root: string, trusted: () => boolean): Promise<EngineLease> {
	const { canonical, entry } = await engineEntry(root, trusted);
	const value = await leaseOperator(canonical, entry, []);
	const state = String(value.state);
	if (!LEASE_STATES.includes(state)) { throw Error('HARNESS_HYBRID_WRITER_RESPONSE_INVALID'); }
	return { state: state as EngineLeaseState, ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt.slice(0, 40) } : {}) };
}

/** Remove a lease left behind by an IDE that died while holding it. The caller must hold the shared fence, so no IDE run is writing. */
export async function clearWriterLease(root: string, trusted: () => boolean, fence: SharedExecutionFence): Promise<EngineLeaseState> {
	const { canonical, entry } = await engineEntry(root, trusted);
	await fence.assertCurrent();
	const value = await leaseOperator(canonical, entry, ['clear']);
	return value.state === 'cleared' && LEASE_STATES.includes(String(value.previous)) ? value.previous as EngineLeaseState : 'none';
}

/**
 * Acquire the writer lease of a project engine. Requires explicit consent (the approved plan), a trusted
 * workspace, the fence held by the caller and an engine that both declares and reports `writer-lease`.
 */
export async function acquireWriterLease(
	root: string, consent: boolean, trusted: () => boolean, fence: SharedExecutionFence, signal?: AbortSignal
): Promise<WriterLease> {
	if (!consent) { throw Error('HARNESS_HYBRID_WRITER_CONSENT_REQUIRED'); }
	const { canonical, entry } = await engineEntry(root, trusted);
	const handshake = await probeProjectHandshake(canonical, trusted);
	const declared = await readProjectCapabilities(canonical);
	for (const capability of ['writer-lease', 'durable-tasks'] as const) {
		if (!handshake.reported.includes(capability) || !declared.includes(capability)) { throw Error('HARNESS_HYBRID_WRITER_UNSUPPORTED'); }
	}
	const baseline = {
		entry: await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_UNSAFE'),
		capabilities: JSON.stringify(declared),
		gates: (await readProjectGateCatalog(canonical))?.digest ?? ''
	};
	const tasksBefore = quiescent(await queryProjectEngineStatus(canonical, true, trusted));
	const nonce = randomBytes(16).toString('hex');
	await fence.assertCurrent();
	const { output, cancelled } = await runProjectEntry(canonical, entry, ['ide-writer-lease', '--ide-protocol', '2', '--nonce', nonce, '--fence-epoch', String(fence.epoch)], LEASE_TIMEOUT_MS, 'HARNESS_HYBRID_WRITER', signal);
	if (cancelled) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
	const { leaseId } = parseEcho(output, nonce, 'lease', fence.epoch);

	let evidence: WriterLeaseEvidence | undefined;
	const violated = (): Error => Error('HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED');
	const check = async (): Promise<string[]> => {
		await fence.assertCurrent();
		if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
		if (await entryDigest(entry, 'HARNESS_PROJECT_STATUS_ENTRY_UNSAFE').catch(() => '') !== baseline.entry ||
			JSON.stringify(await readProjectCapabilities(canonical).catch(() => [])) !== baseline.capabilities ||
			((await readProjectGateCatalog(canonical).catch(() => undefined))?.digest ?? '') !== baseline.gates) { throw violated(); }
		let tasks: string[];
		try { tasks = quiescent(await queryProjectEngineStatus(canonical, true, trusted)); } catch (error) {
			throw error instanceof Error && error.message === 'HARNESS_HYBRID_WRITER_PROJECT_BUSY' ? violated() : error;
		}
		// A task the engine created during the lease means it kept working while the IDE agent was writing.
		if (tasks.join() !== tasksBefore.join()) { throw violated(); }
		return tasks;
	};
	return {
		leaseId,
		verify: async () => { await check(); },
		async release() {
			if (evidence) { return evidence; }
			const releaseNonce = randomBytes(16).toString('hex');
			let leaseLost = false;
			try {
				const result = await runProjectEntry(canonical, entry, ['ide-writer-release', '--ide-protocol', '2', '--nonce', releaseNonce, '--lease-id', leaseId, '--fence-epoch', String(fence.epoch)], LEASE_TIMEOUT_MS, 'HARNESS_HYBRID_WRITER');
				parseEcho(result.output, releaseNonce, 'release', fence.epoch, leaseId);
			} catch (error) {
				// The engine refuses to release a lease it no longer has (it outlived its time-to-live, or the engine removed it when a command
				// ran). That is not a broken lease: the checks below still prove the project stayed quiet while the agent wrote.
				const gone = error instanceof ProjectEngineError && await leaseOperator(canonical, entry, []).then(value => value.state === 'none' || value.state === 'expired', () => false);
				if (!gone) { throw error; }
				leaseLost = true;
			}
			evidence = { leaseId, fenceEpoch: fence.epoch, tasksBefore, tasksAfter: await check(), ...(leaseLost ? { leaseLost: true } : {}) };
			return evidence;
		}
	};
}
