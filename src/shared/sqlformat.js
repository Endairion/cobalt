'use strict';

/**
 * A SQL formatter.
 *
 * The one rule that matters: formatting must never change what a statement
 * means. So this tokenizes first — strings, dollar-quoted bodies, quoted
 * identifiers and comments come through byte for byte — and only ever decides
 * where the whitespace goes. There is a test that re-tokenizes the output and
 * asserts the significant tokens are identical to the input's, which is the
 * property worth guarding; the exact indentation is taste.
 *
 * Keyword case is normalized because a formatter that leaves `SELECT` and
 * `select` side by side has not really done the job. Identifiers are never
 * touched: on a case-sensitive quoted name that would be a rename.
 */

const { splitStatements } = require('../main/sqlsplit.js');

/* ------------------------------ tokenizer ------------------------------ */

const KEYWORDS = new Set(['select', 'from', 'where', 'group', 'by', 'having', 'order', 'limit',
  'offset', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'lateral', 'on', 'using',
  'union', 'intersect', 'except', 'all', 'distinct', 'as', 'and', 'or', 'not', 'in', 'exists',
  'between', 'like', 'ilike', 'similar', 'is', 'null', 'true', 'false', 'case', 'when', 'then',
  'else', 'end', 'insert', 'into', 'values', 'update', 'set', 'delete', 'returning', 'with',
  'recursive', 'create', 'alter', 'drop', 'table', 'view', 'index', 'unique', 'primary', 'key',
  'foreign', 'references', 'constraint', 'default', 'column', 'add', 'rename', 'to', 'cascade',
  'restrict', 'begin', 'commit', 'rollback', 'asc', 'desc', 'nulls', 'first', 'last', 'over',
  'partition', 'window', 'filter', 'within', 'fetch', 'next', 'rows', 'only', 'conflict', 'do',
  'nothing', 'explain', 'analyze', 'truncate', 'grant', 'revoke', 'cast', 'array', 'any', 'some']);

/** Words that start a clause, so they go on a line of their own. */
const CLAUSE_STARTERS = new Set(['select', 'from', 'where', 'having', 'union', 'intersect',
  'except', 'values', 'set', 'returning', 'limit', 'offset', 'window', 'fetch']);

/** Two-word clause starters, matched on the pair. */
const CLAUSE_PAIRS = [['group', 'by'], ['order', 'by'], ['insert', 'into'], ['delete', 'from'],
  ['cross', 'join'], ['inner', 'join'], ['left', 'join'], ['right', 'join'], ['full', 'join'],
  ['on', 'conflict']];

const JOIN_WORDS = new Set(['join', 'left', 'right', 'inner', 'full', 'cross', 'lateral']);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);

/**
 * tokenize(text) -> [{ kind, text }]
 *   kind: 'space' | 'lineComment' | 'blockComment' | 'string' | 'dollar' |
 *         'ident' | 'word' | 'number' | 'punct'
 */
function tokenize(text) {
  const out = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (isSpace(ch)) {
      let j = i;
      while (j < n && isSpace(text[j])) j++;
      out.push({ kind: 'space', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out.push({ kind: 'lineComment', text: text.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
        else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      out.push({ kind: 'blockComment', text: text.slice(i, j) });
      i = j;
      continue;
    }

    // E'' escape strings take backslash escapes; ordinary ones do not.
    if ((ch === 'E' || ch === 'e') && next === "'") {
      let j = i + 2;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") { j++; break; }
        j++;
      }
      out.push({ kind: 'string', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; }
        if (text[j] === "'") { j++; break; }
        j++;
      }
      out.push({ kind: 'string', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === '"' || ch === '`') {
      const close = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === close && text[j + 1] === close) { j += 2; continue; }
        if (text[j] === close) { j++; break; }
        j++;
      }
      out.push({ kind: 'ident', text: text.slice(i, j) });
      i = j;
      continue;
    }

    // Dollar quoting: $$ … $$ or $tag$ … $tag$. A lone $1 is a placeholder.
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out.push({ kind: 'dollar', text: text.slice(i, end) });
        i = end;
        continue;
      }
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      let j = i;
      while (j < n && /[0-9.eE]/.test(text[j])) {
        if ((text[j] === 'e' || text[j] === 'E') && /[+-]/.test(text[j + 1] || '')) j++;
        j++;
      }
      out.push({ kind: 'number', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (isWordChar(ch)) {
      let j = i;
      while (j < n && isWordChar(text[j])) j++;
      out.push({ kind: 'word', text: text.slice(i, j) });
      i = j;
      continue;
    }

    // Multi-character operators, longest first, so `<=` is one token not two.
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (['!~*'].includes(three)) { out.push({ kind: 'punct', text: three }); i += 3; continue; }
    if (['<=', '>=', '<>', '!=', '||', '::', '->', '=>', '~*', '!~', '@>', '<@', '#>', '&&'].includes(two)) {
      out.push({ kind: 'punct', text: two });
      i += 2;
      continue;
    }
    out.push({ kind: 'punct', text: ch });
    i++;
  }
  return out;
}

/** The tokens that carry meaning — what formatting must leave untouched. */
const significant = (tokens) => tokens.filter((t) => t.kind !== 'space');

/* ------------------------------ formatter ------------------------------ */

const lower = (t) => t.text.toLowerCase();
const isKeyword = (t) => t && t.kind === 'word' && KEYWORDS.has(lower(t));

function format(sql, { indent = '  ', keywordCase = 'lower', maxInlineList = 72 } = {}) {
  const tokens = tokenize(String(sql == null ? '' : sql));
  const code = significant(tokens);
  if (!code.length) return String(sql == null ? '' : sql).trim();

  const out = [];
  let line = '';
  let depth = 0;          // parenthesis nesting
  let clauseIndent = 0;   // extra indent for continuation lines

  const pad = () => indent.repeat(Math.max(0, depth + clauseIndent));
  const flush = () => {
    if (line.trim().length) out.push(line.replace(/\s+$/, ''));
    line = '';
  };
  const newline = () => { flush(); line = pad(); };
  const add = (text, { space = true } = {}) => {
    if (!line.trim()) line = pad() + text;
    // Nothing is ever separated from the paren it opens: count( *) is wrong.
    else if (line.endsWith('(')) line += text;
    else line += (space ? ' ' : '') + text;
  };

  const word = (t) => {
    if (t.kind !== 'word') return t.text;
    if (!KEYWORDS.has(lower(t))) return t.text;    // identifiers keep their case
    return keywordCase === 'upper' ? t.text.toUpperCase()
      : keywordCase === 'preserve' ? t.text
        : t.text.toLowerCase();
  };

  /** How much is between here and the matching close paren, on one line. */
  const inlineWidth = (start) => {
    let d = 0;
    let width = 0;
    for (let k = start; k < code.length; k++) {
      const t = code[k];
      if (t.kind === 'punct' && t.text === '(') d++;
      if (t.kind === 'punct' && t.text === ')') {
        d--;
        if (d === 0) return width + 1;
      }
      if (t.kind === 'lineComment') return Infinity;   // never fold a comment onto one line
      width += t.text.length + 1;
      if (width > maxInlineList) return Infinity;
    }
    return Infinity;
  };

  // Paren depths being laid out on one line, so their commas do not break.
  const inlineDepths = new Set();
  let lastClauseWasJoin = false;

  for (let i = 0; i < code.length; i++) {
    const t = code[i];
    const prev = code[i - 1];
    const next = code[i + 1];
    const lw = lower(t);

    if (t.kind === 'lineComment' || t.kind === 'blockComment') {
      // A comment that followed code on its line stays there — including when
      // a comma has already moved us to the next line, which is the common
      // case of a commented-out column in a select list.
      if (prev && sameLineInSource(tokens, prev, t)) {
        if (!line.trim() && out.length) line = out.pop();
        add(t.text);
        if (t.kind === 'lineComment') { flush(); line = pad(); }
      } else { newline(); add(t.text); flush(); }
      continue;
    }

    if (t.kind === 'punct') {
      if (t.text === '(') {
        const fold = inlineWidth(i) !== Infinity;
        add('(', { space: !(prev && prev.kind === 'word' && !isKeyword(prev)) && !(prev && prev.kind === 'punct' && prev.text === '(') });
        depth++;
        if (fold) inlineDepths.add(depth);
        else if (next && !(next.kind === 'punct' && next.text === ')')) newline();
        continue;
      }
      if (t.text === ')') {
        const wasInline = inlineDepths.has(depth);
        inlineDepths.delete(depth);
        depth--;
        if (!wasInline) newline();
        add(')', { space: false });
        continue;
      }
      if (t.text === ',') {
        add(',', { space: false });
        if (!inlineDepths.has(depth)) newline();
        continue;
      }
      if (t.text === ';') {
        add(';', { space: false });
        flush();
        continue;
      }
      if (t.text === '.' || t.text === '::') {
        add(t.text, { space: false });
        continue;
      }
      add(t.text);
      continue;
    }

    if (t.kind === 'word') {
      const pair = CLAUSE_PAIRS.find(([a, b]) => a === lw && next && lower(next) === b);
      const startsClause = !inlineDepths.has(depth)
        && (CLAUSE_STARTERS.has(lw) || !!pair || (JOIN_WORDS.has(lw) && startsJoin(code, i)));

      if (startsClause) {
        clauseIndent = 0;
        newline();
        add(word(t));
        if (pair) { add(word(next)); i++; }
        lastClauseWasJoin = JOIN_WORDS.has(lw);
        clauseIndent = 1;
        continue;
      }

      // AND / OR line up under the condition they extend.
      if ((lw === 'and' || lw === 'or') && !inlineDepths.has(depth) && clauseIndent > 0) {
        newline();
        add(word(t));
        continue;
      }
      // Only a join's ON starts a line. `distinct on (a)` and `on conflict`
      // are not that, and breaking there reads as a missing clause.
      if (lw === 'on' && !inlineDepths.has(depth) && lastClauseWasJoin) {
        newline();
        add(word(t));
        lastClauseWasJoin = false;
        continue;
      }

      const glue = prev && prev.kind === 'punct' && (prev.text === '.' || prev.text === '::' || prev.text === '(');
      add(word(t), { space: !glue });
      continue;
    }

    // string, dollar, ident, number — verbatim
    const glue = prev && prev.kind === 'punct' && (prev.text === '.' || prev.text === '::' || prev.text === '(');
    add(t.text, { space: !glue });
  }

  flush();
  return out.join('\n').replace(/[ \t]+$/gm, '');
}

/** Was there a newline between these two tokens in the original text? */
function sameLineInSource(tokens, a, b) {
  const ia = tokens.indexOf(a);
  const ib = tokens.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  for (let k = ia + 1; k < ib; k++) {
    if (tokens[k].kind === 'space' && tokens[k].text.includes('\n')) return false;
  }
  return true;
}

/**
 * `left`, `full` and friends only start a clause when a JOIN actually follows;
 * `left(name, 3)` is a function call and `full` could be a column.
 */
function startsJoin(code, i) {
  const lw = lower(code[i]);
  if (lw === 'join') return true;
  for (let k = i + 1; k < Math.min(i + 4, code.length); k++) {
    const w = lower(code[k]);
    if (w === 'join') return true;
    if (!JOIN_WORDS.has(w) && w !== 'outer') return false;
  }
  return false;
}

/** Every statement in a script, formatted, blank line between them. */
function formatScript(text, opts = {}) {
  const parts = splitStatements(String(text == null ? '' : text));
  if (!parts.length) return String(text == null ? '' : text).trim();
  return parts.map((p) => format(p.sql, opts)).join('\n\n');
}

module.exports = { format, formatScript, tokenize, significant, KEYWORDS };
