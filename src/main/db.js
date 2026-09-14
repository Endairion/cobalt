const { splitStatements } = require('./sqlsplit');
const { summarize, compare } = require('../shared/stats');
const { isReadOnlyStatement } = require('../shared/sqlkind');
const { validateWhere } = require('../shared/whereclause');
const { Tunnel } = require('./tunnel');
const { driverFor } = require('./drivers');
const { buildSearchQuery, buildRowFilter, searchableColumns } = require('../shared/dbsearch');
const postgres = require('./drivers/postgres');

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
    const { client, pid } = await this.conn.driver.openSession(this.conn.clientConfig());
    this.pid = pid;
    client.on('error', () => { this.client = null; });
    this.client = client;
    return client;
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) await this.conn.driver.closeSession(c);
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
    this.tunnel = null;
    this.endpoint = null;   // where the driver actually dials, tunnel or not
    this.driver = driverFor(config.engine);
  }

  /** With a tunnel up, everything dials its local end — pool, sessions, cancel. */
  clientConfig() {
    return this.driver.clientConfig(this.config, this.endpoint);
  }

  /** Bring up the SSH tunnel, if this connection goes through one. */
  async openTunnel() {
    const ssh = this.config.ssh;
    if (!ssh || !ssh.enabled) return;
    this.tunnel = new Tunnel(ssh);
    this.endpoint = await this.tunnel.open({
      host: this.config.host || 'localhost',
      port: Number(this.config.port) || this.driver.defaultPort,
    });
  }

  async connect() {
    await this.openTunnel();
    this.pool = this.driver.createPool(this.clientConfig());
    let hello;
    try {
      hello = await this.driver.hello(this.pool);
    } catch (err) {
      // Through a tunnel, a driver-level failure is usually the tunnel's fault
      // and its message says nothing useful about why.
      const why = this.tunnel && this.tunnel.reason();
      if (why) { const e = new Error(`${why} (connecting to ${this.config.host}:${this.config.port} through ${this.tunnel.describe()})`); e.cause = err; throw e; }
      throw err;
    }
    this.currentDatabase = hello.database;
    this.serverVersion = hello.serverVersion;
    return { database: this.currentDatabase, serverVersion: this.serverVersion, banner: hello.banner };
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
    // The tunnel goes last: the pool's sockets run through it.
    if (this.tunnel) { await this.tunnel.close(); this.tunnel = null; this.endpoint = null; }
  }

  /** Cancel the statement running on a tab's backend, from a side connection. */
  async cancel(key) {
    const s = this.sessions.get(key);
    if (!s || !s.pid) return false;
    s.cancelRequested = true;          // also stops a benchmark between iterations
    return this.driver.cancel(this.clientConfig(), s.pid);
  }
}

/**
 * The engine-specific scraps the query builders below need. They default to
 * Postgres, which is what every caller wanted before there was a choice.
 */
const dialectOf = (d) => (d && d.quote ? d : postgres);

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
function buildFilterConds(filters, values, dialect) {
  const d = dialectOf(dialect);
  const conds = [];
  for (const f of filters || []) {
    const raw = FILTER_OPS.get(String(f.op || '').toLowerCase().replace(/\s+/g, ' ').trim());
    if (!raw) throw new Error(`Unsupported filter operator: ${f.op}`);
    if (!f.name) throw new Error('Filter is missing a column name.');
    const op = d.mapOperator(raw);
    const col = TEXT_OPS.has(raw) ? d.textCast(d.quote(f.name)) : d.quote(f.name);

    if (NO_VALUE_OPS.has(raw)) { conds.push(`${col} ${op}`); continue; }

    if (raw === 'in' || raw === 'not in') {
      const list = Array.isArray(f.values) ? f.values : [f.value];
      if (!list.length) throw new Error(`The ${op.toUpperCase()} filter on "${f.name}" needs at least one value.`);
      const ph = list.map((v) => { values.push(v); return d.placeholder(values.length); });
      conds.push(`${col} ${op} (${ph.join(', ')})`);
      continue;
    }

    values.push(f.value);
    conds.push(`${col} ${op} ${d.placeholder(values.length)}`);
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

const orderClause = (sort, d) => sort.map((s) =>
  `${d.quote(s.name)} ${String(s.dir).toLowerCase() === 'desc' ? 'desc' : 'asc'}`).join(', ');

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
  filters = [], where = '', sort = [], limit = null, offset = 0, after = null, dialect = null,
} = {}) {
  const d = dialectOf(dialect);
  const { inner, baseLimit, baseOffset } = parseLimitTail(baseSql);
  const values = [];
  const conds = buildFilterConds(filters, values, d);

  // A hand-written condition, checked for anything that would escape the wrapper.
  if (String(where || '').trim()) {
    const v = validateWhere(where);
    if (!v.ok) throw new Error(v.error);
    conds.push(`(${String(where).trim()})`);
  }
  let strategy = 'offset';

  if (after && after.length && sort.length === after.length) {
    const dirs = new Set(sort.map((x) => String(x.dir).toLowerCase() === 'desc' ? 'desc' : 'asc'));
    if (dirs.size === 1 && baseLimit == null && d.keysetPaging) {
      const cols = sort.map((x) => d.quote(x.name)).join(', ');
      const ph = after.map((v) => { values.push(v); return d.placeholder(values.length); });
      conds.push(`(${cols}) ${dirs.has('desc') ? '<' : '>'} (${ph.join(', ')})`);
      strategy = 'keyset';
    }
  }

  const whereSql = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
  const order = sort.length ? `\norder by ${orderClause(sort, d)}` : '';

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
    text: `select * from (\n${inner}\n) as ${d.quote('_cobalt')}${whereSql}${order}${tail}`,
    values,
    strategy,
    baseLimit,
  };
}

/** Kept for callers that only filter. */
function buildFilteredQuery(baseSql, filters = [], dialect = null) {
  const d = dialectOf(dialect);
  const { inner, tail } = splitLimitTail(baseSql);
  const values = [];
  const conds = buildFilterConds(filters, values, d);
  const where = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
  return { text: `select * from (\n${inner}\n) as ${d.quote('_cobalt')}${where}${tail}`, values };
}

/* ------------------------------------------------------------------ *
 * Performance tools
 * ------------------------------------------------------------------ */



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
      const list = await this.conn.driver.query(this.client, sql);
      const last = list[list.length - 1];
      rowCount = last ? last.rowCount : null;
      if (last && Array.isArray(last.rows)) rowCount = last.rows.length || last.rowCount;
    } finally {
      if (rollback) { try { await this.client.query('rollback'); } catch { /* gone */ } }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, rowCount };
  }

  /** Server-side planning/execution split, measured once per variant. */
  async plan(sql, rollback) {
    const d = this.conn.driver;
    const text = d.explainSql(sql, { analyze: true });
    if (rollback) await this.client.query('begin');
    try {
      const [r] = await d.query(this.client, text);
      const parsed = d.parseExplain(r);
      return {
        planningMs: parsed.planningMs,
        executionMs: parsed.executionMs,
        plan: parsed.plan,
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
      return {
        id,
        engine: conn.driver.id,
        engineLabel: conn.driver.label,
        hasSchemas: conn.driver.hasSchemas,
        schemaWord: conn.driver.schemaWord,
        ...info,
      };
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
        let list;
        try {
          list = await conn.driver.query(client, st.sql);
        } catch (err) {
          results.push({
            sql: st.sql, start: st.start, end: st.end,
            error: conn.driver.shapeError(err, st.sql), elapsedMs: Date.now() - began,
          });
          break;
        }
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
      try { meta = await conn.driver.describeResult(conn.pool, r.fields); }
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
    const { text, values } = buildFilteredQuery(baseSql, filters, conn.driver);
    try {
      let r;
      try {
        [r] = await conn.driver.query(client, text, values);
      } catch (err) {
        return { results: [{ sql: text, baseSql, error: conn.driver.shapeError(err, text), elapsedMs: Date.now() - began }] };
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
          catch (err) { v.error = conn.driver.shapeError(err, v.sql); }
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
            v.error = conn.driver.shapeError(err, v.sql);
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
    const text = conn.driver.explainSql(sql, { analyze });
    const began = Date.now();

    try {
      if (rollback) await client.query('begin');
      let r;
      try {
        [r] = await conn.driver.query(client, text);
      } finally {
        if (rollback) { try { await client.query('rollback'); } catch { /* gone */ } }
      }
      const parsed = conn.driver.parseExplain(r);
      return {
        kind: 'plan',
        sql,
        analyze,
        rolledBack: rollback,
        planningMs: parsed.planningMs,
        executionMs: parsed.executionMs,
        triggers: parsed.triggers,
        plan: parsed.plan,
        planText: parsed.planText,
        elapsedMs: Date.now() - began,
      };
    } catch (err) {
      return { kind: 'plan', sql, analyze, error: conn.driver.shapeError(err, text), elapsedMs: Date.now() - began };
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
    const d = conn.driver;
    const [r] = await d.query(client, `select * from (\n${inner}\n) as ${d.quote('_cobalt')} limit 0`);
    return d.describeResult(conn.pool, r.fields || []);
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
    filters = [], where = '', sort = [], limit = 500, offset = 0, after = null, maxRows = 20000,
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
        where,
        sort: effectiveSort,
        limit: limit + 1,                      // one extra row answers "is there more?"
        offset,
        after: keysetSafe ? after : null,
        dialect: conn.driver,
      });

      let r;
      try {
        [r] = await conn.driver.query(client, built.text, built.values);
      } catch (err) {
        return { results: [{ sql: built.text, baseSql, error: conn.driver.shapeError(err, built.text), elapsedMs: Date.now() - began }] };
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
          filtered: filters.length > 0 || !!String(where || '').trim(),
          page: {
            limit,
            offset,
            where,
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
  async countRows(id, tabKey, baseSql, filters = [], where = '') {
    const conn = this.get(id);
    const session = conn.session(tabKey);
    const client = await session.ensure();
    const { inner, baseLimit, baseOffset } = parseLimitTail(baseSql);
    const d = conn.driver;
    const values = [];
    const conds = buildFilterConds(filters, values, d);
    if (String(where || '').trim()) {
      const v = validateWhere(where);
      if (!v.ok) throw new Error(v.error);
      conds.push(`(${String(where).trim()})`);
    }
    const whereSql = conds.length ? `\nwhere ${conds.join('\n  and ')}` : '';
    // A caller-supplied LIMIT bounds the count too, so honour it.
    const bounded = baseLimit == null
      ? `select * from (\n${inner}\n) as ${d.quote('_cobalt')}${whereSql}`
      : `select * from (\n${inner}\n) as ${d.quote('_cobalt')}${whereSql} limit ${baseLimit}${baseOffset ? ` offset ${baseOffset}` : ''}`;
    const began = Date.now();
    const [r] = await d.query(client,
      `select ${d.countExpr} as n from (\n${bounded}\n) as ${d.quote('_cobalt_count')}`, values);
    return { count: Number(r.rows[0][0]), elapsedMs: Date.now() - began };
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
  /**
   * Run one schema statement built by src/shared/ddl.js.
   *
   * Separate from run() because it is not a tab's session: a schema change
   * should not be sitting inside whatever transaction a query tab has open. It
   * goes on the pool, on its own, and it obeys the read-only flag for the same
   * reason applyChanges does — the flag has to hold even if the renderer asks.
   */
  async ddl(id, sql) {
    const conn = this.get(id);
    if (conn.config && conn.config.readOnly) {
      throw new Error(`Connection "${conn.config.name || conn.id}" is marked read-only — nothing was changed.`);
    }
    const text = String(sql || '').trim();
    if (!text) throw new Error('No statement to run.');
    const started = Date.now();
    const res = await conn.pool.query(text);
    return {
      command: Array.isArray(res) ? res[res.length - 1].command : res.command,
      rowCount: Array.isArray(res) ? null : res.rowCount,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Insert rows read from a file.
   *
   * Values go in as text parameters and Postgres casts them to whatever the
   * column is, which is both safer and more faithful than guessing types here:
   * a numeric keeps its scale, a timestamp is parsed by the server's own rules,
   * and nothing is concatenated into SQL.
   *
   * The whole import is one transaction. A file that fails halfway leaves the
   * table exactly as it was, and the error says which row stopped it.
   */
  async importRows(id, { schema, table, columns, rows, mode = 'insert' }) {
    const conn = this.get(id);
    if (conn.config && conn.config.readOnly) {
      throw new Error(`Connection "${conn.config.name || conn.id}" is marked read-only — nothing was imported.`);
    }
    if (!columns || !columns.length) throw new Error('No columns were mapped.');
    if (!rows || !rows.length) throw new Error('There are no rows to import.');

    const d = conn.driver;
    const rel = d.qualify(schema, table);
    const cols = columns.map((c) => d.quote(c)).join(', ');

    // There is a hard limit on bind parameters per statement, so batch to it.
    const perRow = columns.length;
    const batchSize = Math.max(1, Math.min(1000, Math.floor(d.maxBindParams / perRow)));

    const tx = await d.begin(conn.pool);
    const started = Date.now();
    let inserted = 0;
    try {
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const params = [];
        const tuples = chunk.map((r) => {
          const marks = r.map((v) => { params.push(v === undefined ? null : v); return d.placeholder(params.length); });
          return `(${marks.join(', ')})`;
        });
        try {
          const res = await tx.query(d.insertStatement({
            rel, cols, tuples: tuples.join(', '), skipConflicts: mode === 'skipConflicts',
          }), params);
          inserted += res.rowCount || 0;
        } catch (err) {
          // Name the first row of the batch that failed, so a 10,000 line file
          // does not just say "invalid input syntax" with no idea where.
          err.message = `${err.message} (in rows ${i + 1}-${i + chunk.length} of the file)`;
          throw err;
        }
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      tx.release();
    }
    return { inserted, skipped: rows.length - inserted, elapsedMs: Date.now() - started };
  }

  async applyChanges(id, change) {
    const conn = this.get(id);
    // Enforced here, not just in the UI: a connection the user marked read-only
    // must refuse writes even if the renderer asks for them.
    if (conn.config && conn.config.readOnly) {
      throw new Error(`Connection "${conn.config.name || conn.id}" is marked read-only — no changes were applied.`);
    }
    const d = conn.driver;
    const { source, columns, key } = change;
    const rel = d.qualify(source.schema, source.table);
    const keyNames = key.map((i) => columns[i].sourceColumn || columns[i].name);
    const applied = { updated: 0, inserted: 0, deleted: 0, returnedRows: [] };
    const colName = (idx) => d.quote(columns[idx].sourceColumn || columns[idx].name);

    // A key column can be NULL, so the comparison has to be the null-safe one.
    const whereClause = (offset) =>
      keyNames.map((nme, i) => d.nullSafeEq(d.quote(nme), d.placeholder(offset + i + 1))).join(' and ');

    const tx = await d.begin(conn.pool);
    try {
      for (const del of change.deletes || []) {
        const r = await tx.query(`delete from ${rel} where ${whereClause(0)}`, del.keyValues);
        if (r.rowCount !== 1) throw new Error(`Delete matched ${r.rowCount} rows, expected 1. Rolled back.`);
        applied.deleted += r.rowCount;
      }

      for (const up of change.updates || []) {
        const entries = Object.entries(up.set);
        if (!entries.length) continue;
        const sets = entries.map(([idx], i) => `${colName(idx)} = ${d.placeholder(i + 1)}`);
        const params = entries.map(([, v]) => v);
        const sql = `update ${rel} set ${sets.join(', ')} where ${whereClause(params.length)}`;
        const r = await tx.query(sql, [...params, ...up.keyValues]);
        // MySQL reports 0 changed rows when the new value equals the old one,
        // even though it matched the row — so only "too many" is a failure.
        if (r.rowCount > 1) throw new Error(`Update matched ${r.rowCount} rows, expected 1. Rolled back.`);
        applied.updated += 1;
      }

      for (const ins of change.inserts || []) {
        const entries = Object.entries(ins.values);
        let sql;
        let params = [];
        if (!entries.length) {
          sql = d.insertDefaultRow(rel);
        } else {
          const cols = entries.map(([idx]) => colName(idx));
          params = entries.map(([, v]) => v);
          const ph = params.map((_, i) => d.placeholder(i + 1));
          sql = `insert into ${rel} (${cols.join(', ')}) values (${ph.join(', ')})`;
        }
        const r = await tx.query(sql, params);
        applied.inserted += r.rowCount || 1;
      }

      await tx.commit();
      return applied;
    } catch (err) {
      await tx.rollback();
      throw Object.assign(new Error(err.message), { pgError: d.shapeError(err, null) });
    } finally {
      tx.release();
    }
  }

  /**
   * The sidebar tree. The driver supplies the rows; the shaping is the same for
   * every engine. On an engine without schemas the connected database fills the
   * schema slot, so the tree has the same three levels either way.
   */
  async schemaTree(id) {
    const conn = this.get(id);
    const { relations, columns, databases, schemas: schemaNames } = await conn.driver.schemaTree(conn.pool);

    const byTable = new Map();
    for (const c of columns) {
      const k = `${c.schema}.${c.table}`;
      if (!byTable.has(k)) byTable.set(k, []);
      byTable.get(k).push({
        name: c.name, type: c.type, attnum: Number(c.attnum),
        notNull: !!c.not_null, defaultExpr: c.default_expr, isPk: !!c.is_pk,
      });
    }

    const schemas = new Map();
    // Seeded from the server's own list so an empty schema still has a row in
    // the tree; the relations below only fill them in.
    for (const name of schemaNames || []) schemas.set(name, []);
    for (const r of relations) {
      if (!schemas.has(r.schema)) schemas.set(r.schema, []);
      schemas.get(r.schema).push({
        name: r.name, kind: r.kind, oid: r.oid, estRows: Number(r.est_rows),
        columns: byTable.get(`${r.schema}.${r.name}`) || [],
      });
    }
    return {
      engine: conn.driver.id,
      engineLabel: conn.driver.label,
      hasSchemas: conn.driver.hasSchemas,
      database: conn.currentDatabase,
      serverVersion: conn.serverVersion,
      databases,
      schemas: [...schemas.entries()].map(([name, relations2]) => ({ name, relations: relations2 })),
    };
  }

  /**
   * Every foreign key in the database, indexed both ways.
   *
   * `outgoing[schema.table]` are the keys that table holds, so a cell value can
   * be followed to the row it points at. `incoming[schema.table]` are the keys
   * pointing back at it, which is what "referenced by" walks.
   */
  async foreignKeys(id) {
    const conn = this.get(id);
    const rows = await conn.driver.foreignKeys(conn.pool);

    const outgoing = {};
    const incoming = {};
    for (const r of rows) {
      if (!r.columns || !r.ref_columns) continue;
      const fk = {
        name: r.name,
        schema: r.schema, table: r.table, columns: r.columns,
        refSchema: r.ref_schema, refTable: r.ref_table, refColumns: r.ref_columns,
      };
      const from = `${r.schema}.${r.table}`;
      const to = `${r.ref_schema}.${r.ref_table}`;
      (outgoing[from] = outgoing[from] || []).push(fk);
      (incoming[to] = incoming[to] || []).push(fk);
    }
    return { outgoing, incoming };
  }

  async tableDdl(id, schema, table) {
    const conn = this.get(id);
    return conn.driver.tableDdl(conn.pool, schema, table);
  }

  /**
   * What the server is doing right now. Both engines have this; the driver
   * normalizes the columns so the panel does not care which one it is on.
   */
  /**
   * Find a value anywhere in the database.
   *
   * Nothing here can use an index, so the cost is real and the work is bounded
   * on purpose: a row cap per table, views skipped (scanning one re-runs its
   * query over tables already being scanned), and a check between tables so
   * Cancel actually stops it rather than stopping the next query only.
   *
   * One table failing — a permission, a type that will not cast — is recorded
   * and the search carries on. Half an answer beats none.
   */
  async searchDatabase(id, tabKey, {
    needle, mode = 'contains', caseSensitive = false, includeNumeric = false,
    rowCap = 50000, schemas = null, maxMatches = 500,
  } = {}) {
    const text = String(needle == null ? '' : needle);
    if (!text.length) throw new Error('Type something to look for.');

    const conn = this.get(id);
    const d = conn.driver;
    const session = conn.session(tabKey);
    if (session.busy) throw new Error('This tab is already running a query.');
    const client = await session.ensure();
    session.cancelRequested = false;
    session.busy = true;

    const began = Date.now();
    const tree = await this.schemaTree(id);
    const targets = [];
    let skippedViews = 0;

    for (const sch of tree.schemas) {
      if (schemas && schemas.length && !schemas.includes(sch.name)) continue;
      for (const rel of sch.relations) {
        if (rel.kind !== 'r' && rel.kind !== 'p') { skippedViews++; continue; }
        const columns = searchableColumns(rel, { includeNumeric });
        if (columns.length) targets.push({ schema: sch.name, table: rel.name, columns });
      }
    }

    const matches = [];
    const errors = [];
    let scannedTables = 0;
    let cancelled = false;

    try {
      for (const t of targets) {
        if (session.cancelRequested) { cancelled = true; break; }
        let built;
        try {
          built = buildSearchQuery({
            dialect: d, schema: t.schema, table: t.table, columns: t.columns,
            needle: text, mode, caseSensitive, rowCap,
          });
        } catch (err) { errors.push({ schema: t.schema, table: t.table, message: err.message }); continue; }

        try {
          const [r] = await d.query(client, built.text, built.values);
          scannedTables++;
          const row = r.rows[0] || [];
          const scanned = Number(row[row.length - 1] || 0);
          t.columns.forEach((c, i) => {
            const count = Number(row[i * 2] || 0);
            if (!count) return;
            matches.push({
              schema: t.schema,
              table: t.table,
              column: c.name,
              type: c.type,
              count,
              sample: row[i * 2 + 1],
              scanned,
              capped: rowCap ? scanned >= rowCap : false,
            });
          });
        } catch (err) {
          errors.push({ schema: t.schema, table: t.table, message: (err && err.message) || String(err) });
        }
        if (matches.length >= maxMatches) break;
      }
    } finally {
      session.busy = false;
    }

    matches.sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
    return {
      needle: text, mode, caseSensitive, includeNumeric, rowCap,
      matches: matches.slice(0, maxMatches),
      errors,
      scannedTables,
      totalTables: targets.length,
      skippedViews,
      cancelled,
      elapsedMs: Date.now() - began,
    };
  }

  /** The WHERE clause that opens a table on the rows a match came from. */
  searchFilter(id, { column, needle, mode = 'contains', caseSensitive = false }) {
    return buildRowFilter({ dialect: this.get(id).driver, column, needle, mode, caseSensitive });
  }

  /**
   * Indexes, constraints, triggers, routines and sequences, keyed so the
   * sidebar can hang them under the right table without searching a flat list
   * every time it draws.
   */
  async schemaObjects(id) {
    const conn = this.get(id);
    const o = await conn.driver.objects(conn.pool);
    const byTable = {};
    const put = (kind, row) => {
      const key = `${row.schema}.${row.table}`;
      const t = byTable[key] || (byTable[key] = { indexes: [], constraints: [], triggers: [] });
      t[kind].push(row);
    };
    for (const r of o.indexes) put('indexes', r);
    for (const r of o.constraints) put('constraints', r);
    for (const r of o.triggers) put('triggers', r);

    const bySchema = {};
    const putSchema = (kind, row) => {
      const t = bySchema[row.schema] || (bySchema[row.schema] = { routines: [], sequences: [] });
      t[kind].push(row);
    };
    for (const r of o.routines) putSchema('routines', r);
    for (const r of o.sequences) putSchema('sequences', r);

    return {
      byTable,
      bySchema,
      counts: {
        indexes: o.indexes.length,
        constraints: o.constraints.length,
        triggers: o.triggers.length,
        routines: o.routines.length,
        sequences: o.sequences.length,
      },
    };
  }

  async serverStats(id) {
    const conn = this.get(id);
    const stats = await conn.driver.serverStats(conn.pool);
    return { ...stats, engineLabel: conn.driver.label, database: stats.database || conn.currentDatabase };
  }

  async processList(id) {
    const conn = this.get(id);
    return conn.driver.processList(conn.pool);
  }

  /**
   * Stop one of those. `terminate` closes the whole connection rather than
   * cancelling the statement, which is the bigger hammer and is asked for
   * separately.
   */
  async killQuery(id, pid, { terminate = false } = {}) {
    const conn = this.get(id);
    if (conn.config && conn.config.readOnly) {
      throw new Error(`Connection "${conn.config.name || conn.id}" is marked read-only — nothing was cancelled.`);
    }
    return conn.driver.killQuery(conn.pool, pid, { terminate });
  }

  async tableStats(id, schema, table) {
    const conn = this.get(id);
    return conn.driver.tableStats(conn.pool, schema, table);
  }
}

module.exports = {
  Manager, buildFilteredQuery, buildPagedQuery, parseLimitTail,
  splitLimitTail, FILTER_OPS, isReadOnlyStatement,
};
