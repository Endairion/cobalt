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
const COMMON_TYPES = ['text', 'boolean', 'integer', 'bigint', 'numeric(12,2)', 'double precision',
  'date', 'timestamptz', 'uuid', 'jsonb', 'bytea', 'text[]', 'inet'];

const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'];

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
      const ok = await ctx.confirm({ ...confirm, detail: current });
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

/* ------------------------------ table menu ------------------------------ */

/** Menu entries for a table, view or matview in the sidebar. */
export function tableMenuItems({ connId, schema, table, kind, columns, readOnly }) {
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
          { id: 'type', label: 'Type', kind: 'text', value: 'text', options: COMMON_TYPES },
          { id: 'defaultExpr', label: 'Default', kind: 'text', placeholder: "leave blank for none — e.g. 'basic', now(), 0" },
          { id: 'notNull', label: 'NOT NULL', kind: 'check', hint: 'needs a default on a table that already has rows' },
        ],
        build: (v) => ddl.addColumn({ schema, table, ...v }),
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
          { id: 'method', label: 'Method', kind: 'select', options: INDEX_METHODS, value: 'btree' },
          { id: 'name', label: 'Name', kind: 'text', placeholder: 'left blank, Postgres convention is used' },
          { id: 'where', label: 'Where (partial index)', kind: 'text', placeholder: 'deleted_at is null' },
          { id: 'concurrently', label: 'Concurrently', kind: 'check', hint: 'does not lock the table; cannot run inside a transaction' },
        ],
        build: (v) => ddl.createIndex({ schema, table, ...v }),
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
      build: (v) => ddl.renameTable({ schema, table, ...v }),
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
        fields: [
          { id: 'restartIdentity', label: 'Restart identity', kind: 'check', hint: 'reset generated keys to 1' },
          { id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also empties tables with a foreign key to this one' },
        ],
        build: (v) => ddl.truncateTable({ schema, table, ...v }),
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
      fields: [
        { id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also drops views and foreign keys that depend on it' },
      ],
      build: (v) => ddl.dropTable({ schema, table, kind, ...v }),
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

export function columnMenuItems({ connId, schema, table, column, readOnly }) {
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
        build: (v) => ddl.renameColumn({ schema, table, name, ...v }),
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
          { id: 'type', label: 'New type', kind: 'text', value: column.type, options: COMMON_TYPES },
          {
            id: 'using',
            label: 'Using',
            kind: 'text',
            placeholder: `${name}::text`,
            hint: 'only needed when there is no automatic cast',
          },
        ],
        build: (v) => ddl.alterColumnType({ schema, table, name, ...v }),
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
        build: (v) => ddl.setDefault({ schema, table, name, ...v }),
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
        build: () => ddl.setNotNull({ schema, table, name, notNull: !column.notNull }),
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
        fields: [{ id: 'cascade', label: 'Cascade', kind: 'check', hint: 'also drops indexes and constraints that use it' }],
        build: (v) => ddl.dropColumn({ schema, table, name, ...v }),
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
