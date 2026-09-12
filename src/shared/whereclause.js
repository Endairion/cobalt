'use strict';

/**
 * Validation for a hand-written filter expression.
 *
 * The expression goes into `where (...)` on a wrapper around the query, so the
 * one thing that must not happen is it ending the statement and starting
 * another. Writing SQL here is otherwise no different from writing it in the
 * editor — it is the same person and the same connection — so this checks the
 * shape rather than trying to judge intent.
 *
 * Rejected: semicolons, comments and dollar quoting outside string literals,
 * and unbalanced parentheses. All three are ways to escape the wrapper.
 */
function validateWhere(expr) {
  const text = String(expr == null ? '' : expr);
  if (!text.trim()) return { ok: true, empty: true };

  let depth = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "'") {                       // string literal, '' escapes a quote
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return { ok: false, error: 'Unclosed quote.' };
      continue;
    }

    if (ch === '"') {                       // quoted identifier
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return { ok: false, error: 'Unclosed double quote.' };
      continue;
    }

    if (ch === '-' && next === '-') return { ok: false, error: 'A filter cannot contain a comment.' };
    if (ch === '/' && next === '*') return { ok: false, error: 'A filter cannot contain a comment.' };
    if (ch === ';') return { ok: false, error: 'A filter cannot contain a semicolon.' };
    if (ch === '$' && /^\$[A-Za-z_-￿]*\$/.test(text.slice(i, i + 40))) {
      return { ok: false, error: 'A filter cannot use dollar quoting.' };
    }

    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth < 0) return { ok: false, error: 'Unbalanced parentheses.' };
    }
    i++;
  }

  if (depth !== 0) return { ok: false, error: 'Unbalanced parentheses.' };
  return { ok: true, empty: false };
}

/** Join an existing expression with another condition. */
function andWith(expr, condition) {
  const a = String(expr || '').trim();
  const b = String(condition || '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} and ${b}`;
}

module.exports = { validateWhere, andWith };
