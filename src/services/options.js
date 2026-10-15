// Editable option lists (issue #1) — followers, clinic sections, sources of
// money. Everything the UI needs to render labels and select boxes goes
// through this module; the database table is the single source of truth.
//
// Keys are immutable values stored on patient rows; labels are what users
// read. The cache is loaded once on login (and reloaded after every Settings
// edit), so templates can call the synchronous helpers cheaply.
import { supabase } from './supabase.js';
import { getLocale } from './i18n.js';

const KINDS = ['follower', 'section', 'source'];
const cache = { follower: [], section: [], source: [] };

export async function loadOptions() {
    const { data, error } = await supabase()
        .from('app_options')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

    if (error) throw error;

    KINDS.forEach((kind) => {
        cache[kind] = (data || []).filter((opt) => opt.kind === kind);
    });
    return cache;
}

export function allOptions(kind) {
    return [...(cache[kind] || [])];
}

export function activeOptions(kind) {
    return (cache[kind] || []).filter((opt) => opt.active);
}

export function optionByKey(kind, key) {
    if (!key) return null;
    return (cache[kind] || []).find((opt) => opt.key === key) || null;
}

// Localized label for a stored key. Unknown keys (for example a value added
// outside the app) fall back to the raw key so nothing ever renders blank.
export function optionLabel(kind, key) {
    if (!key) return '';
    const opt = optionByKey(kind, key);
    if (!opt) return String(key);
    const label = getLocale() === 'ar'
        ? (opt.label_ar || opt.label_en)
        : (opt.label_en || opt.label_ar);
    return label || String(key);
}

// Client-side key generation for new options: "زمالة، الجمعية" -> a stable,
// URL-safe key. Unicode letters/numbers survive so Arabic-only labels still
// produce a meaningful key.
export function slugify(label) {
    return String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

function uniqueKey(kind, base) {
    const taken = new Set((cache[kind] || []).map((opt) => opt.key));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
}

function nextSortOrder(kind) {
    const orders = (cache[kind] || []).map((opt) => opt.sort_order || 0);
    return orders.length ? Math.max(...orders) + 1 : 1;
}

export async function createOption(kind, { label_en = '', label_ar = '' } = {}) {
    if (!KINDS.includes(kind)) throw new Error('Unknown option kind');
    const base = slugify(label_en) || slugify(label_ar) || `${kind}-${Date.now()}`;
    const { data, error } = await supabase()
        .from('app_options')
        .insert({
            kind,
            key: uniqueKey(kind, base),
            label_en: label_en.trim(),
            label_ar: label_ar.trim(),
            sort_order: nextSortOrder(kind),
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// The one write path for edits: rename labels and/or flip `active`. Options
// are never hard-deleted — deactivating hides them from new selections while
// existing patient rows keep their key and label.
export async function updateOption(id, { label_en, label_ar, active } = {}) {
    const patch = {};
    if (label_en !== undefined) patch.label_en = String(label_en).trim();
    if (label_ar !== undefined) patch.label_ar = String(label_ar).trim();
    if (active !== undefined) patch.active = !!active;

    const { data, error } = await supabase()
        .from('app_options')
        .update(patch)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
}
