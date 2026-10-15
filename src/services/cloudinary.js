let cloudName = '';
let uploadPreset = '';

const ALLOWED_MEDIA_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
];

const MAX_BYTES = 10 * 1024 * 1024;


export async function initCloudinary() {
    cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || '';
    uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || '';

    if (!cloudName || !uploadPreset) {
        console.warn('Cloudinary not configured. Set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET in .env');
    }
}

export function getCloudName() {
    return cloudName;
}

export function isCloudinaryConfigured() {
    return Boolean(cloudName && uploadPreset);
}

export function mediaTypeLabel(mime) {
    if (!mime) return '';
    if (mime.startsWith('image/')) return 'Image';
    if (mime === 'application/pdf') return 'PDF';
    return mime.split('/').pop() || 'File';
}

export function formatMediaSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

export async function uploadMedia(file, onProgress = null) {
    if (!cloudName || !uploadPreset) {
        throw new Error('Cloudinary not configured');
    }

    if (!ALLOWED_MEDIA_TYPES.includes(file.type)) {
        throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);
    }

    if (file.size > MAX_BYTES) {
        throw new Error(`File is too large (${formatMediaSize(file.size)}). The limit is 10 MB.`);
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', uploadPreset);
    formData.append('folder', 'clinic_ehr/patient_documents');

    if (file.type !== 'application/pdf') {
        formData.append('transformation', 'f_auto,q_auto');
    }

    const url = `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`;

    if (onProgress) {
        const reader = file.stream().getReader();
        const chunks = [];

        onProgress(0);

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                const loaded = chunks.reduce((acc, c) => acc + c.byteLength, 0);
                onProgress(Math.round((loaded / file.size) * 100));
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            throw e;
        }

        const assembled = new Blob(chunks);
        formData.set('file', assembled);
    }

    const response = await fetch(url, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Upload failed (${response.status}): ${body.slice(0, 300)}`);
    }

    return response.json();
}

export function getMediaUrl(publicId, options = {}) {
    if (!cloudName) return '';

    const transforms = [];
    if (options.width) transforms.push(`w_${options.width}`);
    if (options.height) transforms.push(`h_${options.height}`);
    if (options.quality) transforms.push(`q_${options.quality}`);
    if (options.format) transforms.push(`f_${options.format}`);
    else if (!options.raw) transforms.push('f_auto');

    transforms.push('c_limit');

    const transformStr = transforms.length > 1 ? transforms.join(',') + '/' : '';

    return `https://res.cloudinary.com/${cloudName}/image/upload/${transformStr}${publicId}`;
}

export function isPdf(publicId) {
    return publicId.endsWith('.pdf');
}