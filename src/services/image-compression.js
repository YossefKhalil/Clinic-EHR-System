// Browser-side image compression for patient attachments (issue #44).
//
// Cloudinary's free plan shares one credit pool across storage, bandwidth and
// transformations, and phone photos (3-4 MB each) exhaust it quickly. Before a
// raster image leaves the browser it is downscaled, re-encoded as WebP (JPEG
// when WebP is unavailable) and stripped of metadata. PDFs and animated or
// vector images are deliberately left unchanged.
//
// This module is only imported from the lazy Cloudinary chunk, so none of this
// code is part of the initial bundle. The pure helpers are exported for tests;
// compressImage itself needs a browser canvas.

export const MAX_IMAGE_DIMENSION = 1600;
export const COMPRESSION_QUALITY = 0.75;
export const THUMBNAIL_WIDTH = 256;
export const PREVIEW_WIDTH = 800;

const COMPRESSIBLE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/bmp',
    'image/avif',
]);

const COMPRESSIBLE_EXTENSIONS = /\.(jpe?g|png|webp|bmp|avif)$/i;

// Opt-out for clinics that need the untouched file (for example a lab that
// has to forward the original DICOM-adjacent photograph). Defaults to on.
export function compressionEnabled(env = import.meta.env) {
    const value = String(env?.VITE_COMPRESS_ATTACHMENTS ?? '').trim().toLowerCase();
    return !['false', '0', 'off', 'no'].includes(value);
}

export function isCompressibleImage(file) {
    const type = String(file?.type || '').toLowerCase();
    if (COMPRESSIBLE_TYPES.has(type)) return true;
    // An unknown/empty MIME type is common for scans; only trust a known
    // raster extension in that case. HEIC/TIFF/GIF/SVG stay untouched: their
    // animation, transparency or metadata is not safe to flatten here.
    if (!type) return COMPRESSIBLE_EXTENSIONS.test(String(file?.name || ''));
    return false;
}

/**
 * The size of an image after fitting it inside a square of `maxDimension`.
 * Images smaller than the box are never upscaled.
 */
export function targetDimensions(width, height, maxDimension = MAX_IMAGE_DIMENSION) {
    const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
    const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
    const limit = Math.max(1, Math.round(Number(maxDimension) || MAX_IMAGE_DIMENSION));
    const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
    };
}

/** The uploaded file name with the extension of the encoded format. */
export function compressedName(name, mimeType) {
    const extension = mimeType === 'image/webp' ? '.webp' : '.jpg';
    const base = String(name || 'image').replace(/\.[^./\\]+$/, '').trim() || 'image';
    return `${base}${extension}`;
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve({
                source: image,
                width: image.naturalWidth || image.width,
                height: image.naturalHeight || image.height,
                close: () => {},
            });
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('The image could not be decoded'));
        };
        image.src = url;
    });
}

// createImageBitmap applies EXIF orientation when asked and avoids an <img>
// round trip. The element fallback applies EXIF orientation automatically.
async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            return {
                source: bitmap,
                width: bitmap.width,
                height: bitmap.height,
                close: () => bitmap.close?.(),
            };
        } catch {
            // Format/orientation unsupported by createImageBitmap: try <img>.
        }
    }
    return loadImageElement(file);
}

function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function canvasBlob(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type, quality });
    }
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encodeImage(image, width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available');

    // A white backing keeps transparent PNGs from turning black in JPEG and
    // makes the result predictable for the paper scans staff upload.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);

    let blob = await canvasBlob(canvas, 'image/webp', COMPRESSION_QUALITY);
    if (!blob || blob.type !== 'image/webp') {
        blob = await canvasBlob(canvas, 'image/jpeg', COMPRESSION_QUALITY);
    }
    return blob;
}

/**
 * Compress one image file before upload.
 *
 * Always resolves. A browser that cannot decode the file, an unsupported
 * format, or an encode that does not get smaller returns the original file and
 * `compressed: false`, so an upload can never fail just because optimization
 * failed.
 *
 * @returns {Promise<{
 *   file: File|Blob,
 *   originalSize: number,
 *   size: number,
 *   compressed: boolean,
 *   width: number|null,
 *   height: number|null,
 *   originalWidth: number|null,
 *   originalHeight: number|null,
 * }>}
 */
export async function compressImage(file, options = {}) {
    const original = {
        file,
        originalSize: Number(file?.size) || 0,
        size: Number(file?.size) || 0,
        compressed: false,
        width: null,
        height: null,
        originalWidth: null,
        originalHeight: null,
    };

    const enabled = options.enabled ?? compressionEnabled();
    if (!enabled || !isCompressibleImage(file)) return original;

    let decoded = null;
    try {
        decoded = await decodeImage(file);
        const dimensions = targetDimensions(
            decoded.width,
            decoded.height,
            options.maxDimension || MAX_IMAGE_DIMENSION,
        );
        const blob = await encodeImage(decoded.source, dimensions.width, dimensions.height);
        if (!blob || blob.size >= original.size) return original;

        const output = new File(
            [blob],
            compressedName(file.name, blob.type),
            { type: blob.type, lastModified: file.lastModified || Date.now() },
        );
        return {
            file: output,
            originalSize: original.size,
            size: output.size,
            compressed: true,
            width: dimensions.width,
            height: dimensions.height,
            originalWidth: decoded.width,
            originalHeight: decoded.height,
        };
    } catch (error) {
        console.warn('Attachment compression skipped:', error);
        return original;
    } finally {
        decoded?.close?.();
    }
}
