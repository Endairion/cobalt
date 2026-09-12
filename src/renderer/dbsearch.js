/**
 * Find in database — the panel.
 *
 * The work is expensive and unindexable, so the two things this owes you are
 * honesty about what it covered and a way to stop it. It says how many tables
 * it scanned, how many rows of each, and marks any result that hit the cap so
 * "3 matches" is never mistaken for "3 matches in the whole table".
 *
 * A hit is a starting point, not an answer: clicking one opens that table with
 * the filter already applied, so you land on the actual rows.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ctx = {
  showOverlay: () => () => {},
  search: async () => ({ matches: [] }),
  cancel: async () => {},
  openMatch: () => {},
  toast: () => {},
  connName: () => '',
};

export function wire(c) { ctx = { ...ctx, ...c }; }

const CAPS = [
  { value: 1000, label: 'first 1,000 rows per table' },
  { value: 10000, label: 'first 10,000 rows per table' },
  { value: 50000, label: 'first 50,000 rows per table' },
  { value: 250000, label: 'first 250,000 rows per table' },
  { value: 0, label: 'every row (can be slow)' },
];

const DEFAULT_CAP = 50000;
const num = (n) => Number(n || 0).toLocaleString();

/** Highlight the needle inside a sample without letting either inject markup. */
export function highlight(sample, needle) {
  const text = String(sample == null ? '' : sample);
  const find = String(needle == null ? '' : needle);
  if (!find) return esc(text);
  const at = text.toLowerCase().indexOf(find.toLowerCase());
  if (at === -1) return esc(text);
  return esc(text.slice(0, at))
    + `<mark>${esc(text.slice(at, at + find.length))}</mark>`
    + esc(text.slice(at + find.length));
}

export function openSearch(connId, initial = '') {
  const node = document.createElement('div');
  node.className = 'modal search-modal';
  const close = ctx.showOverlay(node);

  const state = {
    needle: initial,
    mode: 'contains',
    caseSensitive: false,
    includeNumeric: false,
    rowCap: DEFAULT_CAP,
    running: false,
    result: null,
    error: null,
  };

  const draw = () => {
    const r = state.result;
    node.innerHTML = `
      <h2>Find in database<span class="hint"> · ${esc(ctx.connName(connId))}</span></h2>
      <div class="body">
        <div class="sr-bar">
          <input id="sr-needle" type="text" value="${esc(state.needle)}" spellcheck="false"
                 placeholder="a value to look for, anywhere" />
          <select id="sr-mode">
            <option value="contains"${state.mode === 'contains' ? ' selected' : ''}>contains</option>
            <option value="exact"${state.mode === 'exact' ? ' selected' : ''}>is exactly</option>
            <option value="starts"${state.mode === 'starts' ? ' selected' : ''}>starts with</option>
          </select>
          <button class="btn ${state.running ? 'danger' : 'primary'}" data-sr="${state.running ? 'stop' : 'go'}">
            ${state.running ? 'Stop' : 'Search'}
          </button>
        </div>

        <div class="sr-opts">
          <label class="op-check"><input type="checkbox" id="sr-case" ${state.caseSensitive ? 'checked' : ''} />
            <span>Match case</span></label>
          <label class="op-check"><input type="checkbox" id="sr-num" ${state.includeNumeric ? 'checked' : ''} />
            <span>Also numbers and dates</span>
            <span class="hint">off by default — "1" would match half the database</span></label>
          <span class="spacer"></span>
          <select id="sr-cap">
            ${CAPS.map((c) => `<option value="${c.value}"${c.value === state.rowCap ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </div>

        ${state.error ? `<div class="im-error">${esc(state.error)}</div>` : ''}
        ${state.running ? '<div class="sr-running">Scanning… this cannot use an index, so it reads rows.</div>' : ''}
        ${r ? summaryHtml(r) : ''}
        ${r ? resultsHtml(r) : ''}
      </div>
      <div class="foot">
        <span class="hint">A hit opens that table with the filter already applied.</span>
        <span class="spacer"></span>
        <button class="btn ghost" data-sr="close">Close</button>
      </div>`;

    const input = node.querySelector('#sr-needle');
    if (input && !state.running) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const summaryHtml = (r) => {
    const capped = r.matches.some((m) => m.capped);
    const bits = [
      `${num(r.matches.length)} match${r.matches.length === 1 ? '' : 'es'}`,
      `${num(r.scannedTables)} of ${num(r.totalTables)} tables`,
      `${r.elapsedMs} ms`,
    ];
    if (r.skippedViews) bits.push(`${num(r.skippedViews)} views skipped`);
    return `
      <div class="sr-summary">
        ${bits.map((b) => `<span class="pill">${esc(b)}</span>`).join('')}
        ${r.cancelled ? '<span class="pill warn">stopped early</span>' : ''}
        ${capped ? `<span class="pill warn" title="Some tables have more rows than were scanned">capped at ${num(r.rowCap)} rows</span>` : ''}
      </div>
      ${r.errors.length ? `<div class="im-error">${esc(r.errors.length)} table${r.errors.length === 1 ? '' : 's'} could not be read — ${esc(r.errors[0].schema)}.${esc(r.errors[0].table)}: ${esc(r.errors[0].message)}</div>` : ''}`;
  };

  const resultsHtml = (r) => {
    if (!r.matches.length) {
      return `<div class="sr-none">Nothing matched${r.includeNumeric ? '' : ' — numbers and dates were not searched'}.</div>`;
    }
    return `
      <div class="sr-table">
        <table>
          <tr><th>where</th><th>column</th><th class="n">rows</th><th>an example</th></tr>
          ${r.matches.map((m, i) => `
            <tr data-hit="${i}" title="Open ${esc(m.schema)}.${esc(m.table)} filtered to these rows">
              <td>${esc(m.schema)}.<strong>${esc(m.table)}</strong></td>
              <td>${esc(m.column)}<span class="sr-type">${esc(m.type || '')}</span></td>
              <td class="n">${num(m.count)}${m.capped ? '<span class="sr-cap" title="of the rows that were scanned">+</span>' : ''}</td>
              <td class="sr-sample">${highlight(m.sample, r.needle)}</td>
            </tr>`).join('')}
        </table>
      </div>`;
  };

  const collect = () => {
    state.needle = node.querySelector('#sr-needle').value;
    state.mode = node.querySelector('#sr-mode').value;
    state.caseSensitive = node.querySelector('#sr-case').checked;
    state.includeNumeric = node.querySelector('#sr-num').checked;
    // 0 is the explicit "every row"; anything unrecognised falls back to the
    // default rather than to unlimited, which is the most expensive option and
    // a poor thing to arrive at by accident.
    const cap = node.querySelector('#sr-cap').value;
    state.rowCap = cap === '0' ? null : (Number(cap) || DEFAULT_CAP);
  };

  const go = async () => {
    collect();
    if (!state.needle.trim()) { ctx.toast('Type something to look for.'); return; }
    state.running = true;
    state.error = null;
    state.result = null;
    draw();
    try {
      state.result = await ctx.search(connId, {
        needle: state.needle,
        mode: state.mode,
        caseSensitive: state.caseSensitive,
        includeNumeric: state.includeNumeric,
        rowCap: state.rowCap,
      });
    } catch (err) {
      state.error = err.message;
    } finally {
      state.running = false;
      draw();
    }
  };

  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'sr-needle') { e.preventDefault(); go(); }
  });

  node.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-hit]');
    if (row && state.result) {
      const m = state.result.matches[Number(row.dataset.hit)];
      close();
      ctx.openMatch(connId, m, {
        needle: state.result.needle,
        mode: state.result.mode,
        caseSensitive: state.result.caseSensitive,
      });
      return;
    }
    const b = e.target.closest('[data-sr]');
    if (!b) return;
    if (b.dataset.sr === 'close') { close(); return; }
    if (b.dataset.sr === 'stop') { await ctx.cancel(connId); return; }
    if (b.dataset.sr === 'go') go();
  });

  draw();
}
