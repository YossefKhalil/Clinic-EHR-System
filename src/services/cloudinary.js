import { supabase } from './supabase.js';

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

    // PDFs must go through /raw: the image pipeline renders pages instead of
    // storing the original file.
    const resourceType = isPdf(file) ? 'raw' : 'image';

    try {
        if (authenticated) {
            return await uploadAuthenticated(file, { folder, onProgress, resourceType });
        }
        return await uploadUnsigned(file, { folder, onProgress, resourceType });
    } catch (error) {
        throw enhancePdfError(error, 'upload');
    }
}

// Classic public upload through the unsigned preset.
function uploadUnsigned(file, { folder, onProgress, resourceType }) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', uploadPreset);
        if (folder) formData.append('folder', folder);

        postToCloudinary(resourceType, 'upload', formData, onProgress, resolve, reject, (payload) => ({
            public_id: payload.public_id,
            url: payload.secure_url,
            name: file.name,
            size: payload.bytes ?? file.size,
            mime: file.type || (resourceType === 'raw' ? 'application/pdf' : ''),
            uploaded_at: new Date().toISOString(),
        }));
    });
}

// Signed upload into the `authenticated` delivery type. The API secret never
// leaves the Edge Function; the browser only receives the per-request
// signature. The signed delivery URL is stored with the attachment because
// authenticated assets always need one to be viewed.
async function uploadAuthenticated(file, { folder, onProgress, resourceType }) {
    const { data: signed, error: signError } = await supabase().functions.invoke('cloudinary-sign', {
        body: { action: 'upload', folder },
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

    // `type` is a form field, not a URL segment: authenticated uploads still
    // go to /<resource_type>/upload. The old /authenticated path 404s.
    const payload = await new Promise((resolve, reject) => {
        postToCloudinary(resourceType, 'upload', formData, onProgress, resolve, reject, (body) => body);
    });

    const usedResourceType = payload.resource_type || resourceType;
    const { data: signedUrl, error: urlError } = await supabase().functions.invoke('cloudinary-sign', {
        body: {
            action: 'url',
            public_id: payload.public_id,
            resource_type: usedResourceType,
            format: payload.format,
        },
    });
    if (urlError || !signedUrl?.url) {
        throw new Error(urlError?.message || 'Could not sign the file URL');
    }

    return {
        public_id: payload.public_id,
        url: signedUrl.url,
        name: file.name,
        size: payload.bytes ?? file.size,
        mime: file.type || (usedResourceType === 'raw' ? 'application/pdf' : ''),
        format: payload.format || '',
        resource_type: usedResourceType,
        authenticated: true,
        uploaded_at: new Date().toISOString(),
    };
}

function postToCloudinary(resourceType, deliveryType, formData, onProgress, resolve, reject, map) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/${deliveryType}`);

    xhr.upload.onprogress = (event) => {
        if (onProgress && event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
        }
    };

    xhr.onload = () => {
        let payload = {};
        try { payload = JSON.parse(xhr.responseText); } catch {}

        if (xhr.status >= 200 && xhr.status < 300 && payload.public_id) {
            resolve(map(payload));
        } else {
            reject(new Error(payload?.error?.message || `Upload failed (${xhr.status})`));
        }
    };

    xhr.onerror = () => reject(new Error('Upload failed, check your connection'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(formData);
}

export function getImageUrl(publicId, options = {}) {
    if (!cloudName || !publicId) return '';

    const transforms = [];
    if (options.width) transforms.push(`w_${options.width}`);
    if (options.height) transforms.push(`h_${options.height}`);
    if (options.quality) transforms.push(`q_${options.quality}`);
    if (options.format) transforms.push(`f_${options.format}`);
    else transforms.push('f_auto');

    transforms.push('c_limit');

    const transformStr = transforms.length > 1 ? transforms.join(',') + '/' : '';

    return `https://res.cloudinary.com/${cloudName}/image/upload/${transformStr}${publicId}`;
}
