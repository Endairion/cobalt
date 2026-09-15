/**
 * Virtualized, editable result grid.
 *
 * Rows arrive as arrays (pg rowMode:'array') so duplicate column names survive.
 * Edits are staged locally — nothing hits the database until commit() is called
 * by the app with the change set this grid produces.
 */

const ROW_H = 24;
const HEAD_H = 26;
const NUM_W = 52;
const MIN_W = 54;
const MAX_AUTO_W = 380;
const OVERSCAN = 8;

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);

const escAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let measureCtx = null;
function textWidth(s, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

const NULL_TOKEN = Symbol('null');
const UNSET = Symbol('unset');   // no staged value for this cell

export class ResultGrid {
  constructor(host, { onDirtyChange, onStatus, onFilter, onSort, onNeedMore, onCellMenu, onCursor, onRowLeave, readOnly = false } = {}) {
    this.host = host;
    this.onDirtyChange = onDirtyChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onFilter = onFilter || (() => {});
    this.onSort = onSort || (() => {});
    this.onNeedMore = onNeedMore || (() => {});
    this.onCellMenu = onCellMenu || (() => {});
    this.onCursor = onCursor || (() => {});
    this.onRowLeave = onRowLeave || (() => {});
    this.loadingMore = false;
    this.readOnly = readOnly;
    this.hiddenCols = new Set();   // column indexes the viewer chose to hide

    this.result = null;
    this.columns = [];
    this.rows = [];
    this.order = [];
    this.widths = [];
    this.sort = null;

    this.edits = new Map();     // rowIdx -> Map(colIdx -> value|NULL_TOKEN)
    this.deletes = new Set();   // rowIdx
    this.inserts = [];          // { id, values: Map(colIdx -> value|NULL_TOKEN) }
    this.insertSeq = 0;
    this.undoStack = [];

    this.cursor = { row: 0, col: 0 };
    this.editing = null;

    this.el = document.createElement('div');
    this.el.className = 'grid';
    this.el.tabIndex = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'grid-inner';
    this.head = document.createElement('div');
    this.head.className = 'grid-head';
    this.body = document.createElement('div');
    this.body.className = 'grid-body';
    this.inner.append(this.head, this.body);
    this.el.append(this.inner);
    host.append(this.el);

    this.el.addEventListener('scroll', () => {
      this.renderRows();
      this.maybeLoadMore();
    });
    this.el.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.el.addEventListener('contextmenu', (e) => {
      const cell = e.target.closest('.gc[data-col]');
      if (!cell) return;
      e.preventDefault();
      const row = Number(cell.parentElement.dataset.row);
      const col = Number(cell.dataset.col);
      this.commitEditor();
      this.setCursor(row, col);
      this.onCellMenu(row, col, { left: e.clientX, top: e.clientY, bottom: e.clientY });
    });
    this.head.addEventListener('click', (e) => this.onHeadClick(e));
    this.head.addEventListener('mousedown', (e) => this.onHeadMouseDown(e));

  }

  /* ------------------------ column visibility ------------------------ */

  headOffset() { return HEAD_H; }

  /** Indexes of the columns actually drawn, in display order. */
  get visibleCols() {
    const out = [];
    for (let i = 0; i < this.columns.length; i++) if (!this.hiddenCols.has(i)) out.push(i);
    return out;
  }

  setHidden(indexes) {
    this.hiddenCols = new Set(indexes);
    // Never hide every column; an empty grid is not a useful thing to look at.
    if (this.columns.length && this.hiddenCols.size >= this.columns.length) this.hiddenCols.delete(0);
    if (this.hiddenCols.has(this.cursor.col)) {
      const first = this.visibleCols[0];
      if (first !== undefined) this.cursor.col = first;
    }
    this.render();
  }

  /** Column names that appear more than once can't be referenced unambiguously. */
  ambiguous(name) {
    return this.columns.filter((c) => c.name === name).length > 1;
  }

  /* ----------------------------- data ----------------------------- */

  /** Column name -> the foreign key it belongs to, for the header marker. */
  setForeignKeys(outgoing) {
    this.fkByColumn = new Map();
    for (const fk of outgoing || []) {
      // Only single-column keys get a header marker; composite ones still work
      // from the context menu, where every part can be shown.
      if (fk.columns.length === 1) this.fkByColumn.set(fk.columns[0], fk);
    }
    if (this.columns.length) this.renderHead();
  }

  load(result, { keepFilters = false, append = false } = {}) {
    // Appending the next page must not disturb what is already on screen: the
    // staged edits are keyed by row index, and those indices stay valid.
    if (append) {
      const start = this.rows.length;
      const incoming = result.rows || [];
      this.rows = this.rows.concat(incoming);
      for (let i = 0; i < incoming.length; i++) this.order.push(start + i);
      this.result = { ...result, rows: this.rows };
      this.loadingMore = false;
      this.render();
      return;
    }

    const sameShape = this.columns.length === (result.columns || []).length
      && this.columns.every((c, i) => c.name === result.columns[i].name);
    if (!sameShape) this.hiddenCols = new Set();   // a different result, a different set of columns
    this.result = result;
    this.columns = result.columns || [];
    this.rows = result.rows || [];
    this.order = this.rows.map((_, i) => i);
    // Sorting is the server's job now; this just mirrors what it was asked for.
    this.sort = result.page && result.page.sort && result.page.sort.length
      ? { name: result.page.sort[0].name, dir: result.page.sort[0].dir }
      : null;
    this.loadingMore = false;
    this.edits.clear();
    this.deletes.clear();
    this.inserts = [];
    this.undoStack = [];
    this.cursor = { row: 0, col: 0 };
    // Keep column widths steady across a re-run, so the grid doesn't reflow
    // under the cursor every time you sort or type a filter.
    if (!keepFilters || !this.widths.length || this.widths.length !== this.columns.length) this.autoSize();
    this.render();
    this.onDirtyChange(this.dirtyCount());
  }

  get hasMore() { return !!(this.result && this.result.page && this.result.page.hasMore); }

  /** Ask for the next page once the viewport is within a few rows of the end. */
  maybeLoadMore() {
    if (!this.hasMore || this.loadingMore || this.editing) return;
    const remaining = this.el.scrollHeight - (this.el.scrollTop + this.el.clientHeight);
    if (remaining > ROW_H * 12) return;
    this.loadingMore = true;
    this.onNeedMore();
  }

  get editable() {
    return !!(this.result && this.result.editable) && !this.readOnly;
  }

  autoSize() {
    const headFont = '11.5px -apple-system, "Segoe UI", Inter, sans-serif';
    const cellFont = '12px "Cascadia Mono", Consolas, monospace';
    const sample = Math.min(this.rows.length, 120);
    this.widths = this.columns.map((c, ci) => {
      let w = textWidth(c.name, headFont) + 26 + (c.dataType ? textWidth(c.dataType, '10px sans-serif') + 8 : 0);
      for (let i = 0; i < sample; i++) {
        const v = this.rows[i][ci];
        const s = v === null ? '[NULL]' : String(v);
        const cut = s.length > 60 ? s.slice(0, 60) : s;
        const cw = textWidth(cut, cellFont) + 18;
        if (cw > w) w = cw;
        if (w >= MAX_AUTO_W) break;
      }
      return Math.max(MIN_W, Math.min(MAX_AUTO_W, Math.ceil(w)));
    });
  }

  totalRows() { return this.order.length - 0 + this.inserts.length; }

  /**
   * Logical row at a display index: {kind:'row', idx}, {kind:'new', pos}, or
   * {kind:'none'} when the index is past the end — which happens readily on an
   * empty result, where row 0 exists on screen but addresses nothing.
   */
  at(display) {
    if (display >= 0 && display < this.order.length) return { kind: 'row', idx: this.order[display] };
    const pos = display - this.order.length;
    return pos >= 0 && pos < this.inserts.length ? { kind: 'new', pos } : { kind: 'none' };
  }

  valueAt(display, col) {
    const ref = this.at(display);
    if (ref.kind === 'none') return null;
    if (ref.kind === 'new') {
      const v = this.inserts[ref.pos].values.get(col);
      return v === undefined ? null : (v === NULL_TOKEN ? null : v);
    }
    const e = this.edits.get(ref.idx);
    if (e && e.has(col)) {
      const v = e.get(col);
      return v === NULL_TOKEN ? null : v;
    }
    return this.rows[ref.idx][col];
  }

  isEdited(display, col) {
    const ref = this.at(display);
    if (ref.kind === 'none') return false;
    if (ref.kind === 'new') return this.inserts[ref.pos].values.has(col);
    const e = this.edits.get(ref.idx);
    return !!(e && e.has(col));
  }

  rowState(display) {
    const ref = this.at(display);
    if (ref.kind === 'none') return '';
    if (ref.kind === 'new') return 'new';
    if (this.deletes.has(ref.idx)) return 'del';
    if (this.edits.has(ref.idx)) return 'dirty';
    return '';
  }

  /** Whether one display row has anything staged on it. */
  rowIsDirty(display) {
    const ref = this.at(display);
    if (ref.kind === 'row') {
      return this.deletes.has(ref.idx) || !!(this.edits.get(ref.idx) || {}).size;
    }
    if (ref.kind === 'new') return !!this.inserts[ref.pos];
    return false;
  }

  dirtyCount() {
    let n = this.inserts.length + this.deletes.size;
    for (const [idx] of this.edits) if (!this.deletes.has(idx)) n++;
    return n;
  }

  /* ----------------------------- render ----------------------------- */

  render() {
    this.renderHead();
    this.body.style.height = `${this.totalRows() * ROW_H}px`;
    this.inner.style.width = `${this.totalWidth()}px`;
    this.renderRows();
  }

  totalWidth() {
    return NUM_W + this.visibleCols.reduce((a, i) => a + (this.widths[i] || 0), 0);
  }

  renderHead() {
    const parts = [`<div class="gh rownum" style="width:${NUM_W}px">#</div>`];
    this.visibleCols.forEach((i) => {
      const c = this.columns[i];
      const pk = this.result && this.result.key && this.result.key.includes(i);
      const fk = this.fkByColumn && this.fkByColumn.get(c.sourceColumn || c.name);
      const arrow = this.sort && this.sort.name === c.name ? (this.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      parts.push(
        `<div class="gh" data-col="${i}" style="width:${this.widths[i]}px" title="${esc(c.name)}${c.dataType ? ' · ' + esc(c.dataType) : ''}">` +
        (pk ? '<span class="gh-pk">PK</span>' : '') +
        (fk ? `<span class="gh-fk" title="references ${escAttr(fk.refSchema)}.${escAttr(fk.refTable)}">FK</span>` : '') +
        `<span class="gh-name">${esc(c.name)}${arrow}</span>` +
        (c.dataType ? `<span class="gh-type">${esc(shortType(c.dataType))}</span>` : '') +
        `<span class="gh-resize" data-resize="${i}"></span></div>`
      );
    });
    this.head.innerHTML = parts.join('');
    this.head.style.width = `${this.totalWidth()}px`;
  }

  renderRows() {
    const total = this.totalRows();
    const scrollTop = this.el.scrollTop;
    const head = this.headOffset();
    const viewH = this.el.clientHeight - head;
    let first = Math.max(0, Math.floor((scrollTop - head) / ROW_H) - OVERSCAN);
    let last = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
    if (total === 0) {
      this.body.innerHTML = '';
      return;
    }
    const out = [];
    for (let d = first; d < last; d++) {
      const state = this.rowState(d);
      const isCursorRow = d === this.cursor.row;
      out.push(`<div class="grow${state ? ' state-' + state : ''}${isCursorRow ? ' cursor-row' : ''}" style="top:${d * ROW_H}px;width:${this.totalWidth()}px" data-row="${d}">`);
      const ref = this.at(d);
      const label = ref.kind === 'new' ? '+' : String(d + 1);
      out.push(`<div class="gc rownum" style="width:${NUM_W}px">${label}</div>`);
      for (const c of this.visibleCols) {
        const v = this.valueAt(d, c);
        const isNull = v === null || v === undefined;
        const numeric = NUMERIC_OIDS.has(this.columns[c].dataTypeID);
        const sel = d === this.cursor.row && c === this.cursor.col;
        const cls = ['gc'];
        if (isNull) cls.push('null');
        if (numeric && !isNull) cls.push('num');
        if (sel) cls.push('selected');
        if (this.isEdited(d, c)) cls.push('edited');
        const text = isNull ? '[NULL]' : display(v);
        out.push(`<div class="${cls.join(' ')}" style="width:${this.widths[c]}px" data-col="${c}">${esc(text)}</div>`);
      }
      out.push('</div>');
    }
    this.body.innerHTML = out.join('');
  }

  /* --------------------------- interaction --------------------------- */

  onHeadMouseDown(e) {
    const handle = e.target.closest('[data-resize]');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const col = Number(handle.dataset.resize);
    const startX = e.clientX;
    const startW = this.widths[col];
    const move = (ev) => {
      this.widths[col] = Math.max(MIN_W, startW + (ev.clientX - startX));
      this.render();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /**
   * Clicking a header cycles ascending, descending, unsorted — and asks the
   * server to re-run with that ORDER BY. Sorting only the rows already fetched
   * would be a lie the moment the result has more than one page.
   */
  onHeadClick(e) {
    if (e.target.closest('[data-resize]')) return;
    const gh = e.target.closest('.gh[data-col]');
    if (!gh) return;
    const col = Number(gh.dataset.col);
    const column = this.columns[col];
    if (!column) return;
    if (this.ambiguous(column.name)) {
      this.onStatus(`"${column.name}" appears more than once in this result, so it can't be sorted unambiguously.`);
      return;
    }
    const current = this.sort && this.sort.name === column.name ? this.sort.dir : null;
    const next = current === 'asc' ? 'desc' : current === 'desc' ? null : 'asc';
    this.onSort(next ? [{ name: column.name, dir: next }] : []);
  }

  onMouseDown(e) {
    // The right button opens the cell menu, which has a handler of its own.
    if (e.button !== 0) return;
    const cell = e.target.closest('.gc[data-col]');
    if (!cell) return;
    const row = Number(cell.parentElement.dataset.row);
    const col = Number(cell.dataset.col);
    // Clicking the cell already being edited would otherwise close and reopen
    // the editor under the pointer, losing the caret position you clicked at.
    if (this.editing && this.editing.row === row && this.editing.col === col) return;
    this.commitEditor();
    this.setCursor(row, col);
    this.el.focus();
    // Clicking a value puts you in it. `quiet` because a read-only result would
    // otherwise complain on every single click.
    this.beginEdit(undefined, { quiet: true });
  }

  onDoubleClick(e) {
    const cell = e.target.closest('.gc[data-col]');
    if (!cell) return;
    // The first click already opened it; this is only here for the case where
    // it could not, so the reason gets said out loud.
    if (!this.editing) this.beginEdit();
  }

  setCursor(row, col, { scroll = false } = {}) {
    const total = this.totalRows();
    const vis = this.visibleCols;
    let nextCol = Math.max(0, Math.min(this.columns.length - 1, col));
    if (this.hiddenCols.has(nextCol) && vis.length) {
      // Land on the nearest column that is actually on screen.
      nextCol = vis.reduce((best, i) =>
        Math.abs(i - nextCol) < Math.abs(best - nextCol) ? i : best, vis[0]);
    }
    const before = this.cursor.row;
    this.cursor = { row: Math.max(0, Math.min(total - 1, row)), col: nextCol };
    if (scroll) this.scrollToCursor();
    this.renderRows();
    this.emitCellStatus();
    // Leaving a row you changed is the moment the change is finished, which is
    // when it is worth asking whether to write it. Moving between columns of
    // the same row is not — you are still in the middle of the row.
    if (before !== this.cursor.row && this.rowIsDirty(before)) this.onRowLeave(before);
  }

  /** Move the cursor by whole visible columns, so hidden ones are skipped. */
  stepCol(delta) {
    const vis = this.visibleCols;
    if (!vis.length) return;
    const at = vis.indexOf(this.cursor.col);
    const next = vis[Math.max(0, Math.min(vis.length - 1, (at === -1 ? 0 : at) + delta))];
    this.setCursor(this.cursor.row, next, { scroll: true });
  }

  emitCellStatus() {
    // Anything that moves the cursor or changes the value under it comes
    // through here, which makes it the one place the inspector has to hear.
    this.onCursor();
    if (!this.columns.length || !this.totalRows()) return;
    const v = this.valueAt(this.cursor.row, this.cursor.col);
    const col = this.columns[this.cursor.col];
    this.onStatus(
      `${col.name}${col.dataType ? ' · ' + col.dataType : ''}  —  ` +
      (v === null ? 'NULL' : `${String(v).length} chars`)
    );
  }

  scrollToCursor() {
    const top = this.cursor.row * ROW_H;
    const viewTop = this.el.scrollTop;
    const viewBottom = viewTop + this.el.clientHeight - this.headOffset();
    if (top < viewTop) this.el.scrollTop = top;
    else if (top + ROW_H > viewBottom) this.el.scrollTop = top + ROW_H - this.el.clientHeight + this.headOffset();

    let x = NUM_W;
    for (const i of this.visibleCols) {
      if (i >= this.cursor.col) break;
      x += this.widths[i] || 0;
    }
    const w = this.widths[this.cursor.col] || 0;
    if (x < this.el.scrollLeft + NUM_W) this.el.scrollLeft = Math.max(0, x - NUM_W);
    else if (x + w > this.el.scrollLeft + this.el.clientWidth) this.el.scrollLeft = x + w - this.el.clientWidth;
  }

  onKeyDown(e) {
    if (this.editing) return;
    // The filter inputs and the cell editor live inside the grid element, so
    // their keystrokes bubble here. Without this, typing in a filter box opens
    // a cell editor on whatever the cursor was on, and Enter to apply a filter
    // does the same.
    const t = e.target;
    if (t && t !== this.el && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const { row, col } = this.cursor;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') { this.undoLast(); e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'c') { this.copyCell(); e.preventDefault(); return; }
    if (mod && e.key === '0') { this.setValue(row, col, NULL_TOKEN); e.preventDefault(); return; }

    switch (e.key) {
      case 'ArrowDown': this.setCursor(row + 1, col, { scroll: true }); e.preventDefault(); break;
      case 'ArrowUp': this.setCursor(row - 1, col, { scroll: true }); e.preventDefault(); break;
      case 'ArrowLeft': this.stepCol(-1); e.preventDefault(); break;
      case 'ArrowRight': this.stepCol(1); e.preventDefault(); break;
      case 'Tab':
        this.stepCol(e.shiftKey ? -1 : 1); e.preventDefault(); break;
      case 'PageDown':
        this.setCursor(row + Math.floor(this.el.clientHeight / ROW_H), col, { scroll: true }); e.preventDefault(); break;
      case 'PageUp':
        this.setCursor(row - Math.floor(this.el.clientHeight / ROW_H), col, { scroll: true }); e.preventDefault(); break;
      case 'Home': {
        const vis = this.visibleCols;
        this.setCursor(mod ? 0 : row, vis[0] ?? 0, { scroll: true }); e.preventDefault(); break;
      }
      case 'End': {
        const vis = this.visibleCols;
        this.setCursor(mod ? this.totalRows() - 1 : row, vis[vis.length - 1] ?? 0, { scroll: true });
        e.preventDefault(); break;
      }
      case 'Enter': case 'F2':
        this.beginEdit(); e.preventDefault(); break;
      case 'Escape':
        break;
      default:
        if (!mod && !e.altKey && e.key.length === 1) { this.beginEdit(e.key); e.preventDefault(); }
    }
  }

  copyCell() {
    const v = this.valueAt(this.cursor.row, this.cursor.col);
    window.cobalt.ui.copy(v === null ? '' : String(v));
    this.onStatus('Cell copied.');
  }

  copyAllAsTsv() {
    const vis = this.visibleCols;
    const lines = [vis.map((i) => this.columns[i].name).join('\t')];
    for (let d = 0; d < this.totalRows(); d++) {
      const cells = vis.map((c) => {
        const v = this.valueAt(d, c);
        return v === null ? '' : String(v).replace(/[\t\n\r]/g, ' ');
      });
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }

  toCsv() {
    const q = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const vis = this.visibleCols;
    const lines = [vis.map((i) => q(this.columns[i].name)).join(',')];
    for (let d = 0; d < this.totalRows(); d++) {
      lines.push(vis.map((c) => {
        const v = this.valueAt(d, c);
        return v === null ? '' : q(String(v));
      }).join(','));
    }
    return lines.join('\r\n');
  }

  /* ------------------------------ editing ------------------------------ */

  /**
   * `quiet` is for the edit a click asks for rather than one you asked for by
   * name: there is no point telling someone the result is read-only every time
   * they click a cell in it.
   */
  beginEdit(seedChar, { quiet = false } = {}) {
    if (!this.totalRows() || !this.columns.length) return;
    // Never stack two editors on top of each other. Typing over a cell that is
    // already open replaces what is in it, which is what the keystroke meant.
    if (this.editing) this.commitEditor();
    if (!this.editable) {
      if (!quiet) {
        this.onStatus(this.result && this.result.notEditableReason ? this.result.notEditableReason : 'Result is read-only.');
      }
      return;
    }
    const ref = this.at(this.cursor.row);
    if (ref.kind === 'none') return;
    if (ref.kind === 'row' && this.deletes.has(ref.idx)) {
      if (!quiet) this.onStatus('Row is marked for deletion.');
      return;
    }
    const rowEl = this.body.querySelector(`.grow[data-row="${this.cursor.row}"]`);
    if (!rowEl) { this.scrollToCursor(); this.renderRows(); }
    const cellEl = this.body.querySelector(`.grow[data-row="${this.cursor.row}"] .gc[data-col="${this.cursor.col}"]`);
    if (!cellEl) return;

    const current = this.valueAt(this.cursor.row, this.cursor.col);
    const input = document.createElement('textarea');
    input.className = 'cell-editor';
    input.spellcheck = false;
    input.value = seedChar !== undefined ? seedChar : (current === null ? '' : String(current));

    const rect = cellEl.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const multiline = String(input.value).includes('\n') || String(input.value).length > 80;
    input.style.left = `${rect.left - hostRect.left}px`;
    input.style.top = `${rect.top - hostRect.top}px`;
    input.style.width = `${Math.max(rect.width, multiline ? 340 : rect.width)}px`;
    input.style.height = `${multiline ? 120 : rect.height}px`;
    input.style.lineHeight = multiline ? '1.45' : `${ROW_H - 2}px`;

    this.host.append(input);
    input.focus();
    if (seedChar !== undefined) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();

    this.editing = { input, row: this.cursor.row, col: this.cursor.col, wasNull: current === null };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.cancelEditor(); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        this.commitEditor();
        this.setCursor(this.cursor.row + 1, this.cursor.col, { scroll: true });
        this.el.focus();
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (e.key === 'Tab') {
        this.commitEditor();
        this.setCursor(this.cursor.row, this.cursor.col + (e.shiftKey ? -1 : 1), { scroll: true });
        this.el.focus();
        e.preventDefault(); e.stopPropagation();
      }
    });
    input.addEventListener('blur', () => this.commitEditor());
  }

  cancelEditor({ focus = true } = {}) {
    if (!this.editing) return;
    this.editing.input.remove();
    this.editing = null;
    if (focus) this.el.focus();
  }

  commitEditor() {
    if (!this.editing) return;
    const { input, row, col, wasNull } = this.editing;
    const text = input.value;
    this.editing = null;
    input.remove();
    const original = this.originalValue(row, col);
    // An untouched NULL stays NULL rather than becoming an empty string.
    if (wasNull && text === '') { this.renderRows(); return; }
    const next = text;
    if (original !== null && String(original) === next) {
      // Opening a cell and closing it again without typing is not an edit, so
      // it must not leave an undo step behind for Ctrl+Z to spend itself on.
      if (this.stagedAt(row, col) !== undefined) this.clearEdit(row, col);
      else this.renderRows();
    } else {
      this.setValue(row, col, next);
    }
  }

  originalValue(display, col) {
    const ref = this.at(display);
    if (ref.kind !== 'row') return null;
    return this.rows[ref.idx][col];
  }

  setValue(display, col, value) {
    const ref = this.at(display);
    if (ref.kind === 'none') return;
    this.undoStack.push({ kind: 'cell', display, col, prev: this.stagedAt(display, col) });
    if (ref.kind === 'new') {
      this.inserts[ref.pos].values.set(col, value);
    } else {
      const orig = this.rows[ref.idx][col];
      const isSame = (value === NULL_TOKEN && orig === null) || (value !== NULL_TOKEN && orig !== null && String(orig) === String(value));
      let e = this.edits.get(ref.idx);
      if (isSame) {
        if (e) { e.delete(col); if (!e.size) this.edits.delete(ref.idx); }
      } else {
        if (!e) { e = new Map(); this.edits.set(ref.idx, e); }
        e.set(col, value);
      }
    }
    this.renderRows();
    this.onDirtyChange(this.dirtyCount());
    this.emitCellStatus();
  }

  /**
   * Stage a value from outside the grid — the inspector's editor. `null` means
   * SQL NULL. Goes through setValue, so it lands on the same pending set, the
   * same undo stack and the same "nothing is written yet" bar.
   */
  stageValue(display, col, value) {
    if (!this.editable) { this.onStatus('This result is read-only.'); return false; }
    if (this.at(display).kind === 'none') return false;
    // The inspector has just said what this cell should be. An editor still
    // open on it is holding the old text, and letting it commit on blur would
    // quietly undo what was set here. Focus stays where it is.
    if (this.editing) this.cancelEditor({ focus: false });
    this.setValue(display, col, value === null ? NULL_TOKEN : String(value));
    return true;
  }

  clearEdit(display, col) {
    const ref = this.at(display);
    if (ref.kind === 'none') return;
    this.undoStack.push({ kind: 'cell', display, col, prev: this.stagedAt(display, col) });
    if (ref.kind === 'new') this.inserts[ref.pos].values.delete(col);
    else {
      const e = this.edits.get(ref.idx);
      if (e) { e.delete(col); if (!e.size) this.edits.delete(ref.idx); }
    }
    this.renderRows();
    this.onDirtyChange(this.dirtyCount());
  }

  addRow() {
    if (!this.editable) { this.onStatus('This result is read-only.'); return; }
    this.inserts.push({ id: ++this.insertSeq, values: new Map() });
    this.undoStack.push({ kind: 'insert', pos: this.inserts.length - 1 });
    this.render();
    this.setCursor(this.totalRows() - 1, 0, { scroll: true });
    this.onDirtyChange(this.dirtyCount());
  }

  toggleDelete() {
    if (!this.editable) { this.onStatus('This result is read-only.'); return; }
    if (!this.totalRows()) return;
    const ref = this.at(this.cursor.row);
    if (ref.kind === 'none') return;
    if (ref.kind === 'new') {
      this.inserts.splice(ref.pos, 1);
      this.render();
    } else {
      this.undoStack.push({ kind: 'delete', idx: ref.idx, was: this.deletes.has(ref.idx) });
      if (this.deletes.has(ref.idx)) this.deletes.delete(ref.idx);
      else this.deletes.add(ref.idx);
      this.renderRows();
    }
    this.onDirtyChange(this.dirtyCount());
  }

  discard() {
    this.undoStack = [];
    this.edits.clear();
    this.deletes.clear();
    this.inserts = [];
    this.render();
    this.onDirtyChange(0);
  }

  /** The staged value for a cell, or UNSET when nothing is staged there. */
  stagedAt(display, col) {
    const ref = this.at(display);
    if (ref.kind === 'none') return UNSET;
    if (ref.kind === 'new') {
      const m = this.inserts[ref.pos].values;
      return m.has(col) ? m.get(col) : UNSET;
    }
    const e = this.edits.get(ref.idx);
    return e && e.has(col) ? e.get(col) : UNSET;
  }

  /** Put a staged value back exactly as it was, UNSET meaning "not staged". */
  applyStaged(display, col, v) {
    const ref = this.at(display);
    if (ref.kind === 'none') return;
    if (ref.kind === 'new') {
      if (v === UNSET) this.inserts[ref.pos].values.delete(col);
      else this.inserts[ref.pos].values.set(col, v);
      return;
    }
    let e = this.edits.get(ref.idx);
    if (v === UNSET) {
      if (e) { e.delete(col); if (!e.size) this.edits.delete(ref.idx); }
      return;
    }
    if (!e) { e = new Map(); this.edits.set(ref.idx, e); }
    e.set(col, v);
  }

  /**
   * Step back one staged change. Nothing here has reached the database, so this
   * is only unwinding what is on screen -- but a mistyped cell should not mean
   * discarding every other edit to get rid of it.
   */
  undoLast() {
    const op = this.undoStack.pop();
    if (!op) { this.onStatus('Nothing to undo.'); return false; }
    if (op.kind === 'cell') {
      this.applyStaged(op.display, op.col, op.prev);
      this.cursor = { row: Math.min(op.display, this.totalRows() - 1), col: op.col };
    } else if (op.kind === 'insert') {
      this.inserts.splice(op.pos, 1);
    } else if (op.kind === 'delete') {
      if (op.was) this.deletes.add(op.idx); else this.deletes.delete(op.idx);
    }
    this.render();
    this.onDirtyChange(this.dirtyCount());
    this.onStatus(this.dirtyCount() ? `Undone. ${this.changeSummary()} still staged.` : 'Undone. Nothing staged.');
    return true;
  }

  /** The change set for the main process, or null when nothing is staged. */
  buildChanges() {
    if (!this.editable || !this.dirtyCount()) return null;
    const { source, key } = this.result;
    const unwrap = (v) => (v === NULL_TOKEN ? null : v);
    const keyValues = (rowIdx) => key.map((c) => this.rows[rowIdx][c]);

    const updates = [];
    for (const [rowIdx, cells] of this.edits) {
      if (this.deletes.has(rowIdx)) continue;
      const set = {};
      for (const [col, val] of cells) set[col] = unwrap(val);
      updates.push({ keyValues: keyValues(rowIdx), set });
    }
    const deletes = [...this.deletes].map((rowIdx) => ({ keyValues: keyValues(rowIdx) }));
    const inserts = this.inserts.map((ins) => {
      const values = {};
      for (const [col, val] of ins.values) values[col] = unwrap(val);
      return { values };
    });
    return { source, columns: this.columns, key, updates, inserts, deletes };
  }

  /** Human-readable preview of what commit() will run. */
  changeSummary() {
    const c = this.buildChanges();
    if (!c) return '';
    const bits = [];
    if (c.updates.length) bits.push(`${c.updates.length} update${c.updates.length > 1 ? 's' : ''}`);
    if (c.inserts.length) bits.push(`${c.inserts.length} insert${c.inserts.length > 1 ? 's' : ''}`);
    if (c.deletes.length) bits.push(`${c.deletes.length} delete${c.deletes.length > 1 ? 's' : ''}`);
    return bits.join(', ');
  }

  destroy() {
    this.cancelEditor();
    this.el.remove();
  }
}

/* ------------------------------ helpers ------------------------------ */

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function display(v) {
  const s = typeof v === 'string' ? v : String(v);
  return s.length > 500 ? s.slice(0, 500) + '…' : s.replace(/\n/g, '⏎');
}

function shortType(t) {
  return t
    .replace('character varying', 'varchar')
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('double precision', 'float8');
}

export { NULL_TOKEN };
