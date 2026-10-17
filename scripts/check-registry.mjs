// CI check: the field registry and the real `patients` table must never
// diverge (spec §4, invariant I4).
//
// The registry is the single source of truth for every importable column.
// This script parses supabase/schema.sql and fails when:
//   1. a registry column is missing from the patients table, or
//   2. a patients column is neither in the registry nor explicitly
//      app-managed (see APP_MANAGED_COLUMNS), or
//   3. the registry itself is malformed (duplicate keys/columns).
//
// Run locally: npm run check:registry

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIELDS } from '../supabase/functions/_shared/import-core/field-registry.js';

const SCHEMA_PATH = fileURLToPath(new URL('../supabase/schema.sql', import.meta.url));

// patients columns owned by the application, not the import agent.
const APP_MANAGED_COLUMNS = [
    'id',
    'is_completed',
    'user_id',
    'created_at',
    'updated_at',
    'attachments', // Cloudinary metadata array
    'registered_by_name', // denormalized registrar name
];

function patientsColumns(sql) {
    const columns = new Set();

    const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS public\.patients \(([\s\S]*?)\n\);/);
    if (!createMatch) throw new Error('Could not find CREATE TABLE public.patients in schema.sql');
    for (const line of createMatch[1].split('\n')) {
        const match = line.match(/^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/);
        if (match) columns.add(match[1]);
    }

    const addColumn = /ALTER TABLE public\.patients\s+ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)/gi;
    for (const match of sql.matchAll(addColumn)) columns.add(match[1]);

    return columns;
}

function fail(message) {
    console.error(`check-registry: ${message}`);
    process.exitCode = 1;
}

const schemaColumns = patientsColumns(readFileSync(SCHEMA_PATH, 'utf8'));

// 3. Registry integrity.
const seenKeys = new Set();
const seenColumns = new Set();
for (const field of FIELDS) {
    if (seenKeys.has(field.key)) fail(`duplicate registry key "${field.key}"`);
    seenKeys.add(field.key);
    if (seenColumns.has(field.column)) fail(`duplicate registry column "${field.column}"`);
    seenColumns.add(field.column);
    if (field.key !== field.column) {
        fail(`registry key "${field.key}" differs from column "${field.column}" (decision D15: keys equal columns)`);
    }
}

// 1. Every registry column exists in the table.
for (const field of FIELDS) {
    if (!schemaColumns.has(field.column)) {
        fail(`registry field "${field.key}" has no "${field.column}" column in public.patients`);
    }
}

// 2. Every table column is accounted for.
const accounted = new Set([...seenColumns, ...APP_MANAGED_COLUMNS]);
for (const column of schemaColumns) {
    if (!accounted.has(column)) {
        fail(`public.patients column "${column}" is neither in the registry nor in APP_MANAGED_COLUMNS`);
    }
}
for (const column of APP_MANAGED_COLUMNS) {
    if (seenColumns.has(column)) {
        fail(`column "${column}" is both app-managed and in the registry`);
    }
}

if (process.exitCode) {
    console.error(`check-registry: FAILED (${FIELDS.length} registry fields, ${schemaColumns.size} patients columns)`);
} else {
    console.log(`check-registry: OK (${FIELDS.length} registry fields cover every importable patients column)`);
}
