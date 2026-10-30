/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
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
          usage: input !== undefined && output !== undefined
            ? { inputTokens: input, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }),
              ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) }
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
      let latestUsage: ProviderUsage | undefined;
      for (const event of events) {
        if (!event) { continue; }
        if (event.type === 'error' || event.type === 'turn.failed') { providerError = true; }
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
        return { message, structured: true, providerError, usage: latestUsage };
      }
    } catch { /* Fallback supports older CLIs and mock providers. */ }
  }
  return { message: raw, structured: false, providerError: false };
}
