// OpenRouter adapter (spec §7.1): the OpenAI-compatible shape plus a
// per-request provider preference that denies data collection, and an ordered
// model fallback that kicks in only after a model's transient failures repeat
// (never on schema failures — those never reach the provider layer).

import { LlmError, LlmProvider, LlmRequest, LlmResult } from './provider.ts';
import { createOpenAiCompatibleProvider } from './openai-compatible.ts';

export interface OpenRouterOptions {
    apiKey: string;
    /** One model or an ordered fallback list (comma/space separated). */
    model: string | string[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    /** Optional attribution headers. */
    appUrl?: string;
    appTitle?: string;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export function modelList(model: string | string[]): string[] {
    const list = Array.isArray(model) ? model : String(model ?? '').split(/[,\s]+/);
    const models = list.map((entry) => entry.trim()).filter(Boolean);
    if (models.length === 0) throw new Error('OpenRouter: no model configured');
    return models;
}

/**
 * OpenRouter body extras. `data_collection: 'deny'` routes to providers that
 * do not train on or retain the request (spec §7.1).
 */
export const OPENROUTER_PROVIDER_PREFS = Object.freeze({ data_collection: 'deny' });

export function createOpenRouterProvider(options: OpenRouterOptions): LlmProvider {
    const models = modelList(options.model);
    const build = (model: string) => createOpenAiCompatibleProvider({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: options.apiKey,
        model,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        maxAttempts: options.maxAttempts,
        headers: {
            ...(options.appUrl ? { 'HTTP-Referer': options.appUrl } : {}),
            ...(options.appTitle ? { 'X-Title': options.appTitle } : {}),
        },
        extraBody: { provider: OPENROUTER_PROVIDER_PREFS },
        sleep: options.sleep,
        random: options.random,
    });

    return {
        model: models[0],
        async complete(request: LlmRequest): Promise<LlmResult> {
            let lastError: LlmError | null = null;
            for (const model of models) {
                try {
                    return await build(model).complete(request);
                } catch (err) {
                    // Fall through to the next model only on repeated transient
                    // failure; auth and rejected requests fail immediately.
                    if (err instanceof LlmError && err.retryable) {
                        lastError = err;
                        continue;
                    }
                    throw err;
                }
            }
            throw lastError ?? new LlmError('PROVIDER_ERROR', 'OpenRouter: all models failed');
        },
    };
}
