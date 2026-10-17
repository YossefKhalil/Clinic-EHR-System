// Provider interface and retry policy (spec §7.1).
//
// Three adapters implement this: OpenRouter, Cloudflare Workers AI and any
// OpenAI-compatible endpoint (Ollama, LM Studio, …). Retries happen only for
// transient failures — 429, 5xx and timeouts — with exponential backoff plus
// jitter, honouring Retry-After. Parse/schema failures are the repair loop's
// job (spec §7.5), never blind retries.

export type LlmMessage =
    | { type: 'text'; text: string }
    | { type: 'image'; dataUrl: string };

export interface LlmRequest {
    system: string;
    user: LlmMessage[];
    maxTokens: number;
    temperature: 0;
    signal?: AbortSignal;
}

export interface LlmResult {
    text: string;
    finishReason: 'stop' | 'length' | 'error';
    usage: { in: number; out: number };
    model: string;
    /** Provider-reported cost when available (OpenRouter); null otherwise. */
    cost?: number | null;
}

export interface LlmProvider {
    readonly model: string;
    complete(req: LlmRequest): Promise<LlmResult>;
}

/** A provider failure that knows whether retrying can help. */
export class LlmError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly retryAfterMs: number | null;
    readonly status: number | null;

    constructor(
        code: string,
        message: string,
        options: { retryable?: boolean; retryAfterMs?: number | null; status?: number | null; cause?: unknown } = {},
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'LlmError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.retryAfterMs = options.retryAfterMs ?? null;
        this.status = options.status ?? null;
    }
}

/** Retry-After may be seconds or an HTTP date (RFC 9110). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
    return null;
}

export interface RetryOptions {
    /** Total attempts, spec §7.1: max 3. */
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Injectable for tests; defaults to real sleeping. */
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal | null;
    /** Injectable jitter source for deterministic tests. */
    random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with the spec §7.1 retry policy. Rethrows immediately when the
 * error is not retryable (schema failures, 4xx, aborts) or attempts run out.
 */
export async function withRetries<T>(
    fn: () => Promise<T>,
    {
        maxAttempts = 3,
        baseDelayMs = 500,
        maxDelayMs = 8_000,
        sleep = defaultSleep,
        signal = null,
        random = Math.random,
    }: RetryOptions = {},
): Promise<T> {
    let attempt = 1;
    for (;;) {
        try {
            return await fn();
        } catch (err) {
            if (signal?.aborted) throw err;
            const retryable = err instanceof LlmError && err.retryable;
            if (!retryable || attempt >= maxAttempts) throw err;

            const step = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const jittered = step / 2 + random() * (step / 2);
            const waitMs = Math.max(jittered, err.retryAfterMs ?? 0);
            attempt += 1;
            await sleep(Math.round(waitMs));
            if (signal?.aborted) throw err;
        }
    }
}
