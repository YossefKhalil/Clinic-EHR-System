// cloudinary-sign - signs Cloudinary uploads and delivery URLs.
//
// The API secret must never reach the browser, so the frontend asks this
// function for a signature before every authenticated upload, and for a
// signed delivery URL after one. One invocation per upload: negligible
// against the free-plan quota (500,000/month).
//
// Request bodies:
//   { action: 'upload', folder: string }
//     -> { cloud_name, api_key, timestamp, signature, type, folder, allowed_formats }
//   { action: 'url', public_id, resource_type?: 'image'|'raw', format?: string,
//     variants?: [{ key, width?, height?, quality?, crop? }] }
//     -> { url, urls }  (original plus optional signed derivatives; all
//                        authenticated assets need a signature to be shown)
//
// One invocation returns every URL the upload needs: the original and the
// small `f_auto,q_auto,w_...` derivatives used by cards and upload rows.
//
// Secrets (supabase secrets set ...):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// The gateway enforces verify_jwt, and the handler resolves the token against
// /auth/v1/user so the public anon key alone cannot mint signatures.
//
// Both actions are scoped to the caller: an upload folder is either an
// existing patient the caller can read through RLS, or the caller's own
// `clinic-ehr/drafts/<user-id>/...` area. A delivery URL may point at the same
// two places. Patient folders are checked with the caller's JWT, never the
// service role, so a section user cannot sign another section's assets.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    ?? Deno.env.get('ANON_KEY')
    ?? '';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}

// Cloudinary folders/public ids are slash-separated. Reject empty, absolute,
// backslash and dot segments before they are compared with a scope rule.
function segmentsOf(value: string): string[] | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('//')) {
        return null;
    }
    const parts = trimmed.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) return null;
    return parts;
}

// Ask PostgREST as the caller. RLS is the section boundary: a row that is not
// visible to this JWT produces an empty result and the signature is refused.
async function canReadPatient(key: string, token: string): Promise<boolean> {
    const column = UUID.test(key) ? 'id' : 'national_id';
    const url = `${SUPABASE_URL}/rest/v1/patients?select=id&${column}=eq.${encodeURIComponent(key)}&limit=1`;
    try {
        const response = await fetch(url, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${token}`,
            },
        });
        if (!response.ok) return false;
        const rows = await response.json();
        return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
        console.error('cloudinary-sign patient scope check failed', error);
        return false;
    }
}

async function canSignUploadFolder(folder: string, userId: string, token: string): Promise<boolean> {
    const parts = segmentsOf(folder);
    if (!parts || parts[0] !== 'clinic-ehr') return false;

    // An existing patient: the folder is exactly patients/<id-or-national-id>.
    if (parts[1] === 'patients' && parts.length === 3) {
        return await canReadPatient(parts[2], token);
    }

    // A new patient has no row yet. Its uploads live under the signed-in
    // user's own draft prefix, which another user cannot address.
    if (parts[1] === 'drafts' && parts.length >= 3 && parts[2] === userId) {
        return true;
    }

    return false;
}

async function canSignPublicId(publicId: string, userId: string, token: string): Promise<boolean> {
    const parts = segmentsOf(publicId);
    if (!parts || parts[0] !== 'clinic-ehr') return false;

    if (parts[1] === 'drafts' && parts.length >= 3) {
        return parts[2] === userId;
    }
    if (parts[1] === 'patients' && parts.length >= 3) {
        return await canReadPatient(parts[2], token);
    }
    return false;
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

const VARIANT_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CROPS = new Set(['limit', 'fill', 'fit', 'scale', 'thumb']);

function optionalInteger(value: unknown, min: number, max: number): number | null {
    if (value === undefined || value === null || value === '') return null;
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number >= min && number <= max ? number : NaN;
}

// A signed transformation path, e.g. w_256,c_limit,q_auto,f_auto. Returning
// null means a supplied value was invalid; the caller answers 400 rather than
// signing an unexpected URL. An empty string is the original asset.
function variantTransformation(variant: Record<string, unknown>): string | null {
    const width = optionalInteger(variant.width, 1, 4096);
    const height = optionalInteger(variant.height, 1, 4096);
    if (Number.isNaN(width) || Number.isNaN(height)) return null;
    if (variant.crop !== undefined && !CROPS.has(String(variant.crop))) return null;

    const hasQuality = variant.quality !== undefined && variant.quality !== null && variant.quality !== '';
    let quality = '';
    if (hasQuality) {
        if (String(variant.quality) === 'auto') {
            quality = 'q_auto';
        } else {
            const number = optionalInteger(variant.quality, 1, 100);
            if (Number.isNaN(number) || number === null) return null;
            quality = `q_${number}`;
        }
    }
    if (!width && !height && !quality) return '';

    const parts: string[] = [];
    if (width) parts.push(`w_${width}`);
    if (height) parts.push(`h_${height}`);
    if (width || height) parts.push(`c_${String(variant.crop || 'limit')}`);
    parts.push(quality || 'q_auto');
    parts.push('f_auto');
    return parts.join(',');
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
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
        },
    });
    if (!userResponse.ok) {
        return json({ error: 'Sign in required' }, 401);
    }
    const caller = await userResponse.json() as { id?: string };
    if (!caller?.id) {
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
        if (!folder) return json({ error: 'folder is required' }, 400);
        if (!await canSignUploadFolder(folder, caller.id, token)) {
            return json({ error: 'Forbidden: folder is outside your patients' }, 403);
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const params: Record<string, string | number> = {
            timestamp,
            type: 'authenticated',
            allowed_formats: 'jpg,jpeg,png,webp,pdf',
            folder,
        };

        // Authenticated assets cannot be transformed on the fly. Generate the
        // two card/preview derivatives eagerly during upload; their signed
        // URLs come back in the upload response. PDFs (raw) do not support
        // image transformations.
        if (body.resource_type !== 'raw') {
            params.eager = 'w_256,c_limit,q_auto|w_800,c_limit,q_auto';
        }

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
        if (!await canSignPublicId(publicId, caller.id, token)) {
            return json({ error: 'Forbidden: asset is outside your patients' }, 403);
        }

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

        // One call can sign the original plus the small derivatives a card
        // and upload row render (issue #44). Without `variants` this is the
        // original single-URL request older clients send.
        const requested = Array.isArray(body.variants)
            ? body.variants
            : [{ key: 'url', width: body.width, height: body.height, quality: body.quality, crop: body.crop }];
        if (requested.length === 0 || requested.length > 6) {
            return json({ error: 'variants must contain 1-6 entries' }, 400);
        }

        const urls: Record<string, string> = {};
        for (const raw of requested) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return json({ error: 'Invalid variant' }, 400);
            }
            const variant = raw as Record<string, unknown>;
            const key = String(variant.key || 'url');
            if (!VARIANT_KEY.test(key) || urls[key]) {
                return json({ error: 'Invalid or duplicate variant key' }, 400);
            }
            const transformation = variantTransformation(variant);
            if (transformation === null) {
                return json({ error: `Invalid transformation for ${key}` }, 400);
            }
            if (resourceType === 'raw' && transformation) {
                return json({ error: 'PDFs do not support image transformations' }, 400);
            }

            const signature = await signDeliveryPath(transformation, source, apiSecret);
            const path = [signature, transformation, source].filter(Boolean).join('/');
            urls[key] = `https://res.cloudinary.com/${cloudName}/${resourceType}/authenticated/${path}`;
        }

        const url = urls.url || Object.values(urls)[0];
        return json({ url, urls });
    }

    return json({ error: 'Unknown action' }, 400);
});
