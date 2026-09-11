'use strict';

/**
 * Split a SQL script into individual statements.
 * Understands: line comments, block comments (nested), single-quoted strings
 * with '' escapes, double-quoted identifiers, E'' escape strings with backslash
 * escapes, and PostgreSQL dollar-quoting ($$ ... $$ / $tag$ ... $tag$).
 *
 * Returns [{ sql, start, end }] with offsets into the original text so the UI can
 * map an error position or the cursor back onto the source document.
 */
function splitStatements(text) {
  const out = [];
  let i = 0;
  let stmtStart = 0;
  const n = text.length;

  const push = (end) => {
    const raw = text.slice(stmtStart, end);
    if (raw.trim().length) out.push({ sql: raw, start: stmtStart, end });
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; }
        else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if ((ch === 'E' || ch === 'e') && next === "'") {
      i += 2;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/.exec(text.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      push(i + 1);
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** The statement containing `pos`, else the nearest preceding one. */
function statementAt(text, pos) {
  const stmts = splitStatements(text);
  if (!stmts.length) return null;
  for (const s of stmts) {
    if (pos >= s.start && pos <= s.end) return s;
  }
  return stmts[stmts.length - 1];
}

module.exports = { splitStatements, statementAt };
