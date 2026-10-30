/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderOutput } from '../src/native-provider-output.ts';

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
