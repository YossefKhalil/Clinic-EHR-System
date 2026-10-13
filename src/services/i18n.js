import Alpine from 'alpinejs';
import en from '../locales/en.json';
import ar from '../locales/ar.json';

const dictionaries = { en, ar };

// The locale lives on an Alpine-reactive object so every `x-text="t('...')"`
// expression that reads it re-renders when the language changes.
const state = Alpine.reactive({ locale: 'en' });

function dictionary(locale) {
    return dictionaries[locale] || dictionaries.en;
}

export async function initI18n() {
    const saved = localStorage.getItem('locale') || 'en';
    await setLocale(saved);
}

export async function setLocale(locale) {
    const next = dictionaries[locale] ? locale : 'en';
    const translations = dictionary(next);

    state.locale = next;
    localStorage.setItem('locale', next);

    document.documentElement.lang = next;
    document.documentElement.dir = translations.direction || (next === 'ar' ? 'rtl' : 'ltr');

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (translations[key]) {
            el.textContent = translations[key];
        }
    });

    window.localeChanged?.();
}

export function getLocale() {
    return state.locale;
}

export function t(key, params = {}) {
    const translations = dictionary(state.locale);
    let text = translations[key] ?? key;

    Object.entries(params).forEach(([k, v]) => {
        text = text.replace(`:${k}`, v);
    });

    return text;
}
