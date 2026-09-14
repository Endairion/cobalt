'use strict';

/**
 * The DDL the schema actions generate.
 *
 * Kept here, away from any dialog, for two reasons: it is the part worth having
 * tests for, and the exact text this produces is what the dialog shows you
 * before anything runs. Nothing is generated that you have not read.
 *
 * A type, a default and an index expression are free SQL — there is no way to
 * parameterize them — so they go through checkFragment first. That is not a
 * security boundary (the editor next door runs anything you like); it is there
 * so a stray semicolon in a pasted value cannot quietly turn one statement into
 * two.
 *
 * The engines differ by more than quoting, which is why there is a dialect
 * table below rather than a single quote function. MySQL has no
 * `ALTER COLUMN … TYPE` (it is `MODIFY COLUMN`, restating the whole column,
 * which is also why dropping NOT NULL there needs the column's current type),
 * no CONCURRENTLY, no CASCADE on a drop, and it writes USING before the table
 * on an index rather than after it. Emitting Postgres syntax everywhere would
 * give you a dialog that always fails on the other engine.
 */

const RESERVED = new Set(['user', 'order', 'table', 'select', 'from', 'where', 'group', 'default',
  'check', 'column', 'constraint', 'index', 'primary', 'references', 'unique', 'all', 'and', 'any',
  'array', 'as', 'case', 'cast', 'desc', 'asc', 'limit', 'offset', 'union', 'using', 'when', 'with',
  'to', 'end', 'is', 'in', 'not', 'null', 'true', 'false', 'analyze', 'between', 'both', 'collate',
  'create', 'current_date', 'do', 'else', 'except', 'for', 'foreign', 'grant', 'having', 'into',
  'join', 'leading', 'like', 'only', 'or', 'placing', 'returning', 'then', 'trailing', 'values']);

const SAFE_BARE = /^[a-z_][a-z0-9_]*$/;
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
const backtick = (s) => ['`', String(s).replace(/`/g, '``'), '`'].join('');

/** Bare when it is safe to be, quoted when it is not — so the SQL reads well. */
const q = (s) => (SAFE_BARE.test(String(s)) && !RESERVED.has(String(s)) ? String(s) : quote(s));
const qMysql = (s) => (SAFE_BARE.test(String(s)) && !RESERVED.has(String(s)) ? String(s) : backtick(s));

const DIALECTS = {
  postgres: {
    id: 'postgres',
    q,
    cascade: true,
    concurrently: true,
    restartIdentity: true,
    usingCast: true,
    alterType: ({ relName, col, type, using }) =>
      `ALTER TABLE ${relName}\n  ALTER COLUMN ${col} TYPE ${type}${using ? `\n  USING ${using}` : ''};`,
    setNotNull: ({ relName, col, notNull }) =>
      `ALTER TABLE ${relName}\n  ALTER COLUMN ${col} ${notNull ? 'SET' : 'DROP'} NOT NULL;`,
    addColumnTail: ({ type, def, notNull }) =>
      `${type}${def ? ` DEFAULT ${def}` : ''}${notNull ? ' NOT NULL' : ''}`,
    indexHead: ({ unique, concurrently, name }) =>
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${concurrently ? 'CONCURRENTLY ' : ''}${name}`,
    indexBody: ({ relName, method, cols }) =>
      `\n  ON ${relName}${method ? ` USING ${method}` : ''} (${cols})`,

    // A schema is a thing of its own here, inside a database.
    schemas: true,
    identity: () => 'GENERATED ALWAYS AS IDENTITY',
    createDatabase: ({ name, owner, encoding, template }) => {
      const opts = [];
      if (owner) opts.push(`OWNER ${owner}`);
      if (template) opts.push(`TEMPLATE ${template}`);
      if (encoding) opts.push(`ENCODING ${encoding}`);
      return `CREATE DATABASE ${name}${opts.length ? `\n  ${opts.join(' ')}` : ''};`;
    },
    // MySQL wants the table; Postgres knows which one from the index itself.
    dropIndex: ({ schema, name, concurrently, cascade }) =>
      `DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}${schema ? `${schema}.` : ''}${name}${cascade ? ' CASCADE' : ''};`,
  },
  mysql: {
    id: 'mysql',
    q: qMysql,
    cascade: false,
    concurrently: false,
    restartIdentity: false,
    usingCast: false,
    alterType: ({ relName, col, type }) =>
      `ALTER TABLE ${relName}\n  MODIFY COLUMN ${col} ${type};`,
    // MODIFY restates the column, so the type has to come along for the ride.
    setNotNull: ({ relName, col, notNull, currentType }) =>
      `ALTER TABLE ${relName}\n  MODIFY COLUMN ${col} ${currentType || 'text'}${notNull ? ' NOT NULL' : ' NULL'};`,
    addColumnTail: ({ type, def, notNull }) =>
      `${type}${notNull ? ' NOT NULL' : ''}${def ? ` DEFAULT ${def}` : ''}`,
    indexHead: ({ unique, name }) => `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name}`,
    indexBody: ({ relName, method, cols }) =>
      `${method ? ` USING ${method}` : ''}\n  ON ${relName} (${cols})`,

    // On MySQL a schema *is* a database — CREATE SCHEMA is a synonym — so
    // offering both would be offering the same thing twice under two names.
    schemas: false,
    identity: () => 'AUTO_INCREMENT',
    createDatabase: ({ name, charset, collation }) => {
      const opts = [];
      if (charset) opts.push(`CHARACTER SET ${charset}`);
      if (collation) opts.push(`COLLATE ${collation}`);
      return `CREATE DATABASE ${name}${opts.length ? `\n  ${opts.join(' ')}` : ''};`;
    },
    dropIndex: ({ schema, table, name }) =>
      `DROP INDEX ${name} ON ${schema ? `${schema}.` : ''}${table};`,
  },
};

const dialect = (engine) => DIALECTS[String(engine || 'postgres').toLowerCase()] || DIALECTS.postgres;

/** The identifier quoter for an engine, for callers that need only that. */
const quoterFor = (engine) => dialect(engine).q;

const rel = (schema, table) => `${q(schema)}.${q(table)}`;
const relOf = (d, schema, table) => (schema ? `${d.q(schema)}.${d.q(table)}` : d.q(table));

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** A fragment of SQL someone typed: a type, a default, an index expression. */
function checkFragment(text, what) {
  const s = String(text == null ? '' : text).trim();
  if (!s) throw new Error(`${what} is required.`);
  if (s.includes(';')) throw new Error(`${what} cannot contain a semicolon.`);
  if (s.includes('--') || s.includes('/*')) throw new Error(`${what} cannot contain a comment.`);
  return s;
}

/** An identifier someone typed. Anything can be quoted, but not nothing. */
function checkName(name, what) {
  const s = String(name == null ? '' : name).trim();
  if (!s) throw new Error(`${what} is required.`);
  if (s.length > 63) throw new Error(`${what} is longer than 63 characters, which the server will truncate.`);
  return s;
}

/* ------------------------------ columns ------------------------------ */

function addColumn({ schema, table, name, type, notNull = false, defaultExpr = '', engine }) {
  const d = dialect(engine);
  const col = checkName(name, 'Column name');
  const t = checkFragment(type, 'Type');
  const raw = String(defaultExpr || '').trim();
  const tail = d.addColumnTail({
    type: t,
    def: raw ? checkFragment(raw, 'Default') : '',
    notNull,
  });
  return `ALTER TABLE ${relOf(d, schema, table)}\n  ADD COLUMN ${d.q(col)} ${tail};`;
}

function dropColumn({ schema, table, name, cascade = false, engine }) {
  const d = dialect(engine);
  const suffix = cascade && d.cascade ? ' CASCADE' : '';
  return `ALTER TABLE ${relOf(d, schema, table)}\n  DROP COLUMN ${d.q(checkName(name, 'Column name'))}${suffix};`;
}

function renameColumn({ schema, table, name, to, engine }) {
  const d = dialect(engine);
  return `ALTER TABLE ${relOf(d, schema, table)}\n  RENAME COLUMN ${d.q(checkName(name, 'Column name'))} TO ${d.q(checkName(to, 'New name'))};`;
}

function alterColumnType({ schema, table, name, type, using = '', engine }) {
  const d = dialect(engine);
  const u = String(using || '').trim();
  return d.alterType({
    relName: relOf(d, schema, table),
    col: d.q(checkName(name, 'Column name')),
    type: checkFragment(type, 'Type'),
    using: u && d.usingCast ? checkFragment(u, 'USING expression') : '',
  });
}

function setNotNull({ schema, table, name, notNull, currentType = '', engine }) {
  const d = dialect(engine);
  return d.setNotNull({
    relName: relOf(d, schema, table),
    col: d.q(checkName(name, 'Column name')),
    notNull,
    currentType,
  });
}

function setDefault({ schema, table, name, defaultExpr, engine }) {
  const d = dialect(engine);
  const relName = relOf(d, schema, table);
  const col = d.q(checkName(name, 'Column name'));
  const def = String(defaultExpr == null ? '' : defaultExpr).trim();
  return def
    ? `ALTER TABLE ${relName}\n  ALTER COLUMN ${col} SET DEFAULT ${checkFragment(def, 'Default')};`
    : `ALTER TABLE ${relName}\n  ALTER COLUMN ${col} DROP DEFAULT;`;
}

/* ------------------------------- tables ------------------------------- */

function renameTable({ schema, table, to, engine }) {
  const d = dialect(engine);
  return `ALTER TABLE ${relOf(d, schema, table)}\n  RENAME TO ${d.q(checkName(to, 'New name'))};`;
}

function dropTable({ schema, table, kind = 'r', cascade = false, engine }) {
  const d = dialect(engine);
  const what = kind === 'v' ? 'VIEW' : kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE';
  return `DROP ${what} ${relOf(d, schema, table)}${cascade && d.cascade ? ' CASCADE' : ''};`;
}

function truncateTable({ schema, table, restartIdentity = false, cascade = false, engine }) {
  const d = dialect(engine);
  let sql = `TRUNCATE TABLE ${relOf(d, schema, table)}`;
  if (restartIdentity && d.restartIdentity) sql += ' RESTART IDENTITY';
  if (cascade && d.cascade) sql += ' CASCADE';
  return `${sql};`;
}

/* ------------------------------ indexes ------------------------------ */

/** What the server would call it if you did not: table_col_col_idx. */
function defaultIndexName({ table, columns, unique = false }) {
  const parts = [table, ...columns.map((c) => String(c).replace(/[^a-zA-Z0-9_]/g, '_'))];
  const base = `${parts.join('_')}${unique ? '_key' : '_idx'}`;
  return base.length > 63 ? base.slice(0, 63) : base;
}

function createIndex({
  schema, table, columns, unique = false, method = '', name = '',
  concurrently = false, where = '', engine,
} = {}) {
  const d = dialect(engine);
  const cols = (columns || []).map((c) => String(c).trim()).filter(Boolean);
  if (!cols.length) throw new Error('Pick at least one column.');
  const idx = String(name || '').trim() || defaultIndexName({ table, columns: cols, unique });
  checkName(idx, 'Index name');
  const m = String(method || '').trim();

  // A bare column name is quoted; anything else is an expression and must be
  // parenthesized, which is how both engines want it written.
  const colSql = cols
    .map((c) => (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c) ? d.q(c) : `(${checkFragment(c, 'Index expression')})`))
    .join(', ');

  let sql = d.indexHead({ unique, concurrently: concurrently && d.concurrently, name: d.q(idx) });
  sql += d.indexBody({
    relName: relOf(d, schema, table),
    method: m && m !== 'btree' ? d.q(m) : '',
    cols: colSql,
  });
  const w = String(where || '').trim();
  if (w) sql += `\n  WHERE ${checkFragment(w, 'WHERE clause')}`;
  return `${sql};`;
}

/* ----------------------------- databases ----------------------------- */

/**
 * A database is the one thing you cannot create from inside itself on some
 * servers, and the one thing you certainly cannot create inside a transaction
 * on Postgres. Both are the caller's problem; this only writes the statement.
 */
function createDatabase({ name, owner = '', encoding = '', template = '', charset = '', collation = '', engine } = {}) {
  const d = dialect(engine);
  const n = checkName(name, 'Database name');
  return d.createDatabase({
    name: d.q(n),
    owner: owner.trim() ? d.q(owner.trim()) : '',
    template: template.trim() ? d.q(template.trim()) : '',
    encoding: encoding.trim() ? lit(encoding.trim()) : '',
    charset: charset.trim() ? checkFragment(charset.trim(), 'Character set') : '',
    collation: collation.trim() ? checkFragment(collation.trim(), 'Collation') : '',
  });
}

function dropDatabase({ name, engine } = {}) {
  const d = dialect(engine);
  return `DROP DATABASE ${d.q(checkName(name, 'Database name'))};`;
}

/* ------------------------------ schemas ------------------------------ */

function createSchema({ name, owner = '', engine } = {}) {
  const d = dialect(engine);
  const n = d.q(checkName(name, 'Schema name'));
  const o = String(owner || '').trim();
  return `CREATE SCHEMA ${n}${o ? ` AUTHORIZATION ${d.q(o)}` : ''};`;
}

function dropSchema({ name, cascade = false, engine } = {}) {
  const d = dialect(engine);
  const n = d.q(checkName(name, 'Schema name'));
  return `DROP SCHEMA ${n}${cascade && d.cascade ? ' CASCADE' : ''};`;
}

/* ------------------------------- tables ------------------------------- */

/**
 * One column of a CREATE TABLE, in the order each engine wants its parts.
 *
 * `identity` is the "give me a key that counts itself up" flag rather than a
 * spelling: Postgres writes GENERATED ALWAYS AS IDENTITY and MySQL writes
 * AUTO_INCREMENT, which additionally has to be a key, which is why a column
 * marked identity is marked primary too when nothing else is.
 */
function columnDef(d, { name, type, notNull = false, defaultExpr = '', identity = false, primaryKey = false }) {
  const col = d.q(checkName(name, 'Column name'));
  const t = checkFragment(type, 'Type');
  const parts = [col, t];
  if (identity) {
    if (d.id === 'mysql') {
      // MySQL puts NOT NULL AUTO_INCREMENT and takes no default.
      parts.push('NOT NULL', d.identity());
    } else {
      parts.push(d.identity());
    }
  } else {
    const def = String(defaultExpr || '').trim();
    if (d.id === 'mysql') {
      if (notNull) parts.push('NOT NULL');
      if (def) parts.push(`DEFAULT ${checkFragment(def, 'Default')}`);
    } else {
      if (def) parts.push(`DEFAULT ${checkFragment(def, 'Default')}`);
      if (notNull) parts.push('NOT NULL');
    }
  }
  if (primaryKey) parts.push('PRIMARY KEY');
  return `  ${parts.join(' ')}`;
}

/**
 * columns: [{ name, type, notNull, defaultExpr, identity, primaryKey }]
 *
 * A single primary key column is written inline, which reads better. Two or
 * more become a table-level PRIMARY KEY, because inline cannot say "these
 * together".
 */
function createTable({ schema, table, columns = [], ifNotExists = false, engine } = {}) {
  const d = dialect(engine);
  const name = checkName(table, 'Table name');
  const cols = columns.filter((c) => String(c && c.name || '').trim());
  if (!cols.length) throw new Error('A table needs at least one column.');

  const keys = cols.filter((c) => c.primaryKey || (c.identity && !cols.some((o) => o.primaryKey)));
  const inlineKey = keys.length === 1 ? keys[0] : null;

  const lines = cols.map((c) => columnDef(d, { ...c, primaryKey: c === inlineKey }));
  if (keys.length > 1) {
    lines.push(`  PRIMARY KEY (${keys.map((c) => d.q(c.name)).join(', ')})`);
  }

  const head = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${relOf(d, schema, name)}`;
  return `${head} (\n${lines.join(',\n')}\n);`;
}

/* ------------------------------ indexes ------------------------------ */

function dropIndex({ schema, table, name, concurrently = false, cascade = false, engine } = {}) {
  const d = dialect(engine);
  return d.dropIndex({
    schema: schema ? d.q(schema) : '',
    table: table ? d.q(table) : '',
    name: d.q(checkName(name, 'Index name')),
    concurrently: concurrently && d.concurrently,
    cascade: cascade && d.cascade,
  });
}

module.exports = {
  q, rel, lit, checkFragment, checkName, quoterFor, dialect,
  createDatabase, dropDatabase, createSchema, dropSchema, createTable, dropIndex,
  addColumn, dropColumn, renameColumn, alterColumnType, setNotNull, setDefault,
  renameTable, dropTable, truncateTable,
  createIndex, defaultIndexName,
};
