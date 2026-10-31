// Serves the model files the clinic picked from its own disk.
//
// WebLLM fetches a model over HTTP: the chat config, the weights, the
// tokenizer and the wasm library, all relative to one base address. Rather
// than teach the engine a second way to load, this worker pretends to be that
// server: the page mounts a folder under a private path on this origin, and
// every request below it is answered from the File objects the page handed
// over. Nothing is uploaded and nothing is downloaded.
//
// The files are File objects, not bytes: the browser reads them from disk
// when a request arrives, so a 5 GB model costs no memory here either.

const PREFIX = '/__local-mlc/';

/** id -> Map(file name -> File) */
const mounts = new Map();

const TYPES = {
    wasm: 'application/wasm',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    bin: 'application/octet-stream',
    model: 'application/octet-stream',
};

function contentType(name) {
    const extension = String(name).split('.').pop()?.toLowerCase() ?? '';
    return TYPES[extension] ?? 'application/octet-stream';
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    const message = event.data ?? {};
    const port = event.ports?.[0] ?? null;

    if (message.type === 'mount' && typeof message.id === 'string') {
        const files = new Map();
        for (const entry of message.files ?? []) {
            if (entry?.name && entry?.file) files.set(String(entry.name), entry.file);
        }
        mounts.set(message.id, files);
        port?.postMessage({ mounted: message.id, count: files.size });
        return;
    }

    if (message.type === 'unmount' && typeof message.id === 'string') {
        mounts.delete(message.id);
        port?.postMessage({ unmounted: message.id });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;

    const rest = url.pathname.slice(PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) {
        event.respondWith(new Response('not found', { status: 404 }));
        return;
    }

    const id = rest.slice(0, slash);
    const name = decodeURIComponent(rest.slice(slash + 1));
    const file = mounts.get(id)?.get(name);
    if (!file) {
        // A missing file is the one error worth naming: the engine reports it
        // as a fetch failure, which the card turns into "a file is missing".
        event.respondWith(new Response(`not mounted: ${name}`, { status: 404 }));
        return;
    }

    event.respondWith(new Response(file.stream(), {
        status: 200,
        headers: {
            'Content-Type': contentType(name),
            'Content-Length': String(file.size),
            // The engine copies what it fetches into its own cache; a plain
            // origin response is all it needs to do that.
            'Cache-Control': 'no-cache',
        },
    }));
});
