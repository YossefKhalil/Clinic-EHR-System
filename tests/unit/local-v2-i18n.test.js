// Every sentence the v2 card can show exists in both locales.
//
// This is the check `npm run check:i18n` does not do (it only looks at three
// files and three namespaces, see #55). The keys are read from the markup and
// from the error table, so a typo in either one fails here instead of showing
// a raw dotted key to an Arabic-speaking clinic.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import en from '../../src/locales/en.json';
import ar from '../../src/locales/ar.json';
import { V2_ERROR_CODES, V2_ERROR_KEYS, v2ErrorKey } from '../../src/features/import-agent/local-v2/errors.js';

const HTML_PATH = fileURLToPath(new URL('../../index.html', import.meta.url));

/** Every `aiSettings.localV2.*` key the settings card references. */
function keysUsedInMarkup() {
    const html = readFileSync(HTML_PATH, 'utf8');
    const keys = new Set();
    for (const match of html.matchAll(/aiSettings\.localV2\.[A-Za-z0-9_.]+/g)) {
        keys.add(match[0]);
    }
    return [...keys];
}

const STATUSES = ['idle', 'checking', 'blocked', 'downloading', 'ready', 'error'];

function hasSentence(locale, key) {
    const value = locale[key];
    return typeof value === 'string' && value.trim().length > 0;
}

describe('v2 translations', () => {
    it('has a sentence for every failure code, in both locales', () => {
        for (const code of V2_ERROR_CODES) {
            const key = v2ErrorKey(code);
            expect(hasSentence(en, key), `en missing ${key} (${code})`).toBe(true);
            expect(hasSentence(ar, key), `ar missing ${key} (${code})`).toBe(true);
        }
    });

    it('has a sentence for every status the card can show', () => {
        for (const status of STATUSES) {
            const key = `aiSettings.localV2.status.${status}`;
            expect(hasSentence(en, key), `en missing ${key}`).toBe(true);
            expect(hasSentence(ar, key), `ar missing ${key}`).toBe(true);
        }
    });

    it('has a sentence for every key the settings markup uses', () => {
        const keys = keysUsedInMarkup();
        expect(keys.length).toBeGreaterThan(10);
        for (const key of keys) {
            expect(hasSentence(en, key), `en missing ${key}`).toBe(true);
            expect(hasSentence(ar, key), `ar missing ${key}`).toBe(true);
        }
    });

    it('keeps the error table and the codes in step', () => {
        expect(Object.keys(V2_ERROR_KEYS).sort()).toEqual([...V2_ERROR_CODES].sort());
        // An unknown code must still produce a valid sentence key.
        expect(v2ErrorKey('SOMETHING_NEW')).toBe(V2_ERROR_KEYS.LOCAL_ENGINE_ERROR);
    });

    it('interpolates the values the sentences ask for', () => {
        // The card passes { needGb, haveGb } and { needGb, freeGb }; a
        // ":name" placeholder with no value would render literally.
        expect(en['aiSettings.localV2.error.ramShort']).toContain(':needGb');
        expect(en['aiSettings.localV2.error.ramShort']).toContain(':haveGb');
        expect(ar['aiSettings.localV2.error.storageShort']).toContain(':freeGb');
    });
});
