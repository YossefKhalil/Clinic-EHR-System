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

/**
 * The generated text of one choice, whatever shape the provider used.
 * Returns null when the choice carries no text at all.
 */
export function choiceText(value: unknown): string | null {
    if (typeof value === 'string') return contentText(value);
    if (!value || typeof value !== 'object') return null;
    const choice = value as ChoiceLike;
    if (typeof choice.message === 'string') return contentText(choice.message);
    if (choice.message && typeof choice.message === 'object') {
        const message = choice.message as MessageLike;
        const text = contentText(message.content)
            ?? contentText(message.reasoning_content)
            ?? contentText(message.reasoning);
        if (text) return text;
    }
    if (choice.delta && typeof choice.delta === 'object') {
        const delta = choice.delta as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
        const text = contentText(delta.content)
            ?? contentText(delta.reasoning_content)
            ?? contentText(delta.reasoning);
        if (text) return text;
    }
    return contentText(choice.text);
}
