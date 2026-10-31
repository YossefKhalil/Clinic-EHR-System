// Issue #44: the pure compression rules. The canvas path itself is browser
// code; these tests cover the decisions before and after it.
import { describe, expect, it } from 'vitest';
import {
    COMPRESSION_QUALITY,
    MAX_IMAGE_DIMENSION,
    compressedName,
    compressionEnabled,
    isCompressibleImage,
    targetDimensions,
} from '../../src/services/image-compression.js';

describe('attachment compression settings', () => {
    it('targets a 1600px long side at 0.75 quality', () => {
        expect(MAX_IMAGE_DIMENSION).toBe(1600);
        expect(COMPRESSION_QUALITY).toBe(0.75);
    });

    it('can be disabled explicitly but is on by default', () => {
        expect(compressionEnabled({})).toBe(true);
        expect(compressionEnabled({ VITE_COMPRESS_ATTACHMENTS: '' })).toBe(true);
        expect(compressionEnabled({ VITE_COMPRESS_ATTACHMENTS: 'true' })).toBe(true);
        for (const value of ['false', 'FALSE', '0', 'off', 'no']) {
            expect(compressionEnabled({ VITE_COMPRESS_ATTACHMENTS: value })).toBe(false);
        }
    });
});

describe('which attachments are compressed', () => {
    it('accepts raster photos', () => {
        expect(isCompressibleImage({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(true);
        expect(isCompressibleImage({ type: 'image/png', name: 'scan.png' })).toBe(true);
        expect(isCompressibleImage({ type: 'image/webp', name: 'image.webp' })).toBe(true);
        expect(isCompressibleImage({ type: 'image/bmp', name: 'scan.bmp' })).toBe(true);
        expect(isCompressibleImage({ type: 'image/avif', name: 'photo.avif' })).toBe(true);
    });

    it('uses the extension only when the browser reports no MIME type', () => {
        expect(isCompressibleImage({ type: '', name: 'PHONE.JPEG' })).toBe(true);
        expect(isCompressibleImage({ type: '', name: 'photo.heic' })).toBe(false);
        expect(isCompressibleImage({ type: '', name: 'notes.pdf' })).toBe(false);
    });

    it('leaves PDFs, animation, vector and unsupported formats alone', () => {
        expect(isCompressibleImage({ type: 'application/pdf', name: 'scan.pdf' })).toBe(false);
        expect(isCompressibleImage({ type: 'image/gif', name: 'animated.gif' })).toBe(false);
        expect(isCompressibleImage({ type: 'image/svg+xml', name: 'vector.svg' })).toBe(false);
        expect(isCompressibleImage({ type: 'image/heic', name: 'photo.heic' })).toBe(false);
        expect(isCompressibleImage({ type: 'image/tiff', name: 'scan.tiff' })).toBe(false);
    });
});

describe('targetDimensions', () => {
    it('downscales a landscape phone photo by its long side', () => {
        expect(targetDimensions(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    });

    it('downscales a portrait photo by its long side', () => {
        expect(targetDimensions(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    });

    it('never upscales a small image', () => {
        expect(targetDimensions(640, 480)).toEqual({ width: 640, height: 480 });
    });

    it('keeps a square square', () => {
        expect(targetDimensions(3000, 3000)).toEqual({ width: 1600, height: 1600 });
    });

    it('rounds and clamps degenerate values', () => {
        expect(targetDimensions(0, 0)).toEqual({ width: 1, height: 1 });
        expect(targetDimensions(3201, 1)).toEqual({ width: 1600, height: 1 });
    });
});

describe('compressedName', () => {
    it('uses the extension of the encoded format and keeps the basename', () => {
        expect(compressedName('IMG_1234.JPG', 'image/webp')).toBe('IMG_1234.webp');
        expect(compressedName('lab.scan.png', 'image/jpeg')).toBe('lab.scan.jpg');
    });

    it('never returns an empty name', () => {
        expect(compressedName('', 'image/webp')).toBe('image.webp');
    });
});
