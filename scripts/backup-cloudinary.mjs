// Cloudinary attachment backup (issue #44).
//
// The Postgres backup only contains attachment metadata; the bytes live in
// Cloudinary. This script lists the clinic's original assets through the
// Cloudinary Admin API, downloads each original, and writes a SHA-256 manifest.
// Run it monthly (the workflow does) and store the encrypted archive somewhere
// private, not on a public repository branch.
//
// Required environment variables:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// Usage: node scripts/backup-cloudinary.mjs [output-directory]

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
const apiKey = process.env.CLOUDINARY_API_KEY || '';
const apiSecret = process.env.CLOUDINARY_API_SECRET || '';
const outputRoot = path.resolve(process.argv[2] || 'cloudinary-backup');

if (!cloudName || !apiKey || !apiSecret) {
    console.error('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required.');
    process.exit(1);
}

const basicAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
const apiRoot = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}`;
const deliveryRoot = `https://res.cloudinary.com/${encodeURIComponent(cloudName)}`;

// Cloudinary's delivery signature: SHA-1 of transformation/public_id + API
// secret, URL-safe base64, first 8 characters. `secure_url` for an
// `authenticated` asset is unsigned and answers 401; the backup has to sign
// the same path the application signs when it reads the file.
function authenticatedDeliveryUrl(resource) {
    const source = resource.format && !String(resource.public_id).endsWith(`.${resource.format}`)
        ? `${resource.public_id}.${resource.format}`
        : String(resource.public_id);
    const digest = createHash('sha1').update(source + apiSecret).digest();
    const signature = digest.toString('base64url').slice(0, 8);
    return `${deliveryRoot}/${resource.resource_type}/authenticated/s--${signature}--/${source}`;
}

function downloadUrl(resource) {
    if (resource.type === 'authenticated') return authenticatedDeliveryUrl(resource);
    return resource.secure_url || '';
}

function safeRelative(resource) {
    const segments = String(resource.public_id || 'asset')
        .split('/')
        .filter(Boolean)
        .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '_'));
    const name = segments.pop() || 'asset';
    const format = String(resource.format || '').replace(/[^A-Za-z0-9]/g, '');
    const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
    return path.join(
        ...segments,
        `${name}${!hasExtension && format ? `.${format}` : ''}`,
    );
}

async function listResources(resourceType, deliveryType) {
    const resources = [];
    let cursor = '';
    do {
        const params = new URLSearchParams({
            prefix: 'clinic-ehr',
            max_results: '500',
        });
        if (cursor) params.set('next_cursor', cursor);
        const response = await fetch(
            `${apiRoot}/resources/${resourceType}/${deliveryType}?${params}`,
            { headers: { Authorization: `Basic ${basicAuth}` } },
        );
        if (!response.ok) {
            throw new Error(`Cloudinary list failed (${response.status}): ${await response.text()}`);
        }
        const payload = await response.json();
        resources.push(...(payload.resources || []));
        cursor = payload.next_cursor || '';
    } while (cursor);
    return resources;
}

async function download(resource) {
    const url = downloadUrl(resource);
    if (!url) {
        return { ...resource, backup_error: 'delivery URL missing' };
    }
    const response = await fetch(url);
    if (!response.ok) {
        return { ...resource, backup_error: `download failed (${response.status})` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const relative = safeRelative(resource);
    const target = path.join(outputRoot, resource.resource_type, resource.type, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return {
        public_id: resource.public_id,
        resource_type: resource.resource_type,
        type: resource.type,
        format: resource.format || '',
        bytes: bytes.length,
        created_at: resource.created_at,
        file: path.relative(outputRoot, target).split(path.sep).join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

const manifest = [];
const errors = [];
for (const [resourceType, deliveryType] of [
    ['image', 'authenticated'],
    ['raw', 'authenticated'],
    ['image', 'upload'],
    ['raw', 'upload'],
]) {
    let resources = [];
    try {
        resources = await listResources(resourceType, deliveryType);
    } catch (error) {
        // A delivery type with no assets still answers 200; a failure here is
        // a real credentials/permission problem worth failing the backup for.
        throw error;
    }
    for (const resource of resources) {
        try {
            const entry = await download(resource);
            if (entry.backup_error) errors.push(entry);
            else manifest.push(entry);
        } catch (error) {
            errors.push({ ...resource, backup_error: error.message });
        }
    }
}

await mkdir(outputRoot, { recursive: true });
await writeFile(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify({ cloud: cloudName, created_at: new Date().toISOString(), assets: manifest, errors }, null, 2)}\n`,
);

console.log(`Backed up ${manifest.length} Cloudinary assets to ${outputRoot}`);
if (errors.length) {
    console.error(`${errors.length} assets could not be downloaded; see manifest.json`);
    process.exitCode = 1;
}
