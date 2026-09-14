'use strict';

/**
 * Looking for a value across every column of every table.
 *
 * This is the "where on earth is that string stored" question, and it is
 * expensive by nature: nothing here can use an index. So the work is bounded
 * rather than open-ended — a row cap per table, and a caller that can stop
 * between tables — and the panel says plainly how much it actually scanned.
 * A search that quietly gave up would be worse than one that says "the first
 * 50,000 rows of each".
 *
 * One query per table, not per column: it asks for a count and a sample per
 * candidate column in a single pass, so a hundred-column table is still one
 * trip to the server.
 */

/**
 * A needle is a literal, not a pattern. `100%` must match the string "100%"
 * and not every row in the table, so the LIKE wildcards are escaped — along
 * with the escape character itself, which is the one people forget.
 */
const LIKE_ESCAPE = '!';

function escapeLike(s) {
  return String(s == null ? '' : s).replace(/([!%_])/g, `${LIKE_ESCAPE}$1`);
}

/** Single-quoted SQL literal. */
const lit = (s) => `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;

/**
 * Types worth looking inside. Text and its relatives always; numbers, dates and
 * booleans only when asked, since "1" would otherwise match half the database.
 * A json column is searched as its text, which is usually what you want.
 */
const TEXTY = /^(text|varchar|character varying|char|character|citext|name|uuid|json|jsonb|bpchar|tinytext|mediumtext|longtext|enum|set)\b/i;
const NUMERICY = /^(int|integer|smallint|bigint|numeric|decimal|real|double|float|money|serial|bigserial|tinyint|mediumint|bit)\b/i;
const DATEY = /^(date|time|timestamp|datetime|year|interval)\b/i;
const BOOLY = /^(bool|boolean)\b/i;
const BINARY = /^(bytea|blob|binary|varbinary|tinyblob|mediumblob|longblob|geometry)\b/i;

function isSearchableType(type, { includeNumeric = false } = {}) {
  const t = String(type || '').trim();
  if (!t) return false;
  if (BINARY.test(t)) return false;            // hex haystacks help nobody
  if (TEXTY.test(t)) return true;
  if (!includeNumeric) return false;
  return NUMERICY.test(t) || DATEY.test(t) || BOOLY.test(t);
}

/**
 * The condition that matches one column, plus the value to bind.
 * `mode` is 'contains' | 'exact' | 'starts'.
 */
function matchCondition(d, colSql, { mode = 'contains', caseSensitive = false, needle, placeholder }) {
  const asText = d.textCast(colSql);
  const esc = escapeLike(needle);
  const pattern = mode === 'exact' ? null
    : mode === 'starts' ? `${esc}%`
      : `%${esc}%`;

  if (mode === 'exact') {
    return caseSensitive
      ? { sql: `${asText} = ${placeholder}`, value: needle }
      : { sql: `lower(${asText}) = lower(${placeholder})`, value: needle };
  }
  // ILIKE only exists on Postgres; elsewhere the collation already ignores case
  // and lower() on both sides is the portable way to be sure.
  const op = caseSensitive ? 'like' : d.mapOperator('ilike');
  if (!caseSensitive && op === 'like') {
    return { sql: `lower(${asText}) like lower(${placeholder}) escape '${LIKE_ESCAPE}'`, value: pattern };
  }
  return { sql: `${asText} ${op} ${placeholder} escape '${LIKE_ESCAPE}'`, value: pattern };
}

/**
 * One table's worth of search: how many rows matched in each column, and one
 * example from each, in a single query.
 *
 * `rowCap` bounds the scan by wrapping the table in a limited subquery. It makes
 * the answer "of the first N rows" rather than "of the table", which the caller
 * is expected to say out loud.
 */
function buildSearchQuery({
  dialect, schema, table, columns, needle,
  mode = 'contains', caseSensitive = false, rowCap = null, sampleChars = 160,
}) {
  const d = dialect;
  if (!columns || !columns.length) throw new Error('No searchable columns in this table.');

  const values = [];
  const parts = [];
  const cols = columns.map((c) => d.quote(c.name)).join(', ');

  columns.forEach((c, i) => {
    const colSql = d.quote(c.name);
    // A placeholder per *occurrence*, not per column. Postgres would happily
    // let $1 appear twice for one bound value; MySQL's ? is positional and
    // consumes the next value each time, so reusing one would run the list dry
    // and leave a bare ? in the SQL.
    const condition = () => {
      const ph = d.placeholder(values.length + 1);
      const { sql, value } = matchCondition(d, colSql, { mode, caseSensitive, needle, placeholder: ph });
      values.push(value);
      return sql;
    };
    parts.push(`sum(case when ${condition()} then 1 else 0 end) as m${i}`);
    parts.push(`max(case when ${condition()} then left(${d.textCast(colSql)}, ${Number(sampleChars) || 160}) end) as s${i}`);
  });

  const from = rowCap
    ? `(select ${cols} from ${d.qualify(schema, table)} limit ${Math.max(1, Math.floor(rowCap))}) as ${d.quote('_cobalt_scan')}`
    : `${d.qualify(schema, table)}`;

  const select = parts.join(',\n       ');
  return {
    text: `select ${select},\n       count(*) as scanned\nfrom ${from}`,
    values,
  };
}

/**
 * A WHERE expression that finds the matching rows, for opening the table with
 * the filter already applied. The needle goes in as a literal because the
 * filter bar takes an expression, not parameters.
 *
 * Keywords are capitalized here and not in buildSearchQuery above, because this
 * one is read: it lands in the filter bar for you to edit. That one is only
 * ever sent to the server.
 */
function buildRowFilter({ dialect, column, needle, mode = 'contains', caseSensitive = false }) {
  const d = dialect;
  const colSql = d.quote(column);
  const asText = d.textCast(colSql);
  if (mode === 'exact') {
    return caseSensitive ? `${asText} = ${lit(needle)}` : `lower(${asText}) = lower(${lit(needle)})`;
  }
  const esc = escapeLike(needle);
  const pattern = mode === 'starts' ? `${esc}%` : `%${esc}%`;
  const op = caseSensitive ? 'like' : d.mapOperator('ilike');
  if (!caseSensitive && op === 'like') {
    return `lower(${asText}) LIKE lower(${lit(pattern)}) ESCAPE '${LIKE_ESCAPE}'`;
  }
  return `${asText} ${op.toUpperCase()} ${lit(pattern)} ESCAPE '${LIKE_ESCAPE}'`;
}

/** Which columns of a relation are worth searching, in order. */
function searchableColumns(relation, opts) {
  return (relation.columns || []).filter((c) => isSearchableType(c.type, opts));
}

module.exports = {
  escapeLike, isSearchableType, buildSearchQuery, buildRowFilter, searchableColumns, matchCondition,
};
