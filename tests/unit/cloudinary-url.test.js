import { describe, expect, it } from 'vitest';
import {
    hasCloudinarySignature,
    isProtectedCloudinaryUrl,
    transformCloudinaryImageUrl,
} from '../../src/services/cloudinary-url.js';

const PUBLIC_URL = 'https://res.cloudinary.com/old-cloud/image/upload/v1723456789/clinic-ehr/drafts/user/unassigned/photo.webp';

describe('transformCloudinaryImageUrl', () => {
    it('keeps the original cloud, version, folder and extension', () => {
        expect(transformCloudinaryImageUrl(PUBLIC_URL, { width: 256 })).toBe(
            'https://res.cloudinary.com/old-cloud/image/upload/w_256,q_auto,f_auto,c_limit/v1723456789/clinic-ehr/drafts/user/unassigned/photo.webp',
        );
    });

    it('never transforms authenticated or private delivery URLs', () => {
        const authenticated = 'https://res.cloudinary.com/cloud/image/authenticated/s--abc12345--/clinic-ehr/patients/id/photo.webp';
        const privateUrl = 'https://res.cloudinary.com/cloud/image/private/s--abc12345--/clinic-ehr/patients/id/photo.webp';

        expect(transformCloudinaryImageUrl(authenticated, { width: 256 })).toBe(authenticated);
        expect(transformCloudinaryImageUrl(privateUrl, { width: 256 })).toBe(privateUrl);
    });

    it('leaves non-Cloudinary URLs alone', () => {
        expect(transformCloudinaryImageUrl('https://example.test/photo.jpg', { width: 256 }))
            .toBe('https://example.test/photo.jpg');
        expect(transformCloudinaryImageUrl('', { width: 256 })).toBe('');
    });

    it('clamps pixel values and supports height-only transforms', () => {
        expect(transformCloudinaryImageUrl(PUBLIC_URL, { width: 99999, height: 0 })).toContain('/w_4096,q_auto,f_auto,c_limit/');
        expect(transformCloudinaryImageUrl(PUBLIC_URL, { height: 300 })).toContain('/h_300,q_auto,f_auto,c_limit/');
    });
});

describe('Cloudinary protected URL detection', () => {
    it('recognises authenticated and private image/raw URLs', () => {
        expect(isProtectedCloudinaryUrl('https://res.cloudinary.com/c/image/authenticated/s--a--/x')).toBe(true);
        expect(isProtectedCloudinaryUrl('https://res.cloudinary.com/c/raw/private/s--a--/x.pdf')).toBe(true);
        expect(isProtectedCloudinaryUrl(PUBLIC_URL)).toBe(false);
    });

    it('only accepts a real s--signature-- segment', () => {
        expect(hasCloudinarySignature('https://res.cloudinary.com/c/image/authenticated/s--abc12345--/x')).toBe(true);
        expect(hasCloudinarySignature('https://res.cloudinary.com/c/image/authenticated/x')).toBe(false);
    });
});
