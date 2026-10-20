// One place that knows how a chat-completion answer can be shaped.
//
// Providers disagree on where the generated text lives:
//   - `choices[0].message.content`            (plain OpenAI shape)
//   - `choices[0].message.reasoning_content`  (reasoning models: content is null)
//   - `choices[0].message.reasoning`          (some gateways)
//   - `choices[0].delta.content`              (streamed answers replayed as deltas)
//   - `choices[0].text`                       (older completions shapes)
//
// The Cloudflare adapter and the OpenAI-compatible adapter (OpenAI, Groq,
// Ollama, LM Studio) must agree, otherwise the same model works with one
// provider and reports "returned no text" with the other.
//
// The answer and the reasoning are kept apart on purpose: when a model ran
// out of its completion budget, `reasoning_content` holds only its thinking
// ("let me look at the table..."), which is not an answer and must never be
// parsed as one.

/** OpenAI-style content may be a string, an array of text parts or an object. */
export function contentText(value: unknown): string | null {
    if (typeof value === 'string') return value.trim() ? value : null;
    if (Array.isArray(value)) {
        const joined = value.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                return (part as { text: string }).text;
            }
            return '';
        }).join('');
        return joined.trim() ? joined : null;
    }
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
        const text = (value as { text: string }).text;
        return text.trim() ? text : null;
    }
    return null;
}

type MessageLike = {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
};

type ChoiceLike = {
    message?: unknown;
    text?: unknown;
    delta?: unknown;
    finish_reason?: unknown;
};

function messageOf(choice: ChoiceLike): MessageLike | null {
    if (!choice.message || typeof choice.message !== 'object') return null;
    return choice.message as MessageLike;
}

/** The answer itself: `message.content`, `delta.content` or `text`. */
export function answerText(value: unknown): string | null {
    if (typeof value === 'string') return contentText(value);
    if (!value || typeof value !== 'object') return null;
    const choice = value as ChoiceLike;
    const message = messageOf(choice);
    if (message) {
        const content = contentText(message.content);
        if (content) return content;
    }
    if (choice.delta && typeof choice.delta === 'object') {
        const content = contentText((choice.delta as { content?: unknown }).content);
        if (content) return content;
    }
    return contentText(choice.text);
}

/** The model's hidden reasoning: never an answer on its own. */
export function reasoningText(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const choice = value as ChoiceLike;
    const message = messageOf(choice);
    if (message) {
        return contentText(message.reasoning_content) ?? contentText(message.reasoning);
    }
    if (choice.delta && typeof choice.delta === 'object') {
        const delta = choice.delta as { reasoning_content?: unknown; reasoning?: unknown };
        return contentText(delta.reasoning_content) ?? contentText(delta.reasoning);
    }
    return null;
}

/**
 * The generated text of one choice, whatever shape the provider used.
 * Returns null when the choice carries no text at all.
 */
export function choiceText(value: unknown): string | null {
    return answerText(value) ?? reasoningText(value);
}
