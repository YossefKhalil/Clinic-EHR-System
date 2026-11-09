// Bootstrap RTL/LTR switching without a flash of unstyled HTML.
//
// Both stylesheets are placed in the document at startup. Exactly one is
// applied at a time (`media="all"`), the other is downloaded but inert
// (`media="not all"`). The language switch only flips the media attribute, so
// it never removes the active stylesheet while the other one is fetching.
// Loading both as normal stylesheets would apply both and break the physical
// spacing utilities, so keep the media toggle.

export const BOOTSTRAP_LINK_IDS = Object.freeze({
    ltr: 'bs-core-ltr',
    rtl: 'bs-core-rtl',
});

function ensureLink(doc, id, href, active) {
    let link = doc.getElementById(id);
    if (!link) {
        link = doc.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = href;
        doc.head.appendChild(link);
    }
    link.media = active ? 'all' : 'not all';
    return link;
}

/**
 * Put both Bootstrap builds in the head before the first Alpine render.
 * `rtl` selects the one that is active immediately.
 */
export function ensureBootstrapLinks(doc, { ltrUrl, rtlUrl }, rtl = false) {
    const ltr = ensureLink(doc, BOOTSTRAP_LINK_IDS.ltr, ltrUrl, !rtl);
    const right = ensureLink(doc, BOOTSTRAP_LINK_IDS.rtl, rtlUrl, rtl);
    return { ltr, rtl: right };
}

/**
 * Apply the language's build by toggling `media` only. Both hrefs stay put,
 * so the browser can reuse the cached stylesheet and never paints unstyled
 * HTML during the switch.
 */
export function applyBootstrapDirectionToDocument(doc, rtl) {
    const ltr = doc.getElementById(BOOTSTRAP_LINK_IDS.ltr);
    const right = doc.getElementById(BOOTSTRAP_LINK_IDS.rtl);
    if (ltr) ltr.media = rtl ? 'not all' : 'all';
    if (right) right.media = rtl ? 'all' : 'not all';
    return Boolean(ltr && right);
}