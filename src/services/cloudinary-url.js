// Pure helpers for Cloudinary delivery URLs.
//
// Attachments store the URL Cloudinary returned at upload time. That URL knows
// the product environment (cloud name), the delivery type and the asset's
// version, while `public_id` alone does not. Rebuilding a URL from the id can
// therefore point at the wrong cloud or at `/upload/` for an authenticated
// asset, which Cloudinary answers with 404 "Resource not found" (issue #54).

const IMAGE_UPLOAD_URL = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/i;
const PROTECTED_URL = /\/(?:image|raw)\/(?:authenticated|private)\//i;
const SIGNED_URL = /\/s--[A-Za-z0-9_-]{8}--\//;

function pixel(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.min(4096, number);
}

/**
 * Authenticated/private assets only work through the signed URL stored on the
 * attachment. They cannot be transformed without minting a new signature.
 */
export function isProtectedCloudinaryUrl(url) {
    return PROTECTED_URL.test(String(url || ''));
}

/** True when an authenticated/private URL already carries `s--...--`. */
export function hasCloudinarySignature(url) {
    return SIGNED_URL.test(String(url || ''));
}

/**
 * Add an image transformation to a stored public-delivery URL.
 *
 * Using the stored URL keeps its cloud, version, folder and extension intact.
 * Protected URLs and non-Cloudinary URLs are returned unchanged; the caller
 * must use the signed URL as-is.
 */
export function transformCloudinaryImageUrl(url, options = {}) {
    const source = String(url || '').trim();
    const match = source.match(IMAGE_UPLOAD_URL);
    if (!match || isProtectedCloudinaryUrl(source)) return source;

    const width = pixel(options.width);
    const height = pixel(options.height);
    const parts = [];
    if (width) parts.push(`w_${width}`);
    if (height) parts.push(`h_${height}`);
    const quality = options.quality === 'auto' || options.quality === undefined
        ? 'q_auto'
        : (pixel(options.quality) ? `q_${pixel(options.quality)}` : 'q_auto');
    parts.push(quality);
    parts.push(options.format ? `f_${String(options.format).replace(/[^a-z0-9]/gi, '')}` : 'f_auto');
    if (width || height) parts.push(`c_${options.crop || 'limit'}`);

    return `${match[1]}${parts.join(',')}/${match[2]}`;
}
