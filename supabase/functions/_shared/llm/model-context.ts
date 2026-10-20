// Best-effort model metadata lookup for the job token cap. The cap is a
// budget, so an unavailable lookup must never block extraction: callers fall
// back to the deployment limit when no context window can be resolved.

import { timeoutSignal } from './openai-compatible.ts';
import { LIMITS } from '../import-core/limits.js';

export interface ModelContextEntry {
    provider: string;
    model: string;
    apiKey?: string | null;
    accountId?: string | null;
    baseUrl?: string | null;
}

export interface ModelContextOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal | null;
    timeoutMs?: number;
    now?: number;
}

interface CacheEntry {
    context: number | null;
    expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Tests use this so one fake provider cannot leak into the next case. */
export function clearModelContextCache() {
    cache.clear();
}

function positiveInt(value: unknown): number | null {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.floor(number);
}

/** Providers disagree on the field name and nesting for context windows. */
export function contextWindowOf(value: unknown): number | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const nested = [record.properties, record.meta, record.top_provider, record.limits]
        .filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[];
    const sources = [record, ...nested];
    const keys = [
        'context_length',
        'context_window',
        'max_context_length',
        'max_model_len',
        'max_input_tokens',
        'context',
    ];
    for (const source of sources) {
        for (const key of keys) {
            const found = positiveInt(source[key]);
            if (found) return found;
        }
    }
    return null;
}

function cacheKey(entry: ModelContextEntry) {
    return `${entry.provider}\u0000${entry.model}\u0000${entry.baseUrl ?? ''}`;
}

async function getJson(
    url: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
    headers: Record<string, string> = {},
): Promise<unknown> {
    const response = await fetchImpl(url, { headers, signal });
    if (!response.ok) return null;
    return response.json().catch(() => null);
}

async function openRouterContext(
    entry: ModelContextEntry,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
): Promise<number | null> {
    const json = await getJson('https://openrouter.ai/api/v1/models', fetchImpl, signal);
    const rows = (json as { data?: unknown[] } | null)?.data ?? [];
    const row = rows.find((item) => (item as { id?: string })?.id === entry.model);
    return contextWindowOf(row);
}

async function cloudflareContext(
    entry: ModelContextEntry,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
): Promise<number | null> {
    if (!entry.accountId || !entry.apiKey) return null;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(entry.accountId)}/ai/models/search?search=${encodeURIComponent(entry.model)}`;
    const json = await getJson(url, fetchImpl, signal, {
        authorization: `Bearer ${entry.apiKey}`,
    });
    const rows = (json as { result?: unknown[] } | null)?.result ?? [];
    const row = rows.find((item) => (item as { id?: string })?.id === entry.model);
    return contextWindowOf(row);
}

async function openAiContext(
    entry: ModelContextEntry,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
): Promise<number | null> {
    if (!entry.baseUrl) return null;
    const base = entry.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = entry.apiKey
        ? { authorization: `Bearer ${entry.apiKey}` }
        : {};
    const json = await getJson(`${base}/models`, fetchImpl, signal, headers);
    const rows = (json as { data?: unknown[]; models?: unknown[] } | null);
    const list = rows?.data ?? rows?.models ?? [];
    const row = list.find((item) => (item as { id?: string })?.id === entry.model);
    return contextWindowOf(row) ?? contextWindowOf(json);
}

/**
 * Resolve the context window for one provider/model pair.
 * Returns null on an unsupported provider, a failed request, or a shape we do
 * not understand. No error is thrown to the caller.
 */
export async function resolveModelContext(
    entry: ModelContextEntry,
    options: ModelContextOptions = {},
): Promise<number | null> {
    if (!entry?.model) return null;
    const now = options.now ?? Date.now();
    const key = cacheKey(entry);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.context;

    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = timeoutSignal(options.signal ?? undefined, options.timeoutMs ?? 5_000);
    let context: number | null = null;
    try {
        if (entry.provider === 'openrouter') {
            context = await openRouterContext(entry, fetchImpl, signal);
        } else if (entry.provider === 'cloudflare') {
            context = await cloudflareContext(entry, fetchImpl, signal);
        } else if (entry.provider === 'openai' || entry.provider === 'groq') {
            context = await openAiContext(entry, fetchImpl, signal);
        }
    } catch {
        // Network failures, aborts and malformed bodies all mean "unknown".
        context = null;
    }
    cache.set(key, { context, expiresAt: now + CACHE_TTL_MS });
    return context;
}

/**
 * The job budget follows the selected model's context window, clamped to a
 * safe minimum and to the daily cap. Unknown models keep the deployment
 * fallback rather than silently disabling the stop.
 */
export function jobTokenCapForContext(context: number | null, limits = LIMITS): number {
    if (!context) return limits.JOB_TOKEN_CAP;
    return Math.max(
        limits.JOB_TOKEN_CAP_MIN,
        Math.min(limits.JOB_TOKEN_CAP_MAX, limits.USER_DAILY_TOKEN_CAP, context),
    );
}
