/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Provider-specific accounting from structured output; no estimated tokens fabricated from text. */
import type { NativeProvider } from './native-providers.ts';

export interface ProviderUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	estimatedCostUsd?: number;
}
export interface ParsedProviderOutput {
	message: string;
	structured: boolean;
	providerError: boolean;
	usage?: ProviderUsage;
	/** Present only when a provider error reports throttling or an exhausted usage quota. */
	rateLimited?: true;
}
const THROTTLED = /rate[ _-]?limit|too many requests|usage limit|quota exceeded|\b429\b/i;
/** Recognize throttling from structured error fields only, never from successful answers. */
function throttled(event: Record<string, unknown> | undefined): boolean {
	if (!event) { return false; }
	const nested = object(event.error);
	return [event.api_error_status, event.status, event.status_code, nested?.status, nested?.code].includes(429) ||
		[event.message, event.result, event.subtype, nested?.message, nested?.type, nested?.code]
			.some(text => typeof text === 'string' && THROTTLED.test(text.slice(0, 4096)));
}
function amount(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}
function cost(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1_000_000 ? value : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const MAX_RETAINED_MESSAGE = 64 * 1024;
const MAX_FAILURE_TEXT = 1024;
const unstructured = (raw: string): ParsedProviderOutput => ({ message: raw, structured: false, providerError: false });

/** Final result shared by Claude's `json` output and the closing `result` event of `stream-json`. */
function claudeResult(data: Record<string, unknown> | undefined): ParsedProviderOutput | undefined {
	if (data?.type !== 'result' || typeof data.result !== 'string') { return undefined; }
	const stats = object(data.usage);
	const input = amount(stats?.input_tokens);
	const output = amount(stats?.output_tokens);
	const cached = amount(stats?.cache_read_input_tokens);
	const estimatedCostUsd = cost(data.total_cost_usd);
	return {
		message: data.result, structured: true, providerError: data.is_error === true,
		...(data.is_error === true && throttled(data) ? { rateLimited: true as const } : {}),
		usage: input !== undefined && output !== undefined
			? {
				inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }),
				...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd })
			}
			: undefined
	};
}

export function parseProviderOutput(provider: NativeProvider, raw: string): ParsedProviderOutput {
	if (!raw || raw.length > 1024 * 1024) { return unstructured(raw); }
	if (provider === 'claude') {
		// `--output-format json` may be pretty-printed by older CLIs; stream-json is one event per line.
		try {
			const result = claudeResult(object(JSON.parse(raw)));
			if (result) { return result; }
		} catch { /* Not a single document: read it as an event stream. */ }
	}
	const events = provider === 'claude' ? new ClaudeEventAccumulator() : new CodexEventAccumulator();
	events.push(raw);
	return events.finish() ?? unstructured(raw);
}

/**
 * Incremental JSONL reducer for provider event streams. Retains final text and usage, never tool logs.
 * `onMessage` observes each assistant message as it arrives: real message-level streaming.
 * A provider error without an answer keeps the provider's own error text, so the user sees why.
 */
abstract class ProviderEventAccumulator {
	private pending = '';
	private seen = 0;
	private invalid = false;
	protected message = '';
	protected failure = '';
	protected providerError = false;
	protected rateLimited = false;
	protected usage: ProviderUsage | undefined;
	private readonly onMessage?: (text: string) => void;

	constructor(onMessage?: (text: string) => void) { this.onMessage = onMessage; }

	push(text: string): void {
		if (this.invalid) { return; }
		this.pending += text;
		if (this.pending.length > 1024 * 1024) { this.invalid = true; this.pending = ''; return; }
		let boundary = this.pending.indexOf('\n');
		while (boundary !== -1) {
			const line = this.pending.slice(0, boundary).trim();
			this.pending = this.pending.slice(boundary + 1);
			if (line) { this.acceptLine(line); }
			if (this.invalid) { this.pending = ''; return; }
			boundary = this.pending.indexOf('\n');
		}
	}

	finish(): ParsedProviderOutput | null {
		if (this.pending.trim()) { this.acceptLine(this.pending.trim()); }
		if (this.invalid || !this.seen || (!this.message && !this.providerError)) { return null; }
		return {
			message: this.message || this.failure, structured: true, providerError: this.providerError, usage: this.usage,
			...(this.rateLimited ? { rateLimited: true as const } : {})
		};
	}

	protected abstract accept(event: Record<string, unknown>): void;

	protected publish(text: string): void {
		this.message = text.slice(-MAX_RETAINED_MESSAGE);
		try { this.onMessage?.(this.message); }
		catch { /* Observers have no authority over parsing. */ }
	}

	protected fail(event: Record<string, unknown>): void {
		this.providerError = true;
		this.rateLimited ||= throttled(event);
		const text = [event.message, object(event.error)?.message].find(value => typeof value === 'string');
		if (!this.failure && typeof text === 'string') { this.failure = text.slice(0, MAX_FAILURE_TEXT); }
	}

	private acceptLine(line: string): void {
		try {
			const event = object(JSON.parse(line));
			if (!event || typeof event.type !== 'string') { this.invalid = true; return; }
			this.seen++;
			this.accept(event);
		} catch { this.invalid = true; }
	}
}

/** `codex exec --json`: completed agent messages, turn usage and error events. */
export class CodexEventAccumulator extends ProviderEventAccumulator {
	protected accept(event: Record<string, unknown>): void {
		if (event.type === 'error' || event.type === 'turn.failed') { this.fail(event); }
		if (event.type === 'item.completed') {
			const item = object(event.item);
			if ((item?.type === 'agent_message' || item?.type === 'assistant_message') && typeof item.text === 'string') { this.publish(item.text); }
		}
		if (event.type === 'turn.completed') {
			const u = object(event.usage);
			const input = amount(u?.input_tokens), output = amount(u?.output_tokens), cached = amount(u?.cached_input_tokens);
			if (input !== undefined && output !== undefined) {
				this.usage = { inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
			}
		}
	}
}

/** `claude --output-format stream-json`: assistant text blocks as they arrive, then one `result` event. */
export class ClaudeEventAccumulator extends ProviderEventAccumulator {
	protected accept(event: Record<string, unknown>): void {
		if (event.type === 'assistant') {
			const content = object(event.message)?.content;
			const text = (Array.isArray(content) ? content : [])
				.map(block => object(block))
				.filter(block => block?.type === 'text' && typeof block.text === 'string')
				.map(block => block!.text as string).join('\n');
			if (text.trim()) { this.publish(text); }
			return;
		}
		const result = claudeResult(event);
		if (!result) { return; }
		// The result text is the final answer; it is not re-published because its last block was already streamed.
		this.message = result.message.slice(-MAX_RETAINED_MESSAGE);
		this.providerError = result.providerError;
		this.rateLimited ||= !!result.rateLimited;
		this.usage = result.usage;
	}
}
