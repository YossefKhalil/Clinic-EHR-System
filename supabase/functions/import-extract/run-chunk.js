// Per-chunk extraction (spec §7): build the request, call the provider, parse
// the YAML contract, run the single repair call for invalid documents, and
// return a verdict the pump can persist.
//
// Pure orchestration — the provider object and the `js-yaml` module are
// injected, so tests drive a fake provider in Node while the Edge Function
// passes the real ones. Nothing here talks to the database.

import { LIMITS } from '../_shared/import-core/limits.js';
import {
    EXTRACTOR_SYSTEM, PROMPT_IDS, buildExtractorUser, buildRepairUser,
    makeDelimiter, parseContract,
} from '../_shared/import-core/yaml-contract.js';

/**
 * max_tokens from the chunk size (spec §7.2): ≈300 tokens per expected record,
 * with a floor and a ceiling — not a fixed 8,000.
 */
export function maxTokensFor(lineCount, limits = LIMITS) {
    const expected = Math.max(1, Number(lineCount) || 1);
    return Math.min(
        limits.MAX_TOKENS_CEILING,
        Math.max(limits.MAX_TOKENS_FLOOR, expected * limits.APPROX_TOKENS_PER_RECORD),
    );
}

function rejectionsFrom(bad, lines) {
    return bad.map((entry) => ({ index: entry.index, raw: entry.raw, error: entry.error, lines }));
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
 *   delimiter?: string,           // injectable for tests
 *   repairDelimiter?: string,
 * }} input
 * @returns {Promise<{
 *   status: 'ok'|'truncated'|'failed'|'cancelled',
 *   documents: {index: number, raw: string, record: object}[],
 *   rejected: {index: number, raw: string, error: string, lines: object[]}[],
 *   truncated: boolean,
 *   repairs: boolean,
 *   usage: {in: number, out: number},
 *   model: string|null,
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
    delimiter,
    repairDelimiter,
}) {
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

    const user = buildExtractorUser({
        header: chunk.header ?? null,
        lines,
        hints,
        delimiter: delimiter ?? makeDelimiter('SRC'),
    });
    const request = {
        system: EXTRACTOR_SYSTEM,
        user: [{ type: 'text', text: user }],
        maxTokens: maxTokensFor(lines.length, limits),
        temperature: 0,
        signal,
    };

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
        return {
            ...base,
            status: 'failed',
            errorCode: dataPolicyBlocked ? 'DATA_POLICY_BLOCKED' : (err?.code || 'PROVIDER_ERROR'),
            // The provider map already puts the upstream status and a short
            // response body in the message. Keep it so the review banner can
            // say *why* the call failed instead of only "PROVIDER_ERROR".
            errorDetail: detail,
            retryAfterMs: err?.retryAfterMs ?? null,
        };
    }
    addUsage(result);

    const parsed = parseContract(result.text ?? '', { yaml, finishReason: result.finishReason });
    if (!parsed.ok) return { ...base, status: 'failed', errorCode: parsed.code };

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
            repaired = await provider.complete({ ...request, user: [{ type: 'text', text: repairUser }] });
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

    return {
        status: parsed.truncated ? 'truncated' : 'ok',
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
