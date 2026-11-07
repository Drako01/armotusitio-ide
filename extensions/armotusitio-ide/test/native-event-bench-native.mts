/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Native path of the DoD-08 bench: the same corpus as `structuredSamples`, through parse + normalization + EventBridge + step forwarding. */
import { performance } from 'node:perf_hooks';
import { EventBridge } from '../src/runtime/event-bridge.ts';
import { claudeToolCall } from '../src/runtime/claude-adapter.ts';
import { stepOf } from '../src/native-agent-transport.ts';
import type { AdapterEvent } from '../src/runtime/contracts.ts';

function normalize(event: Record<string, unknown>): AdapterEvent | undefined {
	const content = (event.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
	if (event.type === 'assistant') {
		const tool = content.find(block => block.type === 'tool_use');
		if (tool) { return { toolCallId: String(tool.id), payload: { type: 'tool.started', call: claudeToolCall(String(tool.name), tool.input as Record<string, unknown>) } }; }
		return { payload: { type: 'message.completed', itemId: 'm', text: String(content[0]?.text ?? '') } };
	}
	if (event.type === 'user') { return { toolCallId: String(content[0]?.tool_use_id), payload: { type: 'tool.completed', status: 'completed' } }; }
	const item = event.item as Record<string, unknown> | undefined;
	if (item?.type === 'agent_message') { return { payload: { type: 'message.completed', itemId: String(item.id), text: String(item.text) } }; }
	if (item?.type === 'command_execution') { return { toolCallId: String(item.id), payload: event.type === 'item.started' ? { type: 'tool.started', call: { kind: 'command', name: 'commandExecution', command: String(item.command) } } : { type: 'tool.completed', status: 'completed' } }; }
	return undefined;
}

export async function nativeSamples(lines: readonly string[]): Promise<number[]> {
	const samples: number[] = [];
	const bridge = new EventBridge('bench');
	bridge.subscribe(event => { if (event.payload.type === 'tool.started' && event.toolCallId) { stepOf(process.cwd(), event.toolCallId, event.payload.call); } });
	for (const line of lines) {
		const started = performance.now();
		const adapted = normalize(JSON.parse(line));
		if (adapted) { bridge.publish(adapted); }
		samples.push(performance.now() - started);
	}
	return samples;
}
