import { supabase } from './supabase.js';
import {
    hasCloudinarySignature,
    isProtectedCloudinaryUrl,
    transformCloudinaryImageUrl,
} from './cloudinary-url.js';

let cloudName = '';
let uploadPreset = '';
// When true, uploads are signed by the `cloudinary-sign` Edge Function and
// stored with Cloudinary's `authenticated` delivery type: the returned URL
// only works because it carries a signature generated with the API secret.
// Toggle with VITE_CLOUDINARY_AUTHENTICATED=true.
let authenticated = false;

// Client-side guard only; Cloudinary enforces the real limits server-side.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function initCloudinary() {
    cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || '';
    uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || '';
    authenticated = String(import.meta.env.VITE_CLOUDINARY_AUTHENTICATED || '').toLowerCase() === 'true';

    if (!cloudName || (!uploadPreset && !authenticated)) {
        console.warn('Cloudinary not configured. Set VITE_CLOUDINARY_CLOUD_NAME and either VITE_CLOUDINARY_UPLOAD_PRESET or VITE_CLOUDINARY_AUTHENTICATED=true in .env');
    }
}

export function isCloudinaryConfigured() {
    return Boolean(cloudName && (uploadPreset || authenticated));
}

export function isSupportedAttachment(file) {
    const mime = file?.type || '';
    if (mime === 'application/pdf' || mime.startsWith('image/')) return true;
    // Some browsers report an empty type for scans; fall back to the extension.
    return /\.(pdf|jpe?g|png|gif|webp|bmp|tiff?|heic)$/i.test(file?.name || '');
}

export function isImageAttachment(attachment) {
    return String(attachment?.mime || '').startsWith('image/');
}

function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

/**
 * Checks if an error is the Cloudinary "PDF delivery blocked on Free tier" error.
 * This happens when the Cloudinary Free tier blocks PDF/ZIP delivery by default.
 */
export function isCloudinaryPdfBlockedError(error) {
    const message = String(error?.message || '');
    return (
        message.includes('deny or ACL failure') ||
        message.includes('PDF files can\'t be shared externally') ||
        message.includes('blocked for delivery') ||
        (message.includes('401') && message.includes('pdf'))
    );
}

/**
 * Returns a user-friendly error message with instructions to fix Cloudinary PDF delivery.
 */
export function getCloudinaryPdfBlockedMessage() {
    return (
        'PDF delivery is blocked by Cloudinary Free tier. ' +
        'To fix this, enable "Allow delivery of PDF and ZIP files" in Cloudinary Console: ' +
        'Settings (gear icon) → Security → "Allow delivery of PDF and ZIP files" → Save. ' +
        'Note: Cloudinary caches the denied response, so wait a minute or use a different filename after enabling.'
    );
}

/**
 * Wraps an error to include PDF block detection and user-friendly message.
 */
function enhancePdfError(error, context = 'upload') {
    if (isCloudinaryPdfBlockedError(error)) {
        const userMessage = getCloudinaryPdfBlockedMessage();
        const enhancedError = new Error(userMessage);
        enhancedError.originalError = error;
        enhancedError.isCloudinaryPdfBlocked = true;
        enhancedError.context = context;
        return enhancedError;
    }
    return error;
}

// Uploads straight to Cloudinary. XHR is used because it can report upload
// progress, which fetch cannot do without streams. Returns the trimmed
// metadata shape stored on the patient row.
export async function uploadAttachment(file, { folder = '', onProgress = null } = {}) {
    if (!isCloudinaryConfigured()) {
        throw new Error('File storage is not configured');
    }
    if (file.size > MAX_FILE_BYTES) {
        throw new Error('The file is larger than 10 MB');
    }

    // Raster photos are downscaled and re-encoded before they leave the
    // browser (issue #44). The module is imported only when an image is
    // actually chosen, keeping the initial bundle unchanged. PDFs and formats
    // the browser cannot safely re-encode fall through untouched.
    let prepared = null;
    const looksLikeRaster = isImageAttachment(file) || /\.(jpe?g|png|webp|bmp|avif)$/i.test(file.name || '');
    if (looksLikeRaster) {
        const { compressImage } = await import('./image-compression.js');
        prepared = await compressImage(file);
    }
    const uploadFile = prepared?.file || file;

    // PDFs must go through /raw: the image pipeline renders pages instead of
    // storing the original file.
    const resourceType = isPdf(uploadFile) ? 'raw' : 'image';

    try {
        const result = authenticated
            ? await uploadAuthenticated(uploadFile, { folder, onProgress, resourceType })
            : await uploadUnsigned(uploadFile, { folder, onProgress, resourceType });

        const metadata = {
            ...result,
            // Staff recognize the file by the name they picked, even though
            // the optimized asset has a new extension on Cloudinary.
            name: file.name,
            original_size: prepared?.originalSize ?? file.size,
            size: result.size ?? uploadFile.size,
            compressed: Boolean(prepared?.compressed),
            width: prepared?.width ?? null,
            height: prepared?.height ?? null,
            mime: uploadFile.type || result.mime,
            authenticated: Boolean(result.authenticated),
            delivery_type: result.delivery_type || (result.authenticated ? 'authenticated' : 'upload'),
        };

        // Public uploads can derive small CDN variants without a signature.
        // Build them from the stored URL, not from the current cloud's public
        // id: that keeps the original cloud, version and extension (issue #54).
        // Authenticated uploads already carry signed variants from the Edge
        // Function; if that function is older and returned none, the caller
        // must fall back to the signed original rather than store an unsigned
        // (and therefore 401) derivative URL.
        if (!metadata.authenticated && isImageAttachment(metadata) && (metadata.url || metadata.public_id)) {
            if (!metadata.thumbnail_url) {
                metadata.thumbnail_url = transformCloudinaryImageUrl(metadata.url, { width: 256 })
                    || getImageUrl(metadata.public_id, { width: 256, quality: 'auto' });
            }
            if (!metadata.preview_url) {
                metadata.preview_url = transformCloudinaryImageUrl(metadata.url, { width: 800 })
                    || getImageUrl(metadata.public_id, { width: 800, quality: 'auto' });
            }
        }
        return metadata;
    } catch (error) {
        throw enhancePdfError(error, 'upload');
    }
}

// Classic public upload through the unsigned preset.
async function uploadUnsigned(file, { folder, onProgress, resourceType }) {
    const payload = await new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', uploadPreset);
        if (folder) formData.append('folder', folder);

        postToCloudinary(cloudName, resourceType, 'upload', formData, onProgress, resolve, reject, (body) => body);
    });

    const deliveryType = String(payload.type || 'upload');
    const metadata = {
        public_id: payload.public_id,
        url: payload.secure_url,
        name: file.name,
        size: payload.bytes ?? file.size,
        mime: file.type || (resourceType === 'raw' ? 'application/pdf' : ''),
        format: payload.format || '',
        resource_type: payload.resource_type || resourceType,
        delivery_type: deliveryType,
        authenticated: deliveryType === 'authenticated',
        uploaded_at: new Date().toISOString(),
    };

    // A preset can be configured for authenticated delivery even when the
    // build uses the unsigned path. Such assets are not reachable through
    // /upload/, so sign their URLs as soon as the upload returns. Without
    // this the UI would save a public_id whose delivery URL always 404s.
    if (deliveryType === 'authenticated') {
        const signed = await requestDeliveryUrls(metadata, metadata.resource_type);
        return { ...metadata, ...signed, authenticated: true };
    }
    if (deliveryType !== 'upload') {
        throw new Error(
            `This Cloudinary preset stores ${deliveryType} assets. ` +
            'Use a public upload preset or enable VITE_CLOUDINARY_AUTHENTICATED=true.',
        );
    }
    return metadata;
}

// Ask the Edge Function for the signed original URL. Authenticated assets
// cannot be transformed on the fly, so small derivatives are generated
// eagerly during upload instead (see uploadAuthenticated).
async function requestDeliveryUrls(asset, resourceType) {
    const body = {
        action: 'url',
        public_id: asset.public_id,
        resource_type: resourceType === 'raw' ? 'raw' : 'image',
        format: asset.format || '',
    };
    const { data, error } = await supabase().functions.invoke('cloudinary-sign', { body });
    if (error || !data?.url) {
        throw new Error(error?.message || 'Could not sign the file URL');
    }
    return { url: data.url };
}

// Pull one eager transformation's signed URL out of the upload response.
// Cloudinary should sign eager URLs for authenticated assets; if an older
// account returns an unsigned one, leave it out so the UI uses the signed
// original instead of rendering a guaranteed 401.
function eagerUrl(payload, width) {
    const eager = Array.isArray(payload?.eager) ? payload.eager : [];
    const match = eager.find((item) => Number(item?.width) === width)
        || eager.find((item) => String(item?.transformation || '').includes(`w_${width}`));
    const secure = match?.secure_url || '';
    if (!secure) return '';
    if (payload?.type === 'authenticated' || isProtectedCloudinaryUrl(secure)) {
        return hasCloudinarySignature(secure) ? secure : '';
    }
    return secure;
}

// Signed upload into the `authenticated` delivery type. The API secret never
// leaves the Edge Function; the browser only receives the per-request
// signature. The signed delivery URL is stored with the attachment because
// authenticated assets always need one to be viewed.
async function uploadAuthenticated(file, { folder, onProgress, resourceType }) {
    const { data: signed, error: signError } = await supabase().functions.invoke('cloudinary-sign', {
        body: { action: 'upload', folder, resource_type: resourceType },
    });
    if (signError || !signed?.signature) {
        throw new Error(signError?.message || 'Could not sign the upload');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', signed.api_key);
    formData.append('timestamp', String(signed.timestamp));
    formData.append('signature', signed.signature);
    formData.append('type', signed.type);
    if (signed.folder) formData.append('folder', signed.folder);
    // Every signed parameter must also be sent, or Cloudinary recomputes a
    // different signature and rejects the upload.
    if (signed.allowed_formats) formData.append('allowed_formats', signed.allowed_formats);
    if (signed.eager) formData.append('eager', signed.eager);

    // `type` is a form field, not a URL segment: authenticated uploads still
    // go to /<resource_type>/upload. The old /authenticated path 404s. Use the
    // cloud name returned by the signer too, so a frontend/Edge Function
    // environment mismatch cannot upload into one cloud and sign for another.
    const targetCloud = signed.cloud_name || cloudName;
    const payload = await new Promise((resolve, reject) => {
        postToCloudinary(targetCloud, resourceType, 'upload', formData, onProgress, resolve, reject, (body) => body);
    });

    const usedResourceType = payload.resource_type || resourceType;
    const urls = await requestDeliveryUrls(payload, usedResourceType);

    return {
        public_id: payload.public_id,
        ...urls,
        // Authenticated images get these from eager transformations; PDFs and
        // older accounts fall back to the signed original.
        thumbnail_url: eagerUrl(payload, 256),
        preview_url: eagerUrl(payload, 800),
        name: file.name,
        size: payload.bytes ?? file.size,
        mime: file.type || (usedResourceType === 'raw' ? 'application/pdf' : ''),
        format: payload.format || '',
        resource_type: usedResourceType,
        delivery_type: payload.type || 'authenticated',
        authenticated: true,
        uploaded_at: new Date().toISOString(),
    };
}

function postToCloudinary(cloud, resourceType, deliveryType, formData, onProgress, resolve, reject, map) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${cloud}/${resourceType}/${deliveryType}`);

    // A stalled connection must not hang an upload - and with it the save
    // form - forever (issue #26). xhr.timeout bounds only the total
    // duration, which is too blunt for a slow 10 MB uplink: the failure
    // worth catching is a connection that stops sending data. Watch for
    // progress instead - a quiet minute aborts the request, firing
    // onabort below.
    const STALL_TIMEOUT_MS = 60000;
    let stallTimer = null;
    const clearStallTimer = () => { clearTimeout(stallTimer); stallTimer = null; };
    const armStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => xhr.abort(), STALL_TIMEOUT_MS);
    };
    armStallTimer();

    xhr.upload.onprogress = (event) => {
        armStallTimer();
        if (onProgress && event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
        }
    };

    xhr.onload = () => {
        clearStallTimer();
        let payload = {};
        try { payload = JSON.parse(xhr.responseText); } catch {}

        if (xhr.status >= 200 && xhr.status < 300 && payload.public_id) {
            resolve(map(payload));
        } else {
            reject(new Error(payload?.error?.message || `Upload failed (${xhr.status})`));
        }
    };

    xhr.onerror = () => { clearStallTimer(); reject(new Error('Upload failed, check your connection')); };
    xhr.onabort = () => { clearStallTimer(); reject(new Error('Upload stalled and was cancelled, check your connection')); };
    xhr.send(formData);
}

export function getImageUrl(publicId, options = {}) {
    if (!cloudName || !publicId) return '';

    const transforms = [];
    if (options.width) transforms.push(`w_${options.width}`);
    if (options.height) transforms.push(`h_${options.height}`);
    transforms.push(`q_${options.quality || 'auto'}`);
    transforms.push(options.format ? `f_${options.format}` : 'f_auto');
    if (options.width || options.height) transforms.push('c_limit');

    return `https://res.cloudinary.com/${cloudName}/image/upload/${transforms.join(',')}/${publicId}`;
}

/**
 * Repair attachment URLs loaded from older records.
 *
 * Records saved before the signed-variant work may carry a protected URL
 * without a signature (for example an authenticated upload made through an
 * unsigned preset) or a signed original with no thumbnail. Re-sign them once
 * when the record is opened. Failures are non-fatal: the stored URL remains
 * usable if it was already signed, and the caller keeps rendering.
 */
export async function refreshAttachmentUrls(attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    let changed = false;

    await Promise.all(list.map(async (attachment) => {
        if (!attachment?.public_id) return;
        const protectedAsset = attachment.authenticated === true
            || isProtectedCloudinaryUrl(attachment.url);
        if (!protectedAsset) return;

        if (!attachment.authenticated) {
            attachment.authenticated = true;
            changed = true;
        }
        // A signed original is already deliverable. Older authenticated assets
        // have no eager derivatives, so cards fall back to that original
        // rather than requesting an on-the-fly transform Cloudinary rejects.
        if (hasCloudinarySignature(attachment.url)) return;

        const resourceType = attachment.resource_type
            || (String(attachment.mime || '').startsWith('image/') ? 'image' : 'raw');
        try {
            const urls = await requestDeliveryUrls(attachment, resourceType);
            if (urls.url && urls.url !== attachment.url) {
                attachment.url = urls.url;
                changed = true;
            }
        } catch (error) {
            console.warn('Could not refresh Cloudinary attachment URLs:', error?.message || error);
        }
    }));

    return changed;
}
