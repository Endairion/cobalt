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
      `alter table ${relName}\n  alter column ${col} type ${type}${using ? `\n  using ${using}` : ''};`,
    setNotNull: ({ relName, col, notNull }) =>
      `alter table ${relName}\n  alter column ${col} ${notNull ? 'set' : 'drop'} not null;`,
    addColumnTail: ({ type, def, notNull }) =>
      `${type}${def ? ` default ${def}` : ''}${notNull ? ' not null' : ''}`,
    indexHead: ({ unique, concurrently, name }) =>
      `create ${unique ? 'unique ' : ''}index ${concurrently ? 'concurrently ' : ''}${name}`,
    indexBody: ({ relName, method, cols }) =>
      `\n  on ${relName}${method ? ` using ${method}` : ''} (${cols})`,
  },
  mysql: {
    id: 'mysql',
    q: qMysql,
    cascade: false,
    concurrently: false,
    restartIdentity: false,
    usingCast: false,
    alterType: ({ relName, col, type }) =>
      `alter table ${relName}\n  modify column ${col} ${type};`,
    // MODIFY restates the column, so the type has to come along for the ride.
    setNotNull: ({ relName, col, notNull, currentType }) =>
      `alter table ${relName}\n  modify column ${col} ${currentType || 'text'}${notNull ? ' not null' : ' null'};`,
    addColumnTail: ({ type, def, notNull }) =>
      `${type}${notNull ? ' not null' : ''}${def ? ` default ${def}` : ''}`,
    indexHead: ({ unique, name }) => `create ${unique ? 'unique ' : ''}index ${name}`,
    indexBody: ({ relName, method, cols }) =>
      `${method ? ` using ${method}` : ''}\n  on ${relName} (${cols})`,
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
  return `alter table ${relOf(d, schema, table)}\n  add column ${d.q(col)} ${tail};`;
}

function dropColumn({ schema, table, name, cascade = false, engine }) {
  const d = dialect(engine);
  const suffix = cascade && d.cascade ? ' cascade' : '';
  return `alter table ${relOf(d, schema, table)}\n  drop column ${d.q(checkName(name, 'Column name'))}${suffix};`;
}

function renameColumn({ schema, table, name, to, engine }) {
  const d = dialect(engine);
  return `alter table ${relOf(d, schema, table)}\n  rename column ${d.q(checkName(name, 'Column name'))} to ${d.q(checkName(to, 'New name'))};`;
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
    ? `alter table ${relName}\n  alter column ${col} set default ${checkFragment(def, 'Default')};`
    : `alter table ${relName}\n  alter column ${col} drop default;`;
}

/* ------------------------------- tables ------------------------------- */

function renameTable({ schema, table, to, engine }) {
  const d = dialect(engine);
  return `alter table ${relOf(d, schema, table)}\n  rename to ${d.q(checkName(to, 'New name'))};`;
}

function dropTable({ schema, table, kind = 'r', cascade = false, engine }) {
  const d = dialect(engine);
  const what = kind === 'v' ? 'view' : kind === 'm' ? 'materialized view' : 'table';
  return `drop ${what} ${relOf(d, schema, table)}${cascade && d.cascade ? ' cascade' : ''};`;
}

function truncateTable({ schema, table, restartIdentity = false, cascade = false, engine }) {
  const d = dialect(engine);
  let sql = `truncate table ${relOf(d, schema, table)}`;
  if (restartIdentity && d.restartIdentity) sql += ' restart identity';
  if (cascade && d.cascade) sql += ' cascade';
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
  if (w) sql += `\n  where ${checkFragment(w, 'WHERE clause')}`;
  return `${sql};`;
}

module.exports = {
  q, rel, lit, checkFragment, checkName, quoterFor, dialect,
  addColumn, dropColumn, renameColumn, alterColumnType, setNotNull, setDefault,
  renameTable, dropTable, truncateTable,
  createIndex, defaultIndexName,
};
