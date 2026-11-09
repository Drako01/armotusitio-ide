/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Minimal stdio MCP server for the real-provider scenarios: one tool, `echo_note`, that records each call in a marker file. */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const marker = process.argv[2];
const send = (message: Record<string, unknown>): boolean => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
	let request: { id?: number; method?: string; params?: { protocolVersion?: string; arguments?: { text?: unknown } } };
	try { request = JSON.parse(line); } catch { return; }
	if (request.id === undefined) { return; }
	if (request.method === 'initialize') {
		send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } } });
	} else if (request.method === 'tools/list') {
		send({ id: request.id, result: { tools: [{ name: 'echo_note', description: 'Records a note and returns it.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
	} else if (request.method === 'tools/call') {
		const text = String(request.params?.arguments?.text ?? '');
		if (marker) { fs.appendFileSync(marker, text + '\n'); }
		send({ id: request.id, result: { content: [{ type: 'text', text: 'recorded: ' + text }] } });
	} else {
		send({ id: request.id, error: { code: -32601, message: 'method not found' } });
	}
});
