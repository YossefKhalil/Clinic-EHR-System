// Ports and stable keys for the mock backend.
//
// The anon and service-role keys are ordinary JWTs signed with the mock secret.
// They are written once to .local/mock-keys.json and reused, so a restart does
// not invalidate the .env.local the dev server already loaded.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sign } from './jwt.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEYS_PATH = `${ROOT}.local/mock-keys.json`;

export const PORT = Number(process.env.MOCK_PORT || 54321);
export const FUNCTIONS_PORT = Number(process.env.MOCK_FUNCTIONS_PORT || 54328);

export function keys() {
    if (existsSync(KEYS_PATH)) {
        try {
            const stored = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
            if (stored.anonKey && stored.serviceKey) return stored;
        } catch {
            // fall through and regenerate
        }
    }
    const value = {
        anonKey: sign({ role: 'anon', aud: 'authenticated', iss: 'local-mock' }),
        serviceKey: sign({ role: 'service_role', aud: 'authenticated', iss: 'local-mock' }),
    };
    if (!existsSync(`${ROOT}.local`)) mkdirSync(`${ROOT}.local`, { recursive: true });
    writeFileSync(KEYS_PATH, JSON.stringify(value, null, 2));
    return value;
}
