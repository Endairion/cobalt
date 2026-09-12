# Cobalt

A fast SQL editor in the spirit of TablePlus — Electron shell, CodeMirror 6
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

**Engines.** PostgreSQL and MySQL/MariaDB. Pick one in the connection dialog; everything
else is the same - browsing, the editable grid, paging, filtering, foreign keys, the value
inspector, export and import. MySQL has no schemas, so the connected database fills that
slot and the tree keeps its three levels. Everything engine-specific lives in
`src/main/drivers`; adding another means adding a file there and nothing in the renderer.

**The object browser.** Expanding a table shows its indexes, foreign keys and triggers
as well as its columns - an index says whether it is the primary key, unique or ordinary
and how much disk it takes, and hovering shows the definition. Functions and sequences
hang off the schema in folders. A primary key is listed under Indexes and not again under
Keys, since it is one thing said twice. The catalogue is read once per connection, the
first time you expand something.

**Find in database. `Ctrl+Shift+G` looks for a value in every text column of every
table and says which table and column held it, how many rows matched, and shows an
example with the match highlighted. Clicking a hit opens that table with the filter
already applied. Numbers and dates are opt-in (`1` would otherwise match half the
database) and binary is never searched. Nothing here can use an index, so the work is
bounded by a row cap per table and any count that hit it is marked - `858+` is never
mistaken for the whole table. The needle is a literal: searching `100%` finds the string,
not every row.

**Health and memory. `Ctrl+Shift+M` puts the two halves of "why is this slow" side by
side: database size, cache hit ratio, connections against the limit and the memory
settings that decide memory speed or disk speed - and next to it what Cobalt costs, per
process, plus how many rows this window is holding. Below that: the biggest tables split
into data and indexes, dead rows waiting on vacuum, and indexes nothing has ever read.
Counters are totals with the uptime beside them, not invented per-second rates.

**Server activity. `Ctrl+Shift+L` lists what the server is doing - who is connected,
what each is running, for how long. Cancel stops a statement, Kill closes the connection,
both after confirming. Your own connection is marked and has no kill button.

**SSH tunnels. A connection can go through a jump box: tick the box in the connection
dialog and give the SSH host, user and either a password or a private key. The database
host and port stay as the jump box sees them, and Test exercises the tunnel too. The
local end binds to `127.0.0.1` only - the default of every interface would publish the
database to whatever network the laptop is on - and there is a test asserting that. SSH
secrets are encrypted through `safeStorage` like the database password and never reach
the renderer.

**Query editor. SQL syntax highlighting, autocomplete fed from the live schema
(tables, and columns per table), bracket matching, multi-cursor, search, fold.
The statement under the caret is tinted, and that is exactly what `Ctrl+Enter` runs —
with a selection, it runs the selection instead. Each tab keeps its own undo history.

**Formatting.** `Ctrl+Shift+K` lays out the statement under the caret (or the selection);
`Ctrl+Alt+K` does the whole script. It tokenizes first, so strings, dollar-quoted function
bodies, quoted identifiers and comments come through byte for byte - a test re-tokenizes
the output and asserts the significant tokens are identical to the input, which is the
guarantee worth having; the indentation is taste. Keywords are lowercased; identifiers and
function names keep their case, since re-casing a quoted name is a rename.

**Statement splitting. A real splitter, not `split(';')`: it understands line and
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

**Export.** The Export button on the result toolbar (`Ctrl+Shift+X`) writes CSV, TSV,
JSON, SQL `INSERT` statements or a Markdown table, showing the first lines of the chosen
format before you pick a filename - or copies it to the clipboard. Hidden columns stay
hidden. JSON writes numbers as numbers but quotes any whose text JavaScript cannot hold
exactly, so a 20-digit `bigint` or a `numeric` of `1.10` comes out intact rather than
rounded.

**Import.** Right-click a table for Import CSV. It reads the file, reports what it found
and maps headings to columns by name, with every part of the guess editable; `NOT NULL`
columns with no default are flagged if left unmapped. The parser is a real one - quoted
fields hold delimiters and newlines, and an empty unquoted field is NULL while an empty
quoted field is the empty string, which is the only way a CSV can tell them apart. The
whole import is one transaction, and a failure names the rows it was working on and
leaves the table untouched; a duplicate key can instead skip that row and carry on.
Values go to Postgres as text parameters and are cast by the server.

**Schema actions. Right-click a table in the sidebar for Add Column, Create Index,
Rename, Empty Table and Drop; right-click a column for Rename, Change Type, Set Default,
Set/Drop NOT NULL and Drop Column. Each opens a small form with the exact statement
underneath it, rebuilt as you type - you can copy it or send it to the editor instead of
running it. Dropping and emptying ask a second time. A view is only offered what applies
to a view, and is dropped as one. On a read-only connection every changing action is
disabled with a line saying why, and the main process refuses the statement anyway.

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

**Shortcuts.** The editor is told which keys the menu has claimed and drops its own
bindings for them - CodeMirror handles keys in the renderer and consumes the ones its
commands take, so a menu accelerator it also binds never fires. That is not visible by
reading either list: `Ctrl+Shift+L` worked until you had text selected, because only then
did "select all occurrences" claim it. Keys that mean something in any text box, like
`Ctrl+Backspace`, stay with the editor and the app's shortcut moves instead. Every
accelerator is pressed for real in `test/accelui.js`.

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
| `Ctrl+Shift+X` | Export the result |
| `Ctrl+Shift+L` | Server activity |
| `Ctrl+Shift+M` | Health and memory |
| `Ctrl+Shift+G` | Find in database |
| `Ctrl+Shift+K` / `Ctrl+Alt+K` | Format statement / whole script |
| `Ctrl+H` | Query history |
| `Ctrl+Shift+B` | Benchmark statements |
| `Ctrl+Shift+E` / `Ctrl+Alt+E` | Explain / Explain analyze |
| `Ctrl+Shift+S` | Commit grid changes |
| `Ctrl+Shift+A` | Add row |
| `Ctrl+Shift+Backspace` | Toggle row delete |

In the grid: arrows/Tab move, `Enter` or typing edits, `Esc` cancels, `Ctrl+0` sets
NULL, `Ctrl+C` copies the cell. Click a header to sort the loaded page, drag its right
edge to resize. Double-click a table in the sidebar to open it; right-click for DDL.

## Tests

```bash
docker run -d --name cobalt-test-pg -e POSTGRES_PASSWORD=cobalt -e POSTGRES_USER=cobalt \
  -e POSTGRES_DB=cobalt -p 15432:5432 postgres:16-alpine
docker exec -i cobalt-test-pg psql -U cobalt -d cobalt < test/seed.sql

docker run -d --name cobalt-test-mysql -e MYSQL_ROOT_PASSWORD=cobalt -e MYSQL_USER=cobalt \
  -e MYSQL_PASSWORD=cobalt -e MYSQL_DATABASE=cobalt -p 13306:3306 mysql:8
docker exec cobalt-test-mysql mysql -uroot -pcobalt \
  -e "set global log_bin_trust_function_creators = 1;"
docker exec -i cobalt-test-mysql mysql -ucobalt -pcobalt cobalt < test/seed-mysql.sql

node test/commands.test.js # 10 checks: every menu item is wired, no dead entries
node test/version.test.js  # 10 checks: changelog data, CHANGELOG.md sync, git tags
node test/store.test.js    # 12 checks: ordering, duplication, password handling
node test/history.test.js  # 16 checks: collapsing, search, trimming, torn writes
node test/paging.test.js   # 20 checks: page stability, keyset vs offset, counting
node test/fk.test.js       # 8 checks: both directions, composite and duplicate keys
node test/db.test.js       # 25 checks: splitting, editability, commits, sessions, cancel
node test/filter.test.js  # 31 checks: parsing, SQL construction, live filtering
node test/where.test.js    # 18 checks: what an expression may contain, and may not
node test/ddl.test.js      # 27 checks: the SQL the schema actions generate
node test/sqlformat.test.js # 45 checks: tokenizing, layout, and never changing meaning
node test/health.test.js   # 17 checks: the health snapshot on both engines
node test/dbsearch.test.js # 33 checks: the search SQL, and finding things on both engines
node test/csv.test.js      # 35 checks: CSV round trips, JSON/SQL/Markdown export
node test/tunnel.test.js   # 19 checks: forwarding against a real in-process SSH server
node test/sshdb.test.js    # 13 checks: Postgres through a tunnel - query, cancel, commit
node test/mysql.test.js    # 36 checks: the MySQL driver against a real server
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
node test/schemaui.js     # the sidebar menu, the live SQL preview, the change landing
node test/transferui.js   # every export format, and a CSV import that rolls back
node test/sshui.js        # the tunnel dialog, and the app connecting through a jump box
node test/enginesui.js    # the engine picker, MySQL end to end, server activity
node test/formatui.js     # formatting one statement, a script, and what it leaves alone
node test/healthui.js     # the health panel on both engines, and what it counts
node test/searchui.js     # searching, what it reports, and opening a hit
node test/objectsui.js    # indexes, keys, triggers, functions and sequences in the tree
node test/accelui.js      # every shortcut pressed for real, with text selected
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
  ddl.js        the SQL the schema actions generate
  sqlformat.js  tokenizer and layout, guaranteed not to change meaning
  dbsearch.js   the search query, and which columns are worth looking in
  csv.js        a real CSV parser and writer
  exporters.js  a result as CSV, TSV, JSON, SQL or Markdown
  sqlkind.js    whether a statement only reads
src/main/
  main.js       window, menu, IPC surface, smoke mode
  history.js    append-only query history
  db.js         pools, per-tab sessions, result metadata, transactional commits
  drivers/      one file per engine: catalogs, quoting, placeholders, editability
  sqlsplit.js   statement splitter (shared with the renderer)
  store.js      saved connections + workspace, safeStorage encryption
  tunnel.js     SSH port forwarding, bound to loopback only
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
  schemaops.js  schema action dialogs, with a live SQL preview
  transfer.js   the export dialog and the CSV import dialog
  processes.js  the server activity panel
  health.js     server and app health, side by side
  dbsearch.js   the find-in-database panel
  filter.js     filter expression parser
```

## Not built yet

OR between filters, saved snippets, a full object browser (functions,
sequences, triggers), ERD, SQLite. A MySQL `EXPLAIN` is shown as text rather than as a
plan tree, which is built for Postgres. The driver
seam is `src/main/db.js`; the renderer never speaks Postgres directly.
