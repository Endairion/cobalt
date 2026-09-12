/**
 * The value inspector.
 *
 * A grid cell is one line tall. That is right for an id and useless for four
 * kilobytes of jsonb, a stack trace, or a bytea. This panel sits beside the grid
 * and shows the cell the cursor is on at a size you can read — pretty-printed
 * JSON, a hex dump for binary, wrapped text for the rest — plus a "Row" view
 * that lists every field of the current row down the page, so a wide table can
 * be read without scrolling sideways.
 *
 * Editing here stages exactly the way typing in a cell does: the change goes
 * into the grid's pending set, the row turns amber, and nothing reaches the
 * database until Commit.
 */

import { present, oneLine } from '../shared/valueview.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let host = null;
let resizer = null;
let ctx = { onStage: () => {}, onPick: () => {}, onChange: () => {}, copy: () => {}, toast: () => {} };

const state = {
  open: false,
  view: 'value',      // 'value' | 'row'
  pretty: true,
  editing: false,
  width: 360,
};

let last = null;      // the payload we drew, so actions know what they act on

export function wire(elements, callbacks) {
  host = elements.panel;
  resizer = elements.resizer;
  ctx = { ...ctx, ...callbacks };

  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKeyDown);
  wireResizer();
}

export function isOpen() { return state.open; }

export function setOpen(on) {
  state.open = !!on;
  state.editing = false;
  host.hidden = !state.open;
  resizer.hidden = !state.open;
  if (state.open) host.style.width = `${state.width}px`;
  ctx.onChange();
}

export function toggle() { setOpen(!state.open); }

/* ----------------------------- resizing ----------------------------- */

function wireResizer() {
  let startX = 0;
  let startW = 0;
  const move = (e) => {
    // The panel is on the right, so dragging left makes it wider.
    state.width = Math.max(240, Math.min(900, startW + (startX - e.clientX)));
    host.style.width = `${state.width}px`;
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-col');
  };
  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = host.offsetWidth;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.classList.add('resizing-col');
    e.preventDefault();
  });
}

/* ------------------------------ drawing ------------------------------ */

/**
 * payload: { columns, colIdx, rowIdx, value, fields, editable, hasResult, rowLabel }
 * `fields` is [{ name, type, value, edited }] for the whole row.
 */
export function render(payload) {
  if (!state.open) return;

  // Moving to another cell abandons a half-typed edit rather than carrying it
  // silently onto the new one.
  if (last && payload && (last.rowIdx !== payload.rowIdx || last.colIdx !== payload.colIdx)) {
    state.editing = false;
  }
  last = payload;

  if (!payload || !payload.hasResult) {
    host.innerHTML = `${head({ empty: true })}<div class="insp-empty">No result to inspect.</div>`;
    return;
  }

  host.innerHTML = state.view === 'row' ? rowView(payload) : valueView(payload);
  if (state.editing) {
    const ta = host.querySelector('.insp-edit');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function head({ actions = '', empty = false } = {}) {
  return `<div class="insp-head">
    <div class="insp-seg">
      <button data-iv="value" class="${state.view === 'value' ? 'on' : ''}"${empty ? ' disabled' : ''}>Value</button>
      <button data-iv="row" class="${state.view === 'row' ? 'on' : ''}"${empty ? ' disabled' : ''}>Row</button>
    </div>
    <span class="spacer"></span>
    ${actions}
    <button class="insp-x" data-ia="close" title="Close (Ctrl+I)">&times;</button>
  </div>`;
}

function valueView(p) {
  const column = p.columns[p.colIdx] || {};
  const v = present(p.value, column, { pretty: state.pretty });

  const actions = state.editing
    ? `<button class="btn small primary" data-ia="save">Save</button>
       <button class="btn small ghost" data-ia="cancel">Cancel</button>`
    : `${v.pretty || v.kind === 'json' ? `<button class="btn small ghost" data-ia="pretty" title="Show the text exactly as stored">${state.pretty ? 'Raw' : 'Pretty'}</button>` : ''}
       <button class="btn small ghost" data-ia="copy">Copy</button>
       ${p.editable ? '<button class="btn small ghost" data-ia="edit">Edit</button>' : ''}`;

  const body = state.editing
    ? `<textarea class="insp-edit" spellcheck="false">${esc(p.value === null ? '' : String(p.value))}</textarea>
       <div class="insp-editfoot">
         <button class="btn small ghost" data-ia="null">Set NULL</button>
         <span class="spacer"></span>
         <span class="hint">Ctrl+Enter saves · Esc cancels · nothing is written until you commit</span>
       </div>`
    : `<pre class="insp-val kind-${v.kind}">${v.kind === 'null' ? '<span class="nul">NULL</span>' : esc(v.display)}</pre>`;

  return `${head({ actions })}
    <div class="insp-meta">
      <span class="insp-col">${esc(column.name || '')}</span>
      <span class="insp-type">${esc(column.dataType || '')}</span>
      <span class="spacer"></span>
      <span class="hint">${esc(v.meta)}</span>
    </div>
    <div class="insp-body${state.editing ? ' editing' : ''}">${body}</div>`;
}

function rowView(p) {
  const rows = (p.fields || []).map((f, i) => {
    const line = oneLine(f.value);
    return `<div class="insp-field${i === p.colIdx ? ' on' : ''}${f.edited ? ' edited' : ''}${f.hidden ? ' hidden-col' : ''}" data-col="${i}">
      <div class="if-name">${esc(f.name)}<span class="if-type">${esc(f.type || '')}</span>${f.hidden ? '<span class="if-hidden">hidden</span>' : ''}</div>
      <div class="if-val">${line === null ? '<span class="nul">NULL</span>' : (line === '' ? '<span class="nul">empty</span>' : esc(line))}</div>
    </div>`;
  }).join('');

  return `${head({ actions: `<button class="btn small ghost" data-ia="copyrow">Copy row</button>` })}
    <div class="insp-meta">
      <span class="insp-col">${esc(p.rowLabel || 'Row')}</span>
      <span class="spacer"></span>
      <span class="hint">${(p.fields || []).length} columns</span>
    </div>
    <div class="insp-body"><div class="insp-fields">${rows}</div></div>`;
}

/* ------------------------------ actions ------------------------------ */

function onClick(e) {
  const viewBtn = e.target.closest('[data-iv]');
  if (viewBtn) { state.view = viewBtn.dataset.iv; state.editing = false; render(last); return; }

  const field = e.target.closest('.insp-field');
  if (field) {
    // Switch the view first: onPick moves the grid cursor, which redraws this
    // panel synchronously, and a redraw that still said 'row' left the field
    // list on screen after you had asked to see the value.
    state.view = 'value';
    ctx.onPick(Number(field.dataset.col));
    render(last);
    return;
  }

  const act = e.target.closest('[data-ia]');
  if (!act) return;
  const what = act.dataset.ia;

  if (what === 'close') { setOpen(false); return; }
  if (what === 'pretty') { state.pretty = !state.pretty; render(last); return; }
  if (what === 'edit') { state.editing = true; render(last); return; }
  if (what === 'cancel') { state.editing = false; render(last); return; }

  if (what === 'copy') {
    const column = last.columns[last.colIdx] || {};
    const v = present(last.value, column, { pretty: state.pretty });
    // Copy what is on screen: the pretty text if that is what you are looking at.
    ctx.copy(last.value === null ? '' : (state.pretty && v.pretty ? v.display : v.text));
    ctx.toast('Copied.');
    return;
  }

  if (what === 'copyrow') {
    const text = (last.fields || [])
      .map((f) => `${f.name}\t${f.value === null ? '' : String(f.value)}`).join('\n');
    ctx.copy(text);
    ctx.toast('Row copied.');
    return;
  }

  if (what === 'null') { ctx.onStage(last.rowIdx, last.colIdx, null); state.editing = false; return; }
  if (what === 'save') { save(); }
}

function save() {
  const ta = host.querySelector('.insp-edit');
  if (!ta) return;
  ctx.onStage(last.rowIdx, last.colIdx, ta.value);
  state.editing = false;
}

function onKeyDown(e) {
  if (!state.editing) return;
  if (e.key === 'Escape') { state.editing = false; render(last); e.stopPropagation(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { save(); e.preventDefault(); e.stopPropagation(); }
}

/** For tests and for the app's own state reporting. */
export function debugState() {
  return { open: state.open, view: state.view, pretty: state.pretty, editing: state.editing };
}
