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

type CloudflareUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
};

type CloudflarePayload = {
    response?: unknown;
    choices?: unknown;
    content?: unknown;
    text?: unknown;
    finish_reason?: unknown;
    usage?: CloudflareUsage | null;
    model?: unknown;
};

type CloudflareChoice = {
    message?: { content?: unknown } | null;
    text?: unknown;
    finish_reason?: unknown;
};

/** OpenAI-style content may be a string or an array of text parts. */
function contentText(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const joined = value.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                return (part as { text: string }).text;
            }
            return '';
        }).join('');
        return joined || null;
    }
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
        return (value as { text: string }).text;
    }
    return null;
}

function usageCounts(usage: CloudflareUsage | null | undefined) {
    return {
        in: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
        out: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    };
}

export function mapCloudflareResult(json: unknown, fallbackModel: string): LlmResult {
    const data = json as {
        success?: boolean;
        errors?: { message?: string }[];
        error?: { message?: string };
        result?: CloudflarePayload | string | null;
        choices?: unknown;
        usage?: CloudflareUsage | null;
        model?: unknown;
    };
    const errors = (data?.errors ?? []).map((entry) => entry?.message ?? '').filter(Boolean);
    const errorMessage = errors.join('; ') || data?.error?.message || '';
    if (data?.success === false || errorMessage) {
        throw new LlmError('PROVIDER_REJECTED', `Cloudflare Workers AI error: ${errorMessage || 'no result'}`, {
            retryable: false,
        });
    }

    // Older Workers AI chat models wrap the answer in
    // `{ result: { response } }`. Newer OpenAI-compatible models return
    // `{ result: { choices: [{ message: { content } }] } }` (sometimes without
    // the `result` envelope), so accept both shapes instead of reporting
    // "no text" and hiding a perfectly good answer.
    const payload = data?.result ?? data;
    if (payload == null) {
        throw new LlmError('PROVIDER_REJECTED', 'Cloudflare Workers AI error: no result', {
            retryable: false,
        });
    }

    let text: string | null = null;
    let finish: unknown = null;
    let usage: CloudflareUsage | null = data?.usage ?? null;
    let model = fallbackModel;

    if (typeof payload === 'string') {
        text = payload;
    } else if (typeof payload === 'object') {
        const body = payload as CloudflarePayload;
        text = contentText(body.response) ?? contentText(body.content) ?? contentText(body.text);
        usage = body.usage ?? usage;
        finish = body.finish_reason;
        if (typeof body.model === 'string') model = body.model;

        if (text == null && Array.isArray(body.choices) && body.choices.length > 0) {
            const choice = body.choices[0] as CloudflareChoice;
            text = contentText(choice?.message?.content) ?? contentText(choice?.text);
            finish = choice?.finish_reason ?? finish;
        }
    }

    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
        const keys = payload && typeof payload === 'object'
            ? Object.keys(payload as object).join(', ') || 'none'
            : typeof payload;
        throw new LlmError(
            'PROVIDER_BAD_RESPONSE',
            `Cloudflare Workers AI returned no text (result keys: ${keys})`,
            { retryable: false },
        );
    }

    const counts = usageCounts(usage);
    return {
        text: trimmed,
        finishReason: finish === 'length' ? 'length' : 'stop',
        usage: counts,
        model,
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
