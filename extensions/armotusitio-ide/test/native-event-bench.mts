/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * IDE-side event processing latency (DoD-08). The same synthetic provider streams (Claude stream-json and Codex events,
 * 50% text, 50% tool lifecycle) go through each transport's parsing path; the time per event is what the IDE adds on top
 * of the provider. Usage: `node test/native-event-bench.mts [structured|native] [events]`. Prints one JSON line.
 */
import { performance } from 'node:perf_hooks';
import { ClaudeEventAccumulator, CodexEventAccumulator } from '../src/native-provider-output.ts';

export function claudeLines(count: number): string[] {
	const lines: string[] = [JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555', tools: [] })];
	for (let index = 0; index < count; index++) {
		if (index % 2 === 0) {
			lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Step ' + index + ': ' + 'x'.repeat(200) }] }, session_id: '11111111-2222-4333-8444-555555555555' }));
		} else if (index % 4 === 1) {
			lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-' + index, name: 'Bash', input: { command: 'pnpm lint', description: 'lint' } }] } }));
		} else {
			lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-' + (index - 2), content: 'ok', is_error: false }] } }));
		}
	}
	lines.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: '11111111-2222-4333-8444-555555555555', usage: { input_tokens: 10, output_tokens: 5 } }));
	return lines.map(line => line + '\n');
}

export function codexLines(count: number): string[] {
	const lines: string[] = [JSON.stringify({ type: 'thread.started', thread_id: 't1' })];
	for (let index = 0; index < count; index++) {
		if (index % 2 === 0) {
			lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'm' + index, type: 'agent_message', text: 'Step ' + index + ': ' + 'x'.repeat(200) } }));
		} else {
			lines.push(JSON.stringify({ type: index % 4 === 1 ? 'item.started' : 'item.completed', item: { id: 'c' + (index % 4 === 1 ? index : index - 2), type: 'command_execution', command: 'pnpm lint', status: index % 4 === 1 ? 'in_progress' : 'completed', exit_code: 0 } }));
		}
	}
	lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
	return lines.map(line => line + '\n');
}

export function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

/** Per-event milliseconds through the structured (r7) accumulators. */
export function structuredSamples(count: number): number[] {
	const samples: number[] = [];
	for (const [lines, accumulator] of [
		[claudeLines(count), new ClaudeEventAccumulator(() => undefined, () => undefined, { root: process.cwd(), emit: () => undefined })],
		[codexLines(count), new CodexEventAccumulator(() => undefined, () => undefined, { root: process.cwd(), emit: () => undefined })]
	] as const) {
		for (const line of lines) {
			const started = performance.now();
			accumulator.push(line);
			samples.push(performance.now() - started);
		}
		accumulator.finish();
	}
	return samples;
}

export function summarize(samples: number[]): { events: number; p50: number; p95: number; max: number } {
	const round = (value: number): number => Math.round(value * 1000) / 1000;
	return { events: samples.length, p50: round(percentile(samples, 50)), p95: round(percentile(samples, 95)), max: round(Math.max(...samples)) };
}

if (import.meta.main) {
	const mode = process.argv[2] ?? 'structured';
	const count = Number(process.argv[3] ?? 5000);
	// Warm-up so JIT compilation is not attributed to the first events.
	structuredSamples(500);
	if (mode !== 'structured') {
		const { nativeSamples } = await import('./native-event-bench-native.mts');
		const corpus = (n: number): string[] => [...claudeLines(n), ...codexLines(n)];
		await nativeSamples(corpus(500));
		console.log(JSON.stringify({ mode, ...summarize(await nativeSamples(corpus(count))) }));
	} else {
		console.log(JSON.stringify({ mode, ...summarize(structuredSamples(count)) }));
	}
}
