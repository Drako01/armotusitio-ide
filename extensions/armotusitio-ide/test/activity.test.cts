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
	const row = normalizeProgress({ id: 'RED-219', state: 'running', live: true, percent: 42, elapsedMs: 12000, title: 'private', command: 'private' });
	assert.deepEqual(row, { id: 'RED-219', state: 'running', live: true, percent: 42, elapsedMs: 12000 });
	assert.equal(normalizeProgress({ id: 'x', state: 'stalled', percent: 500 }).percent, undefined);
	assert.throws(() => normalizeProgress({ id: '<script>', state: 'running' }));
});

function monitor(reader, id = 'redevent') {
	const subscriptions = [];
	let trusted = false, enabled = true, changed;
	const bar = { text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { } };
	const noop = () => ({ dispose() { } });
	const vscode = { l10n: { t: value => value }, StatusBarAlignment: { Left: 1 },
		window: { createStatusBarItem: () => bar },
		workspace: { get isTrusted() { return trusted; }, onDidGrantWorkspaceTrust: noop, onDidChangeWorkspaceFolders: noop, onDidChangeConfiguration: noop } };
	const controller = { jobs: new Map(), progress: [], refreshActivity: async () => { }, onDidChangeTreeData(fn) { changed = fn; return noop(); }, refresh() { changed(); } };
	const projects = async () => enabled ? [{ profile: { root: '/repo', id, actions: ['progress'] } }] : [];
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
