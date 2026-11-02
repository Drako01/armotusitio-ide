/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TtlCache } from '../src/native-ttl-cache.ts';

describe('TtlCache', () => {
	test('shares one load between concurrent callers and reuses it until the TTL expires', async () => {
		let clock = 0;
		let loads = 0;
		const cache = new TtlCache<number>(1000, () => clock);
		const load = async () => ++loads;
		assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load)]), [1, 1]);
		assert.equal(await cache.get('a', load), 1);
		clock = 1001;
		assert.equal(await cache.get('a', load), 2);
	});

	test('force and invalidate go back to the source', async () => {
		let loads = 0;
		const cache = new TtlCache<number>(1000);
		const load = async () => ++loads;
		await cache.get('a', load);
		assert.equal(await cache.get('a', load, true), 2);
		cache.invalidate();
		assert.equal(await cache.get('a', load), 3);
	});

	test('does not keep values the policy rejects, and a result that was invalidated mid-flight', async () => {
		let loads = 0;
		const cache = new TtlCache<number>(1000, Date.now, value => value > 1);
		const load = async () => ++loads;
		await cache.get('a', load);
		assert.equal(await cache.get('a', load), 2);
		assert.equal(await cache.get('a', load), 2);
		const slow = new TtlCache<number>(1000);
		let release = () => { };
		const first = slow.get('b', () => new Promise<number>(resolve => { release = () => resolve(10); }));
		slow.invalidate('b');
		release();
		await first;
		assert.equal(await slow.get('b', async () => 20), 20);
	});
});
