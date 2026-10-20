let cloudName = '';
let uploadPreset = '';

// Client-side guard only; the Cloudinary unsigned preset enforces the real
// limits server-side (max size + allowed formats).
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function initCloudinary() {
    cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || '';
    uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || '';

    if (!cloudName || !uploadPreset) {
        console.warn('Cloudinary not configured. Set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET in .env');
    }
}

export function isCloudinaryConfigured() {
    return Boolean(cloudName && uploadPreset);
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

// Uploads straight to Cloudinary with the unsigned preset. XHR is used
// because it can report upload progress, which fetch cannot do without
// streams. Returns the trimmed metadata shape stored on the patient row.
export function uploadAttachment(file, { folder = '', onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
        if (!isCloudinaryConfigured()) {
            reject(new Error('File storage is not configured'));
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            reject(new Error('The file is larger than 10 MB'));
            return;
        }

        // PDFs must go through /raw/upload: the image pipeline renders pages
        // instead of storing the original file.
        const resourceType = isPdf(file) ? 'raw' : 'image';

        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', uploadPreset);
        if (folder) formData.append('folder', folder);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`);

        xhr.upload.onprogress = (event) => {
            if (onProgress && event.lengthComputable) {
                onProgress(Math.round((event.loaded / event.total) * 100));
            }
        };

        xhr.onload = () => {
            let payload = {};
            try { payload = JSON.parse(xhr.responseText); } catch {}

            if (xhr.status >= 200 && xhr.status < 300 && payload.secure_url) {
                resolve({
                    public_id: payload.public_id,
                    url: payload.secure_url,
                    name: file.name,
                    size: payload.bytes ?? file.size,
                    mime: file.type || (resourceType === 'raw' ? 'application/pdf' : ''),
                    uploaded_at: new Date().toISOString(),
                });
            } else {
                reject(new Error(payload?.error?.message || `Upload failed (${xhr.status})`));
            }
        };

        xhr.onerror = () => reject(new Error('Upload failed, check your connection'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.send(formData);
    });
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
