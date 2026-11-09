// Check the locale files: the same key set, the same placeholders, and every
// key the browser can ask for exists in both languages.
//
// Run: node scripts/check-local-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';

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

// Every static key in the browser (and the template) must exist. A dynamic
// key such as t('importAgent.review.dup.' + action) is checked as a prefix:
// at least one key with that prefix must exist. This catches the class of
// missing key that the old three-file scan could not see.
const sourceRoots = ['index.html', 'src'];
const sourceFiles = [];
function walk(entry) {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
        for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
        return;
    }
    if (/\.(m?js|html)$/.test(entry)) sourceFiles.push(entry);
}
for (const root of sourceRoots) walk(root);

const used = new Map(); // key -> file
const prefixes = new Map(); // prefix -> file
function record(map, key, file) {
    if (!map.has(key)) map.set(key, file);
}
for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // t('key'), t("key")
    for (const match of text.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
        const key = match[2];
        if (key === '...') continue; // prose example in a comment
        if (key.endsWith('.')) record(prefixes, key, file);
        else record(used, key, file);
    }
    // t(`prefix.${value}`)
    for (const match of text.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) {
        if (match[1]) record(prefixes, match[1], file);
    }
}

let missing = 0;
for (const [key, file] of used) {
    if (!enKeys.has(key)) {
        console.error(`missing in en.json: ${key} (${file})`);
        missing += 1;
    }
    if (!arKeys.has(key)) {
        console.error(`missing in ar.json: ${key} (${file})`);
        missing += 1;
    }
}
for (const [prefix, file] of prefixes) {
    const inEn = [...enKeys].some((key) => key.startsWith(prefix));
    const inAr = [...arKeys].some((key) => key.startsWith(prefix));
    if (!inEn) {
        console.error(`no en.json key starts with: ${prefix} (${file})`);
        missing += 1;
    }
    if (!inAr) {
        console.error(`no ar.json key starts with: ${prefix} (${file})`);
        missing += 1;
    }
}
if (missing) process.exitCode = 1;

console.log(`locale check: ${enKeys.size} keys, ${used.size} literal keys, ${prefixes.size} dynamic prefixes, ${missing} missing`);