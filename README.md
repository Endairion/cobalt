# Cobalt

A fast PostgreSQL editor in the spirit of TablePlus — Electron shell, CodeMirror 6
editor, virtualized editable results grid.

```bash
npm install
npm start          # build the renderer bundle + launch
npm run dev        # same, with devtools and renderer console forwarding
```

## What it does

**Connections.** Saved in `userData/cobalt-connections.json`. Passwords are encrypted
with the OS keychain (DPAPI on Windows, Keychain on macOS) via Electron's `safeStorage`
and never travel to the renderer — it only ever sees a `hasPassword` flag. Mark a
connection read-only to disable grid editing against production.

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
| `Ctrl+R` | Refresh schema |
| `Ctrl+O` / `Ctrl+S` | Open / save .sql |
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

node test/db.test.js      # 24 checks: splitting, editability, commits, sessions, cancel
node test/smoke.js        # boots the real UI, drives it, writes shots/*.png
```

`test/smoke.js` drives the app through `--smoke=out.png,cmd1,cmd2`, which waits for the
renderer's ready signal, fires menu commands, and screenshots the result.

## Layout

```
src/main/
  main.js       window, menu, IPC surface, smoke mode
  db.js         pools, per-tab sessions, result metadata, transactional commits
  sqlsplit.js   statement splitter (shared with the renderer)
  store.js      saved connections + workspace, safeStorage encryption
src/renderer/
  app.js        state, sidebar, tabs, results, dialogs, palette
  editor.js     CodeMirror 6 setup, schema-aware autocomplete
  grid.js       virtualized editable grid
```

## Not built yet

Server-side paging (results are capped at 10k rows), filter row above the grid,
query history, saved snippets, ERD, `EXPLAIN` visualization, other engines. The driver
seam is `src/main/db.js`; the renderer never speaks Postgres directly.
