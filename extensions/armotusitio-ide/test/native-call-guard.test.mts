/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallGuard, LOOP_HOLD_MS, LOOP_LIMIT } from '../src/native-call-guard.ts';

const fail = (text: string) => ({ isError: true, text });

test('the same failing call is stopped after the limit, and a success clears it', () => {
	const guard = createCallGuard(() => 0);
	const outcomes: Array<string | undefined> = [];
	for (let i = 0; i < LOOP_LIMIT; i++) { outcomes.push(guard.stopped('k', 0)?.text.slice(0, 5)); guard.record('k', 0, fail('exit 1')); }
	outcomes.push(guard.stopped('k', 0)?.text.slice(0, 5), guard.stopped('other', 0)?.text);
	guard.record('k', 0, { isError: false, text: 'ok' });
	outcomes.push(guard.stopped('k', 0)?.text);
	assert.deepEqual(outcomes, [undefined, undefined, undefined, 'LOOP:', undefined, undefined]);
});

test('the hold expires and a new turn starts clean', () => {
	let clock = 0;
	const guard = createCallGuard(() => clock);
	for (let i = 0; i < LOOP_LIMIT; i++) { guard.record('k', 0, fail('exit 1')); }
	const sameTurn = guard.stopped('k', 0) !== undefined, nextTurn = guard.stopped('k', 1) !== undefined;
	clock = LOOP_HOLD_MS;
	assert.deepEqual({ sameTurn, nextTurn, expired: guard.stopped('k', 0) !== undefined }, { sameTurn: true, nextTurn: false, expired: false });
});

test('failures carry the shared classification, once, and denials are left alone', () => {
	const guard = createCallGuard(() => 0);
	const locked = guard.record('a', 0, fail('EBUSY: resource busy'));
	const annotated = guard.record('b', 0, fail('FAILED . [locked-files, change-strategy]. Cause: EBUSY'));
	const unknown = guard.record('c', 0, fail('something odd'));
	const denied = guard.record('d', 0, fail('DENIED: the user did not allow it'));
	for (let i = 0; i < LOOP_LIMIT; i++) { guard.record('d', 0, fail('DENIED: the user did not allow it')); }
	assert.deepEqual({ locked: /\[locked-files, change-strategy\] Another process/.test(locked.text), annotated: annotated.text.match(/locked-files/g)?.length, unknown: unknown.text, denied: denied.text, deniedNeverLoops: guard.stopped('d', 0) }, { locked: true, annotated: 1, unknown: 'something odd', denied: 'DENIED: the user did not allow it', deniedNeverLoops: undefined });
});
