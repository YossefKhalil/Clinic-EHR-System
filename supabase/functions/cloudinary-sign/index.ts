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
// The gateway enforces verify_jwt, and the handler resolves the token against
// /auth/v1/user so the public anon key alone cannot mint signatures.

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

    // The gateway checks that the JWT is well-formed, but the public anon key
    // is also a valid JWT. Resolve it to a real user so an anonymous caller
    // cannot mint upload signatures.
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
        return json({ error: 'Sign in required' }, 401);
    }
    const userResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
        headers: {
            apikey: Deno.env.get('SUPABASE_ANON_KEY') || '',
            Authorization: `Bearer ${token}`,
        },
    });
    if (!userResponse.ok) {
        return json({ error: 'Sign in required' }, 401);
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

        // Authenticated delivery URL signature source:
        // - For images: public_id does NOT include extension; Cloudinary expects
        //   the bare public_id (e.g., "folder/image").
        // - For raw (PDFs): public_id INCLUDES extension (e.g.,
        //   "folder/file.PDF"); the full public_id must be signed.
        // The original logic handled this correctly: raw uses publicId as-is.
        const source = resourceType === 'raw' || !format || publicId.endsWith(`.${format}`)
            ? publicId
            : `${publicId}.${format}`;

        const signature = await signDeliveryPath('', source, apiSecret);
        const url = `https://res.cloudinary.com/${cloudName}/${resourceType}/authenticated/${signature}/${source}`;
        return json({ url });
    }

    return json({ error: 'Unknown action' }, 400);
});
