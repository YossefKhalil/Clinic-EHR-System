// The v2 provider: the same `complete()` contract the v1 engine implements,
// so `runChunk()` — the extractor, the YAML contract, the repair pass — works
// unchanged against a WebLLM model.
//
// Two differences from v1 matter here:
//   * Reasoning models write a thinking block before the answer. The
//     extractor must never see it, so it is stripped at this seam.
//   * v2 is text only. A photo part is refused with a code instead of being
//     silently dropped, so the wizard can say why.

const DEFAULT_MAX_TOKENS = 4096;

/** The DeepSeek-style marker reasoning models wrap their thinking in. */
const THINK_MARKER = '\uFF5C\uFF5C\uFF5C';

/**
 * Remove the model's reasoning, keeping only the answer.
 *
 * Three shapes are handled: the marker pair
 * (`｜｜｜reasoning｜｜｜answer`), `<thinking>` / `<|channel>thought` blocks,
 * and an unterminated block of any of them. A model that ran out of tokens
 * while still thinking has no answer to rescue, so the text is cut back to
 * nothing rather than letting half a thought reach the parser.
 */
export function stripReasoning(text) {
    let out = String(text ?? '');

    if (out.includes(THINK_MARKER)) {
        const parts = out.split(THINK_MARKER);
        // marker + reasoning + marker + answer = three parts. Two parts means
        // the model opened a block and never closed it.
        if (parts.length < 3) return '';
        out = parts.slice(2).join('');
    }

    if (/^\s*<\|channel>thought/i.test(out)) {
        const closed = out.replace(/^\s*<\|channel>thought[\s\S]*?<channel\|>/i, '');
        out = closed === out ? '' : closed;
    }

    if (/^\s*<\s*(?:redacted_)?think(?:ing)?\s*>/i.test(out)) {
        const closed = out.replace(/^\s*<\s*(?:redacted_)?think(?:ing)?\s*>[\s\S]*?<\s*\/\s*(?:redacted_)?think(?:ing)?\s*>/i, '');
        out = closed === out ? '' : closed;
    }

    return out.trimStart();
}

function usageFrom(response, fallbackText) {
    const usage = response?.usage;
    if (usage && typeof usage.prompt_tokens === 'number') {
        return { in: usage.prompt_tokens, out: usage.completion_tokens ?? 0 };
    }
    return { in: 0, out: Math.ceil(String(fallbackText ?? '').length / 4) };
}

/**
 * Build the provider around a loaded engine.
 *
 * @param {{ engine: object, model: object }} input
 */
export function createWebLlmProvider(input) {
    const { engine, model } = input;
    if (!engine) throw new Error('no engine');

    const sampling = {
        temperature: Number(model?.sampling?.temperature ?? 0.7),
        topP: Number(model?.sampling?.topP ?? 0.95),
        frequencyPenalty: Number(model?.sampling?.frequencyPenalty ?? 0.5),
    };

    return {
        get model() {
            return model?.id ?? 'local/webllm';
        },
        get multimodal() {
            return false;
        },
        async complete(request) {
            const parts = Array.isArray(request?.user) ? request.user : [];
            if (parts.some((part) => part.type === 'image')) {
                const error = new Error('MODEL_NOT_MULTIMODAL');
                error.code = 'MODEL_NOT_MULTIMODAL';
                throw error;
            }
            const userText = parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n');

            const maxTokens = Math.min(
                Number(request?.maxTokens) || DEFAULT_MAX_TOKENS,
                DEFAULT_MAX_TOKENS,
            );

            const response = await engine.chat({
                messages: [
                    { role: 'system', content: request?.system ?? '' },
                    { role: 'user', content: userText },
                ],
                max_tokens: maxTokens,
                temperature: sampling.temperature,
                top_p: sampling.topP,
                frequency_penalty: sampling.frequencyPenalty,
                ...(request?.signal ? { signal: request.signal } : {}),
            });

            const choice = response?.choices?.[0];
            const raw = String(choice?.message?.content ?? '');
            return {
                text: stripReasoning(raw),
                finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
                usage: usageFrom(response, raw),
                model: model?.id ?? 'local/webllm',
                cost: 0,
            };
        },
    };
}
