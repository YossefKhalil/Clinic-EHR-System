// OpenAI-compatible adapter (spec §7.1): works with any endpoint that speaks
// the chat-completions shape — Ollama, LM Studio, OpenAI itself. OpenRouter
// reuses this module with extra headers and provider preferences.

import {
    LlmError, LlmProvider, LlmRequest, LlmResult, parseRetryAfter, withRetries,
} from './provider.ts';

export interface OpenAiCompatibleOptions {
    /** Base URL without the trailing /chat/completions, e.g. https://openrouter.ai/api/v1 */
    baseUrl: string;
    apiKey?: string | null;
    model: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    /** Extra headers (OpenRouter attribution). */
    headers?: Record<string, string>;
    /** Extra top-level body fields (OpenRouter provider preferences). */
    extraBody?: Record<string, unknown>;
    /** Injectable for tests (retry pacing). */
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export function buildOpenAiMessages(request: LlmRequest) {
    return [
        { role: 'system', content: request.system },
        {
            role: 'user',
            content: request.user.map((part) => (part.type === 'text'
                ? { type: 'text', text: part.text }
                : { type: 'image_url', image_url: { url: part.dataUrl } })),
        },
    ];
}

export function buildOpenAiBody(
    model: string,
    request: LlmRequest,
    extraBody: Record<string, unknown> = {},
) {
    return {
        model,
        temperature: 0,
        max_tokens: request.maxTokens,
        messages: buildOpenAiMessages(request),
        ...extraBody,
    };
}

export function mapOpenAiResult(json: unknown, fallbackModel: string): LlmResult {
    const data = json as {
        choices?: { message?: { content?: unknown }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        model?: string;
    };
    const choice = data?.choices?.[0];
    let text = choice?.message?.content;
    if (Array.isArray(text)) {
        text = text.map((part) => (part as { text?: string })?.text ?? '').join('');
    }
    if (typeof text !== 'string') {
        throw new LlmError('PROVIDER_BAD_RESPONSE', 'Provider returned no message content', { retryable: false });
    }
    return {
        text,
        finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
        usage: {
            in: data?.usage?.prompt_tokens ?? 0,
            out: data?.usage?.completion_tokens ?? 0,
        },
        model: typeof data?.model === 'string' && data.model ? data.model : fallbackModel,
        cost: typeof data?.usage?.cost === 'number' ? data.usage.cost : null,
    };
}

export function openAiErrorFor(
    status: number,
    bodyText: string,
    retryAfterHeader: string | null,
    now = Date.now(),
): LlmError {
    const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
    const snippet = String(bodyText ?? '').slice(0, 300);
    if (status === 429) {
        return new LlmError('PROVIDER_RATE_LIMITED', `Rate limited (429): ${snippet}`, {
            retryable: true, retryAfterMs, status,
        });
    }
    if (status >= 500) {
        return new LlmError('PROVIDER_ERROR', `Provider error (${status}): ${snippet}`, {
            retryable: true, status,
        });
    }
    if (status === 401 || status === 403) {
        return new LlmError('PROVIDER_AUTH', `Provider rejected the credentials (${status})`, { status });
    }
    return new LlmError('PROVIDER_REJECTED', `Provider rejected the request (${status}): ${snippet}`, { status });
}

/** Per-call timeout combined with the caller's abort signal. */
export function timeoutSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxAttempts = options.maxAttempts ?? 3;
    const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    return {
        model: options.model,
        async complete(request: LlmRequest): Promise<LlmResult> {
            return withRetries(async () => {
                const headers: Record<string, string> = {
                    'content-type': 'application/json',
                    ...(options.headers ?? {}),
                };
                if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

                let response: Response;
                try {
                    response = await fetchImpl(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(buildOpenAiBody(options.model, request, options.extraBody)),
                        signal: timeoutSignal(request.signal, timeoutMs),
                    });
                } catch (err) {
                    if (request.signal?.aborted) throw err;
                    throw new LlmError(
                        'PROVIDER_TIMEOUT',
                        `Provider call failed or timed out after ${timeoutMs} ms`,
                        { retryable: true, cause: err },
                    );
                }
                if (!response.ok) {
                    const body = await response.text().catch(() => '');
                    throw openAiErrorFor(response.status, body, response.headers.get('retry-after'));
                }
                return mapOpenAiResult(await response.json(), options.model);
            }, {
                maxAttempts,
                signal: request.signal ?? null,
                sleep: options.sleep,
                random: options.random,
            });
        },
    };
}
