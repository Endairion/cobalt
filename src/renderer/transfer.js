/**
 * Getting data out of a result, and a CSV file into a table.
 *
 * Export shows you the first lines of whatever format you pick before you
 * commit to a filename — the same habit as the schema dialogs, where the thing
 * that will happen is on screen before the button is pressed.
 *
 * Import is deliberately unclever: it reads the file, shows what it found, and
 * asks which CSV column goes into which table column. It guesses the mapping by
 * name and lets you change every part of the guess. Values go to Postgres as
 * text parameters and are cast by the server, so no type detection happens here
 * to be wrong about.
 */

import { render, FORMATS } from '../shared/exporters.js';
import { parseCsv } from '../shared/csv.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ctx = {
  showOverlay: () => () => {},
  saveText: async () => null,
  openText: async () => null,
  importRows: async () => ({}),
  refresh: async () => {},
  copy: () => {},
  toast: () => {},
};

export function wire(c) { ctx = { ...ctx, ...c }; }

const PREVIEW_LINES = 14;

/* -------------------------------- export -------------------------------- */

/**
 * columns: [{ name, dataTypeID }], rows: [[value|null]]
 * source:  { schema, table } when the result came from one table.
 */
export function openExport({ columns, rows, source, title = 'result', hasMore = false }) {
  let format = 'csv';

  const node = document.createElement('div');
  node.className = 'modal export-modal';
  node.innerHTML = `
    <h2>Export ${esc(rows.length.toLocaleString())} row${rows.length === 1 ? '' : 's'}</h2>
    <div class="body">
      <div class="field">
        <label>Format</label>
        <select id="ex-format">
          ${FORMATS.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('')}
        </select>
      </div>
      ${hasMore ? '<div class="op-sub warn-text">Only the rows fetched so far are exported. Scroll to the end, or raise the page size, to get the rest.</div>' : ''}
      <div class="field">
        <label>Preview<span class="hint" id="ex-note"></span></label>
        <pre class="op-sql" id="ex-preview"></pre>
      </div>
    </div>
    <div class="foot">
      <button class="btn ghost" data-ex="copy">Copy to clipboard</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-ex="cancel">Cancel</button>
      <button class="btn primary" data-ex="save">Save to file…</button>
    </div>`;

  const close = ctx.showOverlay(node);
  const pre = node.querySelector('#ex-preview');
  const note = node.querySelector('#ex-note');

  const opts = () => ({
    schema: source ? source.schema : 'public',
    table: source ? source.table : (title || 'table_name').replace(/[^\w]+/g, '_'),
  });

  const text = () => render(format, columns, rows, opts());

  const draw = () => {
    let all;
    try { all = text(); } catch (err) { pre.textContent = err.message; pre.classList.add('err'); return; }
    pre.classList.remove('err');
    const lines = all.split('\n');
    pre.textContent = lines.slice(0, PREVIEW_LINES).join('\n')
      + (lines.length > PREVIEW_LINES ? `\n… ${(lines.length - PREVIEW_LINES).toLocaleString()} more lines` : '');
    note.textContent = ` ${(all.length / 1024).toFixed(all.length > 1024 * 100 ? 0 : 1)} KB`;
  };

  node.querySelector('#ex-format').addEventListener('change', (e) => { format = e.target.value; draw(); });
  draw();

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    if (b.dataset.ex === 'cancel') { close(); return; }
    if (b.dataset.ex === 'copy') { ctx.copy(text()); ctx.toast('Copied.'); close(); return; }
    if (b.dataset.ex === 'save') {
      const f = FORMATS.find((x) => x.id === format);
      const name = `${String(title).replace(/[^\w.-]+/g, '_')}.${f.ext}`;
      try {
        const path = await ctx.saveText(name, text(), { ext: f.ext, label: f.label, bom: !!f.bom });
        if (path) { close(); ctx.toast(`Saved ${path}`, 'ok'); }
      } catch (err) { ctx.toast(err.message, 'err'); }
    }
  });
}

/* -------------------------------- import -------------------------------- */

const SKIP = '__skip__';

/** targetColumns: [{ name, type, notNull, defaultExpr }] from the schema tree. */
export async function openImport({ connId, schema, table, targetColumns, file: given = null }) {
  // `given` is for tests, which cannot answer an OS file picker. Everything
  // after this point is the same code either way.
  let file = given;
  if (!file) {
    try {
      file = await ctx.openText({ label: 'CSV', extensions: ['csv', 'tsv', 'txt'] });
    } catch (err) { ctx.toast(err.message, 'err'); return; }
    if (!file) return;                     // the picker was cancelled
  }

  const state = { hasHeader: true, mode: 'insert', parsed: null };
  const reparse = () => { state.parsed = parseCsv(file.text, { hasHeader: state.hasHeader }); };
  reparse();

  const node = document.createElement('div');
  node.className = 'modal import-modal';
  const close = ctx.showOverlay(node);

  /** Match a CSV heading to a column: exact first, then ignoring case and _ -. */
  const guess = (colName) => {
    const heads = state.parsed.header;
    const exact = heads.indexOf(colName);
    if (exact !== -1) return exact;
    const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');
    const loose = heads.findIndex((h) => norm(h) === norm(colName));
    return loose;
  };

  // Remembered across re-parses so toggling the header row does not undo your work.
  let mapping = null;
  const defaultMapping = () => Object.fromEntries(
    targetColumns.map((c) => [c.name, guess(c.name)]));

  const draw = () => {
    if (!mapping) mapping = defaultMapping();
    const { header, rows, issues, delimiter } = state.parsed;
    const mapped = targetColumns.filter((c) => mapping[c.name] >= 0);
    const delimName = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delimiter] || delimiter;

    const missingRequired = targetColumns.filter(
      (c) => c.notNull && !c.defaultExpr && !(mapping[c.name] >= 0));

    node.innerHTML = `
      <h2>Import into ${esc(schema)}.${esc(table)}</h2>
      <div class="body">
        <div class="op-sub">
          <strong>${esc(file.name)}</strong> — ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'},
          ${header.length} column${header.length === 1 ? '' : 's'}, ${esc(delimName)} separated.
          ${issues.length ? `<span class="warn-text">${issues.length} row${issues.length === 1 ? '' : 's'} had a different number of fields and ${issues.length === 1 ? 'was' : 'were'} padded or trimmed (first at line ${issues[0].line}).</span>` : ''}
        </div>

        <label class="op-check"><input type="checkbox" id="im-header" ${state.hasHeader ? 'checked' : ''} />
          <span>First row is a header</span></label>

        <div class="field">
          <label>Columns</label>
          <div class="im-map">
            ${targetColumns.map((c) => `
              <div class="im-row">
                <span class="im-target">${esc(c.name)}<span class="im-type">${esc(c.type || '')}</span>${c.notNull ? '<span class="im-req">required</span>' : ''}</span>
                <select data-map="${esc(c.name)}">
                  <option value="${SKIP}">— skip —</option>
                  ${header.map((h, i) => `<option value="${i}"${mapping[c.name] === i ? ' selected' : ''}>${esc(h)}</option>`).join('')}
                </select>
              </div>`).join('')}
          </div>
          ${missingRequired.length
    ? `<div class="hint warn-text">${esc(missingRequired.map((c) => c.name).join(', '))} ${missingRequired.length === 1 ? 'is' : 'are'} NOT NULL with no default — skipping ${missingRequired.length === 1 ? 'it' : 'them'} will fail.</div>`
    : ''}
        </div>

        <div class="field">
          <label>On a duplicate key</label>
          <select id="im-mode">
            <option value="insert"${state.mode === 'insert' ? ' selected' : ''}>Stop and roll the whole import back</option>
            <option value="skipConflicts"${state.mode === 'skipConflicts' ? ' selected' : ''}>Skip that row and carry on</option>
          </select>
        </div>

        <div class="field">
          <label>First rows<span class="hint"> as they will be inserted</span></label>
          <div class="im-preview">${previewTable(mapped, mapping, rows)}</div>
        </div>
      </div>
      <div class="foot">
        <span class="hint">One transaction — if it fails, nothing is inserted.</span>
        <span class="spacer"></span>
        <button class="btn ghost" data-im="cancel">Cancel</button>
        <button class="btn primary" data-im="run" ${mapped.length && rows.length ? '' : 'disabled'}>Import ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}</button>
      </div>`;
  };

  const previewTable = (mapped, map, rows) => {
    if (!mapped.length) return '<div class="hint">Nothing is mapped yet.</div>';
    const head = `<tr>${mapped.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr>`;
    const body = rows.slice(0, 5).map((r) =>
      `<tr>${mapped.map((c) => {
        const v = r[map[c.name]];
        return `<td>${v === null || v === undefined ? '<span class="nul">NULL</span>' : esc(v)}</td>`;
      }).join('')}</tr>`).join('');
    return `<table>${head}${body}</table>`;
  };

  draw();

  node.addEventListener('change', (e) => {
    if (e.target.id === 'im-header') {
      state.hasHeader = e.target.checked;
      reparse();
      mapping = null;                       // the headings changed; guess again
      draw();
      return;
    }
    if (e.target.id === 'im-mode') { state.mode = e.target.value; return; }
    if (e.target.dataset.map) {
      const v = e.target.value;
      mapping[e.target.dataset.map] = v === SKIP ? -1 : Number(v);
      draw();
    }
  });

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-im]');
    if (!b) return;
    if (b.dataset.im === 'cancel') { close(); return; }
    if (b.dataset.im !== 'run') return;

    const mapped = targetColumns.filter((c) => mapping[c.name] >= 0);
    const rows = state.parsed.rows.map((r) => mapped.map((c) => r[mapping[c.name]]));
    b.disabled = true;
    b.textContent = 'Importing…';
    try {
      const res = await ctx.importRows(connId, {
        schema, table, columns: mapped.map((c) => c.name), rows, mode: state.mode,
      });
      close();
      const skipped = res.skipped > 0 ? `, ${res.skipped.toLocaleString()} skipped` : '';
      ctx.toast(`Imported ${res.inserted.toLocaleString()} row${res.inserted === 1 ? '' : 's'}${skipped} in ${res.elapsedMs} ms`, 'ok');
      await ctx.refresh(connId, schema, table);
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Try again';
      // Above the file summary, not instead of it — which file and how many
      // rows is exactly the context you want while reading the error.
      let box = node.querySelector('.im-error');
      if (!box) {
        box = document.createElement('div');
        box.className = 'im-error';
        node.querySelector('.body').prepend(box);
      }
      box.innerHTML = `<strong>Nothing was inserted.</strong> ${esc(err.message)}`;
    }
  });
}
