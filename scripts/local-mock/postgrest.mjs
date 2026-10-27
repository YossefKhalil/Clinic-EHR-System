// A small PostgREST.
//
// It implements the slice of the PostgREST protocol the app uses: filters
// (eq/neq/gt/gte/lt/lte/like/ilike/is/in/or), order, limit/offset/Range,
// exact counts, single/maybeSingle, insert/update/delete/upsert and RPC. Query
// execution goes through db.withRole, so RLS is enforced exactly like the
// hosted stack.

import { withRole } from './db.mjs';

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and', 'not']);

const FILTER_OPS = {
    eq: '=',
    neq: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'LIKE',
    ilike: 'ILIKE',
    is: 'IS',
};

function ident(name) {
    const text = String(name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new HttpError(400, `bad identifier: ${text}`);
    return `"${text}"`;
}

class HttpError extends Error {
    constructor(status, message, code = 'PGRST100') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function jsonBody(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(payload);
}

/** Split on a separator that sits outside parentheses and quotes. */
function splitTopLevel(text, separator = ',') {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const char of String(text)) {
        if (quote) {
            current += char;
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === '(' || char === '[') depth += 1;
        if (char === ')' || char === ']') depth -= 1;
        if (char === separator && depth === 0) { parts.push(current); current = ''; continue; }
        current += char;
    }
    if (current !== '') parts.push(current);
    return parts;
}

function parseInList(raw) {
    let text = String(raw).trim();
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    if (!text) return [];
    return splitTopLevel(text).map((value) => {
        const trimmed = value.trim();
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    });
}

function coerce(value) {
    if (value === 'null') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}

function bind(params, value) {
    params.push(value);
    return `$${params.length}`;
}

/** One `column.operator.value` term into a SQL fragment. */
function buildTerm(term, params, alias) {
    const first = term.indexOf('.');
    if (first < 0) throw new HttpError(400, `bad filter: ${term}`);
    const column = term.slice(0, first);
    const rest = term.slice(first + 1);
    const second = rest.indexOf('.');
    const op = second < 0 ? rest : rest.slice(0, second);
    const raw = second < 0 ? '' : rest.slice(second + 1);

    // A computed `anysearch(...)` field or a plain column.
    const target = column === 'anysearch' ? `public.anysearch(${alias})` : `${alias}.${ident(column)}`;

    if (op === 'in') {
        const list = parseInList(raw);
        if (list.length === 0) return 'FALSE';
        const placeholders = list.map((value) => bind(params, coerce(value)));
        return `${target} IN (${placeholders.join(', ')})`;
    }
    if (op === 'is') {
        const value = String(raw).toLowerCase();
        if (value === 'null') return `${target} IS NULL`;
        if (value === 'true') return `${target} IS TRUE`;
        if (value === 'false') return `${target} IS FALSE`;
        throw new HttpError(400, `bad is filter: ${raw}`);
    }
    const sqlOp = FILTER_OPS[op];
    if (!sqlOp) throw new HttpError(400, `unsupported filter: ${op}`);
    return `${target} ${sqlOp} ${bind(params, coerce(raw))}`;
}

function buildCondition(raw, params, alias) {
    const text = String(raw).trim();
    // `or=(a.eq.1,b.eq.2)` / `and=(...)` are handled by the caller; here a
    // term may itself be a `not.` prefix, which PostgREST supports.
    if (text.startsWith('not.')) return `NOT (${buildTerm(text.slice(4), params, alias)})`;
    return buildTerm(text, params, alias);
}

function buildWhere(searchParams, params, alias) {
    const clauses = [];
    for (const [key, value] of searchParams.entries()) {
        if (key === 'or' || key === 'and') {
            const inner = splitTopLevel(String(value).replace(/^\(|\)$/g, ''))
                .filter((part) => part.trim() !== '')
                .map((part) => buildCondition(part, params, alias));
            if (inner.length) clauses.push(`(${inner.join(key === 'or' ? ' OR ' : ' AND ')})`);
            continue;
        }
        if (RESERVED.has(key)) continue;
        clauses.push(buildCondition(`${key}.${value}`, params, alias));
    }
    return clauses;
}

function buildOrder(searchParams, alias) {
    const orders = [];
    for (const raw of searchParams.getAll('order')) {
        for (const part of splitTopLevel(raw)) {
            const [column, ...modifiers] = String(part).split('.');
            if (!column) continue;
            const direction = modifiers.includes('desc') ? 'DESC' : 'ASC';
            const nulls = modifiers.find((entry) => entry === 'nullsfirst' || entry === 'nullslast');
            orders.push(`${alias}.${ident(column)} ${direction}${nulls ? ` ${nulls === 'nullsfirst' ? 'NULLS FIRST' : 'NULLS LAST'}` : ''}`);
        }
    }
    return orders;
}

function rangeFromRequest(req, searchParams) {
    const limit = searchParams.get('limit');
    const offset = searchParams.get('offset');
    let from = offset ? Number(offset) : 0;
    let to = null;
    const range = req.headers.range;
    if (range) {
        const match = /(\d+)-(\d*)/.exec(range);
        if (match) {
            from = Number(match[1]);
            to = match[2] ? Number(match[2]) : null;
        }
    }
    let count = to === null ? null : to - from + 1;
    if (limit !== null) count = Math.min(count ?? Number(limit), Number(limit));
    return { from, count };
}

function normalizeRow(row) {
    return row;
}

function wantsObject(req) {
    return String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');
}

function wantsRepresentation(req) {
    return String(req.headers.prefer ?? '').includes('return=representation');
}

function wantsCount(req) {
    return String(req.headers.prefer ?? '').includes('count=exact');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try { resolve(JSON.parse(text)); } catch (error) { reject(new HttpError(400, 'invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function serializeValues(body) {
    const map = (value) => {
        if (value === undefined) return null;
        if (value !== null && typeof value === 'object') return JSON.stringify(value);
        return value;
    };
    if (Array.isArray(body)) return body.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, map(v)])));
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, map(v)]));
}

function respondRows(req, res, rows, { status = 200, total = null, from = 0 } = {}) {
    const headers = {};
    if (total !== null) {
        headers['Content-Range'] = rows.length === 0 ? `*/${total}` : `${from}-${from + rows.length - 1}/${total}`;
    }
    if (wantsObject(req)) {
        if (rows.length !== 1) {
            return jsonBody(res, 406, {
                code: 'PGRST116',
                message: rows.length === 0
                    ? 'The result contains 0 rows'
                    : `The result contains ${rows.length} rows`,
                details: null,
                hint: null,
            });
        }
        return jsonBody(res, status, rows[0], headers);
    }
    if (req.method === 'HEAD') {
        res.writeHead(status, headers);
        res.end();
        return;
    }
    jsonBody(res, status, rows.map(normalizeRow), headers);
}

function tableNameFromPath(pathname) {
    const match = /^\/rest\/v1\/([^/?]+)$/.exec(pathname);
    if (!match) return null;
    return match[1];
}

export async function handleRest(req, res, url, ctx) {
    if (url.pathname === '/rest/v1/' || url.pathname === '/rest/v1') {
        return jsonBody(res, 200, { openapi: 'local-mock' });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice('/rest/v1/rpc/'.length);
        return handleRpc(req, res, name, ctx);
    }
    const table = tableNameFromPath(url.pathname);
    if (!table) return jsonBody(res, 404, { message: 'not found' });
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) return jsonBody(res, 404, { message: 'not found' });

    try {
        if (req.method === 'GET' || req.method === 'HEAD') return await handleSelect(req, res, url, table, ctx);
        if (req.method === 'POST') return await handleInsert(req, res, url, table, ctx);
        if (req.method === 'PATCH') return await handleUpdate(req, res, url, table, ctx);
        if (req.method === 'DELETE') return await handleDelete(req, res, url, table, ctx);
        return jsonBody(res, 405, { message: 'method not allowed' });
    } catch (error) {
        if (error instanceof HttpError) {
            return jsonBody(res, error.status, { code: error.code, message: error.message, details: null, hint: null });
        }
        console.error(`[mock] rest ${req.method} ${url.pathname} failed:`, error?.message ?? error);
        return jsonBody(res, 500, { code: 'XX000', message: String(error?.message ?? error), details: null, hint: null });
    }
}

async function handleSelect(req, res, url, table, ctx) {
    const alias = 't';
    const params = [];
    const where = buildWhere(url.searchParams, params, alias);
    const order = buildOrder(url.searchParams, alias);
    const { from, count } = rangeFromRequest(req, url.searchParams);

    let sql = `SELECT ${alias}.* FROM public.${ident(table)} AS ${alias}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    sql += ` LIMIT ${count === null ? 'ALL' : count} OFFSET ${from}`;

    const result = await withRole(ctx.role, (tx) => tx.query(sql, params), ctx.claims);
    let total = null;
    if (wantsCount(req)) {
        let countSql = `SELECT count(*)::int AS n FROM public.${ident(table)} AS ${alias}`;
        if (where.length) countSql += ` WHERE ${where.join(' AND ')}`;
        const counted = await withRole(ctx.role, (tx) => tx.query(countSql, params), ctx.claims);
        total = counted.rows[0]?.n ?? 0;
    }
    return respondRows(req, res, result.rows, { total, from });
}

async function handleInsert(req, res, url, table, ctx) {
    const body = serializeValues(await readBody(req));
    const rows = Array.isArray(body) ? body : [body];
    if (rows.length === 0) return jsonBody(res, 400, { message: 'empty insert' });

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const params = [];
    const tuples = rows.map((row) => `(${columns.map((column) => bind(params, row[column] ?? null)).join(', ')})`);
    let sql = `INSERT INTO public.${ident(table)} (${columns.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`;

    const prefer = String(req.headers.prefer ?? '');
    const onConflict = url.searchParams.get('on_conflict');
    if (prefer.includes('resolution=merge-duplicates')) {
        const keys = onConflict ? splitTopLevel(onConflict).map((entry) => entry.trim()) : ['id'];
        const updates = columns
            .filter((column) => !keys.includes(column))
            .map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`);
        sql += ` ON CONFLICT (${keys.map(ident).join(', ')}) DO UPDATE SET ${updates.length ? updates.join(', ') : `${ident(keys[0])} = EXCLUDED.${ident(keys[0])}`}`;
    } else if (onConflict) {
        sql += ` ON CONFLICT (${splitTopLevel(onConflict).map((entry) => ident(entry.trim())).join(', ')}) DO NOTHING`;
    }
    if (wantsRepresentation(req)) sql += ' RETURNING *';

    const result = await withRole(ctx.role, (tx) => tx.query(sql, params), ctx.claims);
    return respondRows(req, res, result.rows ?? [], { status: 201 });
}

async function handleUpdate(req, res, url, table, ctx) {
    const body = serializeValues(await readBody(req));
    const alias = 't';
    const params = [];
    const assignments = Object.entries(body).map(([column, value]) => `${ident(column)} = ${bind(params, value)}`);
    if (assignments.length === 0) return jsonBody(res, 400, { message: 'empty update' });

    const where = buildWhere(url.searchParams, params, alias);
    let sql = `UPDATE public.${ident(table)} AS ${alias} SET ${assignments.join(', ')}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (wantsRepresentation(req)) sql += ' RETURNING *';

    const result = await withRole(ctx.role, (tx) => tx.query(sql, params), ctx.claims);
    return respondRows(req, res, result.rows ?? [], { status: 200 });
}

async function handleDelete(req, res, url, table, ctx) {
    const alias = 't';
    const params = [];
    const where = buildWhere(url.searchParams, params, alias);
    let sql = `DELETE FROM public.${ident(table)} AS ${alias}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (wantsRepresentation(req)) sql += ' RETURNING *';

    const result = await withRole(ctx.role, (tx) => tx.query(sql, params), ctx.claims);
    return respondRows(req, res, result.rows ?? [], { status: 200 });
}

async function handleRpc(req, res, name, ctx) {
    if (req.method !== 'POST') return jsonBody(res, 405, { message: 'method not allowed' });
    const body = (await readBody(req)) ?? {};
    try {
        if (name === 'existing_national_ids') {
            const ids = Array.isArray(body.ids) ? body.ids : [];
            const result = await withRole(
                ctx.role,
                (tx) => tx.query('SELECT public.existing_national_ids($1::text[]) AS value', [ids]),
                ctx.claims,
            );
            return jsonBody(res, 200, result.rows[0]?.value ?? []);
        }
        // Generic scalar/table function call with named arguments.
        const keys = Object.keys(body);
        const params = [];
        const args = keys.map((key) => `${ident(key)} => ${bind(params, body[key])}`);
        const result = await withRole(
            ctx.role,
            (tx) => tx.query(`SELECT * FROM public.${ident(name)}(${args.join(', ')})`, params),
            ctx.claims,
        );
        return jsonBody(res, 200, result.rows.map((row) => row.value ?? row));
    } catch (error) {
        console.error(`[mock] rpc ${name} failed:`, error?.message ?? error);
        return jsonBody(res, 400, { code: 'PGRST202', message: String(error?.message ?? error) });
    }
}
