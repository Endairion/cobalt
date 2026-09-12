# Cobalt

A fast PostgreSQL editor in the spirit of TablePlus — Electron shell, CodeMirror 6
editor, virtualized editable results grid.

```bash
npm install
npm start          # build the renderer bundle + launch
npm run dev        # same, with devtools and renderer console forwarding
```

## What it does

**Connections.** A manager (`Ctrl+Shift+O`) lists every saved connection with search,
duplicate, reorder, colour and grouping, and an edit form with Test/Connect. The sidebar
is a tree rooted at each connection, so several can be open and expanded at once and you
can jump between them without disconnecting — green dot means live, `RO` means read-only.

Each query tab is bound to one connection, shown as a chip in the editor toolbar; click
it or press `Ctrl+K` to move that tab to a different connection. Tabs remember their
connection across restarts and reattach when it opens. Connection colours run down the
tab strip so a production tab is obvious.

Whatever was connected when you last quit is reopened on the next launch, with the
connection you were working in still focused; on a first run the first saved connection
is opened so nothing sits refusing commands. Saved in `userData/cobalt-connections.json`. Passwords are encrypted through
`safeStorage`, which keys off the profile's own `Local State` file — so if you back up or
move the app data folder, take `Local State` with it or the stored passwords will not
decrypt. The app says so plainly when that happens and asks for the password again. A
password written in plain text (an imported entry, or one saved where safeStorage was
unavailable) is encrypted on the next launch. Passwords are encrypted
with the OS keychain (DPAPI on Windows, Keychain on macOS) via Electron's `safeStorage`
and never travel to the renderer — it only ever sees a `hasPassword` flag. Mark a
connection read-only to disable grid editing against production — that flag is
enforced in the main process, not just by hiding buttons, so a write is refused even
if the renderer asks for one.

**Query editor.** SQL syntax highlighting, autocomplete fed from the live schema
(tables, and columns per table), bracket matching, multi-cursor, search, fold.
The statement under the caret is tinted, and that is exactly what `Ctrl+Enter` runs —
with a selection, it runs the selection instead. Each tab keeps its own undo history.

**Statement splitting.** A real splitter, not `split(';')`: it understands line and
nested block comments, `''` escapes, `E'\'` strings, quoted identifiers, and
dollar-quoting, so function bodies survive intact.

**Sessions.** Each tab holds its own backend connection, so temp tables, `SET`, and
explicit transactions behave the way they do in `psql`. `Ctrl+.` cancels via
`pg_cancel_backend` on a side connection.

**Editable grid.** Results carry `tableID`/`columnID` from the wire protocol, which is
resolved against `pg_attribute`/`pg_index` to find the backing table and a usable key.
When a result comes from one table and contains a primary key (or any unique key), the
grid is editable; otherwise the toolbar shows a read-only pill explaining why.
Edits stage locally — dirty cells go amber, new rows green, deleted rows struck
through — and `Commit` applies the whole batch in one transaction. Any failure rolls
back everything and reports the SQLSTATE.

**Nothing is written until you commit.** Filtering, sorting and paging only ever run a
SELECT — there are tests that fingerprint the table before and after and assert it is
unchanged. Editing a cell stages the change locally: the row goes amber, a bar above the
grid says what is staged and that nothing has reached the database, and `Ctrl+Z` steps
back one change. Only Commit writes, and it shows you what it will run first.

**Values are text.** `bigint`, `numeric`, timestamps and `json` come back as the exact
text Postgres produced, so nothing is mangled by JS number or Date coercion on the way
to the grid and back.

**Filtering.** `Ctrl+Shift+F` opens one expression bar for the whole result: write
`balance > 500 and notes is not null` rather than finding each column. Anything Postgres
accepts in a `WHERE` works — functions, casts, JSON operators. It runs on the *server*:
the query is wrapped in a subquery, the condition goes on the outside, and any trailing
`LIMIT`/`OFFSET` is hoisted past it, so filtering a table view searches the whole table
rather than the page already loaded. Postgres propagates each column's origin through
the wrapper, so a filtered result stays editable.

The expression is checked first for semicolons, comments, dollar quoting and unbalanced
parentheses — the ways it could end the statement and start another — and a mistake in
the SQL itself comes back from the server and is shown beside the box. Right-click a
cell for "Filter by this value", which writes the condition into the bar for you.

**Value inspector.** `Ctrl+I` opens a panel beside the grid showing the cell under
the cursor at a size you can read: JSON pretty-printed, `bytea` as a hex dump with the
printable bytes beside it, long text wrapped, `NULL` labelled rather than blank. The
Row view lists every column of the current row down the page, so a wide table needs no
sideways scrolling; clicking a field takes the cursor there. Editing in the panel stages
the change the same way typing in a cell does - amber row, pending bar, `Ctrl+Z` to take
it back, nothing written until Commit.

The JSON is re-indented by walking the text, never through `JSON.parse`: that would
round a 20-digit key and drop the trailing zero from a `numeric` on the way through, and
the point of this panel is to show you what is actually in the row. `Raw` shows the
stored text unchanged.

**Columns.** The Columns button chooses what to show. Hidden columns leave the grid, the
CSV export and the clipboard, and arrow keys skip them.

**Errors.** Message, SQLSTATE, detail, hint, plus the offending line with a caret under
the error position — and the editor caret jumps there.

**Version history.** The changelog lives as data in `src/shared/changelog.js`. The app
renders it under Help, and `npm run changelog` regenerates `CHANGELOG.md` from the same
source, so the two cannot drift — `npm run changelog -- --check` fails the build if they
have. Help → About shows the app version alongside the Electron/Chromium/Node/pg
versions behind it and the server you are on. The first launch of a build you have not
seen opens What's New once, listing only the releases after the version you were on.
Releases are tagged in git (`v0.1.0` …).

**The menu.** The window is frameless, so there is no OS menu bar — the button at the
left of the tab strip opens the same menu, with shortcuts shown beside each item.
Explain, Benchmark and History also have toolbar buttons. It is all defined once in
`src/shared/commands.js`: the main process builds the Electron menu from it (that is
what registers the accelerators) and the app renders the same tree, so a menu item
cannot drift out of sync with what the code handles.

## Keys

| | |
|---|---|
| `Ctrl+Enter` | Run statement under cursor (or selection) |
| `Ctrl+Shift+Enter` | Run whole script |
| `Ctrl+.` | Cancel running query |
| `Ctrl+T` / `Ctrl+W` | New / close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+P` | Quick-open table |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+N` | New connection |
| `Ctrl+Shift+O` | Manage connections |
| — | Help → About / What's New / Version History |
| `Ctrl+K` | Switch this tab's connection |
| `Ctrl+R` | Refresh schema |
| `Ctrl+O` / `Ctrl+S` | Open / save .sql |
| `Ctrl+Shift+F` | Toggle the filter row |
| `Ctrl+I` | Value inspector |
| `Ctrl+H` | Query history |
| `Ctrl+Shift+B` | Benchmark statements |
| `Ctrl+Shift+E` / `Ctrl+Alt+E` | Explain / Explain analyze |
| `Ctrl+Shift+S` | Commit grid changes |
| `Ctrl+Shift+A` | Add row |
| `Ctrl+Backspace` | Toggle row delete |

In the grid: arrows/Tab move, `Enter` or typing edits, `Esc` cancels, `Ctrl+0` sets
NULL, `Ctrl+C` copies the cell. Click a header to sort the loaded page, drag its right
edge to resize. Double-click a table in the sidebar to open it; right-click for DDL.

## Tests

```bash
docker run -d --name cobalt-test-pg -e POSTGRES_PASSWORD=cobalt -e POSTGRES_USER=cobalt \
  -e POSTGRES_DB=cobalt -p 15432:5432 postgres:16-alpine
docker exec -i cobalt-test-pg psql -U cobalt -d cobalt < test/seed.sql

node test/commands.test.js # 10 checks: every menu item is wired, no dead entries
node test/version.test.js  # 10 checks: changelog data, CHANGELOG.md sync, git tags
node test/store.test.js    # 12 checks: ordering, duplication, password handling
node test/history.test.js  # 16 checks: collapsing, search, trimming, torn writes
node test/paging.test.js   # 20 checks: page stability, keyset vs offset, counting
node test/fk.test.js       # 8 checks: both directions, composite and duplicate keys
node test/db.test.js       # 25 checks: splitting, editability, commits, sessions, cancel
node test/filter.test.js  # 31 checks: parsing, SQL construction, live filtering
node test/where.test.js    # 18 checks: what an expression may contain, and may not
node test/value.test.js    # 33 checks: JSON that survives pretty-printing, hex dumps
node test/perf.test.js    # 21 checks: timing stats, benchmark safety, plans
node test/smoke.js        # boots the real UI, drives it, writes shots/*.png
node test/manager.js      # multi-connection sidebar, manager dialog, tab rebinding
node test/about.js        # version badge, About, What's New on upgrade
node test/tabs.js         # tab naming and the close-button gesture
node test/chrome.js       # frameless window controls, grid header geometry
node test/perfui.js       # benchmark and plan panels
node test/pagingui.js     # scroll-to-load, server sorting, count all
node test/historyui.js    # recording, search, reuse
node test/fkui.js         # travelling a key, referenced-by
node test/menuui.js       # the in-app menu, toolbar buttons, real key presses
node test/browseui.js     # click-to-browse, tab reuse, open as query
node test/safetyui.js     # staged-change bar, undo, filtering writes nothing
node test/filterbarui.js  # the expression bar, column chooser, filter-by-value
node test/reconnectui.js  # startup reopens what was connected
node test/inspectorui.js  # the value panel: JSON, binary, the row view, staging an edit
node test/menuprobe.js    # fires every menu command and reports what each did
```

`test/realdb.js` points the data layer at a database you already have and reports what
it found — schema load time, editability across every table, DDL generation, a wide
read. It issues only SELECT and catalog queries:

```bash
node test/realdb.js 5432 mydb postgres
```

`test/smoke.js` drives the app through `--smoke=out.png,cmd1,cmd2`, which waits for the
renderer's ready signal, fires menu commands, and screenshots the result.
`--smoke-js=<expr>` adds a DOM-level step for interactions no menu command covers, and
prints what the expression returned. `test/inspect.js` wraps that for one-off poking:

```bash
node test/inspect.js "query:run" "document.querySelectorAll('.grow').length"
```

## Layout

```
src/shared/
  changelog.js  release history as data; CHANGELOG.md is generated from it
  commands.js   the menu tree, shared by the native menu and the in-app one
  stats.js      quantiles and the benchmark verdict rule
  whereclause.js  validation for a hand-written filter expression
  valueview.js  classifying and formatting one cell value
  sqlkind.js    whether a statement only reads
src/main/
  main.js       window, menu, IPC surface, smoke mode
  history.js    append-only query history
  db.js         pools, per-tab sessions, result metadata, transactional commits
  sqlsplit.js   statement splitter (shared with the renderer)
  store.js      saved connections + workspace, safeStorage encryption
src/renderer/
  app.js        state, sidebar, tabs, results, dialogs, palette
  connections.js  connection manager, row menu, tab connection picker
  about.js      About window and version history
  perf.js       benchmark comparison and EXPLAIN plan tree
  history.js    query history browser
  menu.js       shared floating context menu, with submenus
  appmenu.js    the in-app menu bar
  editor.js     CodeMirror 6 setup, schema-aware autocomplete
  grid.js       virtualized editable grid + filter row
  inspector.js  the value panel beside the grid
  filter.js     filter expression parser
```

## Not built yet

OR between filters, starred/saved snippets, saved snippets, ERD, `EXPLAIN` visualization, other engines. The driver
seam is `src/main/db.js`; the renderer never speaks Postgres directly.
