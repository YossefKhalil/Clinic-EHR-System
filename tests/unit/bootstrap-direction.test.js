// Issue #58: a language switch must never remove the only active Bootstrap
// stylesheet while the other build is still downloading.

import { describe, expect, it } from 'vitest';
import {
    applyBootstrapDirectionToDocument,
    ensureBootstrapLinks,
} from '../../src/services/bootstrap-direction.js';

function fakeDocument() {
    const byId = new Map();
    const head = {
        appendChild(element) {
            byId.set(element.id, element);
            return element;
        },
    };
    return {
        head,
        createElement(tagName) {
            return { tagName, id: '', rel: '', href: '', media: '' };
        },
        getElementById(id) {
            return byId.get(id) ?? null;
        },
    };
}

const urls = { ltrUrl: '/assets/ltr.css', rtlUrl: '/assets/rtl.css' };

describe('Bootstrap direction links', () => {
    it('puts both builds in the document and applies exactly one', () => {
        const doc = fakeDocument();
        const links = ensureBootstrapLinks(doc, urls, false);

        expect(links.ltr.href).toBe('/assets/ltr.css');
        expect(links.rtl.href).toBe('/assets/rtl.css');
        expect(links.ltr.media).toBe('all');
        expect(links.rtl.media).toBe('not all');
    });

    it('starts in RTL when the saved language is Arabic', () => {
        const doc = fakeDocument();
        const links = ensureBootstrapLinks(doc, urls, true);

        expect(links.ltr.media).toBe('not all');
        expect(links.rtl.media).toBe('all');
    });

    it('flips media only, keeping both hrefs cached', () => {
        const doc = fakeDocument();
        const links = ensureBootstrapLinks(doc, urls, false);
        const ltrHref = links.ltr.href;
        const rtlHref = links.rtl.href;

        applyBootstrapDirectionToDocument(doc, true);
        expect(links.ltr.media).toBe('not all');
        expect(links.rtl.media).toBe('all');
        expect(links.ltr.href).toBe(ltrHref);
        expect(links.rtl.href).toBe(rtlHref);

        applyBootstrapDirectionToDocument(doc, false);
        expect(links.ltr.media).toBe('all');
        expect(links.rtl.media).toBe('not all');
        expect(links.ltr.href).toBe(ltrHref);
        expect(links.rtl.href).toBe(rtlHref);
    });

    it('reuses the links instead of adding duplicates', () => {
        const doc = fakeDocument();
        ensureBootstrapLinks(doc, urls, false);
        ensureBootstrapLinks(doc, urls, true);

        expect(doc.head.appendChild).toBeTypeOf('function');
        expect(doc.getElementById('bs-core-ltr')).not.toBeNull();
        expect(doc.getElementById('bs-core-rtl')).not.toBeNull();
        expect(doc.getElementById('bs-core')).toBeNull();
    });
});