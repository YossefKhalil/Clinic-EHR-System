// Bridges the shared chunk runner to the local wllama engine. The runner and
// the YAML contract are the same modules the old server used; only the
// provider changed. Images are converted from the stored data URL to the
// ArrayBuffer shape wllama expects, and nothing is uploaded.

import yaml from 'js-yaml';
import { LIMITS } from '@import-core/limits.js';
import { runChunk } from '@import-extract/run-chunk.js';
import { MODEL_MANIFEST } from './manifest.js';

export function dataUrlToBuffer(dataUrl) {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) throw new Error('IMAGE_DECODE_FAILED');
    const header = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const binary = header.includes(';base64')
        ? atob(body)
        : decodeURIComponent(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function contentParts(parts) {
    return parts.map((part) => {
        if (part?.type === 'image') {
            return { type: 'image', data: dataUrlToBuffer(part.dataUrl) };
        }
        return { type: 'text', text: String(part?.text ?? '') };
    });
}

export function createLocalProvider(engine) {
    return {
        model: MODEL_MANIFEST.title,
        async complete(request) {
            const messages = [
                { role: 'system', content: String(request.system ?? '') },
                { role: 'user', content: contentParts(request.user ?? []) },
            ];
            const response = await engine.chat(messages, {
                maxTokens: request.maxTokens,
                temperature: request.temperature,
                signal: request.signal,
                grammar: request.grammar,
                responseFormat: request.responseFormat,
            });
            return {
                text: response.text,
                finishReason: response.finishReason,
                usage: response.usage,
                timings: response.timings,
                model: MODEL_MANIFEST.title,
                cost: 0,
            };
        },
    };
}

export async function extractChunk({ engine, chunk, hints = '', signal, maxTokens = null, onLog = null }) {
    const provider = createLocalProvider(engine);
    return runChunk({
        provider,
        chunk,
        hints,
        limits: LIMITS,
        yaml,
        signal,
        maxTokens,
        mode: 'local',
        onLog,
        delimiter: undefined,
        repairDelimiter: undefined,
    });
}