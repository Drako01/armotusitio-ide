/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { parseEnv } = require('node:util');
const { createHash } = require('node:crypto');

/** Bind a reviewed plan to its private provider configuration without exposing its contents. */
async function providerRevision(profile) {
	try {
		const file = await envPath(profile);
		const info = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') { return null; } throw error; });
		if (info?.size > 65536) { throw new Error('Harness configuration too large'); }
		return createHash('sha256').update(JSON.stringify([info ? await fs.readFile(file, 'utf8') : '', process.env.HARNESS_HOST || '', process.env.HARNESS_AGENT_COMMAND || ''])).digest('hex');
	} catch { return 'unavailable'; }
}

/** Read only nonsecret provider metadata; inherited variables have the same precedence as Node loadEnvFile. */
function providerState(text, inherited = process.env) {
	const values = parseEnv(text);
	const raw = inherited.HARNESS_HOST ?? values.HARNESS_HOST ?? '';
	return {
		supported: true, host: ['codex', 'claude'].includes(raw.toLowerCase()) ? raw.toLowerCase() : undefined,
		custom: !!(inherited.HARNESS_AGENT_COMMAND || values.HARNESS_AGENT_COMMAND), inherited: inherited.HARNESS_HOST !== undefined,
		invalid: !!raw && !['codex', 'claude'].includes(raw.toLowerCase())
	};
}

/** Locate assignments outside comments and multiline strings, preserving every unrelated byte when editing. */
function hostEdits(text, host) {
	if (!['codex', 'claude'].includes(host)) { throw new Error('Invalid Harness provider'); }
	const edits = []; let quote = '', offset = 0;
	for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
		if (!quote) {
			const match = /^(\uFEFF?\s*(?:export\s+)?HARNESS_HOST\s*=\s*)([^\r\n]*)/.exec(line);
			if (match) {
				const value = match[2];
				// Refuse multiline provider values instead of damaging adjacent configuration.
				const parsed = /^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^#'"\r\n]*?)([ \t]*(?:#.*)?)$/.exec(value);
				if (!parsed) { throw new Error('Unsupported multiline HARNESS_HOST'); }
				const comment = parsed[1];
				edits.push({ start: offset + match[1].length, end: offset + match[1].length + value.length, text: host + comment });
			}
		}
		if (quote) { if (line.includes(quote)) { quote = ''; } }
		else {
			const quoted = /^\uFEFF?\s*(?:export\s+)?[a-zA-Z_][\w]*\s*=[ \t]*(['"])/.exec(line);
			if (quoted && !line.slice(quoted[0].length).includes(quoted[1])) { quote = quoted[1]; }
		}
		offset += line.length;
	}
	if (quote) { throw new Error('Unclosed quoted configuration'); }
	if (!edits.length) {
		const eol = text.includes('\r\n') ? '\r\n' : '\n';
		edits.push({ start: text.length, end: text.length, text: (text && !text.endsWith('\n') ? eol : '') + 'HARNESS_HOST=' + host + eol });
	}
	return edits;
}

/** Resolve a local configuration path without following links outside the selected project. */
async function envPath(profile) {
	if (profile.id !== 'redevent') { throw new Error('Harness provider is selected by its agent plan'); }
	const root = await fs.realpath(profile.root);
	const directory = path.join(root, '.harness');
	const realDirectory = await fs.realpath(directory);
	if (realDirectory !== directory) { throw new Error('Linked Harness directory'); }
	const file = path.join(directory, '.env');
	try { if (!(await fs.lstat(file)).isFile()) { throw new Error('Linked or invalid Harness configuration'); } }
	catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	return file;
}

/** Inspect a project's saved configuration without exposing tokens, commands or other .env values. */
async function readProvider(profile, inherited = process.env): Promise<{ supported: boolean; host?: string; custom?: boolean; inherited?: boolean; invalid?: boolean; error?: boolean }> {
	if (profile.id !== 'redevent') { return { supported: false }; }
	try {
		const file = await envPath(profile);
		const info = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') { return null; } throw error; });
		if (info && info.size > 65536) { throw new Error('Harness configuration too large'); }
		const text = info ? await fs.readFile(file, 'utf8') : '';
		return providerState(text, inherited);
	} catch { return { supported: true, error: true }; }
}

/** Check CLI availability on PATH without starting an agent or invoking a shell. */
async function cliAvailable(host, environment = process.env, platform = process.platform) {
	if (!['codex', 'claude'].includes(host)) { return false; }
	const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
	for (const directory of (environment.PATH || environment.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
		for (const extension of extensions) {
			try {
				const file = path.join(directory.replace(/^"|"$/g, ''), host + extension);
				if (!(await fs.stat(file)).isFile()) { continue; }
				await fs.access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true;
			} catch { /* Continue checking PATH; never run a provider just to inspect it. */ }
		}
	}
	return false;
}

/** Persist only HARNESS_HOST through the editor's versioned document and undo infrastructure. */
async function selectProvider(project, vscode, available = cliAvailable) {
	const t = (message, ...args) => vscode.l10n.t(message, ...args);
	if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage(t('Marc\u00e1 el workspace como confiable para cambiar la IA del Harness.')); return; }
	if (project.profile.id !== 'redevent') { vscode.window.showInformationMessage(t('Este Harness selecciona la IA en su plan de agentes; no utiliza HARNESS_HOST.')); return; }
	try {
		const file = await envPath(project.profile);
		const uri = vscode.Uri.file(file);
		if (!vscode.workspace.getWorkspaceFolder(uri)) { return; }
		let exists = true;
		try { await fs.access(file); } catch (error) { if (error.code !== 'ENOENT') { throw error; } exists = false; }
		const document = exists ? await vscode.workspace.openTextDocument(uri) : undefined;
		if (document?.isDirty) { vscode.window.showWarningMessage(t('Guard\u00e1 o descart\u00e1 los cambios de .harness/.env antes de cambiar la IA.')); return; }
		const text = document?.getText() || '';
		if (Buffer.byteLength(text) > 65536) { throw new Error('Configuration too large'); }
		const state = providerState(text);
		if (state.custom) { vscode.window.showWarningMessage(t('HARNESS_AGENT_COMMAND tiene prioridad. Revis\u00e1 esa configuraci\u00f3n antes de elegir otra IA; no se modific\u00f3 el archivo.')); return; }
		const selected = await vscode.window.showQuickPick([
			{ label: 'Codex', host: 'codex' }, { label: 'Claude Code', host: 'claude' },
			{ label: t('Usar configuraci\u00f3n del proyecto'), description: t('Conservar HARNESS_HOST sin cambios'), host: undefined }
		], { title: t('IA del Harness \u00b7 {0}', project.profile.name), placeHolder: t('El cambio se aplica a las pr\u00f3ximas ejecuciones; las tareas activas siguen con su IA original.') });
		if (!selected?.host) { return; }
		if (state.inherited && state.host !== selected.host) { vscode.window.showWarningMessage(t('HARNESS_HOST del entorno heredado tiene prioridad. Quit\u00e1 esa variable y reinici\u00e1 el IDE para usar la selecci\u00f3n del proyecto.')); return; }
		if (!await available(selected.host)) { vscode.window.showWarningMessage(t('No se encontr\u00f3 el CLI de {0} en PATH. Instalalo y volv\u00e9 a intentar.', selected.label)); return; }
		// Revalidate trust, project membership, links and editor state after the asynchronous picker/check.
		if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(uri) || await envPath(project.profile) !== file) { return; }
		const saved = exists ? await fs.readFile(file, 'utf8') : '';
		if (saved.replace(/^\uFEFF/, '') !== text.replace(/^\uFEFF/, '') || providerState(saved).custom) { throw new Error('Configuration changed'); }
		if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(uri)) { return; }
		if (document && (document.isDirty || document.getText() !== text)) { throw new Error('Configuration changed'); }
		const edit = new vscode.WorkspaceEdit();
		if (document) {
			for (const change of hostEdits(text, selected.host)) { edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text); }
		} else { edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(hostEdits('', selected.host)[0].text) }); }
		if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Configuration edit rejected'); }
		if (document && !await document.save()) { throw new Error('Configuration save rejected'); }
		vscode.window.showInformationMessage(t('IA de {0}: {1}. Se aplica a las pr\u00f3ximas ejecuciones; las tareas activas no cambian.', project.profile.name, selected.label));
	} catch { vscode.window.showErrorMessage(t('No se pudo cambiar la IA. Revis\u00e1 los permisos y los cambios pendientes de .harness/.env.')); }
}

module.exports = { providerState, hostEdits, readProvider, providerRevision, cliAvailable, selectProvider };
