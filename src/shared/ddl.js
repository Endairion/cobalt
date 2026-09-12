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
 */

const RESERVED = new Set(['user', 'order', 'table', 'select', 'from', 'where', 'group', 'default',
  'check', 'column', 'constraint', 'index', 'primary', 'references', 'unique', 'all', 'and', 'any',
  'array', 'as', 'case', 'cast', 'desc', 'asc', 'limit', 'offset', 'union', 'using', 'when', 'with',
  'to', 'end', 'is', 'in', 'not', 'null', 'true', 'false', 'analyze', 'between', 'both', 'collate',
  'create', 'current_date', 'do', 'else', 'except', 'for', 'foreign', 'grant', 'having', 'into',
  'join', 'leading', 'like', 'only', 'or', 'placing', 'returning', 'then', 'trailing', 'values']);

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Bare when it is safe to be, quoted when it is not — so the SQL reads well. */
const q = (s) => (/^[a-z_][a-z0-9_]*$/.test(String(s)) && !RESERVED.has(String(s)) ? String(s) : quote(s));

const rel = (schema, table) => `${q(schema)}.${q(table)}`;

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
  if (s.length > 63) throw new Error(`${what} is longer than 63 characters, which Postgres will truncate.`);
  return s;
}

/* ------------------------------ columns ------------------------------ */

function addColumn({ schema, table, name, type, notNull = false, defaultExpr = '' }) {
  const col = checkName(name, 'Column name');
  const t = checkFragment(type, 'Type');
  const def = String(defaultExpr || '').trim();
  let sql = `alter table ${rel(schema, table)}\n  add column ${q(col)} ${t}`;
  if (def) sql += ` default ${checkFragment(def, 'Default')}`;
  if (notNull) sql += ' not null';
  return `${sql};`;
}

function dropColumn({ schema, table, name, cascade = false }) {
  return `alter table ${rel(schema, table)}\n  drop column ${q(checkName(name, 'Column name'))}${cascade ? ' cascade' : ''};`;
}

function renameColumn({ schema, table, name, to }) {
  return `alter table ${rel(schema, table)}\n  rename column ${q(checkName(name, 'Column name'))} to ${q(checkName(to, 'New name'))};`;
}

function alterColumnType({ schema, table, name, type, using = '' }) {
  const col = q(checkName(name, 'Column name'));
  let sql = `alter table ${rel(schema, table)}\n  alter column ${col} type ${checkFragment(type, 'Type')}`;
  const u = String(using || '').trim();
  if (u) sql += `\n  using ${checkFragment(u, 'USING expression')}`;
  return `${sql};`;
}

function setNotNull({ schema, table, name, notNull }) {
  return `alter table ${rel(schema, table)}\n  alter column ${q(checkName(name, 'Column name'))} ${notNull ? 'set' : 'drop'} not null;`;
}

function setDefault({ schema, table, name, defaultExpr }) {
  const col = q(checkName(name, 'Column name'));
  const def = String(defaultExpr == null ? '' : defaultExpr).trim();
  return def
    ? `alter table ${rel(schema, table)}\n  alter column ${col} set default ${checkFragment(def, 'Default')};`
    : `alter table ${rel(schema, table)}\n  alter column ${col} drop default;`;
}

/* ------------------------------- tables ------------------------------- */

function renameTable({ schema, table, to }) {
  return `alter table ${rel(schema, table)}\n  rename to ${q(checkName(to, 'New name'))};`;
}

function dropTable({ schema, table, kind = 'r', cascade = false }) {
  const what = kind === 'v' ? 'view' : kind === 'm' ? 'materialized view' : 'table';
  return `drop ${what} ${rel(schema, table)}${cascade ? ' cascade' : ''};`;
}

function truncateTable({ schema, table, restartIdentity = false, cascade = false }) {
  let sql = `truncate table ${rel(schema, table)}`;
  if (restartIdentity) sql += ' restart identity';
  if (cascade) sql += ' cascade';
  return `${sql};`;
}

/* ------------------------------ indexes ------------------------------ */

/** What Postgres would call it if you did not: table_col_col_idx. */
function defaultIndexName({ table, columns, unique = false }) {
  const parts = [table, ...columns.map((c) => String(c).replace(/[^a-zA-Z0-9_]/g, '_'))];
  const base = `${parts.join('_')}${unique ? '_key' : '_idx'}`;
  return base.length > 63 ? base.slice(0, 63) : base;
}

function createIndex({ schema, table, columns, unique = false, method = '', name = '', concurrently = false, where = '' }) {
  const cols = (columns || []).map((c) => String(c).trim()).filter(Boolean);
  if (!cols.length) throw new Error('Pick at least one column.');
  const idx = String(name || '').trim() || defaultIndexName({ table, columns: cols, unique });
  checkName(idx, 'Index name');
  const m = String(method || '').trim();

  let sql = `create ${unique ? 'unique ' : ''}index ${concurrently ? 'concurrently ' : ''}${q(idx)}\n  on ${rel(schema, table)}`;
  if (m && m !== 'btree') sql += ` using ${q(m)}`;
  // A bare column name is quoted; anything else is an expression and must be
  // parenthesized, which is also how Postgres wants it written.
  sql += ` (${cols.map((c) => (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c) ? q(c) : `(${checkFragment(c, 'Index expression')})`)).join(', ')})`;
  const w = String(where || '').trim();
  if (w) sql += `\n  where ${checkFragment(w, 'WHERE clause')}`;
  return `${sql};`;
}

module.exports = {
  q, rel, lit, checkFragment, checkName,
  addColumn, dropColumn, renameColumn, alterColumnType, setNotNull, setDefault,
  renameTable, dropTable, truncateTable,
  createIndex, defaultIndexName,
};
