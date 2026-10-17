// Minimal ZIP writer for test fixtures (DOCX files, hostile zips). Deflates
// entries with node:zlib and writes a spec-conformant central directory —
// the same structure the reader's zip-bomb guard walks.
//
// `declaredUncompressed` overrides the uncompressed size that lands in the
// headers, which lets tests exercise the guard without materialising
// hundreds of megabytes.

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data) {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/**
 * @param {{ name: string, data: string|Uint8Array, store?: boolean,
 *           declaredUncompressed?: number }[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;

    const push = (bytes) => {
        chunks.push(bytes);
        offset += bytes.length;
    };

    for (const entry of entries) {
        const name = new TextEncoder().encode(entry.name);
        const data = toBytes(entry.data);
        const crc = crc32(data);
        const compressed = entry.store ? data : new Uint8Array(deflateRawSync(data));
        const method = entry.store ? 0 : 8;
        const uncompressedSize = entry.declaredUncompressed ?? data.length;

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);        // version needed
        lv.setUint16(6, 0x0800, true);    // UTF-8 names
        lv.setUint16(8, method, true);
        lv.setUint16(10, 0, true);        // time
        lv.setUint16(12, 0, true);        // date
        lv.setUint32(14, crc, true);
        lv.setUint32(18, compressed.length, true);
        lv.setUint32(22, uncompressedSize, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);        // extra length
        local.set(name, 30);

        const cd = new Uint8Array(46 + name.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);        // version made by
        cv.setUint16(6, 20, true);        // version needed
        cv.setUint16(8, 0x0800, true);    // UTF-8 names
        cv.setUint16(10, method, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, compressed.length, true);
        cv.setUint32(24, uncompressedSize, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true);        // extra
        cv.setUint16(32, 0, true);        // comment
        cv.setUint16(34, 0, true);        // disk
        cv.setUint16(36, 0, true);        // internal attrs
        cv.setUint32(38, 0, true);        // external attrs
        cv.setUint32(42, offset, true);   // local header offset
        cd.set(name, 46);

        push(local);
        push(compressed);
        central.push(cd);
    }

    const cdOffset = offset;
    for (const cd of central) push(cd);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);             // disk
    ev.setUint16(6, 0, true);             // cd disk
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, offset - cdOffset, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);            // comment
    push(eocd);

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
        out.set(c, pos);
        pos += c.length;
    }
    return out;
}
