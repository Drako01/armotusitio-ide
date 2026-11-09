/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * AUD-P1-004: real processes compete for the project's writer fence. Twenty rounds of: one process holds it, a second one and the
 * parent are refused, the holder is killed without releasing, nobody inherits a dead owner's fence, and only the explicit
 * reconciliation (consent plus the operator's attestation) frees it for the next writer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireSharedExecutionFence, inspectSharedExecutionFence, reconcileSharedExecutionFence } from '../src/native-shared-fence.ts';

const CHILD = path.join(import.meta.dirname, 'native-fence-child.mts');
const ROUNDS = 20;

function launch(root: string, storage: string, owner: string): { process: ChildProcess; first: Promise<string> } {
	const child = spawn(process.execPath, ['--no-warnings', CHILD, root, storage, owner], { stdio: ['ignore', 'pipe', 'ignore'] });
	const first = new Promise<string>((resolve, reject) => {
		let seen = '';
		child.stdout!.on('data', chunk => { seen += chunk; if (seen.includes('\n')) { resolve(seen.trim()); } });
		child.on('error', reject);
		child.on('exit', () => resolve(seen.trim() || 'exited'));
	});
	return { process: child, first };
}

const exited = (child: ChildProcess): Promise<void> => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()));

test('twenty rounds of competing and killed writers never produce two writers or an inherited dead fence', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-proc-')));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-proc-data-'));
	const rounds: Array<Record<string, unknown>> = [];
	try {
		for (let round = 1; round <= ROUNDS; round++) {
			const holder = launch(root, storage, 'native-task');
			const held = await holder.first;
			const contender = launch(root, storage, 'native-agent');
			const refusedChild = (await contender.first).startsWith('refused:HARNESS_');
			const refusedParent = await acquireSharedExecutionFence(root, storage, 'native-workflow').then(() => false, () => true);
			holder.process.kill('SIGKILL');
			await exited(holder.process);
			const inheritedDead = await acquireSharedExecutionFence(root, storage, 'native-workflow').then(() => true, () => false);
			const recovered = await reconcileSharedExecutionFence(root, storage, true, true);
			const successor = await acquireSharedExecutionFence(root, storage, 'native-task');
			await successor.release();
			rounds.push({ round, held: held.startsWith('held:'), refusedChild, refusedParent, inheritedDead, recovered: recovered.released, monotonic: successor.epoch > Number(held.split(':')[1]) });
			await exited(contender.process);
		}
		assert.deepEqual(rounds, Array.from({ length: ROUNDS }, (_, index) => ({ round: index + 1, held: true, refusedChild: true, refusedParent: true, inheritedDead: false, recovered: true, monotonic: true })));
		assert.deepEqual(await inspectSharedExecutionFence(root, storage), { held: false, epoch: null });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});
