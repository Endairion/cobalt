'use strict';

/**
 * CSV, read and written.
 *
 * A real parser rather than `split(',')`, for the same reason the statement
 * splitter is a real one: quoted fields hold commas and newlines, and a file
 * exported from a spreadsheet will have both.
 *
 * One convention worth knowing, and it is Postgres's own COPY convention: an
 * empty unquoted field is NULL, an empty quoted field ("") is the empty string.
 * That is the only way a CSV can say which it meant, and a tool that collapses
 * the two will quietly turn every blank string in your table into a NULL.
 */

const DELIMITERS = [',', ';', '\t', '|'];

/** Guess the delimiter from the first line, outside quotes. */
function sniffDelimiter(text) {
  const line = firstLogicalLine(text);
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuotes = !inQuotes; continue; }
      if (!inQuotes && c === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** The first row, which may span several physical lines if a field is quoted. */
function firstLogicalLine(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (c === '\n' || c === '\r')) return text.slice(0, i);
  }
  return text;
}

/**
 * parseCsv(text, opts) -> { delimiter, header, rows, issues }
 *
 * `rows` are arrays of string|null, padded or trimmed to the header width.
 * `issues` describes rows whose width did not match, rather than throwing —
 * one bad line in a large file should not cost you the other ten thousand.
 */
function parseCsv(text, { delimiter = null, hasHeader = true } = {}) {
  const src = String(text == null ? '' : text).replace(/^﻿/, '');
  const d = delimiter || sniffDelimiter(src);

  const records = [];
  let field = '';
  let row = [];
  let quoted = false;       // this field was written with quotes
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    // Unquoted empty means absent; quoted empty means an empty string.
    row.push(field === '' && !quoted ? null : field);
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    // A trailing newline should not produce a row of one empty field.
    if (!(row.length === 1 && row[0] === null)) records.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; quoted = true; i++; continue; }
    if (c === d) { endField(); i++; continue; }
    if (c === '\r') { i += src[i + 1] === '\n' ? 2 : 1; endRow(); continue; }
    if (c === '\n') { i++; endRow(); continue; }
    field += c; i++;
  }
  // Whatever is left over is the last row, unless the file ended on a newline.
  if (field !== '' || quoted || row.length) endRow();

  const issues = [];
  if (!records.length) return { delimiter: d, header: [], rows: [], issues };

  const header = hasHeader
    ? records[0].map((h, n) => (h == null || h === '' ? `column${n + 1}` : String(h).trim()))
    : records[0].map((_, n) => `column${n + 1}`);
  const body = hasHeader ? records.slice(1) : records;

  const width = header.length;
  const rows = body.map((r, n) => {
    if (r.length !== width) {
      issues.push({ line: n + (hasHeader ? 2 : 1), got: r.length, want: width });
      if (r.length < width) return r.concat(new Array(width - r.length).fill(null));
      return r.slice(0, width);
    }
    return r;
  });

  return { delimiter: d, header, rows, issues };
}

/** Quote a field only when it needs it, the way a spreadsheet writes one. */
function csvField(value, delimiter = ',') {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '""';                     // so it reads back as an empty string
  return new RegExp(`["\r\n${delimiter === '|' ? '\\|' : delimiter}]`).test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function toCsv(columns, rows, { delimiter = ',', eol = '\r\n' } = {}) {
  const out = [columns.map((c) => csvField(c, delimiter)).join(delimiter)];
  for (const r of rows) out.push(r.map((v) => csvField(v, delimiter)).join(delimiter));
  return out.join(eol);
}

module.exports = { parseCsv, toCsv, csvField, sniffDelimiter };
