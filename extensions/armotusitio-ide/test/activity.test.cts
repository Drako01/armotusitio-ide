/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { History, normalizeProgress, registerActivity } = require('../src/activity.ts');

test('history persists bounded summaries per project and restores unfinished tasks as unknown', async () => {
	let stored = [], errors = 0;
	const storage = { get: () => stored, update: async (_, value) => { stored = value; } };
	const history = new History(storage, () => errors++);
	for (let i = 0; i < 25; i++) { history.put({ id: String(i), project: '/one', action: 'check', startedAt: i, state: 'passed', endedAt: i + 10, log: 'private', command: 'private' }); }
	history.put({ id: 'live', project: '/two', action: 'run', host: 'claude', startedAt: 30, state: 'running' });
	await history.pending;
	assert.equal(stored.length, 21);
	assert.equal(stored.filter(row => row.project === '/one').length, 20);
	assert.doesNotMatch(JSON.stringify(stored), /private|command|log/);
	const restored = new History(storage, () => errors++);
	assert.equal(restored.rows.at(-1).state, 'unknown');
	assert.equal(restored.rows.at(-1).host, 'claude');
	assert.equal(restored.rows.at(-1).endedAt, undefined);
	restored.clear(); await restored.pending;
	assert.deepEqual(stored, []);
	assert.equal(errors, 0);
});

test('history rejects malformed storage and serializes writes after a storage failure', async () => {
	let errors = 0, attempts = 0;
	const history = new History({ get: () => [{ id: 'bad' }, null], update: async () => { if (attempts++ === 0) { throw new Error('storage'); } } }, () => errors++);
	assert.deepEqual(history.rows, []);
	history.put({ id: 'ok', project: '/repo', action: 'check', startedAt: 0, state: 'passed' });
	history.clear(); await history.pending;
	assert.deepEqual([errors, attempts], [1, 2]);
});

test('native progress preserves real percentages and excludes arbitrary metadata', () => {
	const row = normalizeProgress({ id: 'RED-219', state: 'running', live: true, percent: 42, elapsedMs: 12000, title: 'Current task', command: 'private' });
	assert.deepEqual([row.id, row.state, row.live, row.percent, row.elapsedMs, row.title], ['RED-219', 'running', true, 42, 12000, 'Current task']);
	assert.doesNotMatch(JSON.stringify(row), /private|command/);
	assert.equal(normalizeProgress({ id: 'x', state: 'stalled', percent: 500 }).percent, undefined);
	assert.throws(() => normalizeProgress({ id: '<script>', state: 'running' }));
});

function monitor(reader, id = 'redevent', workflow = false) {
	const subscriptions = [];
	let trusted = false, enabled = true, changed;
	const bar = { text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { } };
	const noop = () => ({ dispose() { } });
	const vscode = { l10n: { t: value => value }, StatusBarAlignment: { Left: 1 },
		window: { createStatusBarItem: () => bar },
		workspace: { get isTrusted() { return trusted; }, onDidGrantWorkspaceTrust: noop, onDidChangeWorkspaceFolders: noop, onDidChangeConfiguration: noop } };
	const controller = { jobs: new Map(), progress: [], refreshActivity: async () => { }, onDidChangeTreeData(fn) { changed = fn; return noop(); }, refresh() { changed(); } };
	const projects = async () => enabled ? [{ profile: { root: '/repo', id, actions: ['progress'], workflow } }] : [];
	registerActivity({ subscriptions }, controller, projects, vscode, reader);
	return { controller, bar, trust() { trusted = true; }, disable() { enabled = false; }, dispose() { subscriptions.forEach(item => item.dispose()); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('monitor respects trust, clears stale progress on failure and hides when disabled', async () => {
	let reads = 0, fail = false;
	const h = monitor(async () => { reads++; if (fail) { throw new Error('private error'); } return normalizeProgress({ id: 'RED-219', state: 'running', live: true, percent: 42 }); });
	try {
		await tick(); assert.equal(reads, 0); assert.match(h.bar.text, /lock/);
		h.trust(); await h.controller.refreshActivity(); assert.match(h.bar.text, /42%/);
		fail = true; await h.controller.refreshActivity(); assert.doesNotMatch(h.bar.text, /42%/); assert.equal(h.controller.progress[0].error, true);
		h.disable(); await h.controller.refreshActivity(); assert.equal(h.bar.visible, false); assert.deepEqual(h.controller.progress, []);
	} finally { h.dispose(); }
});

test('monitor suppresses concurrent polls and discards a response after workspace removal or disposal', async () => {
	let resolveRead, reads = 0;
	const h = monitor(() => { reads++; return new Promise(resolve => { resolveRead = resolve; }); });
	await tick(); h.trust();
	const pending = h.controller.refreshActivity(); await tick();
	await h.controller.refreshActivity(); assert.equal(reads, 1);
	h.disable(); resolveRead({ id: 'x', live: true, percent: 10, state: 'running' }); await pending;
	assert.deepEqual(h.controller.progress, []); assert.equal(h.bar.visible, false);
	h.dispose(); await h.controller.refreshActivity(); assert.equal(reads, 1);
});

test('ArmotuSitio shows IDE task activity without invoking the RedEvent progress reader', async () => {
	let reads = 0;
	const h = monitor(async () => { reads++; }, 'armotusitio');
	try {
		await tick(); h.trust(); h.controller.jobs.set('task', { state: 'running' });
		await h.controller.refreshActivity();
		assert.equal(h.bar.visible, true); assert.match(h.bar.text, /sync~spin.*1/);
		assert.equal(reads, 0); assert.deepEqual(h.controller.progress, []);
	} finally { h.dispose(); }
});

test('current IDE execution takes priority over old tasks and stale progress is explicit', async () => {
	const h = monitor(async () => ({ id: 'old-task', state: 'stalled', live: false, percent: 24 }));
	try {
		await tick(); h.trust();
		const entry = { owned: true, phase: 'running', project: '/repo', nativeId: 'new-task', checkedAt: Date.now(), progress: { percent: 63 }, progressError: false };
		h.controller.getWorkflowActivity = () => [entry];
		await h.controller.refreshActivity();
		assert.match(h.bar.text, /63%/);
		assert.doesNotMatch(h.bar.text, /24%|old-task/);
		assert.match(h.bar.tooltip, /new-task/);
		entry.progressError = true; h.controller.refresh();
		assert.match(h.bar.text, /warning/);
		assert.doesNotMatch(h.bar.text, /63%/);
		assert.match(h.bar.tooltip, /no est\u00e1 actualizado/);
	} finally { h.dispose(); }
});

test('status bar and tree keep following native work while no home panel exists', async () => {
	let reads = 0, trees = 0;
	const h = monitor(async () => { reads++; }, 'armotusitio', true);
	try {
		await tick(); h.trust();
		const entry = { owned: true, phase: 'running', project: '/repo', nativeId: 'task', title: 'Tarea en curso', checkedAt: Date.now(), progress: { percent: 10 } };
		let observations = 0;
		h.controller.refreshWorkflowActivity = async () => { observations++; entry.progress.percent += 40; entry.checkedAt = Date.now(); };
		h.controller.getWorkflowActivity = () => [entry];
		const refresh = h.controller.refresh; h.controller.refresh = () => { trees++; refresh(); };
		await h.controller.refreshActivity();
		const first = h.bar.text;
		await h.controller.refreshActivity();
		assert.deepEqual({ first, second: h.bar.text, observations, reads, treeUpdates: trees, progress: h.controller.progress.map(row => row.percent) }, { first: '$(sync~spin) Harness \u00b7 Tarea en curso \u00b7 50%', second: '$(sync~spin) Harness \u00b7 Tarea en curso \u00b7 90%', observations: 2, reads: 0, treeUpdates: 2, progress: [90] });
	} finally { h.dispose(); }
});

test('manual refresh is forwarded and a recent result takes priority over old interrupted work', async () => {
	const h = monitor(async () => ({ id: 'old-task', state: 'stalled', live: false, percent: 24 }));
	try {
		await tick(); h.trust();
		let manual = false;
		h.controller.refreshWorkflowActivity = async value => { manual = value; };
		h.controller.getWorkflowActivity = () => [{ owned: false, phase: 'completed', project: '/repo', nativeId: 'new-task', endedAt: Date.now() }];
		await h.controller.refreshActivity(true);
		assert.equal(manual, true);
		assert.match(h.bar.text, /Tarea completada/);
		assert.doesNotMatch(h.bar.text, /warning|24%/);
		assert.match(h.bar.tooltip, /new-task/);
	} finally { h.dispose(); }
});

test('manual refresh during a poll waits for a trailing native reading instead of being lost', async () => {
	let reads = 0, finish;
	const h = monitor(() => { reads++; return reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null); });
	try {
		await tick(); h.trust();
		const first = h.controller.refreshActivity(); await tick();
		const manual = h.controller.refreshActivity(true);
		finish({ id: 'first', state: 'stalled', live: false });
		await Promise.all([first, manual]);
		assert.deepEqual([reads, h.controller.progress], [2, []]);
	} finally { h.dispose(); }
});
