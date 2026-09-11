# Changelog

Generated from `src/shared/changelog.js` by `npm run changelog` — edit that file, not this one.
The same data is what the app shows under Help → What's New.

## 0.4.0 — Version history in the app
*2026-09-11*

Cobalt now knows what version it is and what changed.

### Added
- About window showing the app version, the Electron/Chromium/Node/pg versions behind it, and the server you are connected to.
- What's New, opened from Help or automatically the first time you run a version you have not seen before.
- A changelog kept as data, so the in-app history and CHANGELOG.md can never drift apart — `npm run changelog` regenerates the file.
- The version number sits next to the app name in the sidebar; click it to open the history.

### Changed
- Releases before this one were reconstructed from the commit history and tagged retroactively; package.json had claimed 0.1.0 the whole time.

## 0.3.0 — Connection manager
*2026-09-11*

Several databases open at once, and every tab says which one it runs on.

### Added
- A connection manager (Ctrl+Shift+O): searchable list, reorder, duplicate, colours, groups, and an edit form with Test and Connect.
- Per-tab connection binding, shown as a chip in the editor toolbar. Ctrl+K moves the tab to another connection, connecting it first if needed.
- Connection colours run down the tab strip, so a production tab is hard to mistake for a local one.
- Tabs remember their connection across restarts and reattach when it opens.

### Changed
- The sidebar is a tree rooted at each saved connection instead of a flat chip list, so several can be open and expanded side by side without disconnecting.

### Fixed
- Rebinding a tab releases its old backend session, so temp tables and transactions no longer leak across databases.

## 0.2.1 — Read-only means read-only
*2026-09-11*

Found by pointing the app at a real database.

### Added
- test/realdb.js, a read-only probe that points the data layer at an existing database and reports schema load time, editability across every table, DDL generation and a wide read.

### Changed
- The read-only flag is now enforced in the main process: a write is refused there even if the renderer asks for one.

### Fixed
- A connection marked read-only still showed "+ Row", "Delete row" and "Commit". Nothing could actually be written, but a production connection that advertises edit controls is a trust problem in its own right.

## 0.2.0 — Filter row
*2026-09-11*

Filtering searches the whole table, not the page you already loaded.

### Added
- A filter box under every column header (Ctrl+Shift+F). Filters run on the server: the query is wrapped in a subquery, the condition goes outside it, and any trailing LIMIT/OFFSET is hoisted out past the filter.
- Forgiving filter syntax — a bare word means contains on text columns and equals elsewhere, with >=, !=, wildcards, regex, in-lists and null forms available explicitly.
- Filtered results stay editable: Postgres propagates each column's origin table through the wrapper, so you can filter down to a row and edit it in place.
- Filter values are bound as parameters and operators come from a fixed allowlist, so nothing typed into a box reaches the SQL text.

## 0.1.0 — First run
*2026-09-11*

A PostgreSQL editor with an editable results grid.

### Added
- Electron shell with saved connections; passwords encrypted through the OS keychain and never handed to the renderer.
- CodeMirror 6 SQL editor with autocomplete fed from the live schema, and a separate undo history per tab.
- A real statement splitter that understands comments, escape strings, quoted identifiers and dollar-quoting, so function bodies survive intact.
- Virtualized results grid, editable when the result comes from one base table and carries a primary or unique key; otherwise it says why not.
- Grid edits stage locally and commit as one transaction that rolls back whole on any failure.
- A dedicated backend connection per tab, so temp tables, SET and explicit transactions behave as they do in psql. Ctrl+. cancels through pg_cancel_backend.
- Wide types (bigint, numeric, timestamps, json) arrive as the exact text Postgres produced, so JS number and Date coercion cannot mangle a round-trip.
- Schema tree, quick-open table palette, command palette, CSV export, and an error panel with SQLSTATE, detail, hint and a caret under the error position.
