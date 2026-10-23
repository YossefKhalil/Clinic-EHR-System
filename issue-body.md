## Problem
Authenticated delivery URLs for raw assets (PDFs) return **401 Unauthenticated access / deny or ACL failure**, while authenticated image delivery works correctly.

## Working: Images
- Upload: `POST /v1_1/enawkhji/image/upload` with signed `type=authenticated` → 200
- Delivery: `GET https://res.cloudinary.com/enawkhji/image/authenticated/s--SIG--/public_id` → 200

## Broken: PDFs (raw)
- Upload: `POST /v1_1/enawkhji/raw/upload` with signed `type=authenticated` → 200
- Delivery: `GET https://res.cloudinary.com/enawkhji/raw/authenticated/s--SIG--/public_id.PDF` → **401**

## Current signature logic (supabase/functions/cloudinary-sign/index.ts)
```typescript
const source = resourceType === 'raw' || !format || publicId.endsWith(`.${format}`)
    ? publicId
    : `${publicId}.${format}`;

const signature = await signDeliveryPath('', source, apiSecret);
const url = `https://res.cloudinary.com/${cloudName}/${resourceType}/authenticated/${signature}/${source}`;
```

For raw assets, `publicId` already includes the extension (e.g., `clinic-ehr/patients/.../file.PDF`), so `source` = `publicId`. The signature is computed over the full path.

## Error response
```json
{
  "success": false,
  "url": "https://res.cloudinary.com/enawkhji/raw/authenticated/s--Y0Ia3mLe--/clinic-ehr/patients/9ec0e396-2891-403e-8ed1-c67e7594f048/gmee9vwbeh45oxizvwic.PDF",
  "error": {
    "code": 401,
    "message": "deny or ACL failure",
    "requestId": "-"
  }
}
```

## Hypotheses
1. **Cloudinary free tier limitation**: Authenticated delivery for raw assets may be restricted.
2. **Raw authenticated delivery requires different URL format** (e.g., `/raw/authenticated/s--SIG--/public_id` without extension in path?).
3. **ACL settings**: The upload preset `clinic_ehr_uploads` is configured for authenticated delivery, but raw assets might need explicit ACL.
4. **Signature computation differs for raw**: The delivery URL signature algorithm might expect the resource_type in the string-to-sign.

## Relevant code
- Edge function: `supabase/functions/cloudinary-sign/index.ts` (actions `upload` and `url`)
- Frontend upload: `src/services/cloudinary.js` → `uploadAuthenticated()`
- Frontend URL helpers: `src/main.js` → `attachmentUrl()` / `attachmentFullUrl()`

## Environment
- Cloudinary cloud: `enawkhji`
- Supabase project: `xrotdkccsgdzswvejaki`
- Upload preset: `clinic_ehr_uploads` (authenticated delivery type)
- Free tier on both platforms