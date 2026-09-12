# Changelog

Generated from `src/shared/changelog.js` by `npm run changelog` — edit that file, not this one.
The same data is what the app shows under Help → What's New.

## 0.14.0 — Change the schema without writing the SQL
*2026-09-12*

Add a column, create an index, rename, drop - from the sidebar, with the statement shown first.

### Added
- Right-clicking a table in the sidebar now opens a menu rather than dumping its DDL into a tab: Browse, Show DDL, Copy name, Add Column, Create Index, Rename, Empty Table and Drop. Right-clicking a column offers Rename, Change Type, Set Default, Set or Drop NOT NULL, and Drop Column.
- Every one of those opens a small form with the exact statement underneath it, rebuilt on each keystroke. You can copy it or send it to the editor instead of running it, so nothing happens that you have not read first. Dropping and emptying ask again through the OS dialog.
- A view is not offered the table-only actions, and is dropped as a view rather than as a table. On a read-only connection every changing action is disabled with a line saying why - and the main process refuses schema changes regardless of what the window asks for, the same way it already refuses grid writes.

### Changed
- Schema changes run on the pool rather than in the tab session, so one sitting in an open transaction cannot swallow them.
- The schema tree carries each column default, which is what the Set Default box starts from.

## 0.13.0 — The value inspector
*2026-09-12*

Read a value that does not fit in a cell, and edit it in a box big enough to type in.

### Added
- A panel beside the grid shows the cell under the cursor in full - Ctrl+I, or the Value button on the result toolbar. JSON is pretty-printed, bytea is a hex dump with the printable bytes beside it, long text wraps, and NULL is labelled rather than left blank. It follows the cursor as you move.
- A Row view lists every column of the current row down the page, so a wide table can be read without scrolling sideways. Clicking a field takes the cursor to that column, bringing it back if you had hidden it.
- Editing from the panel stages the change exactly as typing in a cell does: the row goes amber, the pending bar appears, Ctrl+Z takes it back, and nothing reaches the database until Commit. Ctrl+Enter saves, Esc cancels, and there is a Set NULL button. A read-only result offers no editor at all.

### Changed
- JSON is re-indented by walking the text rather than through JSON.parse, which would round a 20-digit key and drop the trailing zero from a numeric on the way through. The Raw button shows the text exactly as stored. Anything that is not JSON - prose, a Postgres array - is left alone rather than reformatted.

## 0.12.2 — Menu items respond to the mouse
*2026-09-12*

Pressing a submenu item closed the menu before the click landed.

### Changed
- The menu test presses the way a mouse does, sending mousedown first and only delivering a click if the item survived it. Dispatching a bare click event, which is what it did before, reaches a detached element quite happily and so reported the menu as working.

### Fixed
- Choosing anything from a submenu did nothing. A submenu is its own element rather than a child of the menu that opened it, so the parent treated a press inside it as a press outside itself and dismissed the whole chain on mousedown - leaving nothing for the click to land on. A press anywhere in the open chain now belongs to that menu.

## 0.12.1 — Start connected
*2026-09-12*

With more than one connection saved, the app opened none of them.

### Added
- Whichever connections were open when you last quit are reopened, and the one you were working in stays focused. A connection deleted in the meantime is skipped rather than failing the restore.

### Changed
- A command that needs a database now opens the connection picker instead of only complaining, so the refusal is something you can act on.

### Fixed
- Startup only opened a connection when exactly one was saved. With several, nothing connected, so every command that needs a database refused - which reads as the whole menu being broken rather than as nothing being connected.
- A byte order mark in the connections or history file no longer wipes it. JSON.parse throws on one and the file was treated as unreadable, which an editor on Windows could cause by saving a hand edit.

## 0.12.0 — One filter for the whole result
*2026-09-12*

Write a condition instead of hunting for the column.

### Added
- Anything Postgres accepts in a WHERE clause works, including functions, casts and JSON operators. It is validated first for semicolons, comments, dollar quoting and unbalanced parentheses - the ways an expression could end the statement and start another - and a mistake in the SQL itself comes back from the server and is shown beside the box.
- A Columns button chooses which columns to show. Hidden columns leave the grid, the CSV export and the clipboard, and keyboard navigation skips them; the last visible column cannot be hidden.
- Right-clicking a cell offers "Filter by this value", which writes the condition into the bar and leaves it there to edit, and "Hide this column".

### Changed
- The per-column filter boxes are replaced by a single expression bar (Ctrl+Shift+F). Write something like "balance > 500 and notes is not null" and it applies to the whole result, so a column far off to the right no longer has to be scrolled to, and one condition can span several columns.

## 0.11.2 — Typing in a filter box stays there
*2026-09-12*

Filter keystrokes were reaching the grid and editing a cell.

### Changed
- The cell cursor dims while a filter box has focus, so it no longer looks like the grid is still taking input.

### Fixed
- Typing in a filter box opened a cell editor on whatever the grid cursor was on, and pressing Enter to apply a filter did the same. The filter inputs sit inside the grid element, so their keystrokes bubbled to the grid handler, which starts editing on any printable key. The grid now ignores keys that came from an input.
- Reading a cell beyond the last row crashed on an empty result, where row 0 exists on screen but addresses nothing. Row lookup returns a "no such row" result now and every caller handles it.

## 0.11.1 — Nothing is written until you say so
*2026-09-12*

Filtering never changes data, and now the app makes that obvious.

### Added
- A bar above the grid appears the moment an edit is staged: what is staged, that nothing has been written to the database yet, and buttons to commit or discard. Staged edits were already local-only, but the grid gave no reassurance of it.
- Ctrl+Z in the grid steps back one staged change, so a cell typed into by accident no longer means discarding every other edit to be rid of it.
- The filter row is labelled "filter" in the row-number gutter, since it sits directly above the data and a stray keystroke in the grid starts editing a cell rather than filtering.
- Tests that fingerprint the whole table before and after filtering and assert it is unchanged, and that a filter can only ever produce a SELECT.

## 0.11.0 — Browse a table by clicking it
*2026-09-12*

No query to write, and none in the way.

### Added
- Clicking a table in the sidebar shows its rows immediately, with the editor out of the way and the grid taking the whole pane. Filtering, sorting, paging and editing all work exactly as they do on a query result.
- A header names the table and the connection, with Refresh and "Open as query", which hands the statement to a normal tab so nothing is hidden from you - only moved aside.

### Changed
- One browse tab per connection follows what you click rather than opening a tab per table. Double-clicking still opens a separate, persistent query tab, and the sidebar highlights whichever table is being browsed.
- The arrow beside a table expands its columns; clicking the name browses it. Previously the whole row toggled columns and only a double-click opened anything.

## 0.10.1 — Stored passwords
*2026-09-12*

Plaintext entries get encrypted, and an unreadable one says so.

### Added
- Any password sitting in plain text is re-encrypted through the OS keychain the next time the app starts. That is the documented fallback for machines without safeStorage, and it is also what a connection imported by hand looks like; either way there is no reason to leave it readable once encryption is available.

### Fixed
- A stored password that cannot be decrypted now says so. safeStorage keys off the profile Local State file, so a connections file copied or restored without it decrypts to nothing, and the driver was reporting the opaque "client password must be a string" instead.

## 0.10.0 — The menu comes back
*2026-09-12*

Frameless removed the menu bar, and with it the way to find anything.

### Added
- A menu button at the left of the tab strip opens File, Edit, Query, Go, View and Help as a cascading menu, each item showing its keyboard shortcut. Going frameless had left every feature reachable only by a shortcut you had to already know.
- Explain, Benchmark and History now have buttons in the editor toolbar, plus an overflow button that opens the Query menu where the grid actions live.
- The test harness can press real keys, which is how the accelerators are checked to still reach the app on a frameless window rather than assumed to.

### Changed
- The menu is defined once, in shared/commands.js. The main process builds the Electron menu from it (which is what registers the accelerators even though no menu bar is drawn) and the app renders the same tree. A test asserts every command in it is handled and every role is performed, so a menu entry cannot quietly do nothing.

## 0.9.0 — Foreign key navigation
*2026-09-12*

Follow a value to the row it points at, or back to everything pointing at it.

### Added
- Right-click a cell to travel: a foreign key column offers the row it references, and any row offers a "Referenced by" list of the tables pointing back at it. Either opens a new tab already filtered to the matching rows.
- Foreign key columns are marked FK in the grid header, with the table they reference in the tooltip.
- The same menu carries filter-by-this-value, copy value and copy column name.
- Composite keys travel as a unit, and a table with two keys to the same target keeps them separate, so each offers its own destination.

### Changed
- Foreign keys are read once per connection alongside the schema and re-read when it is refreshed.

### Fixed
- Key column names came back as the raw string "{customer_id}" rather than a list: array_agg over a name column yields name[], which the driver has no parser for. They are cast to text[] now.

## 0.8.0 — Query history
*2026-09-12*

Every statement you run is recorded and searchable.

### Added
- Query history (Ctrl+H): every run is recorded with its connection, database, duration, row count and any error. Search across statements and connection names, filter to the current connection or to failures, and put a statement back in the editor or open it in a new tab.
- Consecutive runs of the same statement collapse into one row with a run count, so iterating on a query with Ctrl+Enter does not bury everything else. The fastest of those runs is the time shown.
- History is stored as JSON Lines and appended one line at a time, so recording costs nothing on the query path, and it is trimmed to the newest 5,000 entries at startup. A half-written line is skipped rather than losing the file.

### Changed
- Test runs no longer interrupt you: the window opens on a second display when there is one, stays out of the taskbar, and never takes focus.

### Fixed
- The history panel collapsed into a single column because the generic modal body rule outranked its own grid. It no longer borrows that class, and a test asserts the two panes really sit side by side.

## 0.7.0 — Server-side paging and sorting
*2026-09-12*

Results are no longer capped, and sorting reaches the whole table.

### Added
- Keyset paging: once the result carries a unique key and every sort column is non-nullable and sorted the same way, the next page is fetched with a row comparison rather than OFFSET, so deep pages stay fast. Anything else falls back to OFFSET, and the toolbar says which is in use.
- The unique key is appended to whatever you sorted by, making the order total. Without that, paging silently drops and repeats rows wherever the sort has ties.
- A count-all button runs COUNT(*) over the whole filtered result, on request rather than automatically, since it can be slow.

### Changed
- Results page in as you scroll instead of stopping at a hidden 10,000 row cap. The toolbar shows how many rows have been fetched, a plus when there are more, and a page size picker.
- Clicking a column header sorts on the server, so the top row is the maximum in the table rather than the maximum of the rows already loaded. Clicking cycles ascending, descending, unsorted.
- Opening a table from the sidebar no longer appends LIMIT 500 - paging governs instead, so you can browse the whole thing. A LIMIT you write yourself still caps the set, and pages are served inside it.
- The CSV button says "CSV (loaded)" while more rows remain, because it exports what has been fetched.

## 0.6.0 — Performance tools
*2026-09-11*

Time two queries against each other, and see why one wins.

### Added
- Benchmark (Ctrl+Shift+B) times several statements against each other and reports median, min, p95, max and spread for each, with a bar chart whose lighter band is the interquartile range.
- Runs are interleaved (A, B, C, A, B, C...) rather than grouped, so a busy moment on the machine hits every variant instead of landing entirely on whichever went first. Warmup runs are discarded so first-read-from-disk cost stays out of the numbers.
- The verdict is conservative: a win is only declared when the p75 of the fastest variant still beats the p25 of the runner-up. Queries a few percent apart on a noisy laptop are reported as too close to call rather than crowned.
- Benchmarking a statement that writes is refused unless you turn on roll-back-each-run, so timing an INSERT ten times cannot leave ten rows behind.
- Explain (Ctrl+Shift+E) and Explain Analyze (Ctrl+Alt+E) draw the plan as a tree with self time per node, its share of execution, actual against estimated rows, cost and buffers. The slowest node by self time is flagged, and nodes whose row estimate is out by 10x or more are called out because that is usually why the planner chose the shape it did.
- EXPLAIN ANALYZE on a statement that writes runs inside a transaction that is rolled back; plain EXPLAIN never executes anything.
- Sequential scans over large tables and bad row estimates surface as plain-English hints above the tree.

### Fixed
- EXPLAIN (FORMAT JSON) output arrived as text, because this app deliberately keeps json columns as raw text for lossless round-trips. The plan is parsed explicitly now.

## 0.5.1 — Tab numbering
*2026-09-11*

New tabs stop counting into the hundreds.

### Changed
- Tabs named after something else - a table, an opened .sql file - no longer consume a Query number.

### Fixed
- The tab label and the internal tab id shared one counter, so every close pushed the next "Query N" higher - and because closing the last tab opens a replacement, holding down the close button ran the number away. Twenty-five clicks left the next tab called "Query 27". Ids still never repeat; the label is now the lowest number not already on screen, so closing Query 2 frees that name.

## 0.5.0 — Frameless window
*2026-09-11*

The OS title bar is gone; the tab strip is the title bar.

### Added
- The maximise glyph swaps to a restore glyph, and the chrome dims when the window loses focus, the way native apps do.
- Rounded window corners while restored, squared off when maximised.

### Changed
- The window is frameless. Minimise, maximise and close are drawn at the end of the tab strip as thin monochrome glyphs that light up on hover, with close turning red. macOS keeps its traffic lights, inset into the sidebar header.
- Dragging the tab strip moves the window and double-clicking it still maximises, because the whole strip is a drag region and tabs opt back out.

### Fixed
- The collapsed filter row was still occupying its 26 pixels under the grid header: an author display rule was overriding the [hidden] attribute, which left a dead band above the first row and shifted the virtualisation maths by the same amount.

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
