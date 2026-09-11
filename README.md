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

Saved in `userData/cobalt-connections.json`. Passwords are encrypted
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

**Values are text.** `bigint`, `numeric`, timestamps and `json` come back as the exact
text Postgres produced, so nothing is mangled by JS number or Date coercion on the way
to the grid and back.

**Filter row.** `Ctrl+Shift+F` drops a filter box under every column header. Filters
run on the *server*: the base query is wrapped in a subquery, the condition goes on the
outside, and any trailing `LIMIT`/`OFFSET` is hoisted out past it — so filtering a
`limit 500` table view searches the whole table, not just the 500 rows already loaded.
Postgres propagates each column's origin through the wrapper, so a filtered result
stays editable. Values are always bound as parameters and operators come from a fixed
allowlist; nothing you type reaches the SQL text.

The syntax is forgiving — a bare word means "contains" on a text column and "equals"
everywhere else:

| you type | you get |
|---|---|
| `bob` | `ilike '%bob%'` on text, `= bob` otherwise |
| `>= 100`, `!= draft`, `< 5` | that comparison |
| `%ob%` | `ilike '%ob%'` verbatim |
| `~ ^user[0-9]+` | regex (`~*`, `!~`, `!~*` too) |
| `in a, b, 'c, d'` | `in (…)`, quotes protect commas |
| `null`, `!null` | `is null` / `is not null` |
| `'bob'` | exact match, quotes override "contains" |

Filters across columns are ANDed. `Enter` applies, `Esc` clears the box then closes the
row, and the toolbar shows how many are active with a Clear button.

**Errors.** Message, SQLSTATE, detail, hint, plus the offending line with a caret under
the error position — and the editor caret jumps there.

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
| `Ctrl+K` | Switch this tab's connection |
| `Ctrl+R` | Refresh schema |
| `Ctrl+O` / `Ctrl+S` | Open / save .sql |
| `Ctrl+Shift+F` | Toggle the filter row |
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

node test/store.test.js    # 12 checks: ordering, duplication, password handling
node test/db.test.js       # 25 checks: splitting, editability, commits, sessions, cancel
node test/filter.test.js  # 29 checks: parsing, SQL construction, live filtering
node test/smoke.js        # boots the real UI, drives it, writes shots/*.png
node test/manager.js      # multi-connection sidebar, manager dialog, tab rebinding
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
src/main/
  main.js       window, menu, IPC surface, smoke mode
  db.js         pools, per-tab sessions, result metadata, transactional commits
  sqlsplit.js   statement splitter (shared with the renderer)
  store.js      saved connections + workspace, safeStorage encryption
src/renderer/
  app.js        state, sidebar, tabs, results, dialogs, palette
  connections.js  connection manager, row menu, tab connection picker
  editor.js     CodeMirror 6 setup, schema-aware autocomplete
  grid.js       virtualized editable grid + filter row
  filter.js     filter expression parser
```

## Not built yet

Server-side paging (results are capped at 10k rows), OR between filters,
query history, saved snippets, ERD, `EXPLAIN` visualization, other engines. The driver
seam is `src/main/db.js`; the renderer never speaks Postgres directly.
