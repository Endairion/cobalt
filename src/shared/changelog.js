'use strict';

/**
 * The changelog, as data.
 *
 * This is the single source of truth: the app renders it in About / What's New,
 * and `npm run changelog` writes CHANGELOG.md from it. The newest entry's
 * version must match package.json — test/version.test.js enforces that, along
 * with ordering and date sanity.
 *
 * `type` is one of: added | changed | fixed | removed.
 */

const releases = [
  {
    version: '0.6.0',
    date: '2026-09-11',
    title: 'Performance tools',
    summary: 'Time two queries against each other, and see why one wins.',
    changes: [
      { type: 'added', text: 'Benchmark (Ctrl+Shift+B) times several statements against each other and reports median, min, p95, max and spread for each, with a bar chart whose lighter band is the interquartile range.' },
      { type: 'added', text: 'Runs are interleaved (A, B, C, A, B, C...) rather than grouped, so a busy moment on the machine hits every variant instead of landing entirely on whichever went first. Warmup runs are discarded so first-read-from-disk cost stays out of the numbers.' },
      { type: 'added', text: 'The verdict is conservative: a win is only declared when the p75 of the fastest variant still beats the p25 of the runner-up. Queries a few percent apart on a noisy laptop are reported as too close to call rather than crowned.' },
      { type: 'added', text: 'Benchmarking a statement that writes is refused unless you turn on roll-back-each-run, so timing an INSERT ten times cannot leave ten rows behind.' },
      { type: 'added', text: 'Explain (Ctrl+Shift+E) and Explain Analyze (Ctrl+Alt+E) draw the plan as a tree with self time per node, its share of execution, actual against estimated rows, cost and buffers. The slowest node by self time is flagged, and nodes whose row estimate is out by 10x or more are called out because that is usually why the planner chose the shape it did.' },
      { type: 'added', text: 'EXPLAIN ANALYZE on a statement that writes runs inside a transaction that is rolled back; plain EXPLAIN never executes anything.' },
      { type: 'added', text: 'Sequential scans over large tables and bad row estimates surface as plain-English hints above the tree.' },
      { type: 'fixed', text: 'EXPLAIN (FORMAT JSON) output arrived as text, because this app deliberately keeps json columns as raw text for lossless round-trips. The plan is parsed explicitly now.' },
    ],
  },
  {
    version: '0.5.1',
    date: '2026-09-11',
    title: 'Tab numbering',
    summary: 'New tabs stop counting into the hundreds.',
    changes: [
      { type: 'fixed', text: 'The tab label and the internal tab id shared one counter, so every close pushed the next "Query N" higher - and because closing the last tab opens a replacement, holding down the close button ran the number away. Twenty-five clicks left the next tab called "Query 27". Ids still never repeat; the label is now the lowest number not already on screen, so closing Query 2 frees that name.' },
      { type: 'changed', text: 'Tabs named after something else - a table, an opened .sql file - no longer consume a Query number.' },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-09-11',
    title: 'Frameless window',
    summary: 'The OS title bar is gone; the tab strip is the title bar.',
    changes: [
      { type: 'changed', text: 'The window is frameless. Minimise, maximise and close are drawn at the end of the tab strip as thin monochrome glyphs that light up on hover, with close turning red. macOS keeps its traffic lights, inset into the sidebar header.' },
      { type: 'changed', text: 'Dragging the tab strip moves the window and double-clicking it still maximises, because the whole strip is a drag region and tabs opt back out.' },
      { type: 'added', text: 'The maximise glyph swaps to a restore glyph, and the chrome dims when the window loses focus, the way native apps do.' },
      { type: 'added', text: 'Rounded window corners while restored, squared off when maximised.' },
      { type: 'fixed', text: 'The collapsed filter row was still occupying its 26 pixels under the grid header: an author display rule was overriding the [hidden] attribute, which left a dead band above the first row and shifted the virtualisation maths by the same amount.' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-11',
    title: 'Version history in the app',
    summary: 'Cobalt now knows what version it is and what changed.',
    changes: [
      { type: 'added', text: 'About window showing the app version, the Electron/Chromium/Node/pg versions behind it, and the server you are connected to.' },
      { type: 'added', text: "What's New, opened from Help or automatically the first time you run a version you have not seen before." },
      { type: 'added', text: 'A changelog kept as data, so the in-app history and CHANGELOG.md can never drift apart — `npm run changelog` regenerates the file.' },
      { type: 'added', text: 'The version number sits next to the app name in the sidebar; click it to open the history.' },
      { type: 'changed', text: 'Releases before this one were reconstructed from the commit history and tagged retroactively; package.json had claimed 0.1.0 the whole time.' },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-11',
    title: 'Connection manager',
    summary: 'Several databases open at once, and every tab says which one it runs on.',
    changes: [
      { type: 'added', text: 'A connection manager (Ctrl+Shift+O): searchable list, reorder, duplicate, colours, groups, and an edit form with Test and Connect.' },
      { type: 'added', text: 'Per-tab connection binding, shown as a chip in the editor toolbar. Ctrl+K moves the tab to another connection, connecting it first if needed.' },
      { type: 'added', text: 'Connection colours run down the tab strip, so a production tab is hard to mistake for a local one.' },
      { type: 'added', text: 'Tabs remember their connection across restarts and reattach when it opens.' },
      { type: 'changed', text: 'The sidebar is a tree rooted at each saved connection instead of a flat chip list, so several can be open and expanded side by side without disconnecting.' },
      { type: 'fixed', text: 'Rebinding a tab releases its old backend session, so temp tables and transactions no longer leak across databases.' },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-09-11',
    title: 'Read-only means read-only',
    summary: 'Found by pointing the app at a real database.',
    changes: [
      { type: 'fixed', text: 'A connection marked read-only still showed "+ Row", "Delete row" and "Commit". Nothing could actually be written, but a production connection that advertises edit controls is a trust problem in its own right.' },
      { type: 'changed', text: 'The read-only flag is now enforced in the main process: a write is refused there even if the renderer asks for one.' },
      { type: 'added', text: 'test/realdb.js, a read-only probe that points the data layer at an existing database and reports schema load time, editability across every table, DDL generation and a wide read.' },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-11',
    title: 'Filter row',
    summary: 'Filtering searches the whole table, not the page you already loaded.',
    changes: [
      { type: 'added', text: 'A filter box under every column header (Ctrl+Shift+F). Filters run on the server: the query is wrapped in a subquery, the condition goes outside it, and any trailing LIMIT/OFFSET is hoisted out past the filter.' },
      { type: 'added', text: 'Forgiving filter syntax — a bare word means contains on text columns and equals elsewhere, with >=, !=, wildcards, regex, in-lists and null forms available explicitly.' },
      { type: 'added', text: 'Filtered results stay editable: Postgres propagates each column\'s origin table through the wrapper, so you can filter down to a row and edit it in place.' },
      { type: 'added', text: 'Filter values are bound as parameters and operators come from a fixed allowlist, so nothing typed into a box reaches the SQL text.' },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-11',
    title: 'First run',
    summary: 'A PostgreSQL editor with an editable results grid.',
    changes: [
      { type: 'added', text: 'Electron shell with saved connections; passwords encrypted through the OS keychain and never handed to the renderer.' },
      { type: 'added', text: 'CodeMirror 6 SQL editor with autocomplete fed from the live schema, and a separate undo history per tab.' },
      { type: 'added', text: 'A real statement splitter that understands comments, escape strings, quoted identifiers and dollar-quoting, so function bodies survive intact.' },
      { type: 'added', text: 'Virtualized results grid, editable when the result comes from one base table and carries a primary or unique key; otherwise it says why not.' },
      { type: 'added', text: 'Grid edits stage locally and commit as one transaction that rolls back whole on any failure.' },
      { type: 'added', text: 'A dedicated backend connection per tab, so temp tables, SET and explicit transactions behave as they do in psql. Ctrl+. cancels through pg_cancel_backend.' },
      { type: 'added', text: 'Wide types (bigint, numeric, timestamps, json) arrive as the exact text Postgres produced, so JS number and Date coercion cannot mangle a round-trip.' },
      { type: 'added', text: 'Schema tree, quick-open table palette, command palette, CSV export, and an error panel with SQLSTATE, detail, hint and a caret under the error position.' },
    ],
  },
];

const TYPES = ['added', 'changed', 'fixed', 'removed'];
const TYPE_LABEL = { added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed' };

const current = () => releases[0];

/** Releases newer than `version`, for the "what changed since you last looked" view. */
function since(version) {
  if (!version) return [];
  const i = releases.findIndex((r) => r.version === version);
  return i === -1 ? releases : releases.slice(0, i);
}

/** -1 / 0 / 1, comparing dotted numeric versions. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Group one release's changes by type, in a stable order. */
function grouped(release) {
  return TYPES
    .map((type) => ({ type, label: TYPE_LABEL[type], items: release.changes.filter((c) => c.type === type) }))
    .filter((g) => g.items.length);
}

module.exports = { releases, current, since, compareVersions, grouped, TYPES, TYPE_LABEL };
