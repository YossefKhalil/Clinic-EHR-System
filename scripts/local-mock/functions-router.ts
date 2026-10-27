// @ts-nocheck
//
// Runs the real Supabase Edge Functions in one Deno process.
//
// Each function calls `Deno.serve(handler)` at import time. We replace
// Deno.serve with a capture function, import every function once, and then
// start one server that routes `/<function-name>` to the captured handler.
// The functions are otherwise untouched and keep talking to
// SUPABASE_URL -- which points at the Node mock.

const realServe = Deno.serve.bind(Deno);

const handlers: Record<string, (req: Request) => Response | Promise<Response>> = {};
let current = '';

Object.defineProperty(Deno, 'serve', {
    configurable: true,
    writable: true,
    value: (arg1: unknown, arg2?: unknown) => {
        const handler = typeof arg1 === 'function' ? arg1 : arg2;
        if (typeof handler === 'function') handlers[current] = handler as never;
        return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {} };
    },
});

const NAMES = ['login', 'ai-settings', 'manage-user', 'import-job', 'cloudinary-sign', 'import-cleanup'];

for (const name of NAMES) {
    current = name;
    try {
        await import(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url).href);
    } catch (error) {
        console.error(`[mock] failed to load function ${name}:`, error?.message ?? error);
    }
}

// Restore the real Deno.serve before starting the router.
Object.defineProperty(Deno, 'serve', { configurable: true, writable: true, value: realServe });

const port = Number(Deno.env.get('MOCK_FUNCTIONS_PORT') ?? '54328');

realServe({ port, hostname: '127.0.0.1' }, async (req: Request) => {
    const url = new URL(req.url);
    const name = url.pathname.replace(/^\/+/, '').split('/')[0];
    const handler = handlers[name];
    if (!handler) {
        return new Response(JSON.stringify({ error: `unknown function: ${name}` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    try {
        return await handler(req);
    } catch (error) {
        console.error(`[mock] function ${name} failed:`, error?.message ?? error);
        return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
});

console.log(`[mock] Edge Functions router on http://127.0.0.1:${port} (${Object.keys(handlers).join(', ')})`);
