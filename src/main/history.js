'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Query history, stored as JSON Lines.
 *
 * Append-only on purpose: a query is recorded on every run, so rewriting a
 * whole JSON document each time would mean re-serialising thousands of entries
 * for each Ctrl+Enter. One `appendFileSync` of a single line costs nothing.
 * The file is trimmed back to `maxEntries` when it outgrows that.
 */
class History {
  constructor(file, { maxEntries = 5000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.seq = 0;
  }

  append(entry) {
    const record = {
      id: `h${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      at: new Date().toISOString(),
      sql: String(entry.sql || '').trim(),
      connectionId: entry.connectionId || null,
      connectionName: entry.connectionName || null,
      database: entry.database || null,
      durationMs: entry.durationMs == null ? null : Math.round(entry.durationMs),
      rowCount: entry.rowCount == null ? null : entry.rowCount,
      error: entry.error || null,
      kind: entry.kind || 'query',
    };
    if (!record.sql) return null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
    } catch { return null; }        // history is a convenience, never fatal
    return record;
  }

  /** Every entry, oldest first. Unparseable lines are skipped rather than fatal. */
  all() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn write, skip it */ }
    }
    return out;
  }

  /**
   * Newest first, optionally filtered. Consecutive runs of the same statement
   * on the same connection collapse into one row carrying a count — otherwise
   * iterating on a query with Ctrl+Enter buries everything else.
   */
  search({ q = '', connectionId = null, limit = 200, collapse = true, failedOnly = false } = {}) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    let rows = this.all().reverse();

    if (connectionId) rows = rows.filter((r) => r.connectionId === connectionId);
    if (failedOnly) rows = rows.filter((r) => r.error);
    if (terms.length) {
      rows = rows.filter((r) => {
        const hay = `${r.sql} ${r.connectionName || ''} ${r.database || ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }

    if (collapse) {
      const out = [];
      for (const r of rows) {
        const prev = out[out.length - 1];
        if (prev && prev.sql === r.sql && prev.connectionId === r.connectionId) {
          prev.runs++;
          prev.firstAt = r.at;
          // Keep the best timing seen for the statement, not the last one.
          if (r.durationMs != null && (prev.durationMs == null || r.durationMs < prev.durationMs)) {
            prev.durationMs = r.durationMs;
          }
          continue;
        }
        out.push({ ...r, runs: 1, firstAt: r.at });
        if (out.length >= limit) break;
      }
      return out;
    }
    return rows.slice(0, limit);
  }

  stats() {
    const rows = this.all();
    return {
      entries: rows.length,
      oldest: rows.length ? rows[0].at : null,
      bytes: (() => { try { return fs.statSync(this.file).size; } catch { return 0; } })(),
    };
  }

  clear() {
    try { fs.rmSync(this.file, { force: true }); } catch { /* nothing to remove */ }
  }

  /** Drop the oldest entries once the file outgrows maxEntries. */
  trim() {
    const rows = this.all();
    if (rows.length <= this.maxEntries) return rows.length;
    const kept = rows.slice(rows.length - this.maxEntries);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
    return kept.length;
  }
}

module.exports = { History };
