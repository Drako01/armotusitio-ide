/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFeed, type ActivityItem } from '../src/native-activity-feed.ts';
import { chatActivityItems, type ChatSnapshot } from '../src/native-chat-session.ts';
import { chatMessage, extractChatPlan } from '../src/native-chat.ts';

const item = (id: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({ id, kind: 'chat-run', project: 'p', title: id, state: 'completed', startedAt: 1, updatedAt: 1, actions: ['open'], origin: 'this-window', ...extra });

test('the feed orders by urgency, groups notifications and ignores identical republishing', () => {
	const timers: Array<() => void> = [];
	const feed = createActivityFeed(callback => { timers.push(callback); return { cancel() { } }; });
	const notified: string[][] = [];
	feed.onDidChange(ids => notified.push([...ids]));
	feed.publish(item('old', { updatedAt: 5 }));
	feed.publish(item('running', { state: 'running', updatedAt: 2 }));
	feed.publish(item('approval', { state: 'queued', needs: 'approval', updatedAt: 1 }));
	feed.publish(item('old', { updatedAt: 5 }));
	feed.appendOutput('running', 'línea 1\nlínea 2\n');
	assert.equal(timers.length, 1, 'a burst schedules a single notification');
	timers.shift()!();
	feed.retain(entry => entry.id !== 'old');
	timers.shift()!();
	assert.deepEqual({ order: feed.snapshot().map(entry => entry.id), notified, tail: feed.tail('running', 1) },
		{ order: ['approval', 'running'], notified: [['old', 'running', 'approval'], ['old']], tail: ['línea 2'] });
});

test('a chat conversation becomes feed items: running work, a plan to approve and its latest runs', () => {
	const plan = extractChatPlan('```harness-plan\n' + JSON.stringify({ title: 'Cobertura', steps: ['Tests'] }) + '\n```', 1).plan!;
	const proposal = chatMessage('assistant', 'Plan', { plan });
	const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
	const base: ChatSnapshot = { provider: 'claude', revision: 1, messages: [proposal], writer: true, verification: [], plan: { messageId: proposal.id, version: 1, digest: plan.digest, approvable: true } };
	const waiting = chatActivityItems(base, { key: 'k', name: 'redevent' }, t);
	const running = chatActivityItems({ ...base, plan: { ...base.plan!, approvable: false }, activity: { kind: 'executing', provider: 'claude', startedAt: new Date().toISOString(), observedBytes: 0, stage: 'agent', planVersion: 1, partial: 'Analizando\nEscribiendo identity_test.go' } }, { key: 'k', name: 'redevent' }, t);
	const run = chatMessage('run', 'Voy por la mitad', { run: { planVersion: 1, provider: 'claude', status: 'failed', durationMs: 1000, verification: { status: 'skipped', gates: [] }, outcome: { kind: 'partial', reason: 'max-turns', diff: { available: true, files: [], count: 3 } } } });
	const partial = chatActivityItems({ ...base, messages: [proposal, run], run: { messageId: run.id, continuable: true, retryable: true } }, { key: 'k', name: 'redevent' }, t);
	assert.deepEqual({
		waiting: waiting.map(entry => [entry.id, entry.state, entry.needs, entry.actions]),
		running: running.map(entry => [entry.state, entry.title, entry.detail, entry.actions]),
		partial: partial.map(entry => [entry.id, entry.state, entry.detail, entry.actions])
	}, {
		waiting: [['chat:k:now', 'queued', 'approval', ['approve', 'open']]],
		running: [['running', 'Plan v1: Cobertura', 'Escribiendo identity_test.go', ['open', 'stop']]],
		partial: [['chat:k:' + run.id, 'partial', '3 archivos cambiados', ['continue', 'open', 'retry']]]
	});
});
