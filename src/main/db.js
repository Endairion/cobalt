'use strict';

const { Pool, Client, types } = require('pg');
const { splitStatements } = require('./sqlsplit');
const { summarize, compare } = require('../shared/stats');
const { isReadOnlyStatement } = require('../shared/sqlkind');

/* ------------------------------------------------------------------ *
 * Type handling
 *
 * The grid is a text editor over a database, so values arrive as the exact
 * text Postgres produced. That keeps numeric/timestamp/json round-trips
 * lossless — JS numbers and Dates would quietly mangle them.
 * ------------------------------------------------------------------ */
const asText = (v) => v;
for (const oid of [
  20,   // int8
  1700, // numeric
  1082, // date
  1114, // timestamp
  1184, // timestamptz
  1083, // time
  1266, // timetz
  1186, // interval
  114,  // json
  3802, // jsonb
  700, 701, // float4/float8
]) types.setTypeParser(oid, asText);
types.setTypeParser(17, (v) => v); // bytea -> \x… text

/* ------------------------------------------------------------------ */

class Session {
  /** A dedicated backend connection: stable temp tables, SET, transactions. */
  constructor(conn, key) {
    this.conn = conn;
    this.key = key;
    this.client = null;
    this.pid = null;
    this.busy = false;
  }

  async ensure() {
    if (this.client) return this.client;
    const client = new Client(this.conn.clientConfig());
    await client.connect();
    const r = await client.query('select pg_backend_pid() as pid');
    this.pid = r.rows[0].pid;
    client.on('error', () => { this.client = null; });
    this.client = client;
    return client;
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) { try { await c.end(); } catch { /* already gone */ } }
  }
}

class Connection {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.pool = null;
    this.sessions = new Map();
    this.serverVersion = null;
    this.currentDatabase = null;
  }

  clientConfig() {
    const c = this.config;
    const cfg = {
      host: c.host || 'localhost',
      port: Number(c.port) || 5432,
      database: c.database || 'postgres',
      user: c.user || undefined,
      password: c.password || undefined,
      application_name: 'Cobalt',
      statement_timeout: 0,
      connectionTimeoutMillis: 15000,
    };
    if (c.ssl && c.ssl !== 'disable') {
      cfg.ssl = c.ssl === 'require' ? { rejectUnauthorized: false } : true;
    }
    return cfg;
  }

  async connect() {
    this.pool = new Pool({ ...this.clientConfig(), max: 4, idleTimeoutMillis: 30000 });
    this.pool.on('error', () => { /* idle client dropped; pool replaces it */ });
    const r = await this.pool.query(
      "select current_database() as db, version() as version, current_setting('server_version') as sv"
    );
    this.currentDatabase = r.rows[0].db;
    this.serverVersion = r.rows[0].sv;
    return { database: this.currentDatabase, serverVersion: this.serverVersion, banner: r.rows[0].version };
  }

  session(key) {
    let s = this.sessions.get(key);
    if (!s) { s = new Session(this, key); this.sessions.set(key, s); }
    return s;
  }

  async closeSession(key) {
    const s = this.sessions.get(key);
    if (s) { this.sessions.delete(key); await s.close(); }
  }

  async close() {
    for (const s of this.sessions.values()) await s.close();
    this.sessions.clear();
    if (this.pool) { try { await this.pool.end(); } catch { /* noop */ } this.pool = null; }
  }

  /** Cancel the statement running on a tab's backend, from a side connection. */
  async cancel(key) {
    const s = this.sessions.get(key);
    if (!s || !s.pid) return false;
    s.cancelRequested = true;          // also stops a benchmark between iterations
    const side = new Client(this.clientConfig());
    await side.connect();
    try {
      await side.query('select pg_cancel_backend($1)', [s.pid]);
      return true;
    } finally { await side.end().catch(() => {}); }
  }
}

/* ------------------------------------------------------------------ *
 * Result metadata: figure out which physical table each column came from,
 * which is what makes the grid editable.
 * ------------------------------------------------------------------ */

const RESULT_META_SQL = `
  select a.attrelid::int as table_oid,
         a.attnum::int   as attnum,
         a.attname       as column_name,
         a.attnotnull    as not_null,
         a.atthasdef     as has_default,
         pg_get_expr(d.adbin, d.adrelid) as default_expr,
         format_type(a.atttypid, a.atttypmod) as data_type,
         c.relname       as table_name,
         c.relkind::text as relkind,
         n.nspname       as schema_name
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped`;

const KEY_SQL = `
  select i.indrelid::int as table_oid,
         i.indkey::int2[] as cols,
         i.indisprimary   as is_primary
  from pg_index i
  where i.indrelid = any($1::oid[])
    and i.indisunique and i.indpred is null and i.indisvalid
  order by i.indisprimary desc`;

async function describeResult(db, fields) {
  const oids = [...new Set(fields.map((f) => f.tableID).filter((x) => x && x > 0))];
  const columns = fields.map((f, idx) => ({
    index: idx,
    name: f.name,
    dataTypeID: f.dataTypeID,
    tableOid: f.tableID || null,
    attnum: f.columnID || null,
    dataType: null,
    sourceColumn: null,
    notNull: false,
    hasDefault: false,
    defaultExpr: null,
  }));
  if (!oids.length) return { columns, source: null, editable: false, reason: 'Result is not backed by a table.' };

  const [meta, keys] = await Promise.all([
    db.query(RESULT_META_SQL, [oids]),
    db.query(KEY_SQL, [oids]),
  ]);

  const byAttr = new Map();
  const tables = new Map();
  for (const r of meta.rows) {
    byAttr.set(`${r.table_oid}:${r.attnum}`, r);
    if (!tables.has(r.table_oid)) {
      tables.set(r.table_oid, { oid: r.table_oid, schema: r.schema_name, table: r.table_name, relkind: r.relkind });
    }
  }
  for (const c of columns) {
    const m = c.tableOid && c.attnum ? byAttr.get(`${c.tableOid}:${c.attnum}`) : null;
    if (!m) continue;
    c.dataType = m.data_type;
    c.sourceColumn = m.column_name;
    c.notNull = m.not_null;
    c.hasDefault = m.has_default;
    c.defaultExpr = m.default_expr;
  }

  // Editing needs exactly one base table behind the result.
  const distinct = [...tables.values()];
  if (distinct.length !== 1) {
    return { columns, source: null, editable: false, reason: 'Result joins more than one table.' };
  }
  const src = distinct[0];
  if (src.relkind !== 'r' && src.relkind !== 'p') {
    return { columns, source: src, editable: false, reason: 'Source is a view, not a table.' };
  }

  // Pick the first unique key (PK preferred) fully present in the result.
  let keyColumns = null;
  for (const k of keys.rows.filter((r) => r.table_oid === src.oid)) {
    const attnums = (k.cols || []).map(Number).filter((x) => x > 0);
    if (!attnums.length) continue;
    const mapped = attnums.map((an) => columns.find((c) => c.tableOid === src.oid && c.attnum === an));
    if (mapped.every(Boolean)) { keyColumns = mapped.map((c) => c.index); break; }
  }
  if (!keyColumns) {
    return { columns, source: src, editable: false, reason: 'No primary or unique key in the result — select the key columns to edit rows.' };
  }
  return { columns, source: src, key: keyColumns, editable: true, reason: null };
}

/* ------------------------------------------------------------------ */

const qid = (s) => '"' + String(s).replace(/"/g, '""') + '"';
// Display-only: leave already-safe identifiers bare so generated DDL reads naturally.
const RESERVED = new Set(['user','order','table','select','from','where','group','default','check','column','constraint','index','primary','references','unique','all','and','any','array','as','case','cast','desc','asc','limit','offset','union','using','when','with']);
const qidNice = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : qid(s));
const qnameNice = (schema, table) => `${qidNice(schema)}.${qidNice(table)}`;
const qname = (schema, table) => `${qid(schema)}.${qid(table)}`;

/* ------------------------------------------------------------------ *
 * Column filters
 * ------------------------------------------------------------------ */

/** Operators the renderer may ask for. Anything else is rejected outright. */
const FILTER_OPS = new Map([
  ['=', '='], ['!=', '<>'], ['<>', '<>'],
  ['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>='],
  ['like', 'like'], ['ilike', 'ilike'], ['not like', 'not like'], ['not ilike', 'not ilike'],
  ['~', '~'], ['~*', '~*'], ['!~', '!~'], ['!~*', '!~*'],
  ['in', 'in'], ['not in', 'not in'],
  ['is null', 'is null'], ['is not null', 'is not null'],
]);

// Pattern and regex operators only exist for text, so cast the column first —
// that is what lets you filter a timestamp or jsonb column by substring.
const TEXT_OPS = new Set(['like', 'ilike', 'not like', 'not ilike', '~', '~*', '!~', '!~*']);
const NO_VALUE_OPS = new Set(['is null', 'is not null']);

/**
 * Peel a trailing LIMIT/OFFSET off a statement so it can be re-applied outside
 * the filter. Returns { inner, tail }.
 */
function splitLimitTail(sql) {
  const s = sql.trim().replace(/;+\s*$/, '');
  let m = /\s+limit\s+(\d+)(?:\s+offset\s+(\d+))?\s*$/i.exec(s);
  if (m) return { inner: s.slice(0, m.index), tail: ` limit ${m[1]}${m[2] ? ` offset ${m[2]}` : ''}` };
  m = /\s+offset\s+(\d+)(?:\s+limit\s+(\d+))?\s*$/i.exec(s);
  if (m) return { inner: s.slice(0, m.index), tail: ` offset ${m[1]}${m[2] ? ` limit ${m[2]}` : ''}` };
  return { inner: s, tail: '' };
}

/** Filter conditions, appending bound values to `values`. */
function buildFilterConds(filters, values) {
  const conds = [];
  for (const f of filters || []) {
    const op = FILTER_OPS.get(String(f.op || '').toLowerCase().replace(/\s+/g, ' ').trim());
    if (!op) throw new Error(`Unsupported filter operator: ${f.op}`);
    if (!f.name) throw new Error('Filter is missing a column name.');
    const col = TEXT_OPS.has(op) ? `${qid(f.name)}::text` : qid(f.name);

    if (NO_VALUE_OPS.has(op)) { conds.push(`${col} ${op}`); continue; }

    if (op === 'in' || op === 'not in') {
      const list = Array.isArray(f.values) ? f.values : [f.value];
      if (!list.length) throw new Error(`The ${op.toUpperCase()} filter on "${f.name}" needs at least one value.`);
      const ph = list.map((v) => { values.push(v); return `$${values.length}`; });
      conds.push(`${col} ${op} (${ph.join(', ')})`);
      continue;
    }

    values.push(f.value);
    conds.push(`${col} ${op} $${values.length}`);
  }
  return conds;
}

/** Pull the numbers out of a trailing LIMIT/OFFSET so paging can work within them. */
function parseLimitTail(baseSql) {
  const { inner, tail } = splitLimitTail(baseSql);
  const lim = /limit\s+(\d+)/i.exec(tail);
  const off = /offset\s+(\d+)/i.exec(tail);
  return {
    inner,
    baseLimit: lim ? Number(lim[1]) : null,
    baseOffset: off ? Number(off[1]) : 0,
  };
}

const orderClause = (sort) => sort.map((s) =>
  `${qid(s.name)} ${String(s.dir).toLowerCase() === 'desc' ? 'desc' : 'asc'}`).join(', ');

/**
 * One page of a query, with filters and sorting pushed down to the server.
 *
 * `after` asks for keyset paging — `where (a, b) > ($1, $2)` — which stays fast
 * however deep you go, unlike OFFSET which makes the server walk and discard
 * every row before the page. It only works when every sort direction matches
 * (a row constructor comparison has one direction) so the caller decides, and
 * anything else falls back to OFFSET.
 */
function buildPagedQuery(baseSql, {
  filters = [], sort = [], limit = null, offset = 0, after = null,
} = {}) {
  const { inner, baseLimit, baseOffset } = parseLimitTail(baseSql);
  const values = [];
  const conds = buildFilterConds(filters, values);
  let strategy = 'offset';

  if (after && after.length && sort.length === after.length) {
    const dirs = new Set(sort.map((x) => String(x.dir).toLowerCase() === 'desc' ? 'desc' : 'asc'));
    if (dirs.size === 1 && baseLimit == null) {
      const cols = sort.map((x) => qid(x.name)).join(', ');
      const ph = after.map((v) => { values.push(v); return `$${values.length}`; });
      conds.push(`(${cols}) ${dirs.has('desc') ? '<' : '>'} (${ph.join(', ')})`);
      strategy = 'keyset';
    }
  }

  const where = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
  const order = sort.length ? `\norder by ${orderClause(sort)}` : '';

  // The caller's own LIMIT caps the whole set; a page is served from inside it.
  let pageLimit = limit;
  let pageOffset = strategy === 'keyset' ? 0 : offset;
  if (baseLimit != null) {
    const remaining = Math.max(0, baseLimit - offset);
    pageLimit = limit == null ? remaining : Math.min(limit, remaining);
  }
  if (baseOffset) pageOffset += baseOffset;

  const tail = pageLimit == null ? ''
    : `\nlimit ${Math.max(0, Math.floor(pageLimit))}${pageOffset ? ` offset ${Math.floor(pageOffset)}` : ''}`;

  return {
    text: `select * from (\n${inner}\n) as ${qid('_cobalt')}${where}${order}${tail}`,
    values,
    strategy,
    baseLimit,
  };
}

/** Kept for callers that only filter. */
function buildFilteredQuery(baseSql, filters = []) {
  const { inner, tail } = splitLimitTail(baseSql);
  const values = [];
  const conds = buildFilterConds(filters, values);
  const where = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
  return { text: `select * from (\n${inner}\n) as ${qid('_cobalt')}${where}${tail}`, values };
}

function shapeError(err, statement) {
  return {
    message: err.message || String(err),
    code: err.code || null,
    detail: err.detail || null,
    hint: err.hint || null,
    position: err.position ? Number(err.position) : null,
    where: err.where || null,
    statement,
  };
}


/* ------------------------------------------------------------------ *
 * Performance tools
 * ------------------------------------------------------------------ */



/**
 * EXPLAIN (FORMAT JSON) returns a json column, and this module deliberately
 * hands json back as raw text so values round-trip losslessly — which means the
 * plan arrives as a string and has to be parsed here.
 */
function parseExplainPayload(row) {
  const raw = row['QUERY PLAN'];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr[0] : arr;
}


class Benchmark {
  constructor(manager, conn, session, client) {
    this.manager = manager;
    this.conn = conn;
    this.session = session;
    this.client = client;
  }

  /** One timed execution. Writes go inside a transaction that is rolled back. */
  async once(sql, rollback) {
    if (rollback) await this.client.query('begin');
    const t0 = process.hrtime.bigint();
    let rowCount = null;
    try {
      const r = await this.client.query({ text: sql, rowMode: 'array' });
      rowCount = Array.isArray(r) ? r[r.length - 1].rowCount : r.rowCount;
      const list = Array.isArray(r) ? r : [r];
      const last = list[list.length - 1];
      if (last && Array.isArray(last.rows)) rowCount = last.rows.length || last.rowCount;
    } finally {
      if (rollback) { try { await this.client.query('rollback'); } catch { /* gone */ } }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, rowCount };
  }

  /** Server-side planning/execution split, measured once per variant. */
  async plan(sql, rollback) {
    const text = `explain (analyze, buffers, format json) ${sql}`;
    if (rollback) await this.client.query('begin');
    try {
      const r = await this.client.query(text);
      const root = parseExplainPayload(r.rows[0]);
      return {
        planningMs: root['Planning Time'] ?? null,
        executionMs: root['Execution Time'] ?? null,
        plan: root.Plan,
      };
    } catch {
      return null;
    } finally {
      if (rollback) { try { await this.client.query('rollback'); } catch { /* gone */ } }
    }
  }
}

/* ------------------------------------------------------------------ */

class Manager {
  constructor() {
    this.connections = new Map();
    this.seq = 0;
  }

  get(id) {
    const c = this.connections.get(id);
    if (!c) throw new Error('Not connected.');
    return c;
  }

  async open(config) {
    const id = `c${++this.seq}`;
    const conn = new Connection(id, config);
    try {
      const info = await conn.connect();
      this.connections.set(id, conn);
      return { id, ...info };
    } catch (e) {
      await conn.close();
      throw e;
    }
  }

  async close(id) {
    const c = this.connections.get(id);
    if (!c) return;
    this.connections.delete(id);
    await c.close();
  }

  async closeAll() {
    const ids = [...this.connections.keys()];
    for (const id of ids) await this.close(id);
  }

  /**
   * Run a script on a tab's dedicated session. Returns one entry per statement;
   * stops at the first error and reports it against that statement.
   */
  async run(id, tabKey, sql, { maxRows = 10000 } = {}) {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.busy = true;

    const statements = splitStatements(sql);
    const results = [];
    try {
      for (const st of statements) {
        const began = Date.now();
        let res;
        try {
          res = await client.query({ text: st.sql, rowMode: 'array' });
        } catch (err) {
          results.push({
            sql: st.sql, start: st.start, end: st.end,
            error: shapeError(err, st.sql), elapsedMs: Date.now() - began,
          });
          break;
        }
        const list = Array.isArray(res) ? res : [res];
        for (const r of list) {
          results.push(await this.shape(conn, r, {
            sql: st.sql, start: st.start, end: st.end, elapsedMs: Date.now() - began, maxRows,
          }));
        }
      }
      return { results };
    } finally {
      session.busy = false;
    }
  }

  /** Turn one pg result into the shape the renderer's grid consumes. */
  async shape(conn, r, { sql, start = 0, end = 0, elapsedMs, maxRows }) {
    const hasRows = Array.isArray(r.fields) && r.fields.length > 0;
    let meta = null;
    if (hasRows) {
      try { meta = await describeResult(conn.pool, r.fields); }
      catch { meta = null; }
    }
    const rows = hasRows ? r.rows.slice(0, maxRows) : [];
    return {
      sql, start, end,
      command: r.command,
      rowCount: r.rowCount,
      elapsedMs,
      truncated: hasRows && r.rows.length > maxRows,
      columns: meta ? meta.columns : (r.fields || []).map((f, i) => ({ index: i, name: f.name, dataTypeID: f.dataTypeID })),
      rows,
      source: meta ? meta.source : null,
      key: meta ? meta.key : null,
      editable: meta ? meta.editable : false,
      notEditableReason: meta ? meta.reason : 'No result metadata.',
    };
  }

  /**
   * Re-run a SELECT with column filters applied.
   *
   * The base query is wrapped in a subquery and the filter goes on the outside,
   * with any trailing LIMIT/OFFSET hoisted out past it — so the filter runs
   * against the whole table, not just the page that was already loaded.
   * Postgres propagates each column's origin table through the wrapper, so the
   * filtered result stays editable.
   */
  async runFiltered(id, tabKey, baseSql, filters, { maxRows = 10000 } = {}) {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.busy = true;
    const began = Date.now();
    const { text, values } = buildFilteredQuery(baseSql, filters);
    try {
      let r;
      try {
        r = await client.query({ text, values, rowMode: 'array' });
      } catch (err) {
        return { results: [{ sql: text, baseSql, error: shapeError(err, text), elapsedMs: Date.now() - began }] };
      }
      const shaped = await this.shape(conn, r, { sql: text, elapsedMs: Date.now() - began, maxRows });
      return { results: [{ ...shaped, baseSql, filtered: filters.length > 0 }] };
    } finally {
      session.busy = false;
    }
  }


  /**
   * Time several query variants against each other.
   *
   * Runs are interleaved (A, B, C, A, B, C, ...) rather than grouped, so a
   * slow patch on the machine hits every variant roughly equally instead of
   * landing entirely on whichever one happened to go first. Warmup runs are
   * discarded, which keeps the first-read-from-disk cost out of the numbers.
   */
  async benchmark(id, tabKey, variants, {
    runs = 10, warmups = 2, rollback = false, collectPlans = true, onProgress = null,
  } = {}) {
    if (!Array.isArray(variants) || !variants.length) throw new Error('Nothing to benchmark.');
    runs = Math.max(1, Math.min(500, Number(runs) || 10));
    warmups = Math.max(0, Math.min(50, Number(warmups) || 0));

    const writes = variants.filter((v) => !isReadOnlyStatement(v.sql));
    if (writes.length && !rollback) {
      throw new Error(
        `${writes.length === 1 ? 'One statement writes' : `${writes.length} statements write`} to the database. ` +
        'Benchmarking would apply it repeatedly — enable "roll back each run" to measure it safely.'
      );
    }

    const conn = this.get(id);
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.busy = true;
    session.cancelRequested = false;

    const bench = new Benchmark(this, conn, session, client);
    const state = variants.map((v, i) => ({
      label: v.label || String.fromCharCode(65 + i),
      sql: v.sql,
      readOnly: isReadOnlyStatement(v.sql),
      samples: [],
      rowCount: null,
      error: null,
      plan: null,
    }));

    const began = Date.now();
    let cancelled = false;
    const report = (phase, done, total) => {
      if (onProgress) { try { onProgress({ phase, done, total }); } catch { /* best effort */ } }
    };

    try {
      const totalSteps = (warmups + runs) * state.length;
      let step = 0;

      for (let w = 0; w < warmups && !cancelled; w++) {
        for (const v of state) {
          if (v.error || session.cancelRequested) continue;
          try { await bench.once(v.sql, rollback); }
          catch (err) { v.error = shapeError(err, v.sql); }
          report('warmup', ++step, totalSteps);
        }
      }

      for (let i = 0; i < runs && !cancelled; i++) {
        for (const v of state) {
          if (session.cancelRequested) { cancelled = true; break; }
          if (v.error) { step++; continue; }
          try {
            const { ms, rowCount } = await bench.once(v.sql, rollback);
            v.samples.push(ms);
            v.rowCount = rowCount;
          } catch (err) {
            v.error = shapeError(err, v.sql);
          }
          report('measure', ++step, totalSteps);
        }
      }

      if (collectPlans && !cancelled) {
        for (const v of state) {
          if (v.error || !v.samples.length) continue;
          v.plan = await bench.plan(v.sql, rollback);
        }
      }
    } finally {
      session.busy = false;
      session.cancelRequested = false;
    }

    const measured = state.map((v) => ({ ...v, stats: summarize(v.samples) }));
    return {
      kind: 'benchmark',
      variants: measured,
      comparison: compare(measured),
      opts: { runs, warmups, rollback, collectPlans },
      cancelled,
      elapsedMs: Date.now() - began,
    };
  }

  /**
   * EXPLAIN, optionally ANALYZE. Analyzing a write actually performs it, so
   * those are wrapped in a transaction and rolled back.
   */
  async explain(id, tabKey, sql, { analyze = false } = {}) {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.busy = true;

    const readOnly = isReadOnlyStatement(sql);
    const rollback = analyze && !readOnly;
    const opts = ['format json', 'verbose', 'costs'];
    if (analyze) opts.unshift('analyze', 'buffers');
    const text = `explain (${opts.join(', ')}) ${sql}`;
    const began = Date.now();

    try {
      if (rollback) await client.query('begin');
      let r;
      try {
        r = await client.query(text);
      } finally {
        if (rollback) { try { await client.query('rollback'); } catch { /* gone */ } }
      }
      const root = parseExplainPayload(r.rows[0]);
      return {
        kind: 'plan',
        sql,
        analyze,
        rolledBack: rollback,
        planningMs: root['Planning Time'] ?? null,
        executionMs: root['Execution Time'] ?? null,
        triggers: root['Triggers'] || [],
        plan: root.Plan,
        elapsedMs: Date.now() - began,
      };
    } catch (err) {
      return { kind: 'plan', sql, analyze, error: shapeError(err, text), elapsedMs: Date.now() - began };
    } finally {
      session.busy = false;
    }
  }


  /**
   * Column metadata without running the query, so the first page can already
   * carry a stable order. `limit 0` stops the Limit node before it pulls a
   * single row from its child, so this costs a plan and nothing else.
   */
  async probeColumns(conn, client, baseSql) {
    const { inner } = parseLimitTail(baseSql);
    const r = await client.query({ text: `select * from (\n${inner}\n) as ${qid('_cobalt')} limit 0`, rowMode: 'array' });
    return describeResult(conn.pool, r.fields || []);
  }

  /**
   * One page of a result, with filters and sort applied by the server.
   *
   * Paging without a total order silently drops and repeats rows wherever the
   * sort has ties, so when the result carries a unique key that key is appended
   * to the sort as a tiebreaker. That also makes keyset paging safe, since the
   * comparison then addresses exactly one row.
   */
  async runPaged(id, tabKey, baseSql, {
    filters = [], sort = [], limit = 500, offset = 0, after = null, maxRows = 20000,
  } = {}) {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.busy = true;
    const began = Date.now();
    limit = Math.max(1, Math.min(maxRows, Number(limit) || 500));

    try {
      let meta = null;
      try { meta = await this.probeColumns(conn, client, baseSql); }
      catch { meta = null; }

      // Append the unique key so the order is total and pages cannot overlap.
      const byName = new Map();
      for (const c of (meta ? meta.columns : [])) {
        byName.set(c.name, (byName.get(c.name) || 0) + 1);
      }
      const keyNames = meta && meta.key
        ? meta.key.map((i) => meta.columns[i].name).filter((n) => byName.get(n) === 1)
        : [];
      const effectiveSort = [...sort];
      const sorted = new Set(sort.map((x) => x.name));
      const tieDir = sort.length ? sort[sort.length - 1].dir : 'asc';
      for (const n of keyNames) if (!sorted.has(n)) effectiveSort.push({ name: n, dir: tieDir });

      // Keyset needs every sort column non-nullable: a NULL inside a row
      // constructor comparison yields NULL, which silently drops rows.
      const colByName = new Map((meta ? meta.columns : []).map((c) => [c.name, c]));
      const keysetSafe = effectiveSort.length > 0
        && keyNames.length > 0
        && effectiveSort.every((x) => {
          const c = colByName.get(x.name);
          return c && c.notNull && byName.get(x.name) === 1;
        })
        && new Set(effectiveSort.map((x) => String(x.dir).toLowerCase())).size === 1;

      const built = buildPagedQuery(baseSql, {
        filters,
        sort: effectiveSort,
        limit: limit + 1,                      // one extra row answers "is there more?"
        offset,
        after: keysetSafe ? after : null,
      });

      let r;
      try {
        r = await client.query({ text: built.text, values: built.values, rowMode: 'array' });
      } catch (err) {
        return { results: [{ sql: built.text, baseSql, error: shapeError(err, built.text), elapsedMs: Date.now() - began }] };
      }

      const hasMore = r.rows.length > limit;
      if (hasMore) r.rows.length = limit;

      const shaped = await this.shape(conn, r, { sql: built.text, elapsedMs: Date.now() - began, maxRows: limit });
      shaped.truncated = false;                // paging replaces the old hard cap

      // Values the next keyset page starts after.
      let nextAfter = null;
      if (keysetSafe && hasMore && r.rows.length) {
        const last = r.rows[r.rows.length - 1];
        const idx = effectiveSort.map((x) => shaped.columns.findIndex((c) => c.name === x.name));
        if (idx.every((i) => i >= 0)) nextAfter = idx.map((i) => last[i]);
      }

      return {
        results: [{
          ...shaped,
          baseSql,
          filtered: filters.length > 0,
          page: {
            limit,
            offset,
            hasMore,
            strategy: built.strategy,
            sort,
            effectiveSort,
            tiebreak: keyNames,
            keysetSafe,
            nextAfter,
            baseLimit: built.baseLimit,
            rows: r.rows.length,
          },
        }],
      };
    } finally {
      session.busy = false;
    }
  }

  /** Exact row count for the current query and filters. Can be slow, so it is asked for. */
  async countRows(id, tabKey, baseSql, filters = []) {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    const client = await session.ensure();
    const { inner, baseLimit, baseOffset } = parseLimitTail(baseSql);
    const values = [];
    const conds = buildFilterConds(filters, values);
    const where = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
    // A caller-supplied LIMIT bounds the count too, so honour it.
    const bounded = baseLimit == null
      ? `select * from (\n${inner}\n) as ${qid('_cobalt')}${where}`
      : `select * from (\n${inner}\n) as ${qid('_cobalt')}${where} limit ${baseLimit}${baseOffset ? ` offset ${baseOffset}` : ''}`;
    const began = Date.now();
    const r = await client.query({ text: `select count(*)::bigint as n from (\n${bounded}\n) as ${qid('_cobalt_count')}`, values });
    return { count: Number(r.rows[0].n), elapsedMs: Date.now() - began };
  }

  async cancel(id, tabKey) {
    return this.get(id).cancel(tabKey);
  }

  async releaseTab(id, tabKey) {
    const c = this.connections.get(id);
    if (c) await c.closeSession(tabKey);
  }

  /**
   * Apply grid edits inside one transaction.
   * changes: { source:{schema,table}, columns:[…], key:[idx…],
   *            updates:[{ keyValues:[…], set:{ colIndex: value } }],
   *            inserts:[{ values:{ colIndex: value } }],
   *            deletes:[{ keyValues:[…] }] }
   */
  async applyChanges(id, change) {
    const conn = this.get(id);
    // Enforced here, not just in the UI: a connection the user marked read-only
    // must refuse writes even if the renderer asks for them.
    if (conn.config && conn.config.readOnly) {
      throw new Error(`Connection "${conn.config.name || conn.id}" is marked read-only — no changes were applied.`);
    }
    const client = await conn.pool.connect();
    const { source, columns, key } = change;
    const rel = qname(source.schema, source.table);
    const keyNames = key.map((i) => columns[i].sourceColumn || columns[i].name);
    const applied = { updated: 0, inserted: 0, deleted: 0, returnedRows: [] };

    const whereClause = (offset) =>
      keyNames.map((nme, i) => `${qid(nme)} is not distinct from $${offset + i + 1}`).join(' and ');

    try {
      await client.query('begin');

      for (const del of change.deletes || []) {
        const sql = `delete from ${rel} where ${whereClause(0)}`;
        const r = await client.query(sql, del.keyValues);
        if (r.rowCount !== 1) throw new Error(`Delete matched ${r.rowCount} rows, expected 1. Rolled back.`);
        applied.deleted += r.rowCount;
      }

      for (const up of change.updates || []) {
        const entries = Object.entries(up.set);
        if (!entries.length) continue;
        const sets = entries.map(([idx], i) => `${qid(columns[idx].sourceColumn || columns[idx].name)} = $${i + 1}`);
        const params = entries.map(([, v]) => v);
        const sql = `update ${rel} set ${sets.join(', ')} where ${whereClause(params.length)} returning *`;
        const r = await client.query(sql, [...params, ...up.keyValues]);
        if (r.rowCount !== 1) throw new Error(`Update matched ${r.rowCount} rows, expected 1. Rolled back.`);
        applied.updated += r.rowCount;
      }

      for (const ins of change.inserts || []) {
        const entries = Object.entries(ins.values);
        let sql;
        let params = [];
        if (!entries.length) {
          sql = `insert into ${rel} default values returning *`;
        } else {
          const cols = entries.map(([idx]) => qid(columns[idx].sourceColumn || columns[idx].name));
          params = entries.map(([, v]) => v);
          const ph = params.map((_, i) => `$${i + 1}`);
          sql = `insert into ${rel} (${cols.join(', ')}) values (${ph.join(', ')}) returning *`;
        }
        const r = await client.query(sql, params);
        applied.inserted += r.rowCount;
      }

      await client.query('commit');
      return applied;
    } catch (err) {
      try { await client.query('rollback'); } catch { /* connection may be gone */ }
      throw Object.assign(new Error(err.message), { pgError: shapeError(err, null) });
    } finally {
      client.release();
    }
  }

  /* ---------------- introspection ---------------- */

  async schemaTree(id) {
    const conn = this.get(id);
    const rels = await conn.pool.query(`
      select n.nspname as schema,
             c.relname as name,
             c.relkind::text as kind,
             c.oid::int as oid,
             coalesce(c.reltuples, 0)::bigint::text as est_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p','v','m','f')
        and n.nspname not in ('pg_catalog','information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, c.relname`);

    const cols = await conn.pool.query(`
      select n.nspname as schema, c.relname as table, a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             a.attnum::int as attnum, a.attnotnull as not_null,
             coalesce(bool_or(i.indisprimary), false) as is_pk
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_index i on i.indrelid = c.oid and a.attnum = any(i.indkey) and i.indisprimary
      where a.attnum > 0 and not a.attisdropped
        and c.relkind in ('r','p','v','m','f')
        and n.nspname not in ('pg_catalog','information_schema')
        and n.nspname not like 'pg_toast%'
      group by 1,2,3,4,5,6
      order by 1, 2, 5`);

    const dbs = await conn.pool.query(
      `select datname from pg_database where datallowconn and not datistemplate order by datname`
    );

    const byTable = new Map();
    for (const c of cols.rows) {
      const k = `${c.schema}.${c.table}`;
      if (!byTable.has(k)) byTable.set(k, []);
      byTable.get(k).push({ name: c.name, type: c.type, attnum: c.attnum, notNull: c.not_null, isPk: c.is_pk });
    }

    const schemas = new Map();
    for (const r of rels.rows) {
      if (!schemas.has(r.schema)) schemas.set(r.schema, []);
      schemas.get(r.schema).push({
        name: r.name, kind: r.kind, oid: r.oid, estRows: Number(r.est_rows),
        columns: byTable.get(`${r.schema}.${r.name}`) || [],
      });
    }
    return {
      database: conn.currentDatabase,
      serverVersion: conn.serverVersion,
      databases: dbs.rows.map((d) => d.datname),
      schemas: [...schemas.entries()].map(([name, relations]) => ({ name, relations })),
    };
  }

  async tableDdl(id, schema, table) {
    const conn = this.get(id);
    const { rows } = await conn.pool.query(
      `select c.oid::int as oid, c.relkind::text as kind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`, [schema, table]);
    if (!rows.length) throw new Error('Relation not found.');
    const { oid, kind } = rows[0];

    if (kind === 'v' || kind === 'm') {
      const v = await conn.pool.query('select pg_get_viewdef($1::oid, true) as def', [oid]);
      const word = kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW';
      return `CREATE OR REPLACE ${word} ${qnameNice(schema, table)} AS\n${v.rows[0].def}`;
    }

    const cols = await conn.pool.query(`
      select a.attname, format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null,
             pg_get_expr(d.adbin, d.adrelid) as def,
             a.attidentity::text as identity
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`, [oid]);

    const cons = await conn.pool.query(
      `select conname, pg_get_constraintdef(oid, true) as def from pg_constraint
       where conrelid = $1 order by contype desc, conname`, [oid]);

    const idx = await conn.pool.query(
      `select indexdef from pg_indexes where schemaname = $1 and tablename = $2`, [schema, table]);

    const lines = cols.rows.map((c) => {
      let s = `  ${qidNice(c.attname)} ${c.type}`;
      if (c.identity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
      else if (c.identity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (c.def) s += ` DEFAULT ${c.def}`;
      if (c.not_null) s += ' NOT NULL';
      return s;
    });
    for (const c of cons.rows) lines.push(`  CONSTRAINT ${qidNice(c.conname)} ${c.def}`);

    let ddl = `CREATE TABLE ${qnameNice(schema, table)} (\n${lines.join(',\n')}\n);`;
    // Drop index definitions that a constraint above already covers.
    const conNames = new Set(cons.rows.map((c) => c.conname));
    const extraIdx = idx.rows.map((r) => r.indexdef).filter((d) => {
      const m = /^CREATE (?:UNIQUE )?INDEX ("(?:[^"]|"")+"|[^\s]+) ON /.exec(d);
      const name = m ? m[1].replace(/^"|"$/g, '').replace(/""/g, '"') : null;
      return !name || !conNames.has(name);
    });
    if (extraIdx.length) ddl += '\n\n' + extraIdx.map((d) => d + ';').join('\n');
    return ddl;
  }

  async tableStats(id, schema, table) {
    const conn = this.get(id);
    const { rows } = await conn.pool.query(
      `select pg_size_pretty(pg_total_relation_size($1::regclass)) as total_size,
              (select count(*) from pg_indexes where schemaname = $2 and tablename = $3) as index_count`,
      [`${qid(schema)}.${qid(table)}`, schema, table]
    );
    return rows[0];
  }
}

module.exports = {
  Manager, qid, qname, buildFilteredQuery, buildPagedQuery, parseLimitTail,
  splitLimitTail, FILTER_OPS, isReadOnlyStatement,
};
