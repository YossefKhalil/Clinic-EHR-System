// cloudinary-sign — signs Cloudinary uploads and delivery URLs.
//
// The API secret must never reach the browser, so the frontend asks this
// function for a signature before every authenticated upload, and for a
// signed delivery URL after one. One invocation per upload: negligible
// against the free-plan quota (500,000/month).
//
// Request bodies:
//   { action: 'upload', folder?: string }
//     -> { cloud_name, api_key, timestamp, signature, type, folder, allowed_formats }
//   { action: 'url', public_id, resource_type?: 'image'|'raw', format?: string }
//     -> { url }  (original asset only; authenticated assets cannot use
//                  on-the-fly transformations)
//
// Secrets (supabase secrets set ...):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// JWT verification is handled by the Supabase gateway (verify_jwt is on by
// default), so only signed-in staff can call this function.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}

async function sha1Bytes(input: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
    return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Upload API signature: every parameter except file/cloud_name/resource_type/
// api_key, sorted alphabetically, joined with '&', API secret appended, SHA-1
// hex digest. (Cloudinary signatures doc.)
async function signUploadParams(
    params: Record<string, string | number>,
    apiSecret: string,
): Promise<string> {
    const toSign = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');
    return toHex(await sha1Bytes(toSign + apiSecret));
}

// Delivery URL signature: the URL path components after the signature
// (transformation/public_id), API secret appended, SHA-1 digest, URL-safe
// base64, first 8 characters, wrapped as s--SIGNATURE--.
async function signDeliveryPath(
    transformation: string,
    source: string,
    apiSecret: string,
): Promise<string> {
    const toSign = [transformation, source].filter(Boolean).join('/');
    const digest = await sha1Bytes(toSign + apiSecret);
    return `s--${toBase64Url(digest).slice(0, 8)}--`;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: CORS_HEADERS });
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME');
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
    if (!cloudName || !apiKey || !apiSecret) {
        return json({ error: 'Cloudinary is not configured on the server' }, 500);
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    const action = String(body.action || '');

    if (action === 'upload') {
        const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
        const timestamp = Math.floor(Date.now() / 1000);
        const params: Record<string, string | number> = {
            timestamp,
            type: 'authenticated',
            allowed_formats: 'jpg,jpeg,png,webp,pdf',
        };
        if (folder) params.folder = folder;

        const signature = await signUploadParams(params, apiSecret);
        return json({
            cloud_name: cloudName,
            api_key: apiKey,
            signature,
            ...params,
        });
    }

    if (action === 'url') {
        const publicId = String(body.public_id || '').trim();
        if (!publicId) return json({ error: 'public_id is required' }, 400);

        const resourceType = body.resource_type === 'raw' ? 'raw' : 'image';
        const format = String(body.format || '').trim();

        // Raw assets (PDFs) store the extension inside the public_id; image
        // assets keep it in the separate `format` field.
        const source = resourceType === 'raw' || !format || publicId.endsWith(`.${format}`)
            ? publicId
            : `${publicId}.${format}`;

        const signature = await signDeliveryPath('', source, apiSecret);
        const url = `https://res.cloudinary.com/${cloudName}/${resourceType}/authenticated/${signature}/${source}`;
        return json({ url });
    }

    return json({ error: 'Unknown action' }, 400);
});
