'use strict';

/**
 * How to show one cell value at a size you can read.
 *
 * The grid hands everything over as the text Postgres produced, and that is the
 * point: a `numeric` or a big integer inside a JSON document must survive being
 * pretty-printed. So the formatter below re-indents JSON by walking the text and
 * never parses a value — `JSON.parse` would round `12345678901234567890` and
 * `1.10` on the way through, and the viewer would be quietly lying about what is
 * in the row.
 */

/** Re-indent JSON without parsing any of its values.
 *
 * Returns `{ ok: false }` for anything that is not JSON, which is also how
 * classify() decides a text column happens to be holding a document. Two
 * adjacent values with no comma between them slip through — this checks shape,
 * not grammar — but nothing is reformatted unless every bare token is a real
 * JSON literal, so ordinary prose and Postgres array syntax are refused.
 */
function prettyJson(text, indent = '  ') {
  const s = String(text);
  let out = '';
  let depth = 0;
  let i = 0;
  // A value is owed after `{`, `[`, `,` and `:` — and by the document itself.
  // Without this, `{"a":}` walks through balanced and gets reformatted as JSON.
  let owed = true;
  const nl = () => { out += `\n${indent.repeat(depth)}`; };

  while (i < s.length) {
    const ch = s[i];

    if (ch === '"') {
      // Copy the string through verbatim, escapes and all.
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      if (j >= s.length) return { ok: false, text: s };
      out += s.slice(i, j + 1);
      i = j + 1;
      owed = false;
      continue;
    }

    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }

    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === close) { out += ch + close; i = j + 1; owed = false; continue; }   // empty stays inline
      depth++;
      out += ch;
      nl();
      i++;
      owed = true;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0 || owed) return { ok: false, text: s };
      nl();
      out += ch;
      i++;
      owed = false;
      continue;
    }

    if (ch === ',') {
      if (owed) return { ok: false, text: s };
      out += ','; nl(); i++; owed = true; continue;
    }
    if (ch === ':') { out += ': '; i++; owed = true; continue; }

    // A bare token: number, true, false or null — copied as written.
    let j = i;
    while (j < s.length && !/[\s{}[\],:"]/.test(s[j])) j++;
    const token = s.slice(i, j);
    if (!/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(token)) return { ok: false, text: s };
    out += token;
    i = j;
    owed = false;
  }

  if (depth !== 0 || owed) return { ok: false, text: s };
  return { ok: true, text: out };
}

/** Postgres renders bytea as `\xdeadbeef`; show it the way a hex editor would. */
function hexDump(value, { maxBytes = 4096 } = {}) {
  const body = String(value).replace(/^\\x/i, '');
  const total = Math.floor(body.length / 2);
  const shown = Math.min(total, maxBytes);
  const lines = [];
  for (let off = 0; off < shown; off += 16) {
    const bytes = [];
    for (let b = off; b < Math.min(off + 16, shown); b++) bytes.push(body.slice(b * 2, b * 2 + 2));
    const hex = bytes.join(' ').padEnd(47, ' ');
    const ascii = bytes.map((h) => {
      const n = parseInt(h, 16);
      return n >= 32 && n <= 126 ? String.fromCharCode(n) : '.';
    }).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return { text: lines.join('\n'), total, shown, truncated: shown < total };
}

const BYTEA_RE = /^\\x(?:[0-9a-fA-F]{2})+$/;

/** 'null' | 'bytea' | 'json' | 'multiline' | 'text'. */
function classify(value, column = {}) {
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  const type = String(column.dataType || '').toLowerCase();
  if (type === 'bytea' || BYTEA_RE.test(s)) return 'bytea';
  if (type === 'json' || type === 'jsonb') return 'json';
  const t = s.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && prettyJson(t).ok) return 'json';
  if (s.includes('\n')) return 'multiline';
  return 'text';
}

/** UTF-8 length, since that is what the column actually costs. */
function byteLength(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return Buffer.byteLength(s, 'utf8');
}

const fmtBytes = (n) => (n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Everything the panel needs to draw one value: what it is, how big, and the
 * text to show — pretty-printed, hex-dumped or as-is.
 */
function present(value, column = {}, opts = {}) {
  const kind = classify(value, column);
  if (kind === 'null') {
    return { kind, text: '', display: 'NULL', meta: 'NULL', chars: 0, bytes: 0, lines: 0, pretty: false };
  }
  const raw = String(value);
  const chars = raw.length;
  const bytes = byteLength(raw);

  if (kind === 'bytea') {
    const dump = hexDump(raw, opts);
    return {
      kind, text: raw, display: dump.text, pretty: true, chars, bytes: dump.total,
      lines: dump.text ? dump.text.split('\n').length : 0,
      truncated: dump.truncated,
      meta: `${fmtBytes(dump.total)} binary${dump.truncated ? ` · showing first ${dump.shown}` : ''}`,
    };
  }

  if (kind === 'json' && opts.pretty !== false) {
    const p = prettyJson(raw);
    const display = p.ok ? p.text : raw;
    return {
      kind, text: raw, display, pretty: p.ok, chars, bytes,
      lines: display.split('\n').length,
      meta: `${p.ok ? 'JSON' : 'JSON (unparsed)'} · ${fmtBytes(bytes)}`,
    };
  }

  const lines = raw.split('\n').length;
  return {
    kind, text: raw, display: raw, pretty: false, chars, bytes, lines,
    meta: `${chars} char${chars === 1 ? '' : 's'} · ${fmtBytes(bytes)}${lines > 1 ? ` · ${lines} lines` : ''}`,
  };
}

/** One line of a value, for the row list — no newlines, clipped. */
function oneLine(value, limit = 200) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

module.exports = { prettyJson, hexDump, classify, present, oneLine, byteLength, fmtBytes };
