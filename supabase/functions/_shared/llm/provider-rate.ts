// How fast a provider may be called.
//
// The extraction pump sends chunks to the model in parallel. A provider with
// a small token budget (Groq: 8 000 tokens a minute for qwen3.8, for
// example) refuses the third parallel chunk of a big import, and the import
// then dies on 429s the user never sees.
//
// The numbers are the provider's published per-minute budgets, per provider
// and overridable through `import_settings`. They are deliberately
// conservative: a slower import is much better than a failed one.

import { LIMITS } from '../import-core/limits.js';

export interface ProviderRate {
    /** Tokens the provider accepts per minute. */
    tokensPerMinute: number;
    /** Requests the provider accepts per minute. */
    requestsPerMinute: number;
}

/** The published per-minute budget per provider (the slowest model wins). */
export const PROVIDER_RATES: Record<string, ProviderRate> = {
    // Groq's free tier: 6 000-15 000 tokens a minute depending on the model.
    groq: { tokensPerMinute: 6_000, requestsPerMinute: 30 },
    // OpenRouter: the tightest case is the free models (20 requests a minute).
    openrouter: { tokensPerMinute: 20_000, requestsPerMinute: 20 },
    // Cloudflare Workers AI: 1 000 requests a day on the free plan, but the
    // per-minute limit is generous.
    cloudflare: { tokensPerMinute: 60_000, requestsPerMinute: 60 },
    // OpenAI and the OpenAI-compatible endpoints: generous, but not free.
    openai: { tokensPerMinute: 100_000, requestsPerMinute: 200 },
};

export function rateFor(provider: string, limits = LIMITS): ProviderRate {
    const known = PROVIDER_RATES[String(provider ?? '').toLowerCase()];
    if (known) return known;
    return {
        tokensPerMinute: limits.PROVIDER_TOKENS_PER_MINUTE,
        requestsPerMinute: limits.PROVIDER_REQUESTS_PER_MINUTE,
    };
}

/**
 * How many chunks may start right now.
 *
 * `usedInWindow` is the tokens the provider already got in the last minute,
 * `tokensPerChunk` the average cost of one chunk. The result is never 0:
 * a chunk that does not fit is delayed, not skipped.
 */
export function affordableChunks({
    usedInWindow = 0,
    tokensPerChunk = 0,
    max = 1,
    rate,
}: {
    usedInWindow?: number;
    tokensPerChunk?: number;
    max?: number;
    rate: ProviderRate;
}): number {
    const ceiling = Math.max(1, max);
    if (!tokensPerChunk || tokensPerChunk <= 0) return ceiling;
    const left = rate.tokensPerMinute - usedInWindow;
    if (left <= 0) return 0;
    return Math.max(1, Math.min(ceiling, Math.floor(left / tokensPerChunk)));
}

/**
 * How long the client has to wait before the next call, in milliseconds.
 *
 * Zero when there is room left in the minute; otherwise the time until the
 * used tokens leave the window.
 */
export function paceMs({ usedInWindow = 0, rate }: { usedInWindow?: number; rate: ProviderRate }): number {
    const left = rate.tokensPerMinute - usedInWindow;
    if (left > 0) return 0;
    const overshoot = Math.max(0, usedInWindow - rate.tokensPerMinute);
    const perMs = rate.tokensPerMinute / 60_000;
    return perMs > 0 ? Math.min(60_000, Math.round(overshoot / perMs)) : 1_000;
}
