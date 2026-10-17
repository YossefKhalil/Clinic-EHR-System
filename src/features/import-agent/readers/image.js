// Image reader — M3 stub. Content sniffing accepts every supported image
// signature (spec §5.2) and the preview counts the file, but transcription
// arrives with the vision milestone (M8), which replaces this module with the
// full pipeline: EXIF orientation, canvas re-encode (strips metadata),
// downscale, tiling for tall images and the transcriber call.
//
// Until then the reader says exactly that, loudly, so nothing is silently
// dropped or quietly sent as raw bytes.

/**
 * @param {{ name: string, meta?: object }} input
 * @returns {{ source: object }}
 */
export function readImageSource({ name, meta = {} }) {
    const source = {
        kind: 'image',
        name,
        layout: 'image',
        header: null,
        lines: [],
        meta,
        warnings: [{ code: 'IMAGE_READER_NOT_READY', params: {} }],
        stats: { images: 1 },
    };
    return { source };
}
