// Which models can look at an image.
//
// The import agent sends photos of notes to the model, so the chain has to
// know which of its entries can actually read an image: a text-only model
// answers "I cannot see the image" or fails outright, and the user gets a
// dead import with no explanation.
//
// The list is a model-id heuristic (providers do not expose a capability
// flag). It is deliberately generous: a false positive costs one failed
// provider call and the chain moves on, while a false negative tells a user
// with a working vision model that no vision model exists.

const VISION_PATTERNS = [
    // The word itself covers most families.
    /vision/,
    /llava/,
    /llama-4/,           // Llama 4 (Scout/Maverick) is multimodal
    /scout-17b/,
    /gpt-4o/,
    /gpt-4\.1/,
    /gpt-4\.5/,
    /gpt-5/,
    /gpt-4-turbo/,
    /o4-mini/,
    /pixtral/,
    /molmo/,
    /idefics/,
    /palmyra/,
    /gemma-3/,           // Gemma 3 is multimodal
    /gemma-3n/,
    /kimi-k2/,           // Kimi K2 reads images
    /mistral-small-3/,
    /ministral-3/,
    /phi-4-multimodal/,
    /phi-3\.5-vision/,
    /gemini-1\.5/,
    /gemini-2/,
    /gemini-3/,
    /internvl/,
    /qwen2\.5-vl/,
    /qwen2-vl/,
    /qwen-vl/,
    /glm-4v/,
    /minicpm-v/,
    /nova-(lite|pro|premium)/,   // Bedrock Nova
    /step-1v/,
];

/**
 * True when the model can read an image.
 *
 * @param {string} model model id, with or without a provider prefix
 * @returns {boolean}
 */
export function isVisionModel(model: string): boolean {
    const id = String(model ?? '').toLowerCase();
    if (!id) return false;
    return VISION_PATTERNS.some((pattern) => pattern.test(id));
}

/** The vision-capable entries of a chain. */
export function visionEntries(chain) {
    return (chain ?? []).filter((entry) => isVisionModel(entry?.model));
}

/** A readable list of the models that cannot see images (for the message). */
export function modelList(chain) {
    return (chain ?? []).map((entry) => entry?.model).filter(Boolean).join(', ');
}
