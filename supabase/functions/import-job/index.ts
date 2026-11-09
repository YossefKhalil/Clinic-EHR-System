// import-job is intentionally inert while the CPU-only local runtime is rebuilt.
//
// The MLC/WebGPU engine and the cloud provider runtime were removed. There is
// deliberately no flag, setting or credential that can turn extraction back on:
// every job action below is refused, and `enabled` always answers false. This
// keeps old clients from creating work against a runtime that no longer exists.
//
// The CPU implementation will replace this file together with its own browser
// engine; it must not resurrect the cloud path.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
}

function disabled(): Response {
    return json({
        ok: false,
        code: 'AI_DISABLED',
        message_key: 'importAgent.error.AI_DISABLED',
    }, 403);
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') {
        return json({ ok: false, code: 'BAD_REQUEST', message_key: 'importAgent.error.BAD_REQUEST' }, 405);
    }

    let action = '';
    try {
        const body = await req.json() as Record<string, unknown>;
        action = String(body.action ?? '');
    } catch {
        return json({ ok: false, code: 'BAD_REQUEST', message_key: 'importAgent.error.BAD_REQUEST' }, 400);
    }

    // `enabled` is the one non-job action: it must always fail closed so a
    // stale browser cannot reveal the import entry.
    if (action === 'enabled') {
        return json({
            ok: true,
            enabled: false,
            engine: 'off',
            local_enabled: false,
            local_profile: null,
            local_config: null,
        });
    }

    return disabled();
});