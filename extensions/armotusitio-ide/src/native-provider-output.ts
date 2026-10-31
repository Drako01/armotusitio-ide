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

export function parseProviderOutput(provider: NativeProvider, raw: string): ParsedProviderOutput {
	if (!raw || raw.length > 1024 * 1024) { return { message: raw, structured: false, providerError: false }; }
	if (provider === 'claude') {
		try {
			const data = object(JSON.parse(raw));
			if (data?.type === 'result' && typeof data.result === 'string') {
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
		} catch { /* Fallback supports older CLIs and mock providers. */ }
		return { message: raw, structured: false, providerError: false };
	}
	if (provider === 'codex') {
		try {
			const lines = raw.split(/\r?\n/).filter(Boolean);
			if (!lines.length) { throw Error('NO_EVENTS'); }
			const events = lines.map(line => object(JSON.parse(line)));
			if (events.some(x => !x || typeof x.type !== 'string')) { throw Error('BAD_EVENTS'); }
			let message = '';
			let providerError = false;
			let rateLimited = false;
			let latestUsage: ProviderUsage | undefined;
			for (const event of events) {
				if (!event) { continue; }
				if (event.type === 'error' || event.type === 'turn.failed') { providerError = true; rateLimited ||= throttled(event); }
				if (event.type === 'item.completed') {
					const item = object(event.item);
					if ((item?.type === 'agent_message' || item?.type === 'assistant_message') && typeof item.text === 'string') {
						message = item.text;
					}
				}
				if (event.type === 'turn.completed') {
					const u = object(event.usage);
					const input = amount(u?.input_tokens), output = amount(u?.output_tokens), cached = amount(u?.cached_input_tokens);
					if (input !== undefined && output !== undefined) {
						latestUsage = { inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
					}
				}
			}
			if (message || providerError) {
				return { message, structured: true, providerError, usage: latestUsage, ...(rateLimited ? { rateLimited: true as const } : {}) };
			}
		} catch { /* Fallback supports older CLIs and mock providers. */ }
	}
	return { message: raw, structured: false, providerError: false };
}


/**
 * Incremental Codex JSONL reducer. Retains final text/usage, not command logs or rollout data.
 * `onMessage` observes each completed assistant message as it arrives: real item-level streaming.
 */
export class CodexEventAccumulator {
	private pending = '';
	private seen = 0;
	private invalid = false;
	private message = '';
	private providerError = false;
	private rateLimited = false;
	private usage: ProviderUsage | undefined;
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
			if (line) { this.accept(line); }
			if (this.invalid) { this.pending = ''; return; }
			boundary = this.pending.indexOf('\n');
		}
	}

	private accept(line: string): void {
		try {
			const event = object(JSON.parse(line));
			if (!event || typeof event.type !== 'string') { this.invalid = true; return; }
			this.seen++;
			if (event.type === 'error' || event.type === 'turn.failed') { this.providerError = true; this.rateLimited ||= throttled(event); }
			if (event.type === 'item.completed') {
				const item = object(event.item);
				if ((item?.type === 'agent_message' || item?.type === 'assistant_message') && typeof item.text === 'string') {
					this.message = item.text.slice(-64 * 1024);
					try { this.onMessage?.(this.message); }
					catch { /* Observers have no authority over parsing. */ }
				}
			}
			if (event.type === 'turn.completed') {
				const u = object(event.usage);
				const input = amount(u?.input_tokens), output = amount(u?.output_tokens), cached = amount(u?.cached_input_tokens);
				if (input !== undefined && output !== undefined) {
					this.usage = { inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
				}
			}
		} catch { this.invalid = true; }
	}

	finish(): ParsedProviderOutput | null {
		if (this.pending.trim()) { this.accept(this.pending.trim()); }
		if (this.invalid || !this.seen || (!this.message && !this.providerError)) { return null; }
		return {
			message: this.message, structured: true, providerError: this.providerError, usage: this.usage,
			...(this.rateLimited ? { rateLimited: true as const } : {})
		};
	}
}
