/**
 * Virtualized, editable result grid.
 *
 * Rows arrive as arrays (pg rowMode:'array') so duplicate column names survive.
 * Edits are staged locally — nothing hits the database until commit() is called
 * by the app with the change set this grid produces.
 */

import { parseFilter } from './filter.js';

const ROW_H = 24;
const HEAD_H = 26;
const FILTER_H = 26;
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

export class ResultGrid {
  constructor(host, { onDirtyChange, onStatus, onFilter, onSort, onNeedMore, onCellMenu, readOnly = false } = {}) {
    this.host = host;
    this.onDirtyChange = onDirtyChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onFilter = onFilter || (() => {});
    this.onSort = onSort || (() => {});
    this.onNeedMore = onNeedMore || (() => {});
    this.onCellMenu = onCellMenu || (() => {});
    this.loadingMore = false;
    this.readOnly = readOnly;
    this.filterVisible = false;
    this.filterText = new Map();   // colIndex -> raw text the user typed
    this.filterError = new Map();  // colIndex -> parse error

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

    this.cursor = { row: 0, col: 0 };
    this.editing = null;

    this.el = document.createElement('div');
    this.el.className = 'grid';
    this.el.tabIndex = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'grid-inner';
    this.head = document.createElement('div');
    this.head.className = 'grid-head';
    this.filterRow = document.createElement('div');
    this.filterRow.className = 'grid-filter';
    this.filterRow.hidden = true;
    this.body = document.createElement('div');
    this.body.className = 'grid-body';
    this.inner.append(this.head, this.filterRow, this.body);
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

    this.filterRow.addEventListener('input', (e) => {
      const input = e.target.closest('input[data-filter]');
      if (!input) return;
      this.filterText.set(Number(input.dataset.filter), input.value);
    });
    this.filterRow.addEventListener('keydown', (e) => {
      const input = e.target.closest('input[data-filter]');
      if (!input) return;
      if (e.key === 'Enter') { e.preventDefault(); this.applyFilters(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value) { input.value = ''; this.filterText.delete(Number(input.dataset.filter)); }
        else this.toggleFilter(false);
      }
    });
  }

  /* ------------------------------ filters ------------------------------ */

  headOffset() { return HEAD_H + (this.filterVisible ? FILTER_H : 0); }

  toggleFilter(show) {
    this.filterVisible = show === undefined ? !this.filterVisible : !!show;
    this.filterRow.hidden = !this.filterVisible;
    if (!this.filterVisible && this.filterText.size) {
      this.filterText.clear();
      this.filterError.clear();
      this.applyFilters();
    }
    this.render();
    if (this.filterVisible) {
      const first = this.filterRow.querySelector('input[data-filter]:not([disabled])');
      if (first) first.focus();
    }
  }

  /** Column names that appear more than once can't be referenced unambiguously. */
  ambiguous(name) {
    return this.columns.filter((c) => c.name === name).length > 1;
  }

  /** Parse every box; hand the caller the specs, or surface the first bad one. */
  applyFilters() {
    const specs = [];
    this.filterError.clear();
    for (const [col, text] of this.filterText) {
      if (!String(text).trim()) continue;
      const column = this.columns[col];
      if (!column) continue;
      const parsed = parseFilter(text, column);
      if (!parsed) continue;
      if (parsed.error) { this.filterError.set(col, parsed.error); continue; }
      specs.push({ ...parsed, name: column.name, column: col });
    }
    this.renderFilterRow();
    if (this.filterError.size) {
      this.onStatus([...this.filterError.values()][0]);
      return;
    }
    this.onFilter(specs);
  }

  activeFilters() {
    return [...this.filterText.entries()].filter(([, v]) => String(v).trim()).length;
  }

  clearFilters() {
    this.filterText.clear();
    this.filterError.clear();
    this.renderFilterRow();
    this.onFilter([]);
  }

  renderFilterRow() {
    if (!this.columns.length) { this.filterRow.innerHTML = ''; return; }
    const parts = [`<div class="gf rownum" style="width:${NUM_W}px"></div>`];
    this.columns.forEach((c, i) => {
      const amb = this.ambiguous(c.name);
      const err = this.filterError.get(i);
      const val = this.filterText.get(i) || '';
      const title = amb
        ? `"${c.name}" appears more than once in this result, so it can't be filtered unambiguously`
        : (err || `Filter ${c.name} — try: bob · >= 100 · != draft · %ob% · in a, b · null`);
      parts.push(
        `<div class="gf${err ? ' err' : ''}" style="width:${this.widths[i]}px">` +
        `<input type="text" data-filter="${i}" value="${escAttr(val)}" spellcheck="false"` +
        ` ${amb ? 'disabled' : ''} placeholder="${amb ? '—' : 'filter'}" title="${escAttr(title)}" /></div>`
      );
    });
    this.filterRow.innerHTML = parts.join('');
    this.filterRow.style.width = `${this.totalWidth()}px`;
    this.filterRow.style.top = `${HEAD_H}px`;
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

    if (!keepFilters) { this.filterText.clear(); this.filterError.clear(); }
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

  /** Logical row at display index: {kind:'row', idx} or {kind:'new', pos}. */
  at(display) {
    if (display < this.order.length) return { kind: 'row', idx: this.order[display] };
    return { kind: 'new', pos: display - this.order.length };
  }

  valueAt(display, col) {
    const ref = this.at(display);
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
    if (ref.kind === 'new') return this.inserts[ref.pos].values.has(col);
    const e = this.edits.get(ref.idx);
    return !!(e && e.has(col));
  }

  rowState(display) {
    const ref = this.at(display);
    if (ref.kind === 'new') return 'new';
    if (this.deletes.has(ref.idx)) return 'del';
    if (this.edits.has(ref.idx)) return 'dirty';
    return '';
  }

  dirtyCount() {
    let n = this.inserts.length + this.deletes.size;
    for (const [idx] of this.edits) if (!this.deletes.has(idx)) n++;
    return n;
  }

  /* ----------------------------- render ----------------------------- */

  render() {
    this.renderHead();
    if (this.filterVisible) this.renderFilterRow();
    this.body.style.height = `${this.totalRows() * ROW_H}px`;
    this.inner.style.width = `${this.totalWidth()}px`;
    this.renderRows();
  }

  totalWidth() {
    return NUM_W + this.widths.reduce((a, b) => a + b, 0);
  }

  renderHead() {
    const parts = [`<div class="gh rownum" style="width:${NUM_W}px">#</div>`];
    this.columns.forEach((c, i) => {
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
      for (let c = 0; c < this.columns.length; c++) {
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
    const cell = e.target.closest('.gc[data-col]');
    if (!cell) return;
    const row = Number(cell.parentElement.dataset.row);
    const col = Number(cell.dataset.col);
    this.commitEditor();
    this.setCursor(row, col);
    this.el.focus();
  }

  onDoubleClick(e) {
    const cell = e.target.closest('.gc[data-col]');
    if (!cell) return;
    this.beginEdit();
  }

  setCursor(row, col, { scroll = false } = {}) {
    const total = this.totalRows();
    this.cursor = {
      row: Math.max(0, Math.min(total - 1, row)),
      col: Math.max(0, Math.min(this.columns.length - 1, col)),
    };
    if (scroll) this.scrollToCursor();
    this.renderRows();
    this.emitCellStatus();
  }

  emitCellStatus() {
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
    for (let i = 0; i < this.cursor.col; i++) x += this.widths[i];
    const w = this.widths[this.cursor.col] || 0;
    if (x < this.el.scrollLeft + NUM_W) this.el.scrollLeft = Math.max(0, x - NUM_W);
    else if (x + w > this.el.scrollLeft + this.el.clientWidth) this.el.scrollLeft = x + w - this.el.clientWidth;
  }

  onKeyDown(e) {
    if (this.editing) return;
    const { row, col } = this.cursor;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'c') { this.copyCell(); e.preventDefault(); return; }
    if (mod && e.key === '0') { this.setValue(row, col, NULL_TOKEN); e.preventDefault(); return; }

    switch (e.key) {
      case 'ArrowDown': this.setCursor(row + 1, col, { scroll: true }); e.preventDefault(); break;
      case 'ArrowUp': this.setCursor(row - 1, col, { scroll: true }); e.preventDefault(); break;
      case 'ArrowLeft': this.setCursor(row, col - 1, { scroll: true }); e.preventDefault(); break;
      case 'ArrowRight': this.setCursor(row, col + 1, { scroll: true }); e.preventDefault(); break;
      case 'Tab':
        this.setCursor(row, col + (e.shiftKey ? -1 : 1), { scroll: true }); e.preventDefault(); break;
      case 'PageDown':
        this.setCursor(row + Math.floor(this.el.clientHeight / ROW_H), col, { scroll: true }); e.preventDefault(); break;
      case 'PageUp':
        this.setCursor(row - Math.floor(this.el.clientHeight / ROW_H), col, { scroll: true }); e.preventDefault(); break;
      case 'Home':
        this.setCursor(mod ? 0 : row, 0, { scroll: true }); e.preventDefault(); break;
      case 'End':
        this.setCursor(mod ? this.totalRows() - 1 : row, this.columns.length - 1, { scroll: true }); e.preventDefault(); break;
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
    const lines = [this.columns.map((c) => c.name).join('\t')];
    for (let d = 0; d < this.totalRows(); d++) {
      const cells = this.columns.map((_, c) => {
        const v = this.valueAt(d, c);
        return v === null ? '' : String(v).replace(/[\t\n\r]/g, ' ');
      });
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }

  toCsv() {
    const q = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const lines = [this.columns.map((c) => q(c.name)).join(',')];
    for (let d = 0; d < this.totalRows(); d++) {
      lines.push(this.columns.map((_, c) => {
        const v = this.valueAt(d, c);
        return v === null ? '' : q(String(v));
      }).join(','));
    }
    return lines.join('\r\n');
  }

  /* ------------------------------ editing ------------------------------ */

  beginEdit(seedChar) {
    if (!this.totalRows() || !this.columns.length) return;
    if (!this.editable) {
      this.onStatus(this.result && this.result.notEditableReason ? this.result.notEditableReason : 'Result is read-only.');
      return;
    }
    const ref = this.at(this.cursor.row);
    if (ref.kind === 'row' && this.deletes.has(ref.idx)) {
      this.onStatus('Row is marked for deletion.');
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

  cancelEditor() {
    if (!this.editing) return;
    this.editing.input.remove();
    this.editing = null;
    this.el.focus();
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
      this.clearEdit(row, col);
    } else {
      this.setValue(row, col, next);
    }
  }

  originalValue(display, col) {
    const ref = this.at(display);
    if (ref.kind === 'new') return null;
    return this.rows[ref.idx][col];
  }

  setValue(display, col, value) {
    const ref = this.at(display);
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

  clearEdit(display, col) {
    const ref = this.at(display);
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
    this.render();
    this.setCursor(this.totalRows() - 1, 0, { scroll: true });
    this.onDirtyChange(this.dirtyCount());
  }

  toggleDelete() {
    if (!this.editable) { this.onStatus('This result is read-only.'); return; }
    if (!this.totalRows()) return;
    const ref = this.at(this.cursor.row);
    if (ref.kind === 'new') {
      this.inserts.splice(ref.pos, 1);
      this.render();
    } else {
      if (this.deletes.has(ref.idx)) this.deletes.delete(ref.idx);
      else this.deletes.add(ref.idx);
      this.renderRows();
    }
    this.onDirtyChange(this.dirtyCount());
  }

  discard() {
    this.edits.clear();
    this.deletes.clear();
    this.inserts = [];
    this.render();
    this.onDirtyChange(0);
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
