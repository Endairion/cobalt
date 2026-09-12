'use strict';

const mysql = require('mysql2/promise');

/**
 * The MySQL / MariaDB driver.
 *
 * Two things differ from Postgres in ways that reach the rest of the app.
 *
 * There are no schemas. A MySQL "database" occupies the same slot a Postgres
 * schema does, so that is what the sidebar shows: the connected database is the
 * one schema, and `schema` everywhere else in the code means the database name.
 *
 * Values must be taken as text, deliberately. mysql2 will happily hand back a
 * JS number for a BIGINT and a parsed object for a JSON column — and a parsed
 * JSON column has already destroyed any integer past 2^53 by the time you see
 * it. The type handling below asks for the raw bytes and keeps them as the text
 * the server sent, which is the same promise the Postgres driver makes.
 */

const BINARY_CHARSET = 63;                 // charset "binary"
const MAYBE_BINARY = new Set([252, 253, 254, 249, 250, 251, 16, 255]); // BLOB/STRING/BIT/GEOMETRY
const HEX_PREFIX = `${String.fromCharCode(92)}x`;

/** MySQL protocol type codes, grouped the way the app cares about. */
const KIND_BY_TYPE = new Map([
  [1, 'int'], [2, 'int'], [3, 'int'], [8, 'int'], [9, 'int'], [13, 'int'],
  [4, 'float'], [5, 'float'],
  [0, 'decimal'], [246, 'decimal'],
  [245, 'json'],
]);

const FLAG_NOT_NULL = 1;
const FLAG_PRI_KEY = 2;

/**
 * Types whose bytes might be binary. Inside typeCast the charset that would
 * settle it is not available, so take the buffer and let textify() decide once
 * the result metadata is in hand.
 */
const BINARYISH_NAMES = new Set([
  'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB',
  'STRING', 'VAR_STRING', 'VARCHAR', 'BIT', 'GEOMETRY',
]);

/**
 * Applied to the statements you run, not to the driver's own catalog queries —
 * those want ordinary strings. JSON falls through to string() on purpose: let
 * mysql2 parse it and a BIGINT inside the document is already gone.
 */
const USER_TYPE_CAST = (field, next) => {
  if (BINARYISH_NAMES.has(field.type)) {
    const b = field.buffer();
    return b === null ? null : b;
  }
  return field.string('utf8');
};

const quote = (s) => `\`${String(s).replace(/`/g, '``')}\``;
// MySQL identifiers are nearly always fine bare, but a reserved word or an odd
// character is not, and the list is long — so display quoting stays cautious.
const quoteNice = (s) => (/^[a-z_][a-z0-9_]*$/.test(String(s)) ? String(s) : quote(s));

/** Rebuild the rows a query returned into plain text, binary as \x hex. */
function textify(rows, fields) {
  const binary = [];
  const text = [];
  fields.forEach((f, i) => {
    if (!MAYBE_BINARY.has(f.columnType)) return;
    (f.characterSet === BINARY_CHARSET ? binary : text).push(i);
  });
  if (!binary.length && !text.length) return rows;
  for (const row of rows) {
    for (const i of binary) {
      if (Buffer.isBuffer(row[i])) row[i] = HEX_PREFIX + row[i].toString('hex');
    }
    for (const i of text) {
      if (Buffer.isBuffer(row[i])) row[i] = row[i].toString('utf8');
    }
  }
  return rows;
}

/** A BLOB and a TEXT column are the same protocol type; only the charset differs. */
function kindOf(field) {
  if (MAYBE_BINARY.has(field.columnType) && field.characterSet === BINARY_CHARSET) return 'binary';
  return KIND_BY_TYPE.get(field.columnType) || 'text';
}

const driver = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
  defaultDatabase: '',
  hasSchemas: false,
  schemaWord: 'database',
  // MySQL compares row constructors, so keyset paging works here too.
  keysetPaging: true,

  quote,
  quoteNice,
  qualify: (schema, table) => (schema ? `${quote(schema)}.${quote(table)}` : quote(table)),
  qualifyNice: (schema, table) => (schema ? `${quoteNice(schema)}.${quoteNice(table)}` : quoteNice(table)),
  placeholder: () => '?',
  textCast: (col) => `cast(${col} as char)`,
  /** There is no ILIKE: MySQL's default collations already ignore case. */
  mapOperator: (op) => (op === 'ilike' ? 'like' : op === 'not ilike' ? 'not like' : op),

  clientConfig(config, endpoint) {
    const at = endpoint || { host: config.host || 'localhost', port: Number(config.port) || 3306 };
    const cfg = {
      host: at.host,
      port: at.port,
      user: config.user || undefined,
      password: config.password || undefined,
      database: config.database || undefined,
      connectTimeout: 15000,
      // Arrays, so duplicate column names survive — the same as pg rowMode.
      rowsAsArray: true,
      // Never parse a value into a JS type: see the note at the top.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
    };
    if (config.ssl && config.ssl !== 'disable') {
      cfg.ssl = config.ssl === 'require' ? { rejectUnauthorized: false } : {};
    }
    return cfg;
  },

  createPool(clientConfig) {
    const pool = mysql.createPool({ ...clientConfig, connectionLimit: 4, waitForConnections: true });
    pool.on('error', () => { /* idle connection dropped; the pool replaces it */ });
    // Give it the same surface the Postgres pool has, so db.js needs no branch.
    return {
      raw: pool,
      async query(sql, values) {
        const [rows, fields] = await pool.query({ sql, values, rowsAsArray: false });
        return { rows: rows || [], fields: fields || [], rowCount: rows && rows.affectedRows };
      },
      async end() { await pool.end(); },
    };
  },

  async hello(pool) {
    const r = await pool.query('select database() as db, version() as version');
    return {
      database: r.rows[0].db || '',
      serverVersion: String(r.rows[0].version || '').split('-')[0],
      banner: r.rows[0].version,
    };
  },

  async openSession(clientConfig) {
    const client = await mysql.createConnection(clientConfig);
    const [rows] = await client.query({ sql: 'select connection_id() as pid', rowsAsArray: false });
    return { client, pid: rows[0].pid };
  },

  async closeSession(client) {
    try { await client.end(); } catch { /* already gone */ }
  },

  async query(client, sql, values) {
    const [rows, fields] = await client.query({
      sql, values, rowsAsArray: true, typeCast: USER_TYPE_CAST,
    });
    // A statement with no result set (INSERT, DDL) gives an OkPacket.
    if (!Array.isArray(fields) || !fields.length) {
      const ok = Array.isArray(rows) ? rows[0] : rows;
      return [{
        rows: [],
        fields: [],
        rowCount: ok && typeof ok.affectedRows === 'number' ? ok.affectedRows : null,
        command: commandOf(sql),
      }];
    }
    return [{
      rows: textify(rows, fields),
      fields,
      rowCount: rows.length,
      command: commandOf(sql),
    }];
  },

  async select(db, sql, values) {
    const r = await db.query(sql, values);
    return r.rows;
  },

  async begin(pool) {
    const conn = await pool.raw.getConnection();
    await conn.beginTransaction();
    return {
      async query(sql, values) {
        const [rows, fields] = await conn.query({ sql, values, rowsAsArray: false });
        const ok = Array.isArray(rows) ? null : rows;
        return {
          rows: Array.isArray(rows) ? rows : [],
          fields: fields || [],
          rowCount: ok ? ok.affectedRows : (Array.isArray(rows) ? rows.length : 0),
        };
      },
      async commit() { await conn.commit(); },
      async rollback() { try { await conn.rollback(); } catch { /* connection may be gone */ } },
      release() { conn.release(); },
    };
  },

  /** MySQL spells the null-safe comparison <=>. */
  nullSafeEq: (col, ph) => `${col} <=> ${ph}`,
  countExpr: 'count(*)',
  maxBindParams: 65000,
  insertDefaultRow: (rel) => `insert into ${rel} () values ()`,
  /** There is no ON CONFLICT; INSERT IGNORE is the nearest thing. */
  insertStatement: ({ rel, cols, tuples, skipConflicts }) =>
    `insert ${skipConflicts ? 'ignore ' : ''}into ${rel} (${cols}) values ${tuples}`,

  async cancel(clientConfig, pid) {
    const side = await mysql.createConnection(clientConfig);
    try {
      await side.query(`kill query ${Number(pid)}`);
      return true;
    } finally { await side.end().catch(() => {}); }
  },

  /**
   * MySQL reports each field's origin table and column, and keeps them through
   * a derived table — so a filtered or paged result stays editable, the same as
   * on Postgres.
   */
  async describeResult(pool, fields) {
    const columns = fields.map((f, idx) => ({
      index: idx,
      name: f.name,
      dataTypeID: f.columnType,
      kind: kindOf(f),
      tableOid: null,
      attnum: null,
      dataType: null,
      sourceColumn: f.orgName || null,
      notNull: !!(f.flags & FLAG_NOT_NULL),
      hasDefault: false,
      defaultExpr: null,
      isPrimary: !!(f.flags & FLAG_PRI_KEY),
      sourceSchema: f.schema || f.db || null,
      sourceTable: f.orgTable || null,
    }));

    const bases = [...new Set(columns
      .filter((c) => c.sourceTable)
      .map((c) => `${c.sourceSchema} ${c.sourceTable}`))];

    if (!bases.length) return { columns, source: null, editable: false, reason: 'Result is not backed by a table.' };

    if (bases.length > 1) {
      // Selecting from a view reports the view's *base* tables, so several
      // origins can still mean one view rather than a join. The name the query
      // used is in `table`; if that is a view, say so — "joins more than one
      // table" would be a puzzling thing to read about `select * from a_view`.
      const named = [...new Set(fields.map((f) => f.table).filter(Boolean))];
      if (named.length === 1) {
        const schema0 = columns.find((c) => c.sourceSchema).sourceSchema;
        const asView = await pool.query(
          `select table_type from information_schema.tables
           where table_schema = ? and table_name = ? and table_type = 'VIEW'`, [schema0, named[0]]);
        if (asView.rows.length) {
          return {
            columns,
            source: { schema: schema0, table: named[0], relkind: 'v' },
            editable: false,
            reason: 'Source is a view, not a table.',
          };
        }
      }
      return { columns, source: null, editable: false, reason: 'Result joins more than one table.' };
    }

    const [schema, table] = bases[0].split(' ');
    const src = { schema, table };

    const info = await pool.query(
      `select column_name, column_type, is_nullable, column_default, extra
       from information_schema.columns where table_schema = ? and table_name = ?`, [schema, table]);
    const byName = new Map(info.rows.map((r) => [r.COLUMN_NAME || r.column_name, r]));
    for (const c of columns) {
      const m = c.sourceColumn ? byName.get(c.sourceColumn) : null;
      if (!m) continue;
      c.dataType = m.COLUMN_TYPE || m.column_type;
      c.hasDefault = (m.COLUMN_DEFAULT ?? m.column_default) !== null
        || /auto_increment|DEFAULT_GENERATED/i.test(m.EXTRA || m.extra || '');
      c.defaultExpr = m.COLUMN_DEFAULT ?? m.column_default ?? null;
    }

    const kindRow = await pool.query(
      'select table_type from information_schema.tables where table_schema = ? and table_name = ?',
      [schema, table]);
    const tableType = kindRow.rows.length ? (kindRow.rows[0].TABLE_TYPE || kindRow.rows[0].table_type) : null;
    src.relkind = tableType === 'VIEW' ? 'v' : 'r';
    if (src.relkind === 'v') {
      return { columns, source: src, editable: false, reason: 'Source is a view, not a table.' };
    }

    // The first unique index whose every column is in the result, primary first.
    const idx = await pool.query(
      `select index_name, seq_in_index, column_name
       from information_schema.statistics
       where table_schema = ? and table_name = ? and non_unique = 0
       order by (index_name = 'PRIMARY') desc, index_name, seq_in_index`, [schema, table]);

    const indexes = new Map();
    for (const r of idx.rows) {
      const name = r.INDEX_NAME || r.index_name;
      if (!indexes.has(name)) indexes.set(name, []);
      indexes.get(name).push(r.COLUMN_NAME || r.column_name);
    }

    let keyColumns = null;
    for (const cols of indexes.values()) {
      const mapped = cols.map((name) => columns.find((c) => c.sourceTable === table && c.sourceColumn === name));
      if (mapped.every(Boolean)) { keyColumns = mapped.map((c) => c.index); break; }
    }
    if (!keyColumns) {
      return { columns, source: src, editable: false, reason: 'No primary or unique key in the result — select the key columns to edit rows.' };
    }
    return { columns, source: src, key: keyColumns, editable: true, reason: null };
  },

  explainSql(sql, { analyze = false } = {}) {
    return analyze ? `explain analyze ${sql}` : `explain format=json ${sql}`;
  },

  /**
   * MySQL's plan is not the same shape as a Postgres one and the plan tree in
   * the perf panel is built for Postgres, so this hands back text. EXPLAIN
   * FORMAT=JSON gives a document worth indenting; EXPLAIN ANALYZE is already a
   * readable tree.
   */
  parseExplain(result) {
    const row = result.rows[0] || [];
    const raw = Array.isArray(row) ? row[row.length - 1] : Object.values(row)[0];
    let text = String(raw == null ? '' : raw);
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* already text */ }
    return { root: null, planningMs: null, executionMs: null, triggers: [], plan: null, planText: text };
  },

  shapeError(err, statement) {
    return {
      message: err.sqlMessage || err.message,
      code: err.code || (err.errno != null ? String(err.errno) : null),
      detail: err.sqlState ? `SQLSTATE ${err.sqlState}` : null,
      hint: null,
      position: null,
      where: null,
      statement,
    };
  },

  /* --------------------------- introspection --------------------------- */

  async schemaTree(pool) {
    const current = await pool.query('select database() as db');
    const db = current.rows[0].db;
    if (!db) {
      return { relations: [], columns: [], databases: await listDatabases(pool), noDatabase: true };
    }

    const rels = await pool.query(
      `select table_schema as \`schema\`, table_name as name,
              case table_type when 'VIEW' then 'v' else 'r' end as kind,
              coalesce(table_rows, 0) as est_rows
       from information_schema.tables
       where table_schema = ?
       order by table_name`, [db]);

    const cols = await pool.query(
      `select table_schema as \`schema\`, table_name as \`table\`, column_name as name,
              column_type as type, ordinal_position as attnum,
              is_nullable = 'NO' as not_null,
              column_default as default_expr,
              column_key = 'PRI' as is_pk
       from information_schema.columns
       where table_schema = ?
       order by table_name, ordinal_position`, [db]);

    const lower = (rows) => rows.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[k.toLowerCase()] = v;
      return out;
    });
    return {
      relations: lower(rels.rows).map((r) => ({ ...r, oid: null, est_rows: String(r.est_rows) })),
      columns: lower(cols.rows).map((c) => ({ ...c, not_null: !!Number(c.not_null), is_pk: !!Number(c.is_pk) })),
      databases: await listDatabases(pool),
    };
  },

  async foreignKeys(pool) {
    const current = await pool.query('select database() as db');
    const db = current.rows[0].db;
    if (!db) return [];
    const r = await pool.query(
      `select k.constraint_name as name,
              k.table_schema as \`schema\`, k.table_name as \`table\`,
              k.referenced_table_schema as ref_schema, k.referenced_table_name as ref_table,
              group_concat(k.column_name order by k.ordinal_position) as columns,
              group_concat(k.referenced_column_name order by k.ordinal_position) as ref_columns
       from information_schema.key_column_usage k
       where k.table_schema = ? and k.referenced_table_name is not null
       group by k.constraint_name, k.table_schema, k.table_name,
                k.referenced_table_schema, k.referenced_table_name
       order by k.table_name, k.constraint_name`, [db]);

    return r.rows.map((row) => {
      const g = (key) => row[key] ?? row[key.toUpperCase()];
      return {
        name: g('name'),
        schema: g('schema'),
        table: g('table'),
        ref_schema: g('ref_schema'),
        ref_table: g('ref_table'),
        columns: String(g('columns') || '').split(','),
        ref_columns: String(g('ref_columns') || '').split(','),
      };
    });
  },

  async tableDdl(pool, schema, table) {
    const r = await pool.query(`show create table ${driver.qualify(schema, table)}`);
    const row = r.rows[0] || {};
    return `${row['Create Table'] || row['Create View'] || ''};\n`;
  },

  async tableStats(pool, schema, table) {
    const r = await pool.query(
      `select data_length + index_length as bytes,
              (select count(distinct index_name) from information_schema.statistics
               where table_schema = ? and table_name = ?) as index_count
       from information_schema.tables where table_schema = ? and table_name = ?`,
      [schema, table, schema, table]);
    const row = r.rows[0] || {};
    const bytes = Number(row.bytes ?? row.BYTES ?? 0);
    const pretty = bytes < 1024 ? `${bytes} bytes`
      : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} kB`
        : bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB`
          : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return { total_size: pretty, index_count: Number(row.index_count ?? row.INDEX_COUNT ?? 0) };
  },

  async processList(pool) {
    const r = await pool.query(
      `select id, user, host as client, coalesce(db, '') as \`database\`,
              command, time as seconds, coalesce(state, '') as waiting,
              coalesce(info, '') as query,
              id = connection_id() as is_self
       from information_schema.processlist
       order by (command <> 'Sleep') desc, time desc`);
    return r.rows.map((row) => {
      const g = (key) => row[key] ?? row[key.toUpperCase()];
      return {
        id: Number(g('id')),
        user: g('user') || '',
        database: g('database') || '',
        client: g('client') || '',
        application: '',
        state: g('command') === 'Sleep' ? 'idle' : 'active',
        waiting: g('waiting') || '',
        seconds: g('seconds') == null ? null : Number(g('seconds')),
        txn_seconds: null,
        query: g('query') || '',
        is_self: !!Number(g('is_self')),
      };
    });
  },

  async killQuery(pool, id, { terminate = false } = {}) {
    await pool.query(`kill ${terminate ? 'connection' : 'query'} ${Number(id)}`);
    return true;
  },
};

async function listDatabases(pool) {
  const r = await pool.query(
    `select schema_name from information_schema.schemata
     where schema_name not in ('information_schema','performance_schema','mysql','sys')
     order by schema_name`);
  return r.rows.map((x) => x.SCHEMA_NAME || x.schema_name);
}

/** The first word, so the result strip can say what ran. */
function commandOf(sql) {
  const m = /^\s*(\w+)/.exec(String(sql));
  return m ? m[1].toUpperCase() : '';
}

module.exports = driver;
