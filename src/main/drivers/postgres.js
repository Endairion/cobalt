'use strict';

const { Pool, Client, types } = require('pg');

/**
 * The PostgreSQL driver.
 *
 * Everything in here is Postgres-specific: the catalog queries, the identifier
 * quoting, the placeholder style, how a result's origin table is found. The
 * generic machinery — paging, filtering, benchmarking, committing a change set —
 * lives in db.js and asks the driver for these pieces.
 */

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

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Display-only: leave already-safe identifiers bare so generated DDL reads naturally.
const RESERVED = new Set(['user', 'order', 'table', 'select', 'from', 'where', 'group', 'default',
  'check', 'column', 'constraint', 'index', 'primary', 'references', 'unique', 'all', 'and', 'any',
  'array', 'as', 'case', 'cast', 'desc', 'asc', 'limit', 'offset', 'union', 'using', 'when', 'with']);
const quoteNice = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : quote(s));

/** Column classes the app reasons about, whatever the engine calls them. */
const KIND_BY_OID = new Map([
  [20, 'int'], [21, 'int'], [23, 'int'], [26, 'int'],
  [700, 'float'], [701, 'float'],
  [1700, 'decimal'],
  [16, 'bool'],
  [114, 'json'], [3802, 'json'],
  [17, 'binary'],
]);

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

const driver = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  defaultDatabase: 'postgres',
  /** Postgres has schemas inside a database; MySQL does not. */
  hasSchemas: true,
  /** What "schema" is called in this engine's own words. */
  schemaWord: 'schema',
  keysetPaging: true,

  quote,
  quoteNice,
  qualify: (schema, table) => `${quote(schema)}.${quote(table)}`,
  qualifyNice: (schema, table) => `${quoteNice(schema)}.${quoteNice(table)}`,
  placeholder: (n) => `$${n}`,
  textCast: (col) => `${col}::text`,
  mapOperator: (op) => op,

  clientConfig(config, endpoint) {
    const at = endpoint || { host: config.host || 'localhost', port: Number(config.port) || 5432 };
    const cfg = {
      host: at.host,
      port: at.port,
      database: config.database || 'postgres',
      user: config.user || undefined,
      password: config.password || undefined,
      application_name: 'Cobalt',
      statement_timeout: 0,
      connectionTimeoutMillis: 15000,
    };
    if (config.ssl && config.ssl !== 'disable') {
      cfg.ssl = config.ssl === 'require' ? { rejectUnauthorized: false } : true;
    }
    return cfg;
  },

  createPool(clientConfig) {
    const pool = new Pool({ ...clientConfig, max: 4, idleTimeoutMillis: 30000 });
    pool.on('error', () => { /* idle client dropped; pool replaces it */ });
    return pool;
  },

  async hello(pool) {
    const r = await pool.query(
      "select current_database() as db, version() as version, current_setting('server_version') as sv"
    );
    return { database: r.rows[0].db, serverVersion: r.rows[0].sv, banner: r.rows[0].version };
  },

  /** A dedicated connection for one tab, plus the backend id cancel needs. */
  async openSession(clientConfig) {
    const client = new Client(clientConfig);
    await client.connect();
    const r = await client.query('select pg_backend_pid() as pid');
    return { client, pid: r.rows[0].pid };
  },

  async closeSession(client) {
    try { await client.end(); } catch { /* already gone */ }
  },

  /** Always an array of results: one statement can return several. */
  async query(client, sql, values) {
    const res = await client.query({ text: sql, values, rowMode: 'array' });
    const list = Array.isArray(res) ? res : [res];
    return list.map((r) => ({
      rows: r.rows || [],
      fields: r.fields || [],
      rowCount: r.rowCount,
      command: r.command,
    }));
  },

  /** Plain object rows, for the driver's own catalog queries. */
  async select(db, sql, values) {
    const r = await db.query(sql, values);
    return r.rows;
  },

  /** A transaction on a pooled connection, with the same shape in every driver. */
  async begin(pool) {
    const client = await pool.connect();
    await client.query('begin');
    return {
      async query(sql, values) {
        const r = await client.query(sql, values);
        return { rows: r.rows || [], fields: r.fields || [], rowCount: r.rowCount };
      },
      async commit() { await client.query('commit'); },
      async rollback() { try { await client.query('rollback'); } catch { /* connection may be gone */ } },
      release() { client.release(); },
    };
  },

  nullSafeEq: (col, ph) => `${col} is not distinct from ${ph}`,
  countExpr: 'count(*)::bigint',
  maxBindParams: 65000,
  insertDefaultRow: (rel) => `insert into ${rel} default values`,
  insertStatement: ({ rel, cols, tuples, skipConflicts }) =>
    `insert into ${rel} (${cols}) values ${tuples}${skipConflicts ? ' on conflict do nothing' : ''}`,

  async cancel(clientConfig, pid) {
    const side = new Client(clientConfig);
    await side.connect();
    try {
      await side.query('select pg_cancel_backend($1)', [pid]);
      return true;
    } finally { await side.end().catch(() => {}); }
  },

  /**
   * Which physical table each column came from, which is what makes the grid
   * editable. Postgres reports the origin table and column of every field, and
   * propagates it through a subquery wrapper — so a filtered or paged result
   * stays editable.
   */
  async describeResult(db, fields) {
    const oids = [...new Set(fields.map((f) => f.tableID).filter((x) => x && x > 0))];
    const columns = fields.map((f, idx) => ({
      index: idx,
      name: f.name,
      dataTypeID: f.dataTypeID,
      kind: KIND_BY_OID.get(f.dataTypeID) || 'text',
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
  },

  explainSql(sql, { analyze = false } = {}) {
    return analyze
      ? `explain (analyze, buffers, format json) ${sql}`
      : `explain (format json, verbose, costs) ${sql}`;
  },

  /**
   * EXPLAIN (FORMAT JSON) comes back as one json column, and this driver hands
   * json back as raw text so values round-trip losslessly — so the plan arrives
   * as a string and is parsed here.
   */
  parseExplain(result) {
    const row = result.rows[0] || [];
    const raw = Array.isArray(row) ? row[0] : row['QUERY PLAN'];
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const root = Array.isArray(arr) ? arr[0] : arr;
    return {
      root,
      planningMs: root['Planning Time'] ?? null,
      executionMs: root['Execution Time'] ?? null,
      triggers: root.Triggers || [],
      plan: root.Plan,
      planText: null,
    };
  },

  shapeError(err, statement) {
    return {
      message: err.message,
      code: err.code || null,
      detail: err.detail || null,
      hint: err.hint || null,
      position: err.position ? Number(err.position) : null,
      where: err.where || null,
      statement,
    };
  },

  /* --------------------------- introspection --------------------------- */

  async schemaTree(pool) {
    const rels = await pool.query(`
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

    const cols = await pool.query(`
      select n.nspname as schema, c.relname as table, a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             a.attnum::int as attnum, a.attnotnull as not_null,
             pg_get_expr(ad.adbin, ad.adrelid) as default_expr,
             coalesce(bool_or(i.indisprimary), false) as is_pk
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
      left join pg_index i on i.indrelid = c.oid and a.attnum = any(i.indkey) and i.indisprimary
      where a.attnum > 0 and not a.attisdropped
        and c.relkind in ('r','p','v','m','f')
        and n.nspname not in ('pg_catalog','information_schema')
        and n.nspname not like 'pg_toast%'
      group by 1,2,3,4,5,6,7
      order by 1, 2, 5`);

    const dbs = await pool.query(
      'select datname from pg_database where datallowconn and not datistemplate order by datname'
    );
    return { relations: rels.rows, columns: cols.rows, databases: dbs.rows.map((d) => d.datname) };
  },

  async foreignKeys(pool) {
    const r = await pool.query(`
      select con.conname as name,
             ns.nspname as schema, cl.relname as table,
             fns.nspname as ref_schema, fcl.relname as ref_table,
             (select array_agg(a.attname::text order by k.ord)
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
             (select array_agg(a.attname::text order by k.ord)
              from unnest(con.confkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_columns
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_class fcl on fcl.oid = con.confrelid
      join pg_namespace fns on fns.oid = fcl.relnamespace
      where con.contype = 'f'
        and ns.nspname not in ('pg_catalog', 'information_schema')
      order by 2, 3, 1`);
    return r.rows;
  },

  async tableDdl(pool, schema, table) {

        const { rows } = await pool.query(
      `select c.oid::int as oid, c.relkind::text as kind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`, [schema, table]);
    if (!rows.length) throw new Error('Relation not found.');
    const { oid, kind } = rows[0];

    if (kind === 'v' || kind === 'm') {
      const v = await pool.query('select pg_get_viewdef($1::oid, true) as def', [oid]);
      const word = kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW';
      return `CREATE OR REPLACE ${word} ${driver.qualifyNice(schema, table)} AS\n${v.rows[0].def}`;
    }

    const cols = await pool.query(`
      select a.attname, format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null,
             pg_get_expr(d.adbin, d.adrelid) as def,
             a.attidentity::text as identity
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`, [oid]);

    const cons = await pool.query(
      `select conname, pg_get_constraintdef(oid, true) as def from pg_constraint
       where conrelid = $1 order by contype desc, conname`, [oid]);

    const idx = await pool.query(
      `select indexdef from pg_indexes where schemaname = $1 and tablename = $2`, [schema, table]);

    const lines = cols.rows.map((c) => {
      let s = `  ${quoteNice(c.attname)} ${c.type}`;
      if (c.identity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
      else if (c.identity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
      else if (c.def) s += ` DEFAULT ${c.def}`;
      if (c.not_null) s += ' NOT NULL';
      return s;
    });
    for (const c of cons.rows) lines.push(`  CONSTRAINT ${quoteNice(c.conname)} ${c.def}`);

    let ddl = `CREATE TABLE ${driver.qualifyNice(schema, table)} (\n${lines.join(',\n')}\n);`;
    // Drop index definitions that a constraint above already covers.
    const conNames = new Set(cons.rows.map((c) => c.conname));
    const extraIdx = idx.rows.map((r) => r.indexdef).filter((d) => {
      const m = /^CREATE (?:UNIQUE )?INDEX ("(?:[^"]|"")+"|[^\s]+) ON /.exec(d);
      const name = m ? m[1].replace(/^"|"$/g, '').replace(/""/g, '"') : null;
      return !name || !conNames.has(name);
    });
    if (extraIdx.length) ddl += '\n\n' + extraIdx.map((d) => d + ';').join('\n');
    return ddl;
  },

  async tableStats(pool, schema, table) {
    const r = await pool.query(
      `select pg_size_pretty(pg_total_relation_size($1::regclass)) as total_size,
              (select count(*) from pg_indexes where schemaname = $2 and tablename = $3) as index_count`,
      [`${quote(schema)}.${quote(table)}`, schema, table]
    );
    return r.rows[0];
  },

  /**
   * A health snapshot: how much the server is holding, how hard it is working,
   * and the two things that quietly rot a Postgres database — dead tuples that
   * never got vacuumed, and indexes nothing has ever read.
   *
   * Counters since the last stats reset are reported raw rather than as rates.
   * A rate needs two samples and a clock, and a made-up per-second number is
   * worse than an honest total with the uptime beside it.
   */
  async serverStats(pool) {
    const overview = await pool.query(`
      select current_database() as database,
             pg_database_size(current_database())::bigint as db_bytes,
             (select count(*) from pg_stat_activity where datname = current_database())::int as db_connections,
             (select count(*) from pg_stat_activity)::int as all_connections,
             current_setting('max_connections')::int as max_connections,
             extract(epoch from (now() - pg_postmaster_start_time()))::bigint as uptime_seconds,
             current_setting('shared_buffers') as shared_buffers,
             current_setting('work_mem') as work_mem,
             current_setting('effective_cache_size') as effective_cache_size,
             current_setting('maintenance_work_mem') as maintenance_work_mem,
             version() as banner`);

    const activity = await pool.query(`
      select coalesce(blks_hit, 0)::bigint as blks_hit,
             coalesce(blks_read, 0)::bigint as blks_read,
             coalesce(xact_commit, 0)::bigint as commits,
             coalesce(xact_rollback, 0)::bigint as rollbacks,
             coalesce(tup_returned, 0)::bigint as tup_returned,
             coalesce(tup_inserted, 0)::bigint as tup_inserted,
             coalesce(tup_updated, 0)::bigint as tup_updated,
             coalesce(tup_deleted, 0)::bigint as tup_deleted,
             coalesce(temp_files, 0)::bigint as temp_files,
             coalesce(temp_bytes, 0)::bigint as temp_bytes,
             coalesce(deadlocks, 0)::bigint as deadlocks,
             stats_reset
      from pg_stat_database where datname = current_database()`);

    const biggest = await pool.query(`
      select n.nspname as schema, c.relname as name,
             pg_total_relation_size(c.oid)::bigint as bytes,
             pg_relation_size(c.oid)::bigint as table_bytes,
             (pg_total_relation_size(c.oid) - pg_relation_size(c.oid))::bigint as index_bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'm')
        and n.nspname not in ('pg_catalog', 'information_schema')
      order by pg_total_relation_size(c.oid) desc
      limit 8`);

    const vacuum = await pool.query(`
      select relname as name, schemaname as schema,
             n_dead_tup::bigint as dead_tuples,
             n_live_tup::bigint as live_tuples,
             greatest(last_autovacuum, last_vacuum) as last_vacuum
      from pg_stat_user_tables
      where n_dead_tup > 0
      order by n_dead_tup desc
      limit 8`);

    // An index nothing has read is disk and write cost for nothing — but a
    // constraint's index has a job beyond being scanned, so it is left out.
    const unused = await pool.query(`
      select s.schemaname as schema, s.relname as table, s.indexrelname as name,
             pg_relation_size(s.indexrelid)::bigint as bytes
      from pg_stat_user_indexes s
      join pg_index i on i.indexrelid = s.indexrelid
      where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
      order by pg_relation_size(s.indexrelid) desc
      limit 8`);

    const o = overview.rows[0];
    const a2 = activity.rows[0] || {};
    const hit = Number(a2.blks_hit || 0);
    const read = Number(a2.blks_read || 0);

    return {
      engine: 'postgres',
      database: o.database,
      uptimeSeconds: Number(o.uptime_seconds),
      sizeBytes: Number(o.db_bytes),
      connections: Number(o.db_connections),
      connectionsAll: Number(o.all_connections),
      maxConnections: Number(o.max_connections),
      cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
      memory: [
        { name: 'shared_buffers', value: o.shared_buffers, note: 'what the server caches pages in' },
        { name: 'effective_cache_size', value: o.effective_cache_size, note: 'what the planner assumes the OS also caches' },
        { name: 'work_mem', value: o.work_mem, note: 'per sort or hash, per operation' },
        { name: 'maintenance_work_mem', value: o.maintenance_work_mem, note: 'vacuum and index builds' },
      ],
      counters: [
        { name: 'commits', value: Number(a2.commits) },
        { name: 'rollbacks', value: Number(a2.rollbacks) },
        { name: 'rows returned', value: Number(a2.tup_returned) },
        { name: 'rows inserted', value: Number(a2.tup_inserted) },
        { name: 'rows updated', value: Number(a2.tup_updated) },
        { name: 'rows deleted', value: Number(a2.tup_deleted) },
        { name: 'temp files', value: Number(a2.temp_files), warn: Number(a2.temp_files) > 0,
          note: 'a sort or hash that did not fit in work_mem spilled to disk' },
        { name: 'deadlocks', value: Number(a2.deadlocks), warn: Number(a2.deadlocks) > 0 },
      ],
      since: a2.stats_reset || null,
      biggest: biggest.rows.map((r) => ({
        schema: r.schema, name: r.name,
        bytes: Number(r.bytes), tableBytes: Number(r.table_bytes), indexBytes: Number(r.index_bytes),
      })),
      vacuum: vacuum.rows.map((r) => ({
        schema: r.schema, name: r.name,
        deadTuples: Number(r.dead_tuples), liveTuples: Number(r.live_tuples),
        lastVacuum: r.last_vacuum,
      })),
      unusedIndexes: unused.rows.map((r) => ({
        schema: r.schema, table: r.table, name: r.name, bytes: Number(r.bytes),
      })),
    };
  },

  /**
   * Everything in a schema that is not a table or a view: indexes, constraints,
   * triggers, routines, sequences.
   *
   * Fetched on its own rather than with the schema tree, because a database
   * with thousands of tables should not pay for this on every refresh — the
   * sidebar asks once, when you first open a table up.
   */
  async objects(pool) {
    const indexes = await pool.query(`
      select n.nspname as schema, t.relname as table, i.relname as name,
             pg_get_indexdef(x.indexrelid) as definition,
             x.indisunique as is_unique,
             x.indisprimary as is_primary,
             x.indisvalid as is_valid,
             pg_relation_size(x.indexrelid)::bigint as bytes,
             coalesce(s.idx_scan, 0)::bigint as scans
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      left join pg_stat_user_indexes s on s.indexrelid = x.indexrelid
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, t.relname, i.relname`);

    const constraints = await pool.query(`
      select n.nspname as schema, t.relname as table, c.conname as name,
             case c.contype
               when 'p' then 'primary key' when 'u' then 'unique'
               when 'f' then 'foreign key' when 'c' then 'check'
               when 'x' then 'exclude' else c.contype::text end as type,
             pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, t.relname, c.contype, c.conname`);

    const triggers = await pool.query(`
      select n.nspname as schema, t.relname as table, g.tgname as name,
             pg_get_triggerdef(g.oid) as definition,
             g.tgenabled <> 'D' as enabled
      from pg_trigger g
      join pg_class t on t.oid = g.tgrelid
      join pg_namespace n on n.oid = t.relnamespace
      where not g.tgisinternal
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, t.relname, g.tgname`);

    const routines = await pool.query(`
      select n.nspname as schema, p.proname as name,
             case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate'
                            when 'w' then 'window' else 'function' end as kind,
             pg_get_function_result(p.oid) as returns,
             pg_get_function_arguments(p.oid) as args,
             l.lanname as language
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, p.proname`);

    const sequences = await pool.query(`
      select n.nspname as schema, c.relname as name,
             format_type(s.seqtypid, null) as type,
             s.seqstart::text as start_value,
             s.seqincrement::text as increment
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_sequence s on s.seqrelid = c.oid
      where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
      order by n.nspname, c.relname`);

    return {
      indexes: indexes.rows.map((r) => ({
        schema: r.schema, table: r.table, name: r.name, definition: r.definition,
        unique: r.is_unique, primary: r.is_primary, valid: r.is_valid,
        bytes: Number(r.bytes), scans: Number(r.scans),
      })),
      constraints: constraints.rows,
      triggers: triggers.rows,
      routines: routines.rows,
      sequences: sequences.rows,
    };
  },

  async processList(pool) {
    const r = await pool.query(`
      select pid::int as id,
             coalesce(usename, '') as user,
             coalesce(datname, '') as database,
             coalesce(client_addr::text, 'local') as client,
             coalesce(application_name, '') as application,
             state,
             coalesce(wait_event_type || ':' || wait_event, '') as waiting,
             extract(epoch from (now() - query_start))::int as seconds,
             extract(epoch from (now() - xact_start))::int as txn_seconds,
             coalesce(query, '') as query,
             pid = pg_backend_pid() as is_self
      from pg_stat_activity
      where backend_type = 'client backend'
      order by (state = 'active') desc, query_start nulls last`);
    return r.rows.map((x) => ({ ...x, seconds: x.seconds == null ? null : Number(x.seconds) }));
  },

  async killQuery(pool, id, { terminate = false } = {}) {
    const fn = terminate ? 'pg_terminate_backend' : 'pg_cancel_backend';
    const r = await pool.query(`select ${fn}($1) as ok`, [Number(id)]);
    return !!r.rows[0].ok;
  },
};

module.exports = driver;
