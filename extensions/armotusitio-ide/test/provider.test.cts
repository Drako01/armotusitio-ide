/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { providerState, hostEdits, readProvider, cliAvailable, selectProvider } = require('../src/provider.ts');

function changed(text, host) {
	for (const edit of hostEdits(text, host).reverse()) { text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); }
	return text;
}

async function fixture(text = '') {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-provider-'));
	await fs.mkdir(path.join(root, '.harness'));
	const file = path.join(root, '.harness', '.env');
	if (text !== null) { await fs.writeFile(file, text, { mode: 0o600 }); }
	return { root, file, profile: { id: 'redevent', root, name: 'RedEvent' }, async dispose() {
		const target = path.resolve(root);
		assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('ats-provider-'));
		await fs.rm(target, { recursive: true, force: true });
	} };
}

async function isolated(action) {
	const previous = { HARNESS_HOST: process.env.HARNESS_HOST, HARNESS_AGENT_COMMAND: process.env.HARNESS_AGENT_COMMAND };
	delete process.env.HARNESS_HOST; delete process.env.HARNESS_AGENT_COMMAND;
	try { await action(); } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } } }
}

function editor(fixture) {
	let document;
	const messages = [], choices = [];
	const ui = {
		choice: 'claude', dirty: false, trusted: true, member: true, hook: async () => { }, applied: 0,
		api: {
			l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => args[i]) },
			Uri: { file: fsPath => ({ fsPath }) }, Range: class { constructor(start, end) { this.start = start; this.end = end; } },
			WorkspaceEdit: class {
				changes = [];
				replace(uri, range, text) { this.changes.push({ uri, range, text }); }
				createFile(uri, options) { this.changes.push({ uri, options }); }
			},
			workspace: {
				get isTrusted() { return ui.trusted; }, getWorkspaceFolder() { return ui.member ? {} : undefined; },
				async openTextDocument() {
					let text = await fs.readFile(fixture.file, 'utf8');
					document = { get isDirty() { return ui.dirty; }, getText: () => text, positionAt: offset => offset, replace: next => { text = next; }, async save() { await fs.writeFile(fixture.file, text); return true; } };
					return document;
				},
				async applyEdit(edit) {
					ui.applied++;
					for (const change of edit.changes.sort((a, b) => (b.range?.start || 0) - (a.range?.start || 0))) {
						if (change.options) { await fs.writeFile(change.uri.fsPath, change.options.contents, { flag: 'wx' }); }
						else { const text = document.getText(); document.replace(text.slice(0, change.range.start) + change.text + text.slice(change.range.end)); }
					}
					return true;
				}
			},
			window: {
				async showQuickPick(items) { choices.push(items); await ui.hook(); return items.find(item => item.host === ui.choice); },
				showWarningMessage: text => messages.push(text), showInformationMessage: text => messages.push(text), showErrorMessage: text => messages.push(text)
			}
		}, messages, choices
	};
	return ui;
}

test('provider metadata follows Node environment precedence and never returns commands or tokens', () => {
	const state = providerState('HARNESS_HOST=codex\nAPI_TOKEN=private-value\nHARNESS_AGENT_COMMAND="custom secret"', { HARNESS_HOST: 'claude' });
	assert.equal(state.host, 'claude'); assert.equal(state.inherited, true); assert.equal(state.custom, true);
	assert.doesNotMatch(JSON.stringify(state), /private-value|custom secret/);
	assert.equal(providerState('HARNESS_HOST=codex', { HARNESS_HOST: '' }).host, undefined);
});

test('editing preserves BOM, CRLF, comments, credentials and assignments inside multiline strings', () => {
	const original = '\uFEFF# config\r\nTOKEN="private\r\nHARNESS_HOST=do-not-touch\r\nvalue"\r\nexport HARNESS_HOST = "codex" # IA\r\nHARNESS_HOST=codex\r\nOTHER=keep\r\n';
	assert.equal(changed(original, 'claude'), original.replace('"codex" # IA', 'claude # IA').replace('HARNESS_HOST=codex\r\n', 'HARNESS_HOST=claude\r\n'));
	assert.equal(changed('OTHER=keep', 'codex'), 'OTHER=keep\nHARNESS_HOST=codex\n');
	assert.equal(changed('OTHER=it\'s fine\nHARNESS_HOST=codex\n', 'claude'), 'OTHER=it\'s fine\nHARNESS_HOST=claude\n');
	assert.equal(changed('HARNESS_HOST="codex#literal" # comment\n', 'claude'), 'HARNESS_HOST=claude # comment\n');
	assert.throws(() => changed('HARNESS_HOST="codex\nother"\n', 'claude'));
	assert.throws(() => changed('TOKEN="unclosed\n', 'claude'));
	assert.throws(() => changed('', 'arbitrary-command'));
});

test('selector updates only its project file, preserves secrets and offers a no-change project option', async () => isolated(async () => {
	const first = await fixture('TOKEN=private-value\r\nHARNESS_HOST=codex # IA\r\n');
	const second = await fixture('HARNESS_HOST=codex\n');
	try {
		const ui = editor(first);
		await selectProvider({ profile: first.profile }, ui.api, async () => true);
		assert.equal(await fs.readFile(first.file, 'utf8'), 'TOKEN=private-value\r\nHARNESS_HOST=claude # IA\r\n');
		assert.equal((await readProvider(second.profile, {})).host, 'codex');
		assert.doesNotMatch(JSON.stringify(ui.messages), /private-value/);
		assert.ok(ui.choices[0].some(item => item.host === undefined));
		const before = await fs.readFile(first.file, 'utf8'); ui.choice = undefined;
		await selectProvider({ profile: first.profile }, ui.api, async () => true);
		assert.equal(await fs.readFile(first.file, 'utf8'), before);
	} finally { await first.dispose(); await second.dispose(); }
}));

test('missing config is created without overwriting a file created while the picker is open', async () => isolated(async () => {
	const f = await fixture(null);
	try {
		const ui = editor(f); await selectProvider({ profile: f.profile }, ui.api, async () => true);
		assert.equal(await fs.readFile(f.file, 'utf8'), 'HARNESS_HOST=claude\n');
		await fs.rm(f.file); const racing = editor(f);
		racing.hook = () => fs.writeFile(f.file, 'TOKEN=new-value\n');
		await selectProvider({ profile: f.profile }, racing.api, async () => true);
		assert.equal(await fs.readFile(f.file, 'utf8'), 'TOKEN=new-value\n');
	} finally { await f.dispose(); }
}));

test('selection refuses dirty files, custom commands, unavailable CLI, lost trust or membership and inherited overrides', async () => isolated(async () => {
	for (const scenario of ['dirty', 'custom', 'cli', 'trust', 'removed', 'inherited', 'edited', 'external']) {
		const text = 'HARNESS_HOST=codex\n' + (scenario === 'custom' ? 'HARNESS_AGENT_COMMAND="private-command"\n' : '');
		const f = await fixture(text);
		try {
			const ui = editor(f); ui.dirty = scenario === 'dirty';
			if (scenario === 'trust') { ui.hook = async () => { ui.trusted = false; }; }
			if (scenario === 'removed') { ui.hook = async () => { ui.member = false; }; }
			if (scenario === 'edited') { ui.hook = async () => { ui.dirty = true; }; }
			if (scenario === 'external') { ui.hook = () => fs.writeFile(f.file, 'HARNESS_HOST=codex\nTOKEN=external-change\n'); }
			if (scenario === 'inherited') { process.env.HARNESS_HOST = 'codex'; }
			await selectProvider({ profile: f.profile }, ui.api, async () => scenario !== 'cli');
			assert.equal(ui.applied, 0, scenario);
			assert.equal(await fs.readFile(f.file, 'utf8'), scenario === 'external' ? 'HARNESS_HOST=codex\nTOKEN=external-change\n' : text);
			assert.doesNotMatch(JSON.stringify(ui.messages), /private-command/);
		} finally { delete process.env.HARNESS_HOST; await f.dispose(); }
	}
}));

test('linked Harness directories and plan-driven projects are not written', async () => isolated(async () => {
	const f = await fixture('HARNESS_HOST=codex\n');
	try {
		const ui = editor(f);
		await selectProvider({ profile: { ...f.profile, id: 'armotusitio' } }, ui.api, async () => true);
		assert.equal(ui.applied, 0); assert.equal((await readProvider({ ...f.profile, id: 'armotusitio' })).supported, false);
		await fs.rename(path.join(f.root, '.harness'), path.join(f.root, 'actual'));
		await fs.symlink(path.join(f.root, 'actual'), path.join(f.root, '.harness'), 'junction');
		await selectProvider({ profile: f.profile }, ui.api, async () => true);
		assert.equal(ui.applied, 0); assert.equal((await readProvider(f.profile)).error, true);
	} finally { await f.dispose(); }
}));

test('CLI discovery checks executable PATH entries without launching an agent', async () => {
	const f = await fixture();
	try {
		await fs.writeFile(path.join(f.root, 'codex.cmd'), '@exit /b 1');
		assert.equal(await cliAvailable('codex', { PATH: f.root }, 'win32'), true);
		assert.equal(await cliAvailable('claude', { PATH: f.root }, 'win32'), false);
		assert.equal(await cliAvailable('invalid', { PATH: f.root }, 'win32'), false);
	} finally { await f.dispose(); }
});
