/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Long processes and notifications (block Y). A script (such as `release.sh`) reports progress by writing a small JSON
 * file in a folder the IDE watches; the IDE publishes it to the feed, detects a stall and notifies the end. Notifications
 * carry only a title and a state, never code, paths or output.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { processAlive } from './native-runtime.ts';
import type { ActivityFeed, ActivityItem } from './native-activity-feed.ts';

/** Written by the process at each phase: `{"title":"Release r5","phase":"build-all","percent":40,"pid":123,"log":"/abs/build.log","state":"running"}`. */
export interface ProgressFile { title: string; phase?: string; percent?: number; pid?: number; log?: string; state?: 'running' | 'completed' | 'failed'; updatedAt?: string }
export interface ProcessView { id: string; title: string; phase?: string; percent?: number; state: 'running' | 'completed' | 'failed' | 'stalled' | 'interrupted'; logTail: string[]; updatedAt: number }

const TAIL_LINES = 8;
const TAIL_BYTES = 16 * 1024;

async function tail(file: string | undefined): Promise<{ lines: string[]; size: number; modified: number }> {
	if (!file) { return { lines: [], size: 0, modified: 0 }; }
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat) { return { lines: [], size: 0, modified: 0 }; }
	const handle = await fs.open(file, 'r');
	try {
		const length = Math.min(stat.size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, stat.size - length);
		return { lines: buffer.toString('utf8').split(/\r?\n/).filter(line => line.trim()).slice(-TAIL_LINES), size: stat.size, modified: stat.mtimeMs };
	} finally { await handle.close(); }
}

/**
 * Read every progress file. A running process with no new output and no progress update for `stallMinutes` is "stalled";
 * one whose pid is gone without a final state is "interrupted".
 */
export async function readProcesses(directory: string, stallMinutes: number, now = Date.now()): Promise<ProcessView[]> {
	const names = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
	const views: ProcessView[] = [];
	for (const name of names) {
		const file = path.join(directory, name);
		let progress: ProgressFile;
		try { progress = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
		if (typeof progress?.title !== 'string') { continue; }
		const stat = await fs.stat(file);
		const log = await tail(typeof progress.log === 'string' ? progress.log : undefined);
		const updatedAt = Math.max(stat.mtimeMs, log.modified);
		let state: ProcessView['state'] = progress.state === 'completed' || progress.state === 'failed' ? progress.state : 'running';
		if (state === 'running' && progress.pid && !processAlive(progress.pid)) { state = 'interrupted'; }
		else if (state === 'running' && now - updatedAt > stallMinutes * 60_000) { state = 'stalled'; }
		views.push({ id: name.slice(0, -5), title: progress.title.slice(0, 120), ...(progress.phase ? { phase: String(progress.phase).slice(0, 80) } : {}), ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}), state, logTail: log.lines, updatedAt });
	}
	return views;
}

export function processActivityItem(view: ProcessView, project: string): ActivityItem {
	return {
		id: 'process:' + view.id, kind: 'process', project, title: view.title, startedAt: view.updatedAt, updatedAt: view.updatedAt, origin: 'external', actions: ['open'],
		state: view.state === 'stalled' ? 'paused' : view.state === 'interrupted' ? 'interrupted' : view.state,
		...(view.state === 'stalled' ? { needs: 'decision' as const } : {}),
		detail: [view.phase, view.percent === undefined ? '' : view.percent + '%', view.state === 'stalled' ? 'parece trabado: sin salida reciente' : '', view.logTail.at(-1)?.slice(0, 160) ?? ''].filter(Boolean).join(' · ')
	};
}

/** Publish the processes and return the ones that changed to a final state since the previous call (to notify them). */
export function publishProcesses(feed: ActivityFeed, views: readonly ProcessView[], project: string, previous: Map<string, ProcessView['state']>): ProcessView[] {
	const finished: ProcessView[] = [];
	for (const view of views) {
		feed.publish(processActivityItem(view, project));
		const before = previous.get(view.id);
		if (before && before !== view.state && view.state !== 'running') { finished.push(view); }
		previous.set(view.id, view.state);
	}
	const ids = new Set(views.map(view => 'process:' + view.id));
	feed.retain(item => item.kind !== 'process' || ids.has(item.id));
	return finished;
}

/** Optional phone notification through the user's webhook: https only, title and state only. */
export async function notifyWebhook(url: string, title: string, state: string, send: typeof fetch = fetch): Promise<void> {
	if (!/^https:\/\//i.test(url)) { throw Error('HARNESS_OTLP_ENDPOINT_INVALID'); }
	await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.slice(0, 120), state }), signal: AbortSignal.timeout(5000) });
}
