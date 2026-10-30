/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderOutput, CodexEventAccumulator } from '../src/native-provider-output.ts';

test('Codex JSONL exposes only final model message and measured tokens', () => {
	const log = [
		JSON.stringify({ type: 'thread.started', thread_id: 'fake-session' }),
		JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'SECRET_COMMAND_OUTPUT' } }),
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Review complete\nHARNESS_REVIEW: PASS' } }),
		JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 32 } })
	].join('\n');
	const parsed = parseProviderOutput('codex', log);
	assert.equal(parsed.structured, true);
	assert.equal(parsed.message, 'Review complete\nHARNESS_REVIEW: PASS');
	assert.ok(!parsed.message.includes('SECRET_COMMAND_OUTPUT'));
	assert.deepEqual(parsed.usage, { inputTokens: 400, outputTokens: 32, cachedInputTokens: 300 });
	assert.equal(parsed.providerError, false);
});

test('Claude JSON reports real usage and estimated USD cost', () => {
	const parsed = parseProviderOutput('claude', JSON.stringify({
		type: 'result', result: 'Finished', is_error: false, total_cost_usd: 0.012,
		usage: { input_tokens: 100, output_tokens: 55, cache_read_input_tokens: 20 }
	}));
	assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 55, cachedInputTokens: 20, estimatedCostUsd: 0.012 });
	assert.equal(parsed.message, 'Finished');
	assert.equal(parsed.structured, true);
});

test('invalid or partial provider usage never fabricates token counts', () => {
	assert.equal(parseProviderOutput('codex', 'legacy text').usage, undefined);
	assert.equal(parseProviderOutput('claude', JSON.stringify({ type: 'result', result: 'text', usage: { input_tokens: -1 } })).usage, undefined);
	assert.equal(parseProviderOutput('claude', JSON.stringify({ type: 'result', result: 'error', is_error: true })).providerError, true);
	assert.equal(parseProviderOutput('codex', '{"type":"turn.failed"}').providerError, true);
});


test('Codex streaming reducer handles chunked JSONL and excludes tool logs', () => {
	const reducer = new CodexEventAccumulator();
	const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(400_000) } }) + '\n';
	const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready\nHARNESS_REVIEW: PASS' } }) + '\n';
	const usage = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 77, output_tokens: 9 } }) + '\n';
	const stream = command + message + usage;
	for (let i = 0; i < stream.length; i += 1024) {
		reducer.push(stream.slice(i, i + 1024));
	}
	const result = reducer.finish();
	assert.equal(result?.structured, true);
	assert.equal(result?.message, 'ready\nHARNESS_REVIEW: PASS');
	assert.deepEqual(result?.usage, { inputTokens: 77, outputTokens: 9 });
	assert.ok(!result?.message.includes('xxxx'));
});
