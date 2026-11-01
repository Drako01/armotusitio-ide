/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderOutput, ClaudeEventAccumulator, CodexEventAccumulator } from '../src/native-provider-output.ts';

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

test('Claude running out of turns is a stop reason with a resumable session, not a provider error', () => {
	// Shape recorded from Claude Code 2.1.224 with `--max-turns 1`: the result has no `result` text and exits 1.
	const session = '759f423d-392a-44be-afd6-46d5b66a120e';
	const log = [
		JSON.stringify({ type: 'system', subtype: 'init', session_id: session }),
		JSON.stringify({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'Leo ambos archivos.' }] } }),
		JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: 'Reached maximum number of turns (1)', session_id: session, num_turns: 2, usage: { input_tokens: 2, output_tokens: 121 } })
	].join('\n');
	const events = new ClaudeEventAccumulator();
	events.push(log);
	const parsed = events.finish()!;
	assert.deepEqual({ message: parsed.message, providerError: parsed.providerError, stopReason: parsed.stopReason, sessionId: parsed.sessionId, usage: parsed.usage },
		{ message: 'Leo ambos archivos.', providerError: false, stopReason: 'max-turns', sessionId: session, usage: { inputTokens: 2, outputTokens: 121 } });
	// Other error results are provider errors that keep their own text.
	const failed = parseProviderOutput('claude', JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }));
	assert.deepEqual({ error: failed.providerError, message: failed.message, stop: failed.stopReason }, { error: true, message: 'boom', stop: undefined });
	assert.equal(parseProviderOutput('claude', JSON.stringify({ type: 'result', result: 'ok', session_id: 'not-a-session' })).sessionId, undefined);
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

test('Codex accumulator streams each completed assistant message to its observer as it arrives', () => {
	const seen: string[] = [];
	const reducer = new CodexEventAccumulator(text => seen.push(text));
	const event = (type: string, item?: object) => JSON.stringify({ type, ...(item ? { item } : {}) }) + '\n';
	reducer.push(event('item.completed', { type: 'agent_message', text: 'Leyendo el proyecto' }));
	reducer.push(event('item.completed', { type: 'command_execution', command: 'ls' }));
	assert.deepEqual(seen, ['Leyendo el proyecto']);
	reducer.push(event('item.completed', { type: 'agent_message', text: 'Respuesta final' }).slice(0, 20));
	assert.deepEqual(seen, ['Leyendo el proyecto']);
	reducer.push(event('item.completed', { type: 'agent_message', text: 'Respuesta final' }).slice(20));
	assert.deepEqual({ seen, final: reducer.finish()?.message }, { seen: ['Leyendo el proyecto', 'Respuesta final'], final: 'Respuesta final' });
	// A throwing observer can never break parsing.
	const tolerant = new CodexEventAccumulator(() => { throw Error('observer'); });
	tolerant.push(event('item.completed', { type: 'agent_message', text: 'ok' }));
	assert.equal(tolerant.finish()?.message, 'ok');
});

test('Claude stream-json streams assistant text and a provider limit keeps its own explanation', () => {
	const seen: string[] = [];
	const claude = new ClaudeEventAccumulator(text => seen.push(text));
	claude.push([
		JSON.stringify({ type: 'system', subtype: 'init' }),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reviso la estructura.' }, { type: 'tool_use', name: 'Read' }] } }),
		JSON.stringify({ type: 'result', result: 'Arquitectura en capas.', is_error: false, usage: { input_tokens: 5, output_tokens: 7 } })
	].join('\n') + '\n');
	const codex = parseProviderOutput('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'You\u2019ve hit your usage limit. Try again at Nov 4th.' } }));
	assert.deepEqual({ seen, final: claude.finish(), codex: [codex.message, codex.rateLimited, codex.providerError] }, {
		seen: ['Reviso la estructura.'],
		final: { message: 'Arquitectura en capas.', structured: true, providerError: false, usage: { inputTokens: 5, outputTokens: 7 } },
		codex: ['You\u2019ve hit your usage limit. Try again at Nov 4th.', true, true]
	});
});

test('web search queries are captured from both providers as the stream reports them (D9)', () => {
	const seen: string[] = [];
	const claude = new ClaudeEventAccumulator(undefined, query => seen.push(query));
	claude.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'pgx v5 CopyFrom' } }, { type: 'text', text: 'Listo' }] } }) + '\n');
	claude.push(JSON.stringify({ type: 'result', result: 'Listo' }) + '\n');
	const codex = new CodexEventAccumulator(undefined, query => seen.push(query));
	codex.push(JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'go 1.25 testing.B.Loop' } }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Ok' } }) + '\n');
	assert.deepEqual([claude.finish()?.searches, codex.finish()?.searches, seen], [['pgx v5 CopyFrom'], ['go 1.25 testing.B.Loop'], ['pgx v5 CopyFrom', 'go 1.25 testing.B.Loop']]);
});
