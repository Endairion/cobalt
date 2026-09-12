/**
 * Query history browser.
 *
 * A list on the left, the full statement on the right. Enter puts the selected
 * statement into the current editor; Shift+Enter opens it in a new tab.
 */

let ctx = null;
export function wire(context) { ctx = context; }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ago(iso) {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const ms = (v) => {
  if (v == null) return '';
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(2)} s`;
};

/** Flatten a statement onto one line for the list. */
function oneLine(sql) {
  const t = String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 150 ? t.slice(0, 150) + '…' : t;
}

export async function openHistory() {
  const node = document.createElement('div');
  node.className = 'modal history-modal';
  node.innerHTML = `
    <h2>Query history</h2>
    <div class="hist-body">
      <div class="hist-left">
        <input class="hist-search" id="h-search" type="text" placeholder="Search statements…" spellcheck="false" />
        <div class="hist-filters">
          <label class="checkline"><input type="checkbox" id="h-thisconn" checked /> This connection only</label>
          <label class="checkline"><input type="checkbox" id="h-failed" /> Failed only</label>
        </div>
        <div class="hist-rows" id="h-rows"></div>
      </div>
      <div class="hist-right">
        <pre class="hist-sql" id="h-sql"></pre>
        <div class="hist-meta" id="h-meta"></div>
      </div>
    </div>
    <div class="foot">
      <span class="hint" id="h-stats"></span>
      <span class="spacer"></span>
      <button class="btn ghost" id="h-clear">Clear history</button>
      <button class="btn ghost" id="h-newtab">Open in new tab</button>
      <button class="btn primary" id="h-use">Use in editor</button>
    </div>`;

  const close = ctx.showOverlay(node);
  const $ = (id) => node.querySelector('#' + id);
  let rows = [];
  let sel = 0;

  const load = async () => {
    const conn = ctx.activeConnection();
    rows = await ctx.search({
      q: $('h-search').value,
      connectionId: $('h-thisconn').checked && conn ? conn.savedId : null,
      failedOnly: $('h-failed').checked,
      limit: 300,
    });
    sel = 0;
    draw();
  };

  const draw = () => {
    if (!rows.length) {
      $('h-rows').innerHTML = '<div class="mgr-empty">Nothing yet — run a query.</div>';
      $('h-sql').textContent = '';
      $('h-meta').innerHTML = '';
      return;
    }
    $('h-rows').innerHTML = rows.map((r, i) => `
      <div class="hist-row${i === sel ? ' sel' : ''}${r.error ? ' failed' : ''}" data-i="${i}">
        <div class="hist-sql-line">${esc(oneLine(r.sql))}</div>
        <div class="hist-sub">
          <span>${esc(ago(r.at))}</span>
          ${r.connectionName ? `<span class="dim">${esc(r.connectionName)}</span>` : ''}
          ${r.error ? '<span class="hist-badge err">failed</span>'
            : `${r.rowCount != null ? `<span class="dim">${Number(r.rowCount).toLocaleString()} rows</span>` : ''}
               ${r.durationMs != null ? `<span class="dim">${esc(ms(r.durationMs))}</span>` : ''}`}
          ${r.runs > 1 ? `<span class="hist-badge">${r.runs}x</span>` : ''}
        </div>
      </div>`).join('');

    const r = rows[sel];
    $('h-sql').textContent = r ? r.sql : '';
    $('h-meta').innerHTML = r ? [
      `<div><b>When</b> ${esc(new Date(r.at).toLocaleString())}${r.runs > 1 ? ` · ran ${r.runs} times` : ''}</div>`,
      r.connectionName ? `<div><b>Connection</b> ${esc(r.connectionName)}${r.database ? ` · ${esc(r.database)}` : ''}</div>` : '',
      r.durationMs != null ? `<div><b>Took</b> ${esc(ms(r.durationMs))}${r.runs > 1 ? ' (fastest run)' : ''}</div>` : '',
      r.rowCount != null ? `<div><b>Rows</b> ${Number(r.rowCount).toLocaleString()}</div>` : '',
      r.error ? `<div class="hist-err"><b>Error</b> ${esc(r.error)}</div>` : '',
    ].join('') : '';

    const selEl = $('h-rows').querySelector('.hist-row.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  };

  const use = (newTab) => {
    const r = rows[sel];
    if (!r) return;
    close();
    if (newTab) ctx.openInNewTab(r.sql);
    else ctx.insertIntoEditor(r.sql);
  };

  $('h-search').addEventListener('input', load);
  $('h-thisconn').addEventListener('change', load);
  $('h-failed').addEventListener('change', load);
  $('h-rows').addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    sel = Number(row.dataset.i);
    draw();
  });
  $('h-rows').addEventListener('dblclick', () => use(false));
  $('h-use').addEventListener('click', () => use(false));
  $('h-newtab').addEventListener('click', () => use(true));
  $('h-clear').addEventListener('click', async () => {
    const ok = await ctx.confirm({
      title: 'Clear query history',
      message: 'Delete every recorded statement?',
      detail: 'This only removes the local history file. Nothing on any server changes.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    await ctx.clear();
    await load();
    await showStats();
  });

  $('h-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(rows.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { use(e.shiftKey); e.preventDefault(); }
  });

  const showStats = async () => {
    try {
      const st = await ctx.stats();
      $('h-stats').textContent = st.entries
        ? `${st.entries.toLocaleString()} statements recorded · ${(st.bytes / 1024).toFixed(0)} kB`
        : 'No history yet';
    } catch { /* the footer is decoration */ }
  };

  await load();
  await showStats();
  setTimeout(() => $('h-search').focus(), 0);
}
