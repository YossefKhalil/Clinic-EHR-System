// Cloudflare Workers AI adapter (spec §7.1). Text-only in this build: image
// requests are rejected with a clear code until the vision milestone wires a
// multimodal path (spec §10).

import {
    LlmError, LlmProvider, LlmRequest, LlmResult, withRetries,
} from './provider.ts';
import { openAiErrorFor, timeoutSignal } from './openai-compatible.ts';

export interface CloudflareOptions {
    accountId: string;
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export function buildCloudflareBody(request: LlmRequest) {
    if (request.user.some((part) => part.type === 'image')) {
        throw new LlmError('IMAGES_UNSUPPORTED', 'The Cloudflare adapter is text-only in this build', {
            retryable: false,
        });
    }
    const userText = request.user
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
    return {
        messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: userText },
        ],
        max_tokens: request.maxTokens,
        temperature: 0,
    };
}

export function mapCloudflareResult(json: unknown, fallbackModel: string): LlmResult {
    const data = json as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: {
            response?: unknown;
            finish_reason?: string;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
    };
    if (data?.success === false || !data?.result) {
        const detail = (data?.errors ?? []).map((entry) => entry?.message ?? '').filter(Boolean).join('; ');
        throw new LlmError('PROVIDER_REJECTED', `Cloudflare Workers AI error: ${detail || 'no result'}`, {
            retryable: false,
        });
    }
    const text = data.result.response;
    if (typeof text !== 'string') {
        throw new LlmError('PROVIDER_BAD_RESPONSE', 'Cloudflare Workers AI returned no text', {
            retryable: false,
        });
    }
    return {
        text,
        finishReason: data.result.finish_reason === 'length' ? 'length' : 'stop',
        usage: {
            in: data.result.usage?.prompt_tokens ?? 0,
            out: data.result.usage?.completion_tokens ?? 0,
        },
        model: fallbackModel,
    };
}

export function createCloudflareProvider(options: CloudflareOptions): LlmProvider {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxAttempts = options.maxAttempts ?? 3;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${options.model}`;

    return {
        model: options.model,
        async complete(request: LlmRequest): Promise<LlmResult> {
            const body = buildCloudflareBody(request); // throws before any network call
            return withRetries(async () => {
                let response: Response;
                try {
                    response = await fetchImpl(url, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            authorization: `Bearer ${options.apiKey}`,
                        },
                        body: JSON.stringify(body),
                        signal: timeoutSignal(request.signal, timeoutMs),
                    });
                } catch (err) {
                    if (request.signal?.aborted) throw err;
                    if (err instanceof LlmError) throw err;
                    throw new LlmError(
                        'PROVIDER_TIMEOUT',
                        `Cloudflare call failed or timed out after ${timeoutMs} ms`,
                        { retryable: true, cause: err },
                    );
                }
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw openAiErrorFor(response.status, text, response.headers.get('retry-after'));
                }
                return mapCloudflareResult(await response.json(), options.model);
            }, {
                maxAttempts,
                signal: request.signal ?? null,
                sleep: options.sleep,
                random: options.random,
            });
        },
    };
}
