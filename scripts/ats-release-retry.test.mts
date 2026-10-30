/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { waitForReleaseByTag } from './ats-autoupdate.mts';

test('new draft lookup retries missing listings without repeating creation', async () => {
	let calls = 0; const waits: number[] = [];
	const result = await waitForReleaseByTag('ats-v1.144.0-r1', async (file, args) => {
		assert.equal(file, 'gh'); assert.equal(args[0], 'api');
		return JSON.stringify(++calls < 3 ? [[]] : [[{ tag_name: 'ats-v1.144.0-r1', id: 1, draft: true, target_commitish: 'a'.repeat(40) }]]);
	}, async ms => { waits.push(ms); });
	assert.equal(result.id, 1); assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
});

test('draft lookup is bounded and does not retry authentication or malformed API failures', async () => {
	let calls = 0;
	await assert.rejects(waitForReleaseByTag('tag', async () => { calls++; return '[[]]'; }, async () => { }), /not visible yet/);
	assert.equal(calls, 6);
	for (const response of ['invalid', '{}']) {
		calls = 0;
		await assert.rejects(waitForReleaseByTag('tag', async () => { calls++; return response; }, async () => { }));
		assert.equal(calls, 1);
	}
	calls = 0;
	await assert.rejects(waitForReleaseByTag('tag', async () => { calls++; throw new Error('authentication'); }, async () => { }), /authentication/);
	assert.equal(calls, 1);
});
