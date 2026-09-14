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
    version: '0.24.0',
    date: '2026-09-14',
    title: 'The app asks its own questions',
    summary: 'Confirmations are drawn by Cobalt instead of by Windows.',
    changes: [
      { type: 'changed', text: 'Every confirmation — discarding staged edits, committing a batch, dropping a table, deleting a connection, installing an update — is now a dialog in the app. It was a Windows message box: another typeface, another grey, the buttons in the other order, and a title bar naming the executable. It read as though something had gone wrong rather than as part of the app.' },
      { type: 'changed', text: 'A question asked from inside a dialog now opens over it rather than replacing it. Confirming an ALTER TABLE leaves the schema dialog where it was, so cancelling puts you back in it with your settings intact.' },
      { type: 'changed', text: 'The statement you are confirming is shown as SQL, in the editor font, rather than as a line of prose.' },
      { type: 'changed', text: 'A destructive question opens on Cancel, so leaning on the space bar cannot drop a table. Enter answers yes, Escape answers no, and clicking outside answers no.' },
      { type: 'changed', text: 'File pickers are still the operating system’s. Those are its job and there is no honest way to replace them.' },
    ],
  },
  {
    version: '0.23.0',
    date: '2026-09-14',
    title: 'Switch database without leaving',
    summary: 'The database name on a connection is now a control.',
    changes: [
      { type: 'added', text: 'Click the database name beside a live connection to open any other database on that server. The one you are in is ticked and not clickable, so the list is the same shape every time. It is also on the connection row menu as Open database, for when you are already in there.' },
      { type: 'changed', text: 'Previously this was only offered when a database turned out to be empty, which is the one moment you are forced to care. One server usually holds several - an app database beside its test twin - and going through the connection dialog to look at the other one is friction you stop noticing and just put up with.' },
      { type: 'changed', text: 'Switching remembers the choice, so the connection opens there next time. The stored password is kept.' },
    ],
  },
  {
    version: '0.22.1',
    date: '2026-09-14',
    title: 'An empty database now says so',
    summary: 'Connecting to the wrong database looked exactly like a broken sidebar.',
    changes: [
      { type: 'fixed', text: 'A connection that opened a database with no tables showed a green dot beside a blank sidebar and no explanation. That is easy to end up in: the connection dialog defaults the Database field to postgres, which exists on every server and is almost always empty, so leaving it alone connects perfectly to nothing.' },
      { type: 'added', text: 'The sidebar now says which database is empty and lists the others on that server. Clicking one reconnects to it and remembers the choice, so you do not have to make it again next launch - the stored password is kept.' },
      { type: 'changed', text: 'The list of databases on a server was already being fetched with the schema and then thrown away. It is what the hint is built from.' },
    ],
  },
  {
    version: '0.22.0',
    date: '2026-09-14',
    title: 'One installer',
    summary: 'A single Cobalt-Setup.exe, and updates that install over the top.',
    changes: [
      { type: 'added', text: 'npm run dist builds one file - dist/Cobalt-Setup-<version>.exe - which installs per user with Start-menu and desktop shortcuts and asks for no administrator rights.' },
      { type: 'added', text: 'Updating means running the newer installer. NSIS matches the existing install by application id and replaces it in place: there is no uninstall step and nothing to remove first. Saved connections, workspace and query history live in %APPDATA%\\cobalt, which the installer never touches - and uninstalling leaves them too, so reinstalling picks up where you left off.' },
      { type: 'added', text: 'Help, Check for Updates asks the GitHub releases of this repository whether there is anything newer. It downloads in the background, says so in the status bar, and installs when you quit - never mid-session, since that is the only moment Windows will let a program replace its own files. A quiet check runs a few seconds after launch and stays silent unless there is news.' },
      { type: 'added', text: 'An app icon, drawn by a script rather than checked in as a binary nobody can edit.' },
      { type: 'fixed', text: 'The smoke runner shows its window inactive so a test run does not steal focus, but a menu accelerator only fires for the focused window - so the shortcut test could not reliably press anything. It now takes the foreground properly for that one case, and retries a press the window never received rather than calling the shortcut dead.' },
    ],
  },
  {
    version: '0.21.1',
    date: '2026-09-13',
    title: 'Shortcuts that actually fire',
    summary: 'The editor was quietly eating six of them.',
    changes: [
      { type: 'fixed', text: 'Ctrl+Shift+L opened Server Activity only while nothing was selected. CodeMirror binds the same key to "select all occurrences of the selection", and a key its own command handles never reaches the menu - so the shortcut worked right up until you had text selected, which is exactly when you would reach for it.' },
      { type: 'fixed', text: 'The same shadowing killed five more outright. Ctrl+Shift+K deleted the line instead of formatting it, Ctrl+Shift+G did nothing, Ctrl+I did nothing, and Ctrl+R was taken by Electron reload rather than refreshing the schema. The editor is now told which keys belong to the app and gives them up.' },
      { type: 'changed', text: 'Ctrl+Backspace stays delete-word-backwards, because that is what it does in any text box. Delete Selected Rows moved to Ctrl+Shift+Backspace instead - an app shortcut is not worth breaking typing for.' },
      { type: 'changed', text: 'Reload moved to Ctrl+Alt+R so Refresh Schema can have Ctrl+R, and on macOS Close Window moved to Cmd+Shift+W so Cmd+W closes the tab, as it does in a browser.' },
      { type: 'added', text: 'Every accelerator is now pressed for real in a test, with text selected in the editor - the case that was broken. The handlers were always covered by calling them directly, which goes around the keystroke entirely and so proved nothing about whether the key arrives.' },
      { type: 'added', text: 'A check that no command collides with an accelerator Electron gives a role by default, which is what had quietly claimed Ctrl+R. It found a second one immediately: Cmd+W was claimed twice on macOS.' },
    ],
  },
  {
    version: '0.21.0',
    date: '2026-09-13',
    title: 'The rest of the schema',
    summary: 'Indexes, keys, triggers, functions and sequences in the sidebar.',
    changes: [
      { type: 'added', text: 'Expanding a table now shows its indexes, foreign keys and triggers alongside its columns. An index says whether it is the primary key, unique or ordinary, and how much disk it takes; hovering any of them shows the definition. A disabled trigger is struck through.' },
      { type: 'added', text: 'Functions and sequences hang off the schema, in folders that open on demand and are searched by the sidebar filter along with everything else.' },
      { type: 'changed', text: 'A primary key is an index and a constraint at once, so it is listed under Indexes and not again under Keys. Listing it twice is noise, not completeness.' },
      { type: 'changed', text: 'The catalogue is fetched once per connection, the first time you expand something, rather than with the schema tree - a database with thousands of tables should not pay for it on every refresh. A schema refresh drops it along with everything else.' },
      { type: 'changed', text: 'Both engines report the same shape. MySQL folds its one-row-per-column index catalogue into one entry per index, so a composite index reads as the single thing it is, and simply reports no sequences rather than inventing any.' },
      { type: 'fixed', text: 'The object queries were picking up the toast and temp schemas, which the tree query already knew to leave out.' },
    ],
  },
  {
    version: '0.20.0',
    date: '2026-09-13',
    title: 'Find in database',
    summary: 'Where is that value actually stored?',
    changes: [
      { type: 'added', text: 'Ctrl+Shift+G looks for a value in every text column of every table and reports which table and column held it, how many rows matched, and an example with the match highlighted. Clicking a hit opens that table with the filter already applied, so you land on the rows rather than on a list.' },
      { type: 'added', text: 'Numbers and dates are off by default, because "1" would otherwise match half the database; one tick brings them in. Contains, exactly, and starts-with, with an optional case match. Binary columns are never searched - a hex haystack helps nobody.' },
      { type: 'changed', text: 'Nothing here can use an index, so the work is bounded and the panel says so: a row cap per table, marked on any count that hit it, so "858+" is never mistaken for the whole table. Views are skipped, since scanning one re-runs its query over tables already being scanned. A table that cannot be read is reported rather than silently dropped.' },
      { type: 'changed', text: 'The needle is a literal, not a pattern. Searching for 100% finds the string and not every row: the LIKE wildcards are escaped with a character that needs no quoting on either engine, which a backslash would.' },
      { type: 'fixed', text: 'An unrecognised row cap fell through to scanning every row - the most expensive setting, and a poor one to reach by accident. It now falls back to the default.' },
    ],
  },
  {
    version: '0.19.0',
    date: '2026-09-13',
    title: 'Health and memory',
    summary: 'What the server is holding, and what Cobalt itself costs, side by side.',
    changes: [
      { type: 'added', text: 'Ctrl+Shift+M shows the two halves of "why is this slow" together: database size, cache hit ratio, connections against the limit, the memory settings that decide whether a query runs in memory or off disk - and beside it what Cobalt is using, per process, plus how many rows this window is actually holding in its grids.' },
      { type: 'added', text: 'The biggest tables, split into data and indexes. Dead rows waiting on vacuum, which is the usual answer to "it got slow and nothing changed". And indexes nothing has ever read, which cost on every write and give nothing back - constraint indexes are left out, since being scanned is not their job.' },
      { type: 'added', text: 'Copy as text writes the whole snapshot out in a form you can paste into an issue.' },
      { type: 'changed', text: 'Counters are shown as totals with the uptime beside them rather than as rates. A rate needs two samples and a clock, and a per-second number invented from one reading would read as precise while being made up.' },
      { type: 'changed', text: 'Both engines report the same shape, so the panel has no idea which it is on: Postgres contributes shared_buffers and vacuum debt, MySQL the InnoDB buffer pool and its hit ratio, and MySQL simply reports no vacuum section because InnoDB reclaims its own dead rows.' },
      { type: 'fixed', text: 'A size that could not be read showed as "0 B" rather than a dash, because Number(null) is zero. Unknown is not the same as empty.' },
    ],
  },
  {
    version: '0.18.0',
    date: '2026-09-13',
    title: 'Tidy up the SQL',
    summary: 'A formatter that moves whitespace and changes nothing else.',
    changes: [
      { type: 'added', text: 'Ctrl+Shift+K lays out the statement under the caret, or exactly what is selected; Ctrl+Alt+K does the whole script. Only that span is rewritten, so the rest of a long file and its undo history are left alone and Ctrl+Z takes it back in one step.' },
      { type: 'changed', text: 'The formatter tokenizes first, so strings, dollar-quoted function bodies, quoted identifiers and comments come through byte for byte. A test re-tokenizes the output and asserts the significant tokens are identical to the input, across a corpus that includes E-strings, nested block comments, jsonb operators and plpgsql bodies - the layout is taste, that is the guarantee. Another asserts running it twice changes nothing.' },
      { type: 'changed', text: 'Keywords are lowercased; identifiers and function names keep their case, because re-casing a quoted name is a rename. A comment that sat at the end of a line stays at the end of that line.' },
    ],
  },
  {
    version: '0.17.0',
    date: '2026-09-13',
    title: 'MySQL, and what the server is doing',
    summary: 'A driver seam, MySQL and MariaDB behind it, and a server activity panel.',
    changes: [
      { type: 'added', text: 'MySQL and MariaDB. Pick the engine in the connection dialog; everything else works the same - browsing, the editable grid, paging, filtering, foreign key navigation, the value inspector, export and import. A connection with no engine recorded is Postgres, which is what every saved connection was.' },
      { type: 'added', text: 'Server Activity (Ctrl+Shift+L) lists what the server is doing: who is connected, what each one is running and for how long. Cancel stops a statement, Kill closes the connection, both after confirming. Your own connection is marked and cannot be killed by mis-click. It does not poll unless you ask it to.' },
      { type: 'changed', text: 'Everything specific to one database now lives in src/main/drivers. db.js keeps the parts that are the same either way - paging, filtering, the change set a grid edit produces, benchmarking - and asks the driver for catalog queries, identifier quoting, placeholder style and how a result reports where its columns came from.' },
      { type: 'changed', text: 'The schema dialogs generate the syntax of the engine you are on rather than Postgres syntax with different quotes: MODIFY COLUMN instead of ALTER COLUMN ... TYPE, USING before the table on an index, NOT NULL before DEFAULT, and no CASCADE or CONCURRENTLY where they do not exist. Options an engine does not have are not offered.' },
      { type: 'changed', text: 'Values arrive as text on MySQL too. mysql2 hands back a JS number for a BIGINT and a parsed object for a JSON column - and a parsed JSON column has already destroyed any integer past 2^53 - so the driver takes the raw bytes instead. A TEXT and a BLOB column are the same protocol type and differ only by charset, which is what decides whether the value is shown as text or as hex.' },
      { type: 'changed', text: 'Column types are reported as a kind the app understands rather than a Postgres OID, because the same number means something else on another engine. That is what the JSON and SQL exports and the value inspector now read.' },
      { type: 'fixed', text: 'Selecting from a MySQL view reports the base tables behind the view, so it read as "joins more than one table". It now says it is a view.' },
    ],
  },
  {
    version: '0.16.0',
    date: '2026-09-13',
    title: 'SSH tunnels',
    summary: 'Reach a database that is only reachable from a jump box.',
    changes: [
      { type: 'added', text: 'A connection can go through an SSH tunnel: tick the box in the connection dialog and give the jump host, user and either a password or a private key. The database host and port stay as the jump box sees them. Test tests the tunnel too.' },
      { type: 'added', text: 'The SSH password and key passphrase are encrypted with the OS keychain alongside the database password and never reach the window, which is only told that one exists. A tunnel you turn off keeps what you typed in case you turn it back on, and duplicating a connection copies it.' },
      { type: 'changed', text: 'The local end of a tunnel binds to 127.0.0.1 and nothing else. The default, if you pass no address, is every interface - which would publish a production database to whatever network the laptop is on, with no password of its own. A test asserts the bound address.' },
      { type: 'changed', text: 'ssh2 errors are accurate and unhelpful, so they are rewritten into what to do about them: a rejected password, a host that does not resolve, a .ppk that needs converting, a jump box that cannot reach the database. The original is kept on the error rather than discarded.' },
      { type: 'fixed', text: 'A connection that failed at startup could leave the window unusable. An SSH failure also mentions a password, which was matching the test for a database password failure and opening a password prompt that nobody was there to answer. SSH failures are now told apart, and one connection failing no longer stops the others or the rest of startup.' },
    ],
  },
  {
    version: '0.15.0',
    date: '2026-09-13',
    title: 'Data in and out',
    summary: 'Export as CSV, TSV, JSON, SQL or Markdown; import a CSV into a table.',
    changes: [
      { type: 'added', text: 'The result toolbar Export button (Ctrl+Shift+X) offers CSV, TSV, JSON, SQL INSERT statements and a Markdown table, with the first lines of the chosen format shown before you pick a filename. Copy to clipboard is there too. Hidden columns stay hidden, so what you export is what you were looking at.' },
      { type: 'added', text: 'Import CSV on a table in the sidebar. It reads the file, says what it found - row count, column count, which delimiter - and maps CSV headings to table columns by name, with every part of the guess editable. NOT NULL columns with no default are flagged if you leave them unmapped, and the first rows are previewed as they will be inserted.' },
      { type: 'added', text: 'The whole import is one transaction: if a row fails, nothing is inserted and the error names the rows it was working on. A duplicate key can instead be told to skip that row and carry on.' },
      { type: 'changed', text: 'A real CSV parser, not a split on commas: quoted fields hold delimiters and newlines, doubled quotes are one quote, and the delimiter is sniffed outside quotes. An empty unquoted field is NULL and an empty quoted field is the empty string, which is the only way a CSV can tell them apart - and the round trip keeps them apart.' },
      { type: 'changed', text: 'JSON export writes numbers as numbers, but quotes any whose text JavaScript cannot hold exactly - a 20-digit bigint, or a numeric of 1.10 - rather than rounding it on the way out. SQL export quotes numerics for the same reason.' },
      { type: 'changed', text: 'Import values are sent as text parameters and cast by Postgres, so nothing is concatenated into SQL and the server decides what a date or a numeric means.' },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-09-12',
    title: 'Change the schema without writing the SQL',
    summary: 'Add a column, create an index, rename, drop - from the sidebar, with the statement shown first.',
    changes: [
      { type: 'added', text: 'Right-clicking a table in the sidebar now opens a menu rather than dumping its DDL into a tab: Browse, Show DDL, Copy name, Add Column, Create Index, Rename, Empty Table and Drop. Right-clicking a column offers Rename, Change Type, Set Default, Set or Drop NOT NULL, and Drop Column.' },
      { type: 'added', text: 'Every one of those opens a small form with the exact statement underneath it, rebuilt on each keystroke. You can copy it or send it to the editor instead of running it, so nothing happens that you have not read first. Dropping and emptying ask again through the OS dialog.' },
      { type: 'added', text: 'A view is not offered the table-only actions, and is dropped as a view rather than as a table. On a read-only connection every changing action is disabled with a line saying why - and the main process refuses schema changes regardless of what the window asks for, the same way it already refuses grid writes.' },
      { type: 'changed', text: 'Schema changes run on the pool rather than in the tab session, so one sitting in an open transaction cannot swallow them.' },
      { type: 'changed', text: 'The schema tree carries each column default, which is what the Set Default box starts from.' },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-09-12',
    title: 'The value inspector',
    summary: 'Read a value that does not fit in a cell, and edit it in a box big enough to type in.',
    changes: [
      { type: 'added', text: 'A panel beside the grid shows the cell under the cursor in full - Ctrl+I, or the Value button on the result toolbar. JSON is pretty-printed, bytea is a hex dump with the printable bytes beside it, long text wraps, and NULL is labelled rather than left blank. It follows the cursor as you move.' },
      { type: 'added', text: 'A Row view lists every column of the current row down the page, so a wide table can be read without scrolling sideways. Clicking a field takes the cursor to that column, bringing it back if you had hidden it.' },
      { type: 'added', text: 'Editing from the panel stages the change exactly as typing in a cell does: the row goes amber, the pending bar appears, Ctrl+Z takes it back, and nothing reaches the database until Commit. Ctrl+Enter saves, Esc cancels, and there is a Set NULL button. A read-only result offers no editor at all.' },
      { type: 'changed', text: 'JSON is re-indented by walking the text rather than through JSON.parse, which would round a 20-digit key and drop the trailing zero from a numeric on the way through. The Raw button shows the text exactly as stored. Anything that is not JSON - prose, a Postgres array - is left alone rather than reformatted.' },
    ],
  },
  {
    version: '0.12.2',
    date: '2026-09-12',
    title: 'Menu items respond to the mouse',
    summary: 'Pressing a submenu item closed the menu before the click landed.',
    changes: [
      { type: 'fixed', text: 'Choosing anything from a submenu did nothing. A submenu is its own element rather than a child of the menu that opened it, so the parent treated a press inside it as a press outside itself and dismissed the whole chain on mousedown - leaving nothing for the click to land on. A press anywhere in the open chain now belongs to that menu.' },
      { type: 'changed', text: 'The menu test presses the way a mouse does, sending mousedown first and only delivering a click if the item survived it. Dispatching a bare click event, which is what it did before, reaches a detached element quite happily and so reported the menu as working.' },
    ],
  },
  {
    version: '0.12.1',
    date: '2026-09-12',
    title: 'Start connected',
    summary: 'With more than one connection saved, the app opened none of them.',
    changes: [
      { type: 'fixed', text: 'Startup only opened a connection when exactly one was saved. With several, nothing connected, so every command that needs a database refused - which reads as the whole menu being broken rather than as nothing being connected.' },
      { type: 'added', text: 'Whichever connections were open when you last quit are reopened, and the one you were working in stays focused. A connection deleted in the meantime is skipped rather than failing the restore.' },
      { type: 'changed', text: 'A command that needs a database now opens the connection picker instead of only complaining, so the refusal is something you can act on.' },
      { type: 'fixed', text: 'A byte order mark in the connections or history file no longer wipes it. JSON.parse throws on one and the file was treated as unreadable, which an editor on Windows could cause by saving a hand edit.' },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-09-12',
    title: 'One filter for the whole result',
    summary: 'Write a condition instead of hunting for the column.',
    changes: [
      { type: 'changed', text: 'The per-column filter boxes are replaced by a single expression bar (Ctrl+Shift+F). Write something like "balance > 500 and notes is not null" and it applies to the whole result, so a column far off to the right no longer has to be scrolled to, and one condition can span several columns.' },
      { type: 'added', text: 'Anything Postgres accepts in a WHERE clause works, including functions, casts and JSON operators. It is validated first for semicolons, comments, dollar quoting and unbalanced parentheses - the ways an expression could end the statement and start another - and a mistake in the SQL itself comes back from the server and is shown beside the box.' },
      { type: 'added', text: 'A Columns button chooses which columns to show. Hidden columns leave the grid, the CSV export and the clipboard, and keyboard navigation skips them; the last visible column cannot be hidden.' },
      { type: 'added', text: 'Right-clicking a cell offers "Filter by this value", which writes the condition into the bar and leaves it there to edit, and "Hide this column".' },
    ],
  },
  {
    version: '0.11.2',
    date: '2026-09-12',
    title: 'Typing in a filter box stays there',
    summary: 'Filter keystrokes were reaching the grid and editing a cell.',
    changes: [
      { type: 'fixed', text: 'Typing in a filter box opened a cell editor on whatever the grid cursor was on, and pressing Enter to apply a filter did the same. The filter inputs sit inside the grid element, so their keystrokes bubbled to the grid handler, which starts editing on any printable key. The grid now ignores keys that came from an input.' },
      { type: 'fixed', text: 'Reading a cell beyond the last row crashed on an empty result, where row 0 exists on screen but addresses nothing. Row lookup returns a "no such row" result now and every caller handles it.' },
      { type: 'changed', text: 'The cell cursor dims while a filter box has focus, so it no longer looks like the grid is still taking input.' },
    ],
  },
  {
    version: '0.11.1',
    date: '2026-09-12',
    title: 'Nothing is written until you say so',
    summary: 'Filtering never changes data, and now the app makes that obvious.',
    changes: [
      { type: 'added', text: 'A bar above the grid appears the moment an edit is staged: what is staged, that nothing has been written to the database yet, and buttons to commit or discard. Staged edits were already local-only, but the grid gave no reassurance of it.' },
      { type: 'added', text: 'Ctrl+Z in the grid steps back one staged change, so a cell typed into by accident no longer means discarding every other edit to be rid of it.' },
      { type: 'added', text: 'The filter row is labelled "filter" in the row-number gutter, since it sits directly above the data and a stray keystroke in the grid starts editing a cell rather than filtering.' },
      { type: 'added', text: 'Tests that fingerprint the whole table before and after filtering and assert it is unchanged, and that a filter can only ever produce a SELECT.' },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-09-12',
    title: 'Browse a table by clicking it',
    summary: 'No query to write, and none in the way.',
    changes: [
      { type: 'added', text: 'Clicking a table in the sidebar shows its rows immediately, with the editor out of the way and the grid taking the whole pane. Filtering, sorting, paging and editing all work exactly as they do on a query result.' },
      { type: 'added', text: 'A header names the table and the connection, with Refresh and "Open as query", which hands the statement to a normal tab so nothing is hidden from you - only moved aside.' },
      { type: 'changed', text: 'One browse tab per connection follows what you click rather than opening a tab per table. Double-clicking still opens a separate, persistent query tab, and the sidebar highlights whichever table is being browsed.' },
      { type: 'changed', text: 'The arrow beside a table expands its columns; clicking the name browses it. Previously the whole row toggled columns and only a double-click opened anything.' },
    ],
  },
  {
    version: '0.10.1',
    date: '2026-09-12',
    title: 'Stored passwords',
    summary: 'Plaintext entries get encrypted, and an unreadable one says so.',
    changes: [
      { type: 'added', text: 'Any password sitting in plain text is re-encrypted through the OS keychain the next time the app starts. That is the documented fallback for machines without safeStorage, and it is also what a connection imported by hand looks like; either way there is no reason to leave it readable once encryption is available.' },
      { type: 'fixed', text: 'A stored password that cannot be decrypted now says so. safeStorage keys off the profile Local State file, so a connections file copied or restored without it decrypts to nothing, and the driver was reporting the opaque "client password must be a string" instead.' },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-09-12',
    title: 'The menu comes back',
    summary: 'Frameless removed the menu bar, and with it the way to find anything.',
    changes: [
      { type: 'added', text: 'A menu button at the left of the tab strip opens File, Edit, Query, Go, View and Help as a cascading menu, each item showing its keyboard shortcut. Going frameless had left every feature reachable only by a shortcut you had to already know.' },
      { type: 'added', text: 'Explain, Benchmark and History now have buttons in the editor toolbar, plus an overflow button that opens the Query menu where the grid actions live.' },
      { type: 'changed', text: 'The menu is defined once, in shared/commands.js. The main process builds the Electron menu from it (which is what registers the accelerators even though no menu bar is drawn) and the app renders the same tree. A test asserts every command in it is handled and every role is performed, so a menu entry cannot quietly do nothing.' },
      { type: 'added', text: 'The test harness can press real keys, which is how the accelerators are checked to still reach the app on a frameless window rather than assumed to.' },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-09-12',
    title: 'Foreign key navigation',
    summary: 'Follow a value to the row it points at, or back to everything pointing at it.',
    changes: [
      { type: 'added', text: 'Right-click a cell to travel: a foreign key column offers the row it references, and any row offers a "Referenced by" list of the tables pointing back at it. Either opens a new tab already filtered to the matching rows.' },
      { type: 'added', text: 'Foreign key columns are marked FK in the grid header, with the table they reference in the tooltip.' },
      { type: 'added', text: 'The same menu carries filter-by-this-value, copy value and copy column name.' },
      { type: 'added', text: 'Composite keys travel as a unit, and a table with two keys to the same target keeps them separate, so each offers its own destination.' },
      { type: 'changed', text: 'Foreign keys are read once per connection alongside the schema and re-read when it is refreshed.' },
      { type: 'fixed', text: 'Key column names came back as the raw string "{customer_id}" rather than a list: array_agg over a name column yields name[], which the driver has no parser for. They are cast to text[] now.' },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-12',
    title: 'Query history',
    summary: 'Every statement you run is recorded and searchable.',
    changes: [
      { type: 'added', text: 'Query history (Ctrl+H): every run is recorded with its connection, database, duration, row count and any error. Search across statements and connection names, filter to the current connection or to failures, and put a statement back in the editor or open it in a new tab.' },
      { type: 'added', text: 'Consecutive runs of the same statement collapse into one row with a run count, so iterating on a query with Ctrl+Enter does not bury everything else. The fastest of those runs is the time shown.' },
      { type: 'added', text: 'History is stored as JSON Lines and appended one line at a time, so recording costs nothing on the query path, and it is trimmed to the newest 5,000 entries at startup. A half-written line is skipped rather than losing the file.' },
      { type: 'changed', text: 'Test runs no longer interrupt you: the window opens on a second display when there is one, stays out of the taskbar, and never takes focus.' },
      { type: 'fixed', text: 'The history panel collapsed into a single column because the generic modal body rule outranked its own grid. It no longer borrows that class, and a test asserts the two panes really sit side by side.' },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-09-12',
    title: 'Server-side paging and sorting',
    summary: 'Results are no longer capped, and sorting reaches the whole table.',
    changes: [
      { type: 'changed', text: 'Results page in as you scroll instead of stopping at a hidden 10,000 row cap. The toolbar shows how many rows have been fetched, a plus when there are more, and a page size picker.' },
      { type: 'changed', text: 'Clicking a column header sorts on the server, so the top row is the maximum in the table rather than the maximum of the rows already loaded. Clicking cycles ascending, descending, unsorted.' },
      { type: 'added', text: 'Keyset paging: once the result carries a unique key and every sort column is non-nullable and sorted the same way, the next page is fetched with a row comparison rather than OFFSET, so deep pages stay fast. Anything else falls back to OFFSET, and the toolbar says which is in use.' },
      { type: 'added', text: 'The unique key is appended to whatever you sorted by, making the order total. Without that, paging silently drops and repeats rows wherever the sort has ties.' },
      { type: 'added', text: 'A count-all button runs COUNT(*) over the whole filtered result, on request rather than automatically, since it can be slow.' },
      { type: 'changed', text: 'Opening a table from the sidebar no longer appends LIMIT 500 - paging governs instead, so you can browse the whole thing. A LIMIT you write yourself still caps the set, and pages are served inside it.' },
      { type: 'changed', text: 'The CSV button says "CSV (loaded)" while more rows remain, because it exports what has been fetched.' },
    ],
  },
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
