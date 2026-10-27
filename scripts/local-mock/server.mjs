// The mock backend HTTP server.
//
// It stands in for a Supabase project: /auth/v1 (auth.mjs), /rest/v1
// (postgrest.mjs) and /functions/v1, which is proxied to the real Edge
// Functions running in a Deno child process (functions-router.ts).

import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.mjs';
import { handleAuth } from './auth.mjs';
import { handleRest } from './postgrest.mjs';
import { verify } from './jwt.mjs';
import { PORT, FUNCTIONS_PORT } from './config.mjs';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer, range, accept, x-supabase-api-version',
    'Access-Control-Expose-Headers': 'content-range, Content-Range',
    'Access-Control-Max-Age': '86400',
};

function bearer(req) {
    return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}

function contextFor(req) {
    const authorization = verify(bearer(req));
    if (authorization?.role === 'service_role') return { role: 'service_role', claims: authorization };
    if (authorization?.sub) return { role: 'authenticated', claims: authorization };
    const api = verify(String(req.headers.apikey ?? ''));
    if (api?.role === 'service_role') return { role: 'service_role', claims: api };
    if (api?.sub) return { role: 'authenticated', claims: api };
    return { role: 'anon', claims: api ?? null };
}

function proxyToFunctions(req, res, url) {
    const targetPath = url.pathname.replace(/^\/functions\/v1\//, '/');
    const headers = { ...req.headers, host: `127.0.0.1:${FUNCTIONS_PORT}` };
    const upstream = httpRequest({
        host: '127.0.0.1',
        port: FUNCTIONS_PORT,
        method: req.method,
        path: `${targetPath}${url.search}`,
        headers,
    }, (upstreamRes) => {
        const outHeaders = { ...upstreamRes.headers, ...CORS };
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
    });
    upstream.on('error', (error) => {
        console.error('[mock] functions proxy failed:', error.message);
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'The local Edge Functions are not running' }));
    });
    req.pipe(upstream);
}

export async function startMockServer() {
    await openDatabase();

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
            res.end();
            return;
        }
        // Every response gets CORS, so the Vite origin can read it.
        res.setHeader('Access-Control-Allow-Origin', '*');
        for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);

        try {
            if (url.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (url.pathname.startsWith('/functions/v1/')) {
                proxyToFunctions(req, res, url);
                return;
            }
            const ctx = contextFor(req);
            if (url.pathname.startsWith('/auth/v1')) {
                await handleAuth(req, res, url, ctx);
                return;
            }
            if (url.pathname.startsWith('/rest/v1')) {
                await handleRest(req, res, url, ctx);
                return;
            }
            if (url.pathname.startsWith('/storage/v1')) {
                res.writeHead(501, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Storage is not part of the local mock (Cloudinary handles attachments)' }));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `no mock route for ${req.method} ${url.pathname}` }));
        } catch (error) {
            console.error('[mock] unhandled error:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: String(error?.message ?? error) }));
            } else {
                res.end();
            }
        }
    });

    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    console.log(`[mock] Supabase-compatible API on http://127.0.0.1:${PORT}`);
    return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    startMockServer().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
