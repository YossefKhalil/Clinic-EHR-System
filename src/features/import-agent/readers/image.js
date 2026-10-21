// Image reader (spec A5.4): a photo of a note is a source like any other.
//
// The browser decodes the image, strips its metadata (a canvas re-encode),
// scales it down and cuts a very tall photo into tiles, so the provider
// receives a normal, small image instead of a 12 megapixel phone photo.
// Every tile travels as a data URL in the chunk payload; the model reads the
// tiles and answers with the same YAML contract as a spreadsheet.
//
// When the runtime cannot decode images (no canvas - the Edge Function
// side, unit tests), the original bytes are embedded as one data URL and a
// warning says so: the image is never silently dropped.

import { LIMITS } from '@import-core/limits.js';

const MIME_BY_FORMAT = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    heic: 'image/heic',
    tiff: 'image/tiff',
};

export function imageMime(format) {
    return MIME_BY_FORMAT[String(format ?? '').toLowerCase()] ?? 'image/jpeg';
}

/** Base64 of raw bytes (browser and Deno both have btoa/atob). */
export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** The data URL of the original file (no re-encode). */
export function originalDataUrl(bytes, format) {
    return `data:${imageMime(format)};base64,${bytesToBase64(bytes)}`;
}

/**
 * The tile plan for an image: how many tiles and how big each one is.
 *
 * A wide photo stays one tile. A very tall photo (a note that fills the
 * camera) is cut into squares, because a provider downscales a tall image
 * until the text is unreadable.
 */
export function planTiles(width, height, limits = LIMITS) {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const aspect = h / w;

    if (aspect <= limits.TILE_ASPECT_THRESHOLD) {
        const scale = Math.min(1, limits.IMAGE_LONG_SIDE / Math.max(w, h));
        return {
            columns: 1,
            rows: 1,
            tileWidth: Math.round(w * scale),
            tileHeight: Math.round(h * scale),
            width: w,
            height: h,
        };
    }

    // Tall: cut into rows that are at most as tall as they are wide.
    const rows = Math.min(limits.MAX_TILES, Math.ceil(aspect));
    const tileHeight = Math.ceil(h / rows);
    const scale = Math.min(1, limits.IMAGE_LONG_SIDE / Math.max(w, tileHeight));
    return {
        columns: 1,
        rows,
        tileWidth: Math.round(w * scale),
        tileHeight: Math.round(tileHeight * scale),
        width: w,
        height: h,
    };
}

/** The browser decoder: createImageBitmap + a canvas (injected for tests). */
async function defaultDecode(bytes, mime) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    const blob = new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(blob);
    return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, sx, sy, sw, sh) => ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh),
        close: () => bitmap.close?.(),
    };
}

/**
 * Read one image file into a source the extractor can use.
 *
 * @param {{ name: string, bytes: Uint8Array, format?: string, meta?: object,
 *           limits?: typeof LIMITS, decode?: Function }} input
 * @returns {Promise<{ source: object }>}
 */
export async function readImageSource({
    name,
    bytes,
    format = 'jpeg',
    meta = {},
    limits = LIMITS,
    decode = defaultDecode,
}) {
    const mime = imageMime(format);
    const warnings = [];
    let images = [];
    let width = 0;
    let height = 0;

    let decoded = null;
    try {
        decoded = await decode(bytes, mime);
    } catch (error) {
        warnings.push({ code: 'IMAGE_DECODE_FAILED', params: { name } });
    }

    if (!decoded) {
        // No canvas: the original bytes travel as one image.
        images = [{
            id: 'img-1',
            dataUrl: originalDataUrl(bytes, format),
            width: 0,
            height: 0,
            tile: 1,
            tiles: 1,
        }];
        warnings.push({ code: 'IMAGE_NO_CANVAS', params: { name } });
    } else {
        width = decoded.width;
        height = decoded.height;
        const plan = planTiles(width, height, limits);
        if (plan.rows > limits.MAX_TILES) {
            warnings.push({ code: 'IMAGE_TOO_TALL', params: { name, tiles: plan.rows } });
        }
        images = [];
        for (let row = 0; row < plan.rows; row += 1) {
            const sy = Math.round((height / plan.rows) * row);
            const sh = Math.round((height / plan.rows) * (row + 1)) - sy;
            const canvas = document.createElement('canvas');
            canvas.width = plan.tileWidth;
            canvas.height = plan.tileHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                warnings.push({ code: 'IMAGE_NO_CANVAS', params: { name } });
                break;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            decoded.draw(ctx, 0, sy, width, sh);
            const dataUrl = canvas.toDataURL('image/jpeg', limits.JPEG_QUALITY);
            images.push({
                id: `img-${row + 1}`,
                dataUrl,
                width: plan.tileWidth,
                height: plan.tileHeight,
                tile: row + 1,
                tiles: plan.rows,
            });
        }
        decoded.close?.();
        if (images.length === 0) {
            images = [{
                id: 'img-1',
                dataUrl: originalDataUrl(bytes, format),
                width,
                height,
                tile: 1,
                tiles: 1,
            }];
            warnings.push({ code: 'IMAGE_NO_CANVAS', params: { name } });
        }
    }

    const source = {
        kind: 'image',
        name,
        layout: 'image',
        header: null,
        lines: [],
        images,
        meta: { ...meta, width, height, format },
        warnings,
        stats: { images: images.length },
    };
    return { source };
}
