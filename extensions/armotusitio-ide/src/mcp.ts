/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const endpoint = 'https://armotusitio.com.ar/backend/api/mcp.php';
const secretKey = 'atsIde.armotusitioMcp.key';

/** Bounded JSON-RPC client for the existing ArmotuSitio Work Management endpoint. */
class McpClient {
	getKey;
	fetcher;
	nextId = 0;
	ready;
	constructor(getKey, fetcher = fetch) { this.getKey = getKey; this.fetcher = fetcher; }
	reset() { this.ready = undefined; }
	async request(method, params = {}, token = undefined) {
		if (token?.isCancellationRequested) { throw new Error('MCP_CANCELLED'); }
		const key = await this.getKey();
		if (!key || /[\r\n]/.test(key) || key.length > 8192) { throw new Error('MCP_AUTH'); }
		const abort = new AbortController();
		const cancel = token?.onCancellationRequested(() => abort.abort());
		const timer = setTimeout(() => abort.abort(), 15000);
		const id = method.startsWith('notifications/') ? undefined : ++this.nextId;
		try {
			if (token?.isCancellationRequested) { throw new Error('MCP_CANCELLED'); }
			const response = await this.fetcher(endpoint, {
				method: 'POST', redirect: 'error', signal: abort.signal,
				headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-ATS-Agent-Key': key, 'MCP-Protocol-Version': '2025-03-26' },
				body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
			});
			if (response.status === 401 || response.status === 403) { throw new Error('MCP_AUTH'); }
			if (!response.ok) { throw new Error('MCP_HTTP'); }
			if (id === undefined) { await response.body?.cancel(); return; }
			if (!response.body) { throw new Error('MCP_RESPONSE'); }
			const reader = response.body.getReader();
			const chunks = []; let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read(); if (done) { break; }
					size += value.length;
					if (size > 1048576) { await reader.cancel(); throw new Error('MCP_SIZE'); }
					chunks.push(value);
				}
			} finally { reader.releaseLock(); }
			let data;
			try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('MCP_RESPONSE'); }
			if (!data || data.jsonrpc !== '2.0' || data.id !== id || data.error || !data.result || typeof data.result !== 'object') { throw new Error('MCP_RESPONSE'); }
			return data.result;
		} finally { clearTimeout(timer); cancel?.dispose(); }
	}
	async connect(token = undefined) {
		if (!this.ready) {
			this.ready = this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'armotusitio-ide', version: '0.3.0' } }, token)
				.then(async result => {
					if (result.protocolVersion !== '2025-03-26' || !result.capabilities?.tools) { throw new Error('MCP_RESPONSE'); }
					await this.request('notifications/initialized', {}, token); return result;
				}).catch(error => { this.reset(); throw error; });
		}
		return this.ready;
	}
	async tools(token = undefined) {
		await this.connect(token);
		const result = await this.request('tools/list', {}, token);
		if (!Array.isArray(result.tools) || result.tools.length > 200) { throw new Error('MCP_RESPONSE'); }
		return result.tools;
	}
	async call(name, args, token = undefined) {
		if (!(await this.tools(token)).some(tool => tool.name === name)) { throw new Error('MCP_PERMISSION'); }
		const result = await this.request('tools/call', { name, arguments: args }, token);
		if (result.isError) { throw new Error('MCP_TOOL'); }
		return result;
	}
}

/** Register native MCP discovery and keep authentication in SecretStorage or the inherited environment. */
function registerMcp(context, vscode) {
	const t = message => vscode.l10n.t(message);
	const events = new vscode.EventEmitter();
	const enabled = () => vscode.workspace.isTrusted && vscode.workspace.getConfiguration('atsHarness').get('mcp.enabled', false);
	const getKey = async () => {
		if (!enabled()) { return; }
		const key = (await context.secrets.get(secretKey)) || process.env.ATS_MCP_TOKEN;
		return enabled() && key?.trim() && key.length <= 8192 && !/[\r\n]/.test(key) ? key.trim() : undefined;
	};
	const client = new McpClient(getKey);
	const credentialState = async () => {
		if (!vscode.workspace.isTrusted) { return { configured: false, enabled: false, locked: true }; }
		const key = (await context.secrets.get(secretKey)) || process.env.ATS_MCP_TOKEN;
		return { configured: !!key?.trim(), enabled: enabled(), locked: false };
	};
	async function enable() {
		if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage(t('Marc\u00e1 el workspace como confiable antes de conectar Work Management.')); return false; }
		if (enabled()) { return true; }
		if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) { vscode.window.showWarningMessage(t('Abr\u00ed una carpeta para habilitar Work Management en este workspace.')); return false; }
		const accept = t('Habilitar en este workspace');
		if (await vscode.window.showWarningMessage(t('\u00bfQuer\u00e9s conectar ArmotuSitio Work Management en este workspace? Es opcional para el Harness.'), { modal: true }, accept) !== accept || !vscode.workspace.isTrusted) { return false; }
		await vscode.workspace.getConfiguration('atsHarness').update('mcp.enabled', true, vscode.ConfigurationTarget.Workspace);
		events.fire(); return enabled();
	}
	async function configure(replace = false) {
		if (!await enable()) { return; }
		if (!replace && (await credentialState()).configured) { events.fire(); return; }

		const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: t('Clave del agente MCP de ArmotuSitio. Se guarda en el almacenamiento seguro del IDE.'), validateInput: value => !value.trim() || /[\r\n]/.test(value) || value.length > 8192 ? t('Ingres\u00e1 una clave v\u00e1lida.') : undefined });
		if (key === undefined) { return; }
		if (!key.trim() || /[\r\n]/.test(key) || key.length > 8192 || !enabled()) { return; }
		await context.secrets.store(secretKey, key.trim()); client.reset(); events.fire();
	}
	const provider = {
		onDidChangeMcpServerDefinitions: events.event,
		provideMcpServerDefinitions: () => enabled() ? [new vscode.McpHttpServerDefinition('ArmotuSitio Work Management', vscode.Uri.parse(endpoint))] : [],
		async resolveMcpServerDefinition(server, token) {
			if (!enabled() || token.isCancellationRequested || server.uri.toString() !== endpoint) { return; }
			let key = await getKey();
			if (!enabled() || token.isCancellationRequested) { return; }
			if (!key) { await configure(); key = await getKey(); }
			if (!key || !enabled() || token.isCancellationRequested) { return; }
			return new vscode.McpHttpServerDefinition('ArmotuSitio Work Management', vscode.Uri.parse(endpoint), { 'X-ATS-Agent-Key': key });
		}
	};
	context.subscriptions.push(events,
		vscode.lm.registerMcpServerDefinitionProvider('atsIde.armotusitioMcp', provider),
		vscode.commands.registerCommand('atsIde.mcpConfigure', () => configure()),
		vscode.commands.registerCommand('atsIde.mcpChangeKey', () => configure(true)),
		vscode.commands.registerCommand('atsIde.mcpEnable', enable),
		vscode.commands.registerCommand('atsIde.mcpClearKey', async () => { await context.secrets.delete(secretKey); client.reset(); events.fire(); }),
		vscode.workspace.onDidGrantWorkspaceTrust(() => events.fire()),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('atsHarness.mcp')) { client.reset(); events.fire(); } }),
		context.secrets.onDidChange(e => { if (e.key === secretKey) { client.reset(); events.fire(); } }));
	return { client, enabled, credentialState, onDidChange: events.event };
}

module.exports = { McpClient, registerMcp, endpoint };
