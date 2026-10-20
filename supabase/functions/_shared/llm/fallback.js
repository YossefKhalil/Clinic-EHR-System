// Ordered extraction fallback (spec 7.1, extended for mixed providers).
//
// One chunk is tried against chain entry 1, then entry 2, and so on. Only a
// `failed` verdict moves to the next entry: a schema repair rejection stays in
// the review tray, a truncated answer is split, and cancellation stops the
// chain. Usage from failed attempts is added to the winning result so token
// caps and cost accounting include every call that actually happened.

function asUsage(result) {
    return {
        in: Number(result?.usage?.in) || 0,
        out: Number(result?.usage?.out) || 0,
    };
}

function asCost(result) {
    return typeof result?.cost === 'number' ? result.cost : null;
}

function syntheticFailure(entry, err) {
    return {
        status: 'failed',
        documents: [],
        rejected: [],
        truncated: false,
        repairs: false,
        usage: { in: 0, out: 0 },
        model: entry.model,
        cost: null,
        promptId: null,
        errorCode: err?.code || 'PROVIDER_ERROR',
    };
}

/**
 * @param {{
 *   chain: {provider: string, model: string}[],
 *   run: (entry: {provider: string, model: string}) => Promise<any>,
 *   signal?: AbortSignal|null,
 * }} input
 * @returns {Promise<{result: any, attempts: object[], fallback: object[]}>}
 */
export async function runChunkWithFallback({ chain, run, signal = null }) {
    const attempts = [];
    const failures = [];
    let usageIn = 0;
    let usageOut = 0;
    let totalCost = null;
    let lastResult = null;

    for (const entry of chain ?? []) {
        let result;
        try {
            result = await run(entry);
        } catch (err) {
            result = syntheticFailure(entry, err);
        }

        lastResult = result;
        const usage = asUsage(result);
        usageIn += usage.in;
        usageOut += usage.out;
        const cost = asCost(result);
        if (cost !== null) totalCost = (totalCost ?? 0) + cost;

        const attempt = {
            provider: entry.provider,
            model: result?.model || entry.model,
            status: result?.status ?? 'failed',
            errorCode: result?.errorCode ?? null,
            usage,
            cost,
        };
        attempts.push(attempt);

        if (result?.status !== 'failed') {
            return {
                result: {
                    ...result,
                    usage: { in: usageIn, out: usageOut },
                    cost: totalCost,
                },
                attempts,
                fallback: failures.slice(),
            };
        }
        failures.push(attempt);
        if (signal?.aborted) break;
    }

    const last = lastResult ?? syntheticFailure(
        { provider: 'chain', model: '' },
        new Error('empty model chain'),
    );
    return {
        result: {
            ...last,
            status: 'failed',
            errorCode: last?.errorCode ?? 'PROVIDER_ERROR',
            usage: { in: usageIn, out: usageOut },
            cost: totalCost,
        },
        attempts,
        fallback: failures.length > 0 ? failures.slice(0, -1) : [],
    };
}
