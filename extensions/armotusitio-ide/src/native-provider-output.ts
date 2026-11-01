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
	/** The provider stopped because it used its whole turn budget; the work may be incomplete, not broken. */
	stopReason?: 'max-turns';
	/** Provider session that `--resume` can continue (Claude only; Codex runs are ephemeral). */
	sessionId?: string;
	/** Web search queries the provider made (decision D9), in order; empty when search was off or unused. */
	searches?: string[];
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A provider session id that is safe to pass back as a CLI argument. */
export function validSessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID.test(value);
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
const MAX_SEARCHES = 50;
const MAX_QUERY = 500;
const unstructured = (raw: string): ParsedProviderOutput => ({ message: raw, structured: false, providerError: false });

/**
 * Final result shared by Claude's `json` output and the closing `result` event of `stream-json`.
 * Error results (`error_max_turns`, `error_during_execution`) carry no `result` text; running out of
 * turns is reported as a stop reason, not as a provider error.
 */
function claudeResult(data: Record<string, unknown> | undefined): ParsedProviderOutput | undefined {
	if (data?.type !== 'result') { return undefined; }
	const maxTurns = data.subtype === 'error_max_turns' || data.terminal_reason === 'max_turns';
	if (typeof data.result !== 'string' && (typeof data.subtype !== 'string' || !data.subtype.startsWith('error'))) { return undefined; }
	const errors = Array.isArray(data.errors) ? data.errors.filter(item => typeof item === 'string').join('\n') : typeof data.errors === 'string' ? data.errors : '';
	const stats = object(data.usage);
	const input = amount(stats?.input_tokens);
	const output = amount(stats?.output_tokens);
	const cached = amount(stats?.cache_read_input_tokens);
	const estimatedCostUsd = cost(data.total_cost_usd);
	const providerError = data.is_error === true && !maxTurns;
	return {
		message: typeof data.result === 'string' ? data.result : errors.slice(0, MAX_FAILURE_TEXT), structured: true, providerError,
		...(providerError && throttled(data) ? { rateLimited: true as const } : {}),
		...(maxTurns ? { stopReason: 'max-turns' as const } : {}),
		...(validSessionId(data.session_id) ? { sessionId: data.session_id } : {}),
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
	protected stopReason: ParsedProviderOutput['stopReason'];
	protected sessionId: string | undefined;
	protected usage: ProviderUsage | undefined;
	private readonly searches: string[] = [];
	private readonly onMessage?: (text: string) => void;
	private readonly onSearch?: (query: string) => void;

	/** `onSearch` sees every web search query as soon as the stream reports it, so a leak can stop the run. */
	constructor(onMessage?: (text: string) => void, onSearch?: (query: string) => void) { this.onMessage = onMessage; this.onSearch = onSearch; }

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
		if (this.invalid || !this.seen || (!this.message && !this.providerError && !this.stopReason)) { return null; }
		return {
			message: this.message || this.failure, structured: true, providerError: this.providerError, usage: this.usage,
			...(this.rateLimited ? { rateLimited: true as const } : {}),
			...(this.stopReason ? { stopReason: this.stopReason } : {}),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(this.searches.length ? { searches: [...this.searches] } : {})
		};
	}

	protected abstract accept(event: Record<string, unknown>): void;

	protected publish(text: string): void {
		this.message = text.slice(-MAX_RETAINED_MESSAGE);
		try { this.onMessage?.(this.message); }
		catch { /* Observers have no authority over parsing. */ }
	}

	protected search(query: unknown): void {
		if (typeof query !== 'string' || !query.trim()) { return; }
		const text = query.trim().slice(0, MAX_QUERY);
		if (this.searches.length < MAX_SEARCHES) { this.searches.push(text); }
		try { this.onSearch?.(text); }
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
			if (item?.type === 'web_search') { this.search(item.query); }
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
		// Every event names the session, so a run stopped by the IDE (timeout, cancel) can still be resumed.
		if (validSessionId(event.session_id)) { this.sessionId = event.session_id; }
		if (event.type === 'assistant') {
			const content = object(event.message)?.content;
			const blocks = (Array.isArray(content) ? content : []).map(block => object(block));
			for (const block of blocks) { if (block?.type === 'tool_use' && block.name === 'WebSearch') { this.search(object(block.input)?.query); } }
			const text = blocks
				.filter(block => block?.type === 'text' && typeof block.text === 'string')
				.map(block => block!.text as string).join('\n');
			if (text.trim()) { this.publish(text); }
			return;
		}
		const result = claudeResult(event);
		if (!result) { return; }
		// The result text is the final answer; it is not re-published because its last block was already streamed.
		// An error result has no answer: the last streamed message stays the report and its text becomes the failure.
		if (typeof event.result === 'string') { this.message = result.message.slice(-MAX_RETAINED_MESSAGE); }
		else if (!this.failure) { this.failure = result.message; }
		this.providerError = result.providerError;
		this.stopReason = result.stopReason;
		this.rateLimited ||= !!result.rateLimited;
		this.usage = result.usage;
	}
}
