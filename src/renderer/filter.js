/**
 * Parse what a person types into a filter box into {op, value}.
 *
 * Deliberately forgiving: a bare word means "contains" on text columns and
 * "equals" everywhere else, which is what you want nine times out of ten.
 * An explicit operator always wins.
 *
 *   bob            text column   -> ilike %bob%
 *   bob            other column  -> = bob
 *   >= 100                       -> >= 100
 *   != draft                     -> <> draft
 *   %ob%                         -> ilike %ob%
 *   ~ ^user[0-9]+                -> regex
 *   in a, b, c                   -> in (a, b, c)
 *   null / is null               -> is null
 *   !null / is not null          -> is not null
 *   'literal spaces'             -> = literal spaces  (quotes force exact)
 */

// Longest first: '<=' must win over '<', 'not ilike' over 'ilike'.
const PREFIX_OPS = [
  'is not null', 'is null', 'not ilike', 'not like',
  '!~*', '!~', '~*', '~',
  '>=', '<=', '<>', '!=', '=', '>', '<',
  'ilike', 'like', 'not in', 'in',
];

const TEXTISH = /^(text|varchar|character|char|name|citext|uuid|json|jsonb|xml|inet|cidr|macaddr)/i;

export function parseFilter(input, column) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (lower === 'null' || lower === 'is null') return { op: 'is null' };
  if (lower === '!null' || lower === 'not null' || lower === 'is not null') return { op: 'is not null' };

  for (const op of PREFIX_OPS) {
    if (!lower.startsWith(op)) continue;
    // A word operator must be followed by whitespace, or "inbox" parses as IN.
    const isWord = /^[a-z]/.test(op);
    const after = raw.slice(op.length);
    if (isWord && after && !/^\s/.test(after)) continue;
    const rest = after.trim();

    if (op === 'in' || op === 'not in') {
      const values = splitList(rest);
      if (!values.length) return { error: `${op.toUpperCase()} needs at least one value` };
      return { op, values };
    }
    if (!rest) return { error: `${op} needs a value` };
    return { op, value: unquote(rest) };
  }

  // No operator given.
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return { op: '=', value: unquote(raw) };
  if (raw.includes('%') || raw.includes('_')) return { op: 'ilike', value: raw };
  if (isTextish(column)) return { op: 'ilike', value: `%${raw}%` };
  return { op: '=', value: raw };
}

function isTextish(column) {
  if (!column) return false;
  if (column.dataType) return TEXTISH.test(column.dataType);
  return false;
}

/** Split "a, b, 'c, d'" honouring quotes. */
function splitList(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'") && t.length > 1) ||
      (t.startsWith('"') && t.endsWith('"') && t.length > 1)) {
    return t.slice(1, -1);
  }
  return t;
}

/** Short human description, for the toolbar pill. */
export function describeFilter(f) {
  if (!f) return '';
  if (f.op === 'is null' || f.op === 'is not null') return f.op;
  if (f.op === 'in' || f.op === 'not in') return `${f.op} (${f.values.join(', ')})`;
  return `${f.op} ${f.value}`;
}
