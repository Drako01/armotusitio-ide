/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Loop and recovery guard for tool results. The same call failing again and again is the loop an agent falls into when it does not
 * change strategy, so after `LOOP_LIMIT` identical failures the call is answered with a stop (no execution, no retry storm) until the
 * hold expires or the call succeeds. Every failure also carries the shared classification (`native-failure-class.ts`): cause kind,
 * class and next step, so all tools speak the same recovery language. A failure of unknown cause is not annotated.
 */
import { classifyFailure } from './native-failure-class.ts';

export interface GuardResult { isError: boolean; text: string }

export const LOOP_LIMIT = 3;
export const LOOP_HOLD_MS = 2 * 60 * 1000;
const MAX_TRACKED_CALLS = 500;

interface Streak { failures: number; since: number; epoch: number }

export interface CallGuard {
	/** A stop message when this exact call already failed `LOOP_LIMIT` times in a row, else `undefined`. */
	stopped(key: string, epoch: number): GuardResult | undefined;
	/** Counts the outcome and annotates a failure with its classification. */
	record(key: string, epoch: number, result: GuardResult): GuardResult;
}

export function createCallGuard(now: () => number = Date.now): CallGuard {
	const streaks = new Map<string, Streak>();
	const live = (streak: Streak | undefined, epoch: number): streak is Streak => streak !== undefined && streak.epoch === epoch && now() - streak.since < LOOP_HOLD_MS;
	return {
		stopped(key, epoch) {
			const streak = streaks.get(key);
			if (!live(streak, epoch) || streak.failures < LOOP_LIMIT) { return undefined; }
			return { isError: true, text: 'LOOP: this exact call failed ' + streak.failures + ' times in a row. Do not repeat it: change the approach (different command, arguments or tool) or report the failure with its cause.' };
		},
		record(key, epoch, result) {
			if (!result.isError) { streaks.delete(key); return result; }
			const previous = streaks.get(key);
			// A denial is the user's or a policy's answer, handled elsewhere; counting it would hide the real reason.
			if (/^(?:DENIED|POLICY_DENIED|LOOP):/.test(result.text)) { return result; }
			const failures = live(previous, epoch) ? previous.failures + 1 : 1;
			if (streaks.size >= MAX_TRACKED_CALLS) { streaks.delete(streaks.keys().next().value as string); }
			streaks.set(key, { failures, since: live(previous, epoch) ? previous.since : now(), epoch });
			const failure = classifyFailure(result.text);
			return failure.kind === 'unknown' || result.text.includes(failure.kind + ', ' + failure.class + ']') ? result : { isError: true, text: result.text + '\n[' + failure.kind + ', ' + failure.class + '] ' + failure.hint };
		}
	};
}
