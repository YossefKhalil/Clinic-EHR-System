// HS256 JWTs for the mock. The browser's supabase-js only decodes the access
// token; the mock verifies its own signatures for authenticated calls.

import { createHmac } from 'node:crypto';

export const JWT_SECRET = process.env.MOCK_JWT_SECRET || 'local-mock-jwt-secret';

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

export function sign(payload, { expiresIn = 60 * 60 * 24 * 3650 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ iat: now, exp: now + expiresIn, ...payload }));
    const data = `${header}.${body}`;
    const signature = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
    return `${data}.${signature}`;
}

export function decode(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export function verify(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const expected = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
    if (expected.length !== parts[2].length) return null;
    let same = 0;
    for (let i = 0; i < expected.length; i += 1) same |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
    if (same !== 0) return null;
    const payload = decode(token);
    if (!payload) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
}
