// Cloudflare Workers AI adapter (spec §7.1). Text-only in this build: image
// requests are rejected with a clear code until the vision milestone wires a
// multimodal path (spec §10).

import {
    LlmError, LlmProvider, LlmRequest, LlmResult, withRetries,
} from './provider.ts';
import { isReasoningModel, openAiErrorFor, timeoutSignal } from './openai-compatible.ts';
import { answerText, contentText, reasoningText } from './content-text.ts';
import { LIMITS } from '../import-core/limits.js';

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

export function buildCloudflareBody(request: LlmRequest, model = '') {
    if (request.user.some((part) => part.type === 'image')) {
        throw new LlmError('IMAGES_UNSUPPORTED', 'The Cloudflare adapter is text-only in this build', {
            retryable: false,
        });
    }
    const userText = request.user
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
    const body: Record<string, unknown> = {
        messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: userText },
        ],
        temperature: 0,
    };
    if (isReasoningModel(model)) {
        // Reasoning models (Qwen 3.8, DeepSeek R1, ...) default to a high
        // reasoning effort. For structured extraction that can spend the whole
        // completion budget on hidden reasoning and return `content: null`.
        // Low effort is plenty for copying rows into YAML and leaves room for
        // the answer - and the floor keeps a small chunk from spending its
        // whole budget on reasoning before it answers.
        body.max_completion_tokens = Math.max(request.maxTokens, LIMITS.REASONING_MIN_TOKENS);
        body.reasoning_effort = 'low';
    } else {
        body.max_tokens = request.maxTokens;
    }
    return body;
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
    message?: unknown;
    text?: unknown;
    delta?: unknown;
    finish_reason?: unknown;
};

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
        const body = payload as CloudflarePayload & {
            generated_text?: unknown;
            output?: unknown;
        };
        text = contentText(body.response)
            ?? contentText(body.content)
            ?? contentText(body.text)
            ?? contentText(body.generated_text)
            ?? contentText(body.output);
        usage = body.usage ?? usage;
        finish = body.finish_reason;
        if (typeof body.model === 'string') model = body.model;

        if (text == null && Array.isArray(body.choices) && body.choices.length > 0) {
            const choice = body.choices[0];
            if (choice && typeof choice === 'object') {
                finish = (choice as CloudflareChoice).finish_reason ?? finish;
            }
            // The answer and the reasoning are different things. When the
            // model ran out of its completion budget, reasoning_content holds
            // only its thinking - parsing that as data would invent rows, so
            // it is only used when the model stopped normally.
            const answer = answerText(choice);
            const reasoning = reasoningText(choice);
            text = answer ?? (finish === 'length' ? null : reasoning);
        }
    }

    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
        const body = payload && typeof payload === 'object' ? payload as CloudflarePayload : null;
        const keys = body ? Object.keys(body).join(', ') || 'none' : typeof payload;
        const choices = body && Array.isArray(body.choices) ? body.choices : null;
        const first = choices?.[0];
        const firstKeys = first && typeof first === 'object' ? Object.keys(first as object).join(', ') : 'none';
        const message = first && typeof first === 'object' ? (first as CloudflareChoice).message : null;
        const messageKeys = message && typeof message === 'object' ? Object.keys(message as object).join(', ') : 'none';
        const finish = first && typeof first === 'object' ? String((first as CloudflareChoice).finish_reason ?? 'none') : 'none';
        if (finish === 'length') {
            // The model reasoned through the whole completion budget and
            // stopped before it wrote the answer. A retry does not help: the
            // model needs a bigger budget or a different one.
            throw new LlmError(
                'OUTPUT_TRUNCATED',
                'The model used its whole completion budget on reasoning and produced no answer '
                + `(result keys: ${keys}; message: ${messageKeys}; finish: ${finish})`,
                { retryable: false },
            );
        }
        throw new LlmError(
            'PROVIDER_BAD_RESPONSE',
            `Cloudflare Workers AI returned no text (result keys: ${keys}; choices: ${choices?.length ?? 'none'}; first choice: ${firstKeys}; message: ${messageKeys}; finish: ${finish})`,
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
            const body = buildCloudflareBody(request, options.model); // throws before any network call
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
