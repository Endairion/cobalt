/**
 * Schema actions from the sidebar.
 *
 * Every one of these works the same way: a small form, and underneath it the
 * exact statement that will run, rebuilt on every keystroke. You never press a
 * button that does something you have not read. Nothing here writes its own SQL
 * — that all comes from src/shared/ddl.js, which is tested on its own.
 *
 * The destructive ones (drop, truncate) ask a second time through the OS
 * dialog, the same as discarding uncommitted grid changes does.
 */

import * as ddl from '../shared/ddl.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ctx = {
  showOverlay: () => () => {},
  runDdl: async () => {},
  refresh: async () => {},
  confirm: async () => false,
  toast: () => {},
  openSql: () => {},
};

export function wire(c) { ctx = { ...ctx, ...c }; }

/** Types offered in the type box. You can type anything; these are just quick. */
const TYPES_BY_ENGINE = {
  postgres: ['text', 'boolean', 'integer', 'bigint', 'numeric(12,2)', 'double precision',
    'date', 'timestamptz', 'uuid', 'jsonb', 'bytea', 'text[]', 'inet'],
  mysql: ['varchar(255)', 'text', 'tinyint(1)', 'int', 'bigint', 'decimal(12,2)', 'double',
    'date', 'datetime', 'timestamp', 'char(36)', 'json', 'blob'],
};
const typesFor = (engine) => TYPES_BY_ENGINE[engine] || TYPES_BY_ENGINE.postgres;

const METHODS_BY_ENGINE = {
  postgres: ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'],
  mysql: ['btree', 'hash'],
};
const methodsFor = (engine) => METHODS_BY_ENGINE[engine] || METHODS_BY_ENGINE.postgres;

/* --------------------------- the shared dialog --------------------------- */

/**
 * fields: [{ id, label, kind, value, placeholder, hint, options, columns }]
 *   kind: 'text' | 'check' | 'select' | 'columns'
 * build(values) -> SQL, or throws with a message to show instead of the SQL.
 */
function openOp({ title, subtitle, fields, build, runLabel = 'Run', danger = false, confirm = null, connId, after }) {
  const node = document.createElement('div');
  node.className = 'modal schema-op';

  const fieldHtml = fields.map((f) => {
    if (f.kind === 'check') {
      return `<label class="op-check"><input type="checkbox" data-f="${esc(f.id)}" ${f.value ? 'checked' : ''} />
        <span>${esc(f.label)}</span>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
    }
    if (f.kind === 'select') {
      return `<div class="field"><label>${esc(f.label)}</label>
        <select data-f="${esc(f.id)}">${f.options.map((o) =>
    `<option value="${esc(o)}"${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    }
    if (f.kind === 'columns') {
      return `<div class="field"><label>${esc(f.label)}</label>
        <div class="op-cols" data-f="${esc(f.id)}">${f.columns.map((c) =>
    `<label><input type="checkbox" value="${esc(c.name)}" /><span class="cn">${esc(c.name)}</span><span class="ct">${esc(c.type || '')}</span></label>`).join('')}</div>
        ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
    }
    const list = f.options ? `list="dl-${esc(f.id)}"` : '';
    const dl = f.options
      ? `<datalist id="dl-${esc(f.id)}">${f.options.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`
      : '';
    return `<div class="field"><label>${esc(f.label)}</label>
      <input type="text" data-f="${esc(f.id)}" ${list} value="${esc(f.value || '')}"
             placeholder="${esc(f.placeholder || '')}" spellcheck="false" />${dl}
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }).join('');

  node.innerHTML = `
    <h2>${esc(title)}</h2>
    <div class="body">
      ${subtitle ? `<div class="op-sub">${esc(subtitle)}</div>` : ''}
      ${fieldHtml}
      <div class="field">
        <label>Statement</label>
        <pre class="op-sql" id="op-sql"></pre>
      </div>
    </div>
    <div class="foot">
      <button class="btn ghost" data-op="copy">Copy SQL</button>
      <button class="btn ghost" data-op="editor">Open in editor</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-op="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-op="run">${esc(runLabel)}</button>
    </div>`;

  const close = ctx.showOverlay(node);
  const sqlEl = node.querySelector('#op-sql');
  const runBtn = node.querySelector('[data-op="run"]');
  let current = null;

  const values = () => {
    const out = {};
    for (const f of fields) {
      const host = node.querySelector(`[data-f="${f.id}"]`);
      if (!host) continue;
      if (f.kind === 'check') out[f.id] = host.checked;
      else if (f.kind === 'columns') {
        out[f.id] = [...host.querySelectorAll('input:checked')].map((b) => b.value);
      } else out[f.id] = host.value;
    }
    return out;
  };

  const preview = () => {
    try {
      current = build(values());
      sqlEl.textContent = current;
      sqlEl.classList.remove('err');
      runBtn.disabled = false;
    } catch (err) {
      current = null;
      sqlEl.textContent = err.message;
      sqlEl.classList.add('err');
      runBtn.disabled = true;
    }
  };

  node.addEventListener('input', preview);
  node.addEventListener('change', preview);
  preview();

  const first = node.querySelector('input[type="text"], input[type="checkbox"], select');
  if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 0);

  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && current) { e.preventDefault(); go(); }
  });

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-op]');
    if (!b) return;
    if (b.dataset.op === 'cancel') { close(); return; }
    if (b.dataset.op === 'copy') { if (current) { ctx.copy(current); ctx.toast('Copied.'); } return; }
    if (b.dataset.op === 'editor') { if (current) { close(); ctx.openSql(current, connId); } return; }
    if (b.dataset.op === 'run') go();
  });

  async function go() {
    if (!current) return;
    if (confirm) {
      const ok = await ctx.confirm({ ...confirm, detail: current, code: true });
      if (!ok) return;
    }
    runBtn.disabled = true;
    try {
      const res = await ctx.runDdl(connId, current);
      close();
      ctx.toast(`${res && res.command ? res.command : 'Done'} · ${res && res.elapsedMs != null ? `${res.elapsedMs} ms` : 'ok'}`);
      await ctx.refresh(connId);
      if (after) after();
    } catch (err) {
      sqlEl.textContent = err.message;
      sqlEl.classList.add('err');
      runBtn.disabled = false;
    }
  }
}

/* ---------------------------- the table maker ---------------------------- */

const KEY_TYPE = { postgres: 'bigint', mysql: 'bigint' };
const STAMP_TYPE = { postgres: 'timestamptz', mysql: 'datetime' };
const STAMP_DEFAULT = { postgres: 'now()', mysql: 'CURRENT_TIMESTAMP' };

/** What a new table starts as, so the common case is already typed in. */
const startingColumns = (engine) => [
  { name: 'id', type: KEY_TYPE[engine] || 'bigint', notNull: false, defaultExpr: '', identity: true, primaryKey: false },
  { name: '', type: '', notNull: false, defaultExpr: '', identity: false, primaryKey: false },
];

/**
 * CREATE TABLE, which is the one action that does not fit the shared dialog:
 * it is a list of things rather than a fixed set of boxes. Same contract
 * otherwise — the statement underneath is rebuilt on every keystroke and is
 * exactly what runs.
 */
export function openCreateTable({ connId, schema, engine = 'postgres', after }) {
  const node = document.createElement('div');
  node.className = 'modal schema-op create-table';
  const types = typesFor(engine);

  let cols = startingColumns(engine);

  node.innerHTML = `
    <h2>New table in ${esc(schema)}</h2>
    <div class="body">
      <div class="op-sub">Columns can be changed afterwards; this is only what the table starts as.</div>
      <div class="field"><label>Name</label>
        <input type="text" id="ct-name" placeholder="orders" spellcheck="false" /></div>
      <div class="field">
        <label>Columns</label>
        <div class="ct-head">
          <span>Name</span><span>Type</span><span>Default</span>
          <span title="Not null">NN</span>
          <span title="Primary key">PK</span>
          <span title="Counts itself up: ${engine === 'mysql' ? 'AUTO_INCREMENT' : 'GENERATED ALWAYS AS IDENTITY'}">AI</span>
          <span></span>
        </div>
        <div class="ct-rows" id="ct-rows"></div>
        <div class="ct-actions">
          <button class="btn small ghost" data-ct="add">Add column</button>
          <span class="hint">a column marked AI is the key unless you tick another</span>
        </div>
      </div>
      <label class="op-check"><input type="checkbox" id="ct-ine" />
        <span>Only if it does not exist</span><span class="hint">IF NOT EXISTS</span></label>
      <div class="field"><label>Statement</label><pre class="op-sql" id="op-sql"></pre></div>
    </div>
    <div class="foot">
      <button class="btn ghost" data-op="copy">Copy SQL</button>
      <button class="btn ghost" data-op="editor">Open in editor</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-op="cancel">Cancel</button>
      <button class="btn primary" data-op="run">Create table</button>
    </div>
    <datalist id="ct-types">${types.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>`;

  const close = ctx.showOverlay(node);
  const sqlEl = node.querySelector('#op-sql');
  const rowsEl = node.querySelector('#ct-rows');
  const runBtn = node.querySelector('[data-op="run"]');
  let current = null;

  const drawRows = () => {
    rowsEl.innerHTML = cols.map((c, i) => `
      <div class="ct-row" data-i="${i}">
        <input type="text" data-c="name" value="${esc(c.name)}" placeholder="column" spellcheck="false" />
        <input type="text" data-c="type" value="${esc(c.type)}" placeholder="type" list="ct-types" spellcheck="false" />
        <input type="text" data-c="defaultExpr" value="${esc(c.defaultExpr)}" placeholder="—" spellcheck="false"
               ${c.identity ? 'disabled title="a column that counts itself up has no default"' : ''} />
        <input type="checkbox" data-c="notNull" ${c.notNull ? 'checked' : ''} ${c.identity ? 'disabled' : ''} />
        <input type="checkbox" data-c="primaryKey" ${c.primaryKey ? 'checked' : ''} />
        <input type="checkbox" data-c="identity" ${c.identity ? 'checked' : ''} />
        <button class="btn small ghost ct-del" data-ct="del" title="Remove this column"
                ${cols.length < 2 ? 'disabled' : ''}>&times;</button>
      </div>`).join('');
  };

  const read = () => {
    [...rowsEl.querySelectorAll('.ct-row')].forEach((row, i) => {
      for (const el of row.querySelectorAll('[data-c]')) {
        cols[i][el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value;
      }
    });
  };

  const preview = () => {
    try {
      current = ddl.createTable({
        schema,
        table: node.querySelector('#ct-name').value,
        columns: cols,
        ifNotExists: node.querySelector('#ct-ine').checked,
        engine,
      });
      sqlEl.textContent = current;
      sqlEl.classList.remove('err');
      runBtn.disabled = false;
    } catch (err) {
      current = null;
      sqlEl.textContent = err.message;
      sqlEl.classList.add('err');
      runBtn.disabled = true;
    }
  };

  drawRows();
  preview();
  setTimeout(() => node.querySelector('#ct-name').focus(), 0);

  node.addEventListener('input', () => { read(); preview(); });
  node.addEventListener('change', (e) => {
    read();
    // Ticking AI rewrites the row, so it has to be redrawn rather than just read.
    if (e.target.dataset && e.target.dataset.c === 'identity') drawRows();
    preview();
  });

  node.addEventListener('click', async (e) => {
    const ct = e.target.closest('[data-ct]');
    if (ct) {
      read();
      if (ct.dataset.ct === 'add') {
        cols.push({ name: '', type: '', notNull: false, defaultExpr: '', identity: false, primaryKey: false });
      } else {
        const i = Number(ct.closest('.ct-row').dataset.i);
        cols = cols.filter((_, n) => n !== i);
      }
      drawRows();
      preview();
      return;
    }

    const b = e.target.closest('[data-op]');
    if (!b) return;
    if (b.dataset.op === 'cancel') { close(); return; }
    if (b.dataset.op === 'copy') { if (current) { ctx.copy(current); ctx.toast('Copied.'); } return; }
    if (b.dataset.op === 'editor') { if (current) { close(); ctx.openSql(current, connId); } return; }
    if (b.dataset.op !== 'run' || !current) return;

    runBtn.disabled = true;
    try {
      const res = await ctx.runDdl(connId, current);
      close();
      ctx.toast(`${res && res.command ? res.command : 'Done'} · ${res && res.elapsedMs != null ? `${res.elapsedMs} ms` : 'ok'}`);
      await ctx.refresh(connId);
      if (after) after();
    } catch (err) {
      sqlEl.textContent = err.message;
      sqlEl.classList.add('err');
      runBtn.disabled = false;
    }
  });
}

/* ------------------------- databases and schemas ------------------------- */

/** What a connection row offers: the things that live above a schema. */
export function connectionMenuItems({ connId, engine = 'postgres', readOnly, database }) {
  const d = ddl.dialect(engine);
  const items = [{
    label: 'New Database…',
    disabled: !!readOnly,
    run: () => openOp({
      connId,
      title: 'New database',
      subtitle: engine === 'mysql'
        ? 'A database on this server. On MySQL this is the same thing as a schema.'
        : 'A database on this server. It starts empty; open it to put anything in it.',
      fields: engine === 'mysql' ? [
        { id: 'name', label: 'Name', kind: 'text', placeholder: 'shop' },
        { id: 'charset', label: 'Character set', kind: 'text', value: 'utf8mb4', hint: 'leave as it is unless you know you want otherwise' },
        { id: 'collation', label: 'Collation', kind: 'text', value: 'utf8mb4_unicode_ci' },
      ] : [
        { id: 'name', label: 'Name', kind: 'text', placeholder: 'shop' },
        { id: 'owner', label: 'Owner', kind: 'text', placeholder: 'leave empty for you' },
        { id: 'template', label: 'Template', kind: 'text', placeholder: 'leave empty for template1' },
      ],
      build: (v) => ddl.createDatabase({ ...v, engine }),
      runLabel: 'Create database',
    }),
  }];

  if (d.schemas) {
    items.push({
      label: 'New Schema…',
      disabled: !!readOnly,
      run: () => openOp({
        connId,
        title: `New schema in ${database || 'this database'}`,
        subtitle: 'A named group of tables inside the database you are in.',
        fields: [
          { id: 'name', label: 'Name', kind: 'text', placeholder: 'billing' },
          { id: 'owner', label: 'Owner', kind: 'text', placeholder: 'leave empty for you' },
        ],
        build: (v) => ddl.createSchema({ ...v, engine }),
        runLabel: 'Create schema',
      }),
    });
  }

  return items;
}

/** What a schema row offers. */
export function schemaMenuItems({ connId, schema, engine = 'postgres', readOnly }) {
  const d = ddl.dialect(engine);
  const items = [{
    label: 'New Table…',
    disabled: !!readOnly,
    run: () => openCreateTable({ connId, schema, engine }),
  }];

  if (d.schemas) {
    items.push({ sep: true });
    items.push({
      label: 'Drop Schema…',
      danger: true,
      disabled: !!readOnly,
      run: () => openOp({
        connId,
        title: `Drop schema ${schema}`,
        subtitle: 'An empty schema goes quietly. One with tables in it needs Cascade, which takes them too.',
        fields: [{ id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also drops everything inside it' }],
        build: (v) => ddl.dropSchema({ name: schema, ...v, engine }),
        runLabel: 'Drop schema',
        danger: true,
        confirm: {
          title: 'Drop schema',
          message: `Drop ${schema}?`,
          confirmLabel: 'Drop it',
          destructive: true,
        },
      }),
    });
  }

  return items;
}

/** What an index row offers. */
export function indexMenuItems({ connId, schema, table, name, engine = 'postgres', readOnly, primary }) {
  const d = ddl.dialect(engine);
  return [{
    label: 'Drop Index…',
    danger: true,
    // A primary key's index belongs to the constraint; dropping it means
    // dropping that, which is a different statement and a different question.
    disabled: !!readOnly || !!primary,
    run: () => openOp({
      connId,
      title: `Drop index ${name}`,
      subtitle: primary
        ? 'This index backs a primary key.'
        : 'Queries that were using it will still work; they will just be slower.',
      fields: d.concurrently
        ? [{ id: 'concurrently', label: 'Concurrently', kind: 'check', hint: 'does not lock the table, but cannot run in a transaction' }]
        : [],
      build: (v) => ddl.dropIndex({ schema, table, name, ...v, engine }),
      runLabel: 'Drop index',
      danger: true,
      confirm: {
        title: 'Drop index',
        message: `Drop ${name}?`,
        confirmLabel: 'Drop it',
        destructive: true,
      },
    }),
  }];
}

/* ------------------------------ table menu ------------------------------ */

/** Menu entries for a table, view or matview in the sidebar. */
export function tableMenuItems({ connId, schema, table, kind, columns, readOnly, engine = 'postgres' }) {
  const pg = engine === 'postgres';
  const isTable = kind === 'r' || kind === 'p';
  const rel = `${schema}.${table}`;

  const items = [];
  if (isTable) {
    items.push({
      label: 'Add Column…',
      run: () => openOp({
        connId,
        title: `Add a column to ${rel}`,
        fields: [
          { id: 'name', label: 'Name', kind: 'text', placeholder: 'nickname' },
          { id: 'type', label: 'Type', kind: 'text', value: engine === 'mysql' ? 'varchar(255)' : 'text', options: typesFor(engine) },
          { id: 'defaultExpr', label: 'Default', kind: 'text', placeholder: "leave blank for none — e.g. 'basic', now(), 0" },
          { id: 'notNull', label: 'NOT NULL', kind: 'check', hint: 'needs a default on a table that already has rows' },
        ],
        build: (v) => ddl.addColumn({ schema, table, engine, ...v }),
        runLabel: 'Add column',
      }),
    });
    items.push({
      label: 'Create Index…',
      disabled: !columns || !columns.length,
      run: () => openOp({
        connId,
        title: `Index on ${rel}`,
        fields: [
          { id: 'columns', label: 'Columns', kind: 'columns', columns: columns || [], hint: 'in the order you tick them' },
          { id: 'unique', label: 'Unique', kind: 'check' },
          { id: 'method', label: 'Method', kind: 'select', options: methodsFor(engine), value: 'btree' },
          { id: 'name', label: 'Name', kind: 'text', placeholder: 'left blank, Postgres convention is used' },
          { id: 'where', label: 'Where (partial index)', kind: 'text', placeholder: 'deleted_at is null' },
          ...(pg ? [{ id: 'concurrently', label: 'Concurrently', kind: 'check', hint: 'does not lock the table; cannot run inside a transaction' }] : []),
        ],
        build: (v) => ddl.createIndex({ schema, table, engine, ...v }),
        runLabel: 'Create index',
      }),
    });
    items.push({ sep: true });
  }

  items.push({
    label: 'Rename…',
    run: () => openOp({
      connId,
      title: `Rename ${rel}`,
      fields: [{ id: 'to', label: 'New name', kind: 'text', value: table }],
      build: (v) => ddl.renameTable({ schema, table, engine, ...v }),
      runLabel: 'Rename',
    }),
  });

  if (isTable) {
    items.push({
      label: 'Empty Table…',
      danger: true,
      run: () => openOp({
        connId,
        title: `Empty ${rel}`,
        subtitle: 'TRUNCATE removes every row. It cannot be undone and no trigger sees the rows go.',
        fields: pg ? [
          { id: 'restartIdentity', label: 'Restart identity', kind: 'check', hint: 'reset generated keys to 1' },
          { id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also empties tables with a foreign key to this one' },
        ] : [],
        build: (v) => ddl.truncateTable({ schema, table, engine, ...v }),
        runLabel: 'Empty table',
        danger: true,
        confirm: {
          title: 'Empty table',
          message: `Delete every row in ${rel}?`,
          confirmLabel: 'Empty it',
          destructive: true,
        },
      }),
    });
  }

  items.push({
    label: 'Drop…',
    danger: true,
    run: () => openOp({
      connId,
      title: `Drop ${rel}`,
      subtitle: 'The table and its data, indexes and triggers all go.',
      fields: pg ? [
        { id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also drops views and foreign keys that depend on it' },
      ] : [],
      build: (v) => ddl.dropTable({ schema, table, kind, engine, ...v }),
      runLabel: 'Drop',
      danger: true,
      confirm: {
        title: 'Drop',
        message: `Drop ${rel}?`,
        confirmLabel: 'Drop it',
        destructive: true,
      },
    }),
  });

  if (readOnly) {
    // The main process refuses these anyway; say so before the click, not after.
    for (const it of items) if (it.run) { it.disabled = true; }
    items.unshift({ header: 'Connection is read-only' }, { sep: true });
  }
  return items;
}

/* ------------------------------ column menu ------------------------------ */

export function columnMenuItems({ connId, schema, table, column, readOnly, engine = 'postgres' }) {
  const pg = engine === 'postgres';
  const name = column.name;
  const rel = `${schema}.${table}`;
  const items = [
    {
      label: 'Rename…',
      run: () => openOp({
        connId,
        title: `Rename ${name}`,
        subtitle: rel,
        fields: [{ id: 'to', label: 'New name', kind: 'text', value: name }],
        build: (v) => ddl.renameColumn({ schema, table, name, engine, ...v }),
        runLabel: 'Rename',
      }),
    },
    {
      label: 'Change Type…',
      run: () => openOp({
        connId,
        title: `Type of ${name}`,
        subtitle: `${rel} — currently ${column.type}`,
        fields: [
          { id: 'type', label: 'New type', kind: 'text', value: column.type, options: typesFor(engine) },
          ...(pg ? [{
            id: 'using',
            label: 'Using',
            kind: 'text',
            placeholder: `${name}::text`,
            hint: 'only needed when there is no automatic cast',
          }] : []),
        ],
        build: (v) => ddl.alterColumnType({ schema, table, name, engine, ...v }),
        runLabel: 'Change type',
      }),
    },
    {
      label: 'Set Default…',
      run: () => openOp({
        connId,
        title: `Default for ${name}`,
        subtitle: `${rel} — leave the box empty to drop the default`,
        fields: [{ id: 'defaultExpr', label: 'Default', kind: 'text', value: column.defaultExpr || '', placeholder: 'now()' }],
        build: (v) => ddl.setDefault({ schema, table, name, engine, ...v }),
        runLabel: 'Apply',
      }),
    },
    {
      label: column.notNull ? 'Drop NOT NULL' : 'Set NOT NULL',
      run: () => openOp({
        connId,
        title: column.notNull ? `Allow NULL in ${name}` : `Require a value in ${name}`,
        subtitle: rel,
        fields: [],
        build: () => ddl.setNotNull({ schema, table, name, engine, notNull: !column.notNull, currentType: column.type }),
        runLabel: 'Apply',
      }),
    },
    { sep: true },
    {
      label: 'Drop Column…',
      danger: true,
      run: () => openOp({
        connId,
        title: `Drop ${name}`,
        subtitle: `${rel} — the data in this column goes with it.`,
        fields: pg ? [{ id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also drops indexes and constraints that use it' }] : [],
        build: (v) => ddl.dropColumn({ schema, table, name, engine, ...v }),
        runLabel: 'Drop column',
        danger: true,
        confirm: {
          title: 'Drop column',
          message: `Drop ${rel}.${name}?`,
          confirmLabel: 'Drop it',
          destructive: true,
        },
      }),
    },
  ];

  if (readOnly) {
    for (const it of items) if (it.run) { it.disabled = true; }
    items.unshift({ header: 'Connection is read-only' }, { sep: true });
  }
  return items;
}
