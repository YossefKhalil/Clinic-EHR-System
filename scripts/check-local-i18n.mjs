// Check the locale files: the same key set, and every key the local engine
// uses exists in both.
//
// Run: node scripts/check-local-i18n.mjs
import fs from 'node:fs';
import { PROBE_MESSAGE_KEYS } from '../src/features/import-agent/local/probe-messages.js';

const en = JSON.parse(fs.readFileSync('src/locales/en.json', 'utf8'));
const ar = JSON.parse(fs.readFileSync('src/locales/ar.json', 'utf8'));

const enKeys = new Set(Object.keys(en));
const arKeys = new Set(Object.keys(ar));
const onlyEn = [...enKeys].filter((key) => !arKeys.has(key));
const onlyAr = [...arKeys].filter((key) => !enKeys.has(key));
if (onlyEn.length || onlyAr.length) {
    console.error('key sets differ');
    for (const key of onlyEn) console.error(`  only en: ${key}`);
    for (const key of onlyAr) console.error(`  only ar: ${key}`);
    process.exitCode = 1;
}

// The placeholders of a key must be the same in both files.
let placeholdersOk = true;
for (const [key, value] of Object.entries(en)) {
    const enMarks = (String(value).match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || []).sort().join(',');
    const arMarks = (String(ar[key] ?? '').match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || []).sort().join(',');
    if (enMarks !== arMarks) {
        console.error(`placeholders differ: ${key} (${enMarks} vs ${arMarks})`);
        placeholdersOk = false;
    }
}
if (!placeholdersOk) process.exitCode = 1;

// Every key the local engine uses must exist in both files.
const files = [
    'index.html',
    'src/main.js',
    'src/features/import-agent/ui.js',
];
const used = new Set();
for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/\bt\(\s*'([^']+)'\s*\+/g)) used.add(match[1]);
}
const localKeys = [...used].filter((key) => key.startsWith('aiSettings.local.') || key.startsWith('importAgent.progress.local.') || key.startsWith('importAgent.wizard.local'))
    // A key that ends with a dot is a prefix a runtime value is added to.
    .filter((key) => !key.endsWith('.'));
let missing = 0;
for (const key of localKeys) {
    if (!enKeys.has(key)) { console.error(`missing in en.json: ${key}`); missing += 1; }
    if (!arKeys.has(key)) { console.error(`missing in ar.json: ${key}`); missing += 1; }
}
// The keys the runtime builds out of a prefix have to exist as well.
for (const key of ['importAgent.progress.local.loading_model', 'importAgent.progress.local.reading_photos', 'importAgent.progress.local.extracting']) {
    if (!enKeys.has(key)) { console.error(`missing in en.json: ${key}`); missing += 1; }
    if (!arKeys.has(key)) { console.error(`missing in ar.json: ${key}`); missing += 1; }
}
// Every probe code the settings card can show has a translated sentence.
for (const key of Object.values(PROBE_MESSAGE_KEYS)) {
    if (!enKeys.has(key)) { console.error(`missing in en.json: ${key}`); missing += 1; }
    if (!arKeys.has(key)) { console.error(`missing in ar.json: ${key}`); missing += 1; }
}
if (missing) process.exitCode = 1;

console.log(`locale check: ${enKeys.size} keys, ${localKeys.length} local keys, ${missing} missing`);
