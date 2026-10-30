/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireSharedExecutionFence } from '../src/native-shared-fence.ts';
import { reserveProviderInvocation } from '../src/native-provider-quota.ts';

test('durable provider quota rejects over-budget concurrent readers before CLI launch', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-workflow');
		try {
			const now = 1700000000000;
			const results = await Promise.allSettled([
				reserveProviderInvocation(storage, 'codex', fence, 1, now),
				reserveProviderInvocation(storage, 'codex', fence, 1, now)
			]);
			assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
			assert.equal(results.filter(result => result.status === 'rejected').length, 1);
			const rejected = results.find(result => result.status === 'rejected');
			assert.equal(rejected?.status, 'rejected');
			if (rejected?.status === 'rejected') {
				assert.match(String(rejected.reason), /HARNESS_PROVIDER_QUOTA_EXCEEDED/);
			}
			const other = await reserveProviderInvocation(storage, 'claude', fence, 1, now);
			assert.deepEqual(other, { used: 1, remaining: 0 });
			const stored = JSON.parse(await fs.readFile(path.join(storage, 'provider-invocations.json'), 'utf8'));
			assert.deepEqual(stored.entries.map(entry => entry.provider), ['codex', 'claude']);
			// Credits expire only after the entire rolling window.
			assert.deepEqual(await reserveProviderInvocation(storage, 'codex', fence, 1, now + 86400001),
				{ used: 1, remaining: 0 });
		} finally { await fence.release(); }
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('provider quota fails closed on invalid policy, corrupt state or a lost fence', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-bad-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-bad-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-agent');
		try {
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 0),
				/HARNESS_PROVIDER_QUOTA_POLICY_INVALID/);
			const now = 1700000000000;
			await reserveProviderInvocation(storage, 'codex', fence, 2, now);
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now - 1),
				/HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK/);
			const ledger = path.join(storage, 'provider-invocations.json');
			await fs.writeFile(ledger, '{"schemaVersion":999}');
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now + 1000),
				/HARNESS_PROVIDER_QUOTA_INVALID/);
			await fs.rm(ledger);
			await fence.release();
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now + 1000),
				/HARNESS_FENCE_ALREADY_RELEASED/);
		} finally {
			// If an assertion fails, never remove the owner's lock without checking identity.
			await fence.release().catch(() => { });
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});
