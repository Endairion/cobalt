'use strict';

/**
 * Turning a result into text: CSV, JSON, SQL INSERTs, Markdown.
 *
 * Values arrive as the text Postgres produced (see the type parsers in
 * src/main/db.js), so the job here is quoting, not conversion. The one place
 * that matters is JSON: a `bigint` or `numeric` that came back as "1.10" must
 * not be turned into a JS number on the way out, because JSON.stringify would
 * then write 1.1 and a 20-digit id would lose its tail. Numbers are emitted
 * from their own text when they are exactly representable, and quoted when
 * they are not — which is what every careful JSON API does with bigints.
 */

const { toCsv } = require('./csv.js');
const { quoterFor } = require('./ddl.js');

/** Column oids whose text is a JSON number, not a string. */
const INT_OIDS = new Set([20, 21, 23, 26]);          // int8, int2, int4, oid
const FLOAT_OIDS = new Set([700, 701]);              // float4, float8
const NUMERIC_OID = 1700;
const BOOL_OID = 16;
const JSON_OIDS = new Set([114, 3802]);

const isSafeNumber = (s) => {
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return false;
  // Round-tripping through a JS number has to give back the same text, or the
  // value is not representable and belongs in quotes.
  return String(Number(s)) === s;
};


/**
 * What class of value this column holds. Drivers report `kind` directly; the
 * OID fallback is for results that predate it — and OIDs must not be consulted
 * on another engine, where the same number means something else entirely.
 */
function kindOf(column = {}) {
  if (column.kind) return column.kind;
  const oid = column.dataTypeID;
  if (oid === BOOL_OID) return 'bool';
  if (JSON_OIDS.has(oid)) return 'json';
  if (INT_OIDS.has(oid)) return 'int';
  if (oid === NUMERIC_OID) return 'decimal';
  if (FLOAT_OIDS.has(oid)) return 'float';
  return 'text';
}

function jsonValue(v, column = {}) {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  const kind = kindOf(column);

  if (kind === 'bool') return s === 't' || s === 'true' || s === '1' ? 'true' : 'false';
  if (kind === 'json') return s;                         // already a document
  if (kind === 'int' || kind === 'decimal' || kind === 'float') {
    // Emit the digits as written when JSON can hold them, quote them when it
    // cannot, rather than silently rounding.
    return isSafeNumber(s) ? s : JSON.stringify(s);
  }
  return JSON.stringify(s);
}

function toJson(columns, rows, { indent = 2 } = {}) {
  const pad = ' '.repeat(indent);
  const objects = rows.map((r) => {
    const fields = columns.map((c, i) => `${pad}${pad}${JSON.stringify(c.name)}: ${jsonValue(r[i], c)}`);
    return `${pad}{\n${fields.join(',\n')}\n${pad}}`;
  });
  return objects.length ? `[\n${objects.join(',\n')}\n]` : '[]';
}

/** One value, as a SQL literal. */
function sqlLiteral(v, column = {}) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  const kind = kindOf(column);
  if (kind === 'bool') return s === 't' || s === 'true' || s === '1' ? 'TRUE' : 'FALSE';
  // Everything else is written as a quoted literal and left for the server to
  // cast on the way in — including numbers, so a numeric keeps its scale.
  if (kind === 'int' && /^-?\d+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function toSqlInserts(columns, rows, { schema = 'public', table = 'table_name', batch = 100, engine = 'postgres' } = {}) {
  if (!rows.length) return `-- no rows\n`;
  // Quote the way the engine you exported from does, so the statements can be
  // pasted straight back into it.
  const qid = quoterFor(engine);
  const rel = schema ? `${qid(schema)}.${qid(table)}` : qid(table);
  const cols = columns.map((c) => qid(c.name)).join(', ');
  const out = [];
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values = chunk.map((r) => `  (${columns.map((c, n) => sqlLiteral(r[n], c)).join(', ')})`);
    out.push(`INSERT INTO ${rel} (${cols}) VALUES\n${values.join(',\n')};`);
  }
  return `${out.join('\n\n')}\n`;
}

/** A Markdown table, with pipes inside cells escaped so the table survives. */
function toMarkdown(columns, rows) {
  const cell = (v) => (v === null || v === undefined
    ? ''
    : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
  const head = `| ${columns.map((c) => cell(c.name)).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${columns.map((c, i) => cell(r[i])).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

const FORMATS = [
  { id: 'csv', label: 'CSV', ext: 'csv', bom: true },
  { id: 'tsv', label: 'TSV (tab separated)', ext: 'tsv', bom: true },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'sql', label: 'SQL INSERT statements', ext: 'sql' },
  { id: 'markdown', label: 'Markdown table', ext: 'md' },
];

/** columns: [{name, dataTypeID}], rows: [[value|null]] */
function render(format, columns, rows, opts = {}) {
  const names = columns.map((c) => c.name);
  switch (format) {
    case 'csv': return toCsv(names, rows, { delimiter: ',' });
    case 'tsv': return toCsv(names, rows, { delimiter: '\t' });
    case 'json': return toJson(columns, rows, opts);
    case 'sql': return toSqlInserts(columns, rows, opts);
    case 'markdown': return toMarkdown(columns, rows);
    default: throw new Error(`Unknown export format "${format}".`);
  }
}

module.exports = { render, FORMATS, toJson, toSqlInserts, toMarkdown, jsonValue, sqlLiteral, isSafeNumber, kindOf };
