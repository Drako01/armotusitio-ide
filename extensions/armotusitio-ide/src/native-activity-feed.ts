/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Single activity feed (block AC): every producer publishes here and every view reads it; no view keeps its own copy. */
import type { RunNeed, RunOutcomeKind } from './native-run-outcome.ts';

export type ActivityKind = 'chat-run' | 'goal' | 'step' | 'command' | 'process' | 'delivery' | 'environment' | 'external' | 'task';
export type ActivityNeed = RunNeed | 'answer' | 'approval' | 'review';
export type ActivityState = RunOutcomeKind | 'queued' | 'running' | 'paused' | 'cancelled' | 'interrupted';
/** Actions a view may offer; each one maps to the same command the chat uses. */
export type ActivityActionId = 'open' | 'stop' | 'approve' | 'continue' | 'retry' | 'answer';
export interface ActivityItem {
	id: string;
	kind: ActivityKind;
	parentId?: string;
	project: string;
	title: string;
	state: ActivityState;
	step?: { index: number; total: number; label: string; agent?: string };
	provider?: string;
	startedAt: number;
	updatedAt: number;
	budget?: { turns?: [number, number]; ms?: [number, number] };
	needs?: ActivityNeed;
	/** One-line summary of what happened or what is needed, in the user's language. */
	detail?: string;
	actions: ActivityActionId[];
	/** The source stopped answering; the item shows its last known state instead of disappearing. */
	stale?: boolean;
	origin: 'this-window' | 'other-window' | 'external';
}
export interface ActivityFeed {
	publish(item: ActivityItem): void;
	/** Remove items a producer no longer reports (a finished external task that left its source). */
	retain(predicate: (item: ActivityItem) => boolean): void;
	appendOutput(id: string, text: string): void;
	snapshot(): readonly ActivityItem[];
	tail(id: string, lines: number): string[];
	onDidChange(listener: (ids: readonly string[]) => void): { dispose(): void };
}

const MAX_ITEMS = 200;
const MAX_OUTPUT_LINES = 200;
/** At most four change notifications per second; bursts are grouped into one. */
const NOTIFY_INTERVAL_MS = 250;
const ACTIVE: readonly ActivityState[] = ['queued', 'running', 'paused'];

/** Active and attention-needing items first, then the newest; finished items beyond MAX_ITEMS are dropped. */
export function activityOrder(left: ActivityItem, right: ActivityItem): number {
	const rank = (item: ActivityItem) => item.needs ? 0 : ACTIVE.includes(item.state) ? 1 : 2;
	return rank(left) - rank(right) || right.updatedAt - left.updatedAt;
}

export function createActivityFeed(schedule: (callback: () => void, ms: number) => { cancel(): void } = (callback, ms) => {
	const timer = setTimeout(callback, ms); timer.unref?.();
	return { cancel: () => clearTimeout(timer) };
}): ActivityFeed {
	const items = new Map<string, ActivityItem>();
	const output = new Map<string, string[]>();
	const listeners = new Set<(ids: readonly string[]) => void>();
	const changed = new Set<string>();
	let pending: { cancel(): void } | undefined;
	let lastNotified = 0;
	const flush = (): void => {
		pending = undefined; lastNotified = Date.now();
		const ids = [...changed]; changed.clear();
		for (const listener of listeners) {
			try { listener(ids); } catch { /* A failing view never stops the others. */ }
		}
	};
	const touch = (id: string): void => {
		changed.add(id);
		if (pending) { return; }
		pending = schedule(flush, Math.max(0, NOTIFY_INTERVAL_MS - (Date.now() - lastNotified)));
	};
	const trim = (): void => {
		if (items.size <= MAX_ITEMS) { return; }
		for (const item of [...items.values()].sort(activityOrder).slice(MAX_ITEMS)) { items.delete(item.id); output.delete(item.id); touch(item.id); }
	};
	return {
		publish(item) {
			const previous = items.get(item.id);
			if (previous && JSON.stringify(previous) === JSON.stringify(item)) { return; }
			items.set(item.id, { ...item }); touch(item.id); trim();
		},
		retain(predicate) {
			for (const item of [...items.values()]) {
				if (!predicate(item)) { items.delete(item.id); output.delete(item.id); touch(item.id); }
			}
		},
		appendOutput(id, text) {
			if (!items.has(id) || !text) { return; }
			const lines = [...(output.get(id) ?? []), ...text.split(/\r?\n/).filter(line => line.trim())].slice(-MAX_OUTPUT_LINES);
			output.set(id, lines); touch(id);
		},
		snapshot() { return [...items.values()].sort(activityOrder); },
		tail(id, count) { return (output.get(id) ?? []).slice(-Math.max(0, count)); },
		onDidChange(listener) {
			listeners.add(listener);
			return { dispose: () => { listeners.delete(listener); } };
		}
	};
}
