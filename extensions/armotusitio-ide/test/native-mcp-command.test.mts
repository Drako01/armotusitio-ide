/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** `/mcp` in the chat: add, list, disable and remove servers with explicit consent and masked secret prompts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMcpCommand, type McpCommandDeps } from '../src/native-mcp-command.ts';
import { McpServerStore } from '../src/native-mcp-servers.ts';

test('/mcp adds a server only after confirmation, asks secrets through a masked prompt, and never echoes them', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-mcp-command-'));
	try {
		const secrets = new Map<string, string>();
		const store = new McpServerStore(directory, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } });
		const confirmations: string[] = [];
		const prompts: string[] = [];
		let accept = false;
		const deps: McpCommandDeps = {
			t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]), store,
			confirm: async summary => { confirmations.push(summary); return accept; },
			askSecret: async prompt => { prompts.push(prompt); return 'S3CRET'; },
			workManagement: async () => 'WORK-MANAGEMENT'
		};
		const run = (line: string) => runMcpCommand(deps, line.split(' ').slice(1));
		const declined = await run('/mcp add docs https://mcp.example.com/sse --token');
		accept = true;
		const added = await run('/mcp add docs https://mcp.example.com/sse --token');
		const local = await run('/mcp add files npx -y srv --env API_KEY');
		const bad = await run('/mcp add docs2 https://a.test --env X');
		const listed = await run('/mcp');
		const disabled = await run('/mcp disable docs');
		const missing = await run('/mcp remove nope');
		const removed = await run('/mcp remove docs');
		assert.deepEqual({
			declined, added: added.startsWith('Agregu'), local: local.startsWith('Agregu'), bad: bad.startsWith('--token'),
			confirmations: confirmations.length, prompts, listed: listed.split('\n').slice(0, 3).map(line => line.trim().replace(/\s+/g, ' ')),
			workShown: listed.endsWith('WORK-MANAGEMENT'), leaked: [added, local, listed].some(text => text.includes('S3CRET')), disabled, missing, removed,
			stored: (await fs.readFile(path.join(directory, 'servers.json'), 'utf8')).includes('S3CRET')
		}, {
			declined: 'No agregu\u00e9 el servidor.', added: true, local: true, bad: true,
			confirmations: 3, prompts: ['Token (Bearer) para docs', 'Token (Bearer) para docs', 'Valor de API_KEY para files'].slice(1),
			listed: ['Servidores MCP conectados:', 'docs activo http https://mcp.example.com/sse (credenciales: token)', 'files activo stdio npx -y srv (credenciales: API_KEY)'],
			workShown: true, leaked: false, disabled: 'Desactiv\u00e9 el servidor docs.', missing: 'No encontr\u00e9 el servidor nope.', removed: 'Quit\u00e9 el servidor docs y sus credenciales.', stored: false
		});
	} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
