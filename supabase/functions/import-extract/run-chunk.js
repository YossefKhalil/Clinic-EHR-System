// Per-chunk extraction (spec §7): build the request, call the provider, parse
// the YAML contract, run the single repair call for invalid documents, and
// return a verdict the pump can persist.
//
// Pure orchestration — the provider object and the `js-yaml` module are
// injected, so tests drive a fake provider in Node while the Edge Function
// passes the real ones. Nothing here talks to the database.

import { LIMITS } from '../_shared/import-core/limits.js';
import {
    EXTRACTOR_SYSTEM, LOCAL_EXTRACTOR_SYSTEM, PROMPT_IDS, buildExtractorUser, buildRepairUser,
    makeDelimiter, parseContract,
} from '../_shared/import-core/yaml-contract.js';

/**
 * max_tokens from the chunk size (spec §7.2): ≈300 tokens per expected record,
 * with a floor and a ceiling — not a fixed 8,000.
 *
 * A caller that knows its own context window (the local engine) may pass
 * `override`. Its budget is the budget: the floor exists so a cloud model
 * does not answer with nothing, and it would not fit a small local context.
 */
export function maxTokensFor(lineCount, limits = LIMITS, override = null) {
    const budget = Number(override);
    if (Number.isFinite(budget) && budget > 0) {
        return Math.min(limits.MAX_TOKENS_CEILING, Math.round(budget));
    }
    const expected = Math.max(1, Number(lineCount) || 1);
    return Math.min(
        limits.MAX_TOKENS_CEILING,
        Math.max(limits.MAX_TOKENS_FLOOR, expected * limits.APPROX_TOKENS_PER_RECORD),
    );
}

function rejectionsFrom(bad, lines) {
    return bad.map((entry) => ({ index: entry.index, raw: entry.raw, error: entry.error, lines }));
}

/** `timings` in llama-server terms -> one short human line. */
function timingsLabel(timings) {
    const prefill = Number(timings?.prompt_per_second ?? 0);
    const decode = Number(timings?.predicted_per_second ?? 0);
    const parts = [];
    if (prefill > 0) parts.push(`prefill ${prefill.toFixed(1)} tok/s`);
    if (decode > 0) parts.push(`decode ${decode.toFixed(1)} tok/s`);
    if (timings?.prompt_n) parts.push(`${timings.prompt_n} in / ${timings.predicted_n} out`);
    return parts.join(', ');
}

function snippet(text, length = 600) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > length ? `${value.slice(0, length)}…` : value;
}

/**
 * Merge the documents of a repair parse back into the original index space.
 *
 * `parseContract` numbers the documents of one parse 1..N, including the
 * broken ones (a broken document still occupies its position). The repair
 * call only asks for the broken documents, so its own numbering restarts at
 * 1. Merging the two lists as-is makes two different patients share one
 * index, and the server then stores the same record twice: the first patient
 * is overwritten by the repaired one.
 *
 * The repaired documents are therefore re-indexed onto the free positions of
 * the original parse (the positions of the documents that were broken), and
 * every index stays unique.
 */
export function mergeRepairedDocuments(documents, bad, reparsed) {
    const used = new Set(documents.map((doc) => doc.index));
    const free = bad.map((entry) => entry.index).filter((index) => !used.has(index));
    const nextFreeIndex = () => {
        let index = 1;
        while (used.has(index)) index += 1;
        used.add(index);
        return index;
    };
    const takeIndex = (position) => {
        const candidate = free[position];
        if (candidate !== undefined && !used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
        return nextFreeIndex();
    };
    const mergedDocuments = reparsed.documents.map((doc, position) => ({
        ...doc,
        index: takeIndex(position),
    }));
    const mergedBad = reparsed.bad.map((entry, position) => ({
        ...entry,
        index: takeIndex(mergedDocuments.length + position),
    }));
    return { documents: mergedDocuments, bad: mergedBad };
}

/**
 * Run one chunk end to end.
 *
 * @param {{
 *   provider: { complete: Function, model?: string },
 *   chunk: { header?: string|null, lines: {id: string, text: string}[], kind?: string },
 *   hints?: string,
 *   limits?: typeof LIMITS,
 *   yaml: object,                 // js-yaml module namespace
 *   signal?: AbortSignal|null,
 *   maxTokens?: number|null,      // the caller's own budget (the local engine)
 *   delimiter?: string,           // injectable for tests
 *   repairDelimiter?: string,
 *   mode?: 'yaml'|'local',        // 'local' = compact prompt + JSON answer
 *   onLog?: (entry: {level: string, message: string, detail?: string}) => void,
 * }} input
 * @returns {Promise<{
 *   status: 'ok'|'truncated'|'failed'|'cancelled',
 *   documents: {index: number, raw: string, record: object}[],
 *   rejected: {index: number, raw: string, error: string, lines: object[]}[],
 *   truncated: boolean,
 *   repairs: boolean,
 *   usage: {in: number, out: number},
 *   model: string|null,
 *   cost: number|null,
 *   promptId: string,
 *   errorCode?: string,
 * }>}
 */
export async function runChunk({
    provider,
    chunk,
    hints = '',
    limits = LIMITS,
    yaml,
    signal = null,
    maxTokens = null,
    delimiter,
    repairDelimiter,
    mode = 'yaml',
    onLog = null,
}) {
    const local = mode === 'local';
    const log = (level, message, detail = '') => {
        try {
            onLog?.({ level, message, detail });
        } catch {
            // logging must never break an extraction
        }
    };
    const usage = { in: 0, out: 0 };
    let model = provider.model ?? null;
    let cost = null;
    const lines = chunk.lines ?? [];
    const aborted = () => Boolean(signal?.aborted);
    const base = {
        documents: [], rejected: [], truncated: false, repairs: false,
        usage, model, cost, promptId: PROMPT_IDS.extractor,
    };
    const addUsage = (entry) => {
        usage.in += entry?.usage?.in ?? 0;
        usage.out += entry?.usage?.out ?? 0;
        model = entry?.model ?? model;
        if (typeof entry?.cost === 'number') cost = (cost ?? 0) + entry.cost;
        base.model = model;
        base.cost = cost;
    };

    if (aborted()) return { ...base, status: 'cancelled' };

    // A photo of a note travels with the request as image parts (spec §5.4).
    const images = Array.isArray(chunk.images) ? chunk.images : [];
    const imageParts = images
        .filter((image) => typeof image?.dataUrl === 'string' && image.dataUrl.length > 0)
        .map((image) => ({ type: 'image', dataUrl: image.dataUrl }));

    let user = buildExtractorUser({
        header: chunk.header ?? null,
        lines,
        hints,
        delimiter: delimiter ?? makeDelimiter('SRC'),
        images: imageParts.length > 0 ? images : [],
    });
    if (local) {
        // A small model likes to renumber the source when a chunk holds more
        // than one patient (S1, S2, ...), which makes every _src after the
        // first one ungroundable. Say the rule once, with the real id.
        const ids = lines.map((line) => line.id).filter(Boolean);
        const prefix = ids.length > 0 ? String(ids[0]).split(':')[0] : null;
        if (prefix) {
            user += '\n\nEvery _src value must be one of the ids above, exactly as written '
                + `(for example "${ids[0]}"). Every id in this chunk starts with "${prefix}:"; `
                + 'never use a different prefix and never invent line numbers.';
        }
    }
    const request = {
        system: local ? LOCAL_EXTRACTOR_SYSTEM : EXTRACTOR_SYSTEM,
        user: [{ type: 'text', text: user }, ...imageParts],
        maxTokens: maxTokensFor(lines.length, limits, maxTokens),
        temperature: 0,
        signal,
        // The on-device runtime turns this into llama.cpp's json_object
        // grammar: valid JSON or nothing, never a half-written YAML stream.
        ...(local ? { responseFormat: { type: 'json_object' } } : {}),
    };
    log('info', `chunk sent: ${lines.length} line(s), ${imageParts.length} image(s), `
        + `prompt ~${Math.round((request.system.length + user.length) / 3.6)} tokens, `
        + `budget ${request.maxTokens} tokens`);

    let result;
    try {
        result = await provider.complete(request);
    } catch (err) {
        if (aborted()) return { ...base, status: 'cancelled' };
        const detail = String(err?.message ?? '').slice(0, 500) || null;
        // OpenRouter returns 404 (not 403) when the request's data policy
        // filters out every endpoint. Free models require "free model
        // training"; this app sends data_collection: 'deny', so free models
        // can never satisfy it. Name the real cause instead of showing only
        // PROVIDER_REJECTED and making the owner try every free model.
        const dataPolicyBlocked = err?.code === 'PROVIDER_REJECTED'
            && /No endpoints found matching your data policy/i.test(detail ?? '');
        const code = dataPolicyBlocked ? 'DATA_POLICY_BLOCKED' : (err?.code || 'PROVIDER_ERROR');
        log('error', `model call failed: ${code}`, detail ?? '');
        return {
            ...base,
            status: 'failed',
            errorCode: code,
            // The provider map already puts the upstream status and a short
            // response body in the message. Keep it so the review banner can
            // say *why* the call failed instead of only "PROVIDER_ERROR".
            errorDetail: detail,
            retryAfterMs: err?.retryAfterMs ?? null,
        };
    }
    addUsage(result);
    log('info', `model answered: ${String(result.text ?? '').length} chars, `
        + `finish=${result.finishReason ?? '?'}, tokens in/out=${usage.in}/${usage.out}`
        + (result.timings ? `, ${timingsLabel(result.timings)}` : ''));

    const parsed = parseContract(result.text ?? '', {
        yaml,
        finishReason: result.finishReason,
        format: local ? 'json' : 'yaml',
    });
    if (!parsed.ok) {
        log('error', `parse failed: ${parsed.code}`, snippet(result.text));
        return { ...base, status: 'failed', errorCode: parsed.code };
    }
    log(parsed.bad.length > 0 || parsed.documents.length === 0 ? 'warn' : 'info',
        `parsed: ${parsed.documents.length} document(s), ${parsed.bad.length} rejected`
        + (parsed.truncated ? ', truncated' : ''));
    if (parsed.documents.length === 0) {
        log('warn', 'no patient records in the answer', snippet(result.text));
    }
    for (const entry of parsed.bad.slice(0, 5)) {
        log('warn', `document ${entry.index} rejected: ${entry.error}`, snippet(entry.raw, 300));
    }

    let documents = parsed.documents;
    let rejected = [];

    if (parsed.bad.length > 0) {
        // One repair call per chunk (spec §7.5), same system message — the A.3
        // note is appended to the original user message.
        if (aborted()) {
            return { ...base, status: 'cancelled', repairs: true, rejected: rejectionsFrom(parsed.bad, lines) };
        }
        const repairUser = buildRepairUser({
            base: user,
            bad: parsed.bad,
            errors: parsed.bad.map((entry) => `document ${entry.index}: ${entry.error}`),
            delimiter: repairDelimiter ?? makeDelimiter('BAD'),
        });
        let repaired = null;
        try {
            repaired = await provider.complete({
                ...request,
                // The repair call needs the images again: the broken document
                // has to be read from the same photo.
                user: [{ type: 'text', text: repairUser }, ...imageParts],
            });
        } catch {
            repaired = null;
        }
        if (repaired) {
            addUsage(repaired);
            const reparsed = parseContract(repaired.text ?? '', { yaml, finishReason: repaired.finishReason });
            if (reparsed.ok) {
                // The repair call numbers its documents from 1 again; put them
                // back onto the original positions so two patients never share
                // one index (and one patient never overwrites the other).
                const merged = mergeRepairedDocuments(documents, parsed.bad, reparsed);
                documents = [...documents, ...merged.documents];
                rejected = rejectionsFrom(merged.bad, lines);
            } else {
                rejected = rejectionsFrom(parsed.bad, lines);
            }
        } else {
            rejected = rejectionsFrom(parsed.bad, lines);
        }
    }

    const status = parsed.truncated ? 'truncated' : 'ok';
    log(status === 'ok' ? 'info' : 'warn',
        `chunk done: ${status}, ${documents.length} document(s), ${rejected.length} rejected`
        + (parsed.truncated ? ' — the tail was dropped and the chunk will be split' : ''));
    return {
        status,
        documents,
        rejected,
        truncated: parsed.truncated,
        repairs: parsed.bad.length > 0,
        usage,
        model,
        cost,
        promptId: PROMPT_IDS.extractor,
    };
}
