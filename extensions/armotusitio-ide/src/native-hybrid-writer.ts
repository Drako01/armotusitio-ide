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
import { entryDigest, probeProjectHandshake, readProjectCapabilities, runProjectEntry } from './native-engine-contract.ts';
import { queryProjectEngineStatus, type ProjectEngineObservation } from './native-engine-interop.ts';
import { readProjectGateCatalog } from './native-project-gates.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';

/** Verifiable record of one lease; contains identifiers and counts only, never logs or file contents. */
export interface WriterLeaseEvidence {
	leaseId: string;
	fenceEpoch: number;
	tasksBefore: string[];
	tasksAfter: string[];
}
export interface WriterLease {
	readonly leaseId: string;
	/** Fails closed with HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED when the engine broke the lease. */
	verify(): Promise<void>;
	/** Idempotent: tells the engine the writer finished, then verifies the whole lease once more. */
	release(): Promise<WriterLeaseEvidence>;
}

const LEASE_TIMEOUT_MS = 15_000;
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

/**
 * Acquire the writer lease of a project engine. Requires explicit consent (the approved plan), a trusted
 * workspace, the fence held by the caller and an engine that both declares and reports `writer-lease`.
 */
export async function acquireWriterLease(
	root: string, consent: boolean, trusted: () => boolean, fence: SharedExecutionFence, signal?: AbortSignal
): Promise<WriterLease> {
	if (!consent) { throw Error('HARNESS_HYBRID_WRITER_CONSENT_REQUIRED'); }
	if (!trusted()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_STATUS_ROOT_CHANGED'); }
	const authority = await inspectHarnessAuthority(canonical);
	if (authority.engine !== 'project' || !authority.entry || authority.reason !== 'project-entry') { throw Error('HARNESS_HYBRID_WRITER_ENTRY_UNAVAILABLE'); }
	const handshake = await probeProjectHandshake(canonical, trusted);
	const declared = await readProjectCapabilities(canonical);
	for (const capability of ['writer-lease', 'durable-tasks'] as const) {
		if (!handshake.reported.includes(capability) || !declared.includes(capability)) { throw Error('HARNESS_HYBRID_WRITER_UNSUPPORTED'); }
	}
	const entry = path.join(canonical, authority.entry);
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
			const result = await runProjectEntry(canonical, entry, ['ide-writer-release', '--ide-protocol', '2', '--nonce', releaseNonce, '--lease-id', leaseId, '--fence-epoch', String(fence.epoch)], LEASE_TIMEOUT_MS, 'HARNESS_HYBRID_WRITER');
			parseEcho(result.output, releaseNonce, 'release', fence.epoch, leaseId);
			evidence = { leaseId, fenceEpoch: fence.epoch, tasksBefore, tasksAfter: await check() };
			return evidence;
		}
	};
}
