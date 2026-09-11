import { SqlEditor } from './editor.js';
import { ResultGrid } from './grid.js';

const api = window.cobalt;
const $ = (id) => document.getElementById(id);

const el = {
  sidebar: $('sidebar'),
  connBar: $('conn-bar'),
  tree: $('tree'),
  filter: $('schema-filter'),
  sidebarFoot: $('sidebar-foot'),
  sidebarResizer: $('sidebar-resizer'),
  tabstrip: $('tabstrip'),
  workarea: $('workarea'),
  editorHost: $('editor-host'),
  editorHint: $('editor-hint'),
  paneResizer: $('pane-resizer'),
  resultTabs: $('result-tabs'),
  gridToolbar: $('grid-toolbar'),
  gridHost: $('grid-host'),
  statusLeft: $('status-left'),
  statusRight: $('status-right'),
  overlay: $('overlay'),
  toastHost: $('toast-host'),
  btnRun: $('btn-run'),
  btnRunAll: $('btn-run-all'),
  btnCancel: $('btn-cancel'),
  btnNewConn: $('btn-new-connection'),
};

/* ------------------------------ state ------------------------------ */

const state = {
  saved: [],              // saved connection records
  conns: new Map(),       // liveId -> { id, savedId, name, database, serverVersion, tree, expanded:Set, readOnly }
  activeConnId: null,
  tabs: [],
  activeTabId: null,
  tabSeq: 0,
  filter: '',
};

let editor = null;

/* ------------------------------ helpers ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toast(message, kind = '') {
  if (kind === 'err') console.error('[cobalt]', message);
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el.toastHost.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'err' ? 6000 : 3000);
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const fmtNum = (n) => Number(n).toLocaleString();

const qid = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : '"' + String(s).replace(/"/g, '""') + '"');
const qrel = (schema, name) => (schema === 'public' ? qid(name) : `${qid(schema)}.${qid(name)}`);

/* ------------------------------- tabs ------------------------------- */

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function newTab({ connId = state.activeConnId, title, sql = '', run = false, kind = 'query' } = {}) {
  const id = `t${++state.tabSeq}`;
  const tab = {
    id,
    connId,
    kind,
    title: title || `Query ${state.tabSeq}`,
    editorState: editor.makeState(sql),
    results: [],
    activeResult: 0,
    grid: null,
    running: false,
    filePath: null,
    dirtyDoc: false,
  };
  state.tabs.push(tab);
  selectTab(id);
  if (run) runScript(false);
  saveWorkspace();
  return tab;
}

function selectTab(id) {
  const current = activeTab();
  if (current && current.id === id) return;
  if (current) current.editorState = editor.state;   // stash the outgoing document
  state.activeTabId = id;
  const tab = activeTab();
  if (tab) {
    editor.swapState(tab.editorState);
    if (tab.connId && state.conns.has(tab.connId)) state.activeConnId = tab.connId;
  }
  renderTabs();
  renderConnBar();
  renderResults();
  updateToolbar();
  renderStatus();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  if (tab.grid && tab.grid.dirtyCount()) {
    const ok = await api.ui.confirm({
      title: 'Unsaved grid changes',
      message: `"${tab.title}" has ${tab.grid.changeSummary()} that have not been committed.`,
      detail: 'Closing the tab discards them.',
      confirmLabel: 'Discard and close',
      destructive: true,
    });
    if (!ok) return;
  }
  if (tab.connId) api.query.release(tab.connId, tab.id).catch(() => {});
  if (tab.grid) tab.grid.destroy();
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) {
      // Avoid swapping the dead tab's state back in.
      state.activeTabId = next.id;
      editor.swapState(next.editorState);
    } else {
      state.activeTabId = null;
      newTab({ title: 'Query 1' });
      return;
    }
  }
  renderTabs();
  renderResults();
  updateToolbar();
  saveWorkspace();
}

function cycleTab(delta) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const next = state.tabs[(i + delta + state.tabs.length) % state.tabs.length];
  selectTab(next.id);
}

function renderTabs() {
  const parts = state.tabs.map((t) => {
    const conn = t.connId ? state.conns.get(t.connId) : null;
    const dirty = t.grid && t.grid.dirtyCount() ? '<span class="t-dirty"></span>' : '';
    const label = conn ? `${t.title}` : `${t.title}`;
    return `<div class="tab${t.id === state.activeTabId ? ' active' : ''}" data-tab="${t.id}" title="${esc(conn ? conn.name + ' · ' + conn.database : 'No connection')}">
      ${dirty}<span class="t-label">${esc(label)}</span>
      <button class="t-close" data-close="${t.id}">×</button>
    </div>`;
  });
  parts.push('<button class="tab-add" id="tab-add" title="New tab (Ctrl+T)">+</button>');
  el.tabstrip.innerHTML = parts.join('');
}

el.tabstrip.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { closeTab(close.dataset.close); return; }
  if (e.target.id === 'tab-add') { newTab(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) selectTab(tab.dataset.tab);
});

/* --------------------------- connections --------------------------- */

async function refreshSaved() {
  state.saved = await api.connections.list();
  renderConnBar();
}

function renderConnBar() {
  const live = [...state.conns.values()];
  const liveBySaved = new Map(live.map((c) => [c.savedId, c]));
  const rows = state.saved.map((s) => {
    const l = liveBySaved.get(s.id);
    const active = l && l.id === state.activeConnId;
    return `<div class="conn-chip${l ? ' live' : ''}${active ? ' active' : ''}" data-saved="${s.id}" title="${esc(s.user ? s.user + '@' : '')}${esc(s.host)}:${s.port}/${esc(s.database)}">
      <span class="dot"></span>
      <span class="label">${esc(s.name)}</span>
      ${l ? `<span class="sub">${esc(l.database)}</span>` : ''}
      <button class="chip-x" data-edit="${s.id}" title="Edit">⋯</button>
    </div>`;
  });
  if (!rows.length) {
    rows.push('<div class="conn-chip" data-new="1"><span class="dot"></span><span class="label">Add a connection…</span></div>');
  }
  el.connBar.innerHTML = rows.join('');
}

el.connBar.addEventListener('click', async (e) => {
  if (e.target.closest('[data-new]')) { openConnectionDialog(null); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    e.stopPropagation();
    openConnectionDialog(state.saved.find((s) => s.id === edit.dataset.edit));
    return;
  }
  const chip = e.target.closest('[data-saved]');
  if (!chip) return;
  const savedId = chip.dataset.saved;
  const existing = [...state.conns.values()].find((c) => c.savedId === savedId);
  if (existing) {
    state.activeConnId = existing.id;
    const t = activeTab();
    if (t && !t.connId) t.connId = existing.id;
    renderConnBar();
    renderTree();
    renderStatus();
  } else {
    await connect(savedId);
  }
});

async function connect(savedId, overrides) {
  const saved = state.saved.find((s) => s.id === savedId);
  setStatus(`Connecting to ${saved ? saved.name : savedId}…`);
  try {
    const info = await api.connections.open(savedId, overrides);
    state.conns.set(info.id, {
      id: info.id,
      savedId,
      name: info.name,
      database: info.database,
      serverVersion: info.serverVersion,
      readOnly: !!info.readOnly,
      tree: null,
      expanded: new Set(),
    });
    state.activeConnId = info.id;
    const t = activeTab();
    if (t && !t.connId) t.connId = info.id;
    renderConnBar();
    await loadSchema(info.id);
    toast(`Connected to ${info.name} · PostgreSQL ${info.serverVersion}`, 'ok');
    updateToolbar();
    renderStatus();
    return info.id;
  } catch (err) {
    if (/password|authentication/i.test(err.message || '')) {
      const pw = await promptPassword(saved ? saved.name : 'connection');
      if (pw != null) return connect(savedId, { password: pw });
    }
    toast(`Connect failed: ${err.message}`, 'err');
    setStatus('');
    return null;
  }
}

async function disconnect(connId) {
  const conn = state.conns.get(connId);
  if (!conn) return;
  for (const t of state.tabs) if (t.connId === connId) t.connId = null;
  state.conns.delete(connId);
  if (state.activeConnId === connId) state.activeConnId = [...state.conns.keys()][0] || null;
  await api.connections.close(connId).catch(() => {});
  renderConnBar();
  renderTree();
  renderStatus();
}

async function loadSchema(connId) {
  const conn = state.conns.get(connId);
  if (!conn) return;
  setStatus('Loading schema…');
  try {
    const tree = await api.connections.schema(connId);
    conn.tree = tree;
    if (!conn.expanded.size) {
      const pub = tree.schemas.find((s) => s.name === 'public') || tree.schemas[0];
      if (pub) conn.expanded.add(`schema:${pub.name}`);
    }
    renderTree();
    if (connId === state.activeConnId) editor.setSchema(tree);
    setStatus('');
  } catch (err) {
    toast(`Schema load failed: ${err.message}`, 'err');
    setStatus('');
  }
}

/* ------------------------------- tree ------------------------------- */

function renderTree() {
  const conn = state.conns.get(state.activeConnId);
  if (!conn || !conn.tree) {
    el.tree.innerHTML = '<div class="sidebar-foot" style="border:0">No connection. Click + to add one.</div>';
    el.sidebarFoot.textContent = '';
    return;
  }
  const needle = state.filter.trim().toLowerCase();
  const out = [];
  let shown = 0;

  for (const s of conn.tree.schemas) {
    const relations = needle
      ? s.relations.filter((r) =>
          r.name.toLowerCase().includes(needle) ||
          r.columns.some((c) => c.name.toLowerCase().includes(needle)))
      : s.relations;
    if (needle && !relations.length) continue;

    const key = `schema:${s.name}`;
    const open = needle ? true : conn.expanded.has(key);
    out.push(`<div class="tree-row schema" data-toggle="${esc(key)}">
      <span class="twisty">${open ? '▾' : '▸'}</span>
      <span class="name">${esc(s.name)}</span>
      <span class="meta">${relations.length}</span>
    </div>`);
    if (!open) continue;

    for (const r of relations) {
      shown++;
      const ckey = `rel:${s.name}.${r.name}`;
      const copen = conn.expanded.has(ckey);
      out.push(`<div class="tree-row rel" data-rel="${esc(s.name)}|${esc(r.name)}" data-toggle="${esc(ckey)}" title="${esc(s.name)}.${esc(r.name)}">
        <span class="twisty">${copen ? '▾' : '▸'}</span>
        <span class="kind ${r.kind}">${kindLabel(r.kind)}</span>
        <span class="name">${esc(r.name)}</span>
        <span class="meta">${r.estRows > 0 ? approx(r.estRows) : ''}</span>
      </div>`);
      if (copen) {
        for (const c of r.columns) {
          out.push(`<div class="tree-row column" data-col="${esc(c.name)}" title="${esc(c.name)} ${esc(c.type)}">
            <span class="name">${c.isPk ? '<span class="pk">PK </span>' : ''}${esc(c.name)}</span>
            <span class="ctype">${esc(c.type)}</span>
          </div>`);
        }
      }
    }
  }
  el.tree.innerHTML = out.join('') || '<div class="sidebar-foot" style="border:0">No matches.</div>';
  el.sidebarFoot.textContent = `${conn.database} · PostgreSQL ${conn.serverVersion} · ${shown} objects`;
}

const kindLabel = (k) => ({ r: 'T', p: 'P', v: 'V', m: 'MV', f: 'F' }[k] || '?');

function approx(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

el.tree.addEventListener('click', (e) => {
  const conn = state.conns.get(state.activeConnId);
  if (!conn) return;
  const row = e.target.closest('[data-toggle]');
  if (!row) return;
  const key = row.dataset.toggle;
  if (conn.expanded.has(key)) conn.expanded.delete(key);
  else conn.expanded.add(key);
  renderTree();
});

el.tree.addEventListener('dblclick', (e) => {
  const row = e.target.closest('[data-rel]');
  if (!row) return;
  const [schema, name] = row.dataset.rel.split('|');
  openTableTab(schema, name);
});

el.tree.addEventListener('contextmenu', async (e) => {
  const row = e.target.closest('[data-rel]');
  if (!row) return;
  e.preventDefault();
  const [schema, name] = row.dataset.rel.split('|');
  try {
    const ddl = await api.connections.ddl(state.activeConnId, schema, name);
    newTab({ title: `${name} DDL`, sql: ddl + '\n' });
  } catch (err) { toast(err.message, 'err'); }
});

el.filter.addEventListener('input', () => {
  state.filter = el.filter.value;
  renderTree();
});

function openTableTab(schema, name) {
  const sql = `select *\nfrom ${qrel(schema, name)}\nlimit 500;`;
  newTab({ title: name, sql, run: true, kind: 'data' });
}

/* ----------------------------- running ----------------------------- */

async function runScript(all) {
  const tab = activeTab();
  if (!tab) return;
  if (!tab.connId || !state.conns.has(tab.connId)) {
    toast('This tab is not attached to a connection. Pick one in the sidebar.', 'err');
    return;
  }
  if (tab.running) { toast('Query already running in this tab.'); return; }

  if (tab.grid && tab.grid.dirtyCount()) {
    const ok = await api.ui.confirm({
      title: 'Uncommitted changes',
      message: `The grid has ${tab.grid.changeSummary()} that have not been committed.`,
      detail: 'Running a new query discards them.',
      confirmLabel: 'Discard and run',
      destructive: true,
    });
    if (!ok) return;
  }

  let sql;
  let offset = 0;
  if (all) {
    sql = editor.getValue();
  } else {
    const st = editor.currentStatement();
    if (!st || !st.sql.trim()) { toast('Nothing to run.'); return; }
    sql = st.sql;
    offset = st.start;
  }
  if (!sql.trim()) { toast('Nothing to run.'); return; }

  tab.running = true;
  tab.filterBaseSql = null;          // a fresh run is the new filter base
  tab.runStarted = Date.now();
  updateToolbar();
  setStatus('Running…');
  const ticker = setInterval(() => setStatus(`Running… ${fmtMs(Date.now() - tab.runStarted)}`), 200);

  try {
    const { results } = await api.query.run(tab.connId, tab.id, sql, { maxRows: 10000 });
    results.forEach((r) => { r.docOffset = offset + (r.start || 0); });
    tab.results = results;
    tab.activeResult = results.findIndex((r) => r.error) !== -1
      ? results.findIndex((r) => r.error)
      : 0;
    renderResults();
    const failed = results.find((r) => r.error);
    if (failed) {
      const pos = failed.error.position;
      if (pos) editor.highlightError(failed.docOffset, pos);
      setStatus('');
    } else {
      const total = results.reduce((a, r) => a + (r.elapsedMs || 0), 0);
      const rowsBack = results.reduce((a, r) => a + (r.rows ? r.rows.length : 0), 0);
      setStatus(`${results.length} statement${results.length > 1 ? 's' : ''} · ${fmtNum(rowsBack)} rows · ${fmtMs(total)}`);
    }
  } catch (err) {
    tab.results = [{ error: { message: err.message, detail: err.detail, hint: err.hint }, sql }];
    tab.activeResult = 0;
    renderResults();
    setStatus('');
  } finally {
    clearInterval(ticker);
    tab.running = false;
    updateToolbar();
    renderTabs();
  }
}

/**
 * Re-run the current result's query with column filters applied.
 * The base SQL is remembered per tab so successive edits filter the original
 * query rather than stacking wrappers on the previous filtered one.
 */
async function applyFilters(tab, specs) {
  const res = tab.results[tab.activeResult];
  if (!res || res.error || !tab.connId) return;
  if (!tab.filterBaseSql) tab.filterBaseSql = res.baseSql || res.sql;
  const baseSql = tab.filterBaseSql;

  if (tab.grid && tab.grid.dirtyCount()) {
    const ok = await api.ui.confirm({
      title: 'Uncommitted changes',
      message: `Re-running with a filter discards ${tab.grid.changeSummary()}.`,
      confirmLabel: 'Discard and filter',
      destructive: true,
    });
    if (!ok) return;
    tab.grid.discard();
  }

  setStatus(specs.length ? 'Filtering…' : 'Clearing filter…');
  tab.reloadingFilter = true;
  try {
    const { results } = await api.query.filter(tab.connId, tab.id, baseSql, specs, { maxRows: 10000 });
    const next = results[0];
    if (next.error) {
      toast(next.error.message, 'err');
      setStatus('');
      return;
    }
    next.baseSql = baseSql;
    tab.results[tab.activeResult] = next;
    renderResults();
    setStatus(
      `${fmtNum(next.rows.length)}${next.truncated ? '+' : ''} rows · ${fmtMs(next.elapsedMs)}` +
      (specs.length ? ` · ${specs.length} filter${specs.length > 1 ? 's' : ''}` : '')
    );
  } catch (err) {
    toast(`Filter failed: ${err.message}`, 'err');
    setStatus('');
  } finally {
    tab.reloadingFilter = false;
  }
}

async function cancelQuery() {
  const tab = activeTab();
  if (!tab || !tab.running || !tab.connId) return;
  try {
    await api.query.cancel(tab.connId, tab.id);
    toast('Cancel requested.');
  } catch (err) { toast(err.message, 'err'); }
}

/* ----------------------------- results ----------------------------- */

function renderResults() {
  const tab = activeTab();
  // Hide every tab's grid, then show the active one.
  for (const t of state.tabs) if (t.grid) t.grid.el.style.display = 'none';
  el.gridHost.querySelectorAll('.grid-empty, .error-box').forEach((n) => n.remove());

  if (!tab) { el.resultTabs.innerHTML = ''; el.gridToolbar.innerHTML = ''; return; }

  el.resultTabs.innerHTML = tab.results.map((r, i) => {
    const label = r.error
      ? 'Error'
      : (r.rows && r.columns && r.columns.length
          ? `${fmtNum(r.rows.length)}${r.truncated ? '+' : ''} rows`
          : `${r.command || 'OK'}${r.rowCount != null ? ' ' + r.rowCount : ''}`);
    return `<div class="rtab${i === tab.activeResult ? ' active' : ''}${r.error ? ' err' : ''}" data-r="${i}">${i + 1}. ${esc(label)}</div>`;
  }).join('');

  const res = tab.results[tab.activeResult];
  if (!res) {
    el.gridToolbar.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    empty.innerHTML = '<div>Run a query to see results.</div><div style="opacity:.6">Ctrl+Enter runs the statement under the cursor · Ctrl+P opens a table</div>';
    el.gridHost.append(empty);
    return;
  }

  if (res.error) {
    el.gridToolbar.innerHTML = '';
    renderError(res);
    return;
  }

  if (!res.columns || !res.columns.length) {
    el.gridToolbar.innerHTML = `<span class="pill">${esc(res.command || 'OK')}</span><span class="pill">${res.rowCount ?? 0} rows affected</span><span class="pill">${fmtMs(res.elapsedMs)}</span>`;
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    empty.textContent = `${res.command || 'Statement'} completed — ${res.rowCount ?? 0} row(s) affected in ${fmtMs(res.elapsedMs)}.`;
    el.gridHost.append(empty);
    return;
  }

  if (!tab.grid) {
    tab.grid = new ResultGrid(el.gridHost, {
      onDirtyChange: () => { renderGridToolbar(); renderTabs(); },
      onStatus: (s) => { el.statusRight.textContent = s; },
      onFilter: (specs) => applyFilters(tab, specs),
      readOnly: !!(state.conns.get(tab.connId) || {}).readOnly,
    });
  }
  tab.grid.el.style.display = '';
  if (tab.grid.result !== res) tab.grid.load(res, { keepFilters: !!tab.reloadingFilter });
  renderGridToolbar();
}

function renderGridToolbar() {
  const tab = activeTab();
  const res = tab && tab.results[tab.activeResult];
  if (!tab || !res || res.error || !res.columns || !res.columns.length) return;
  const g = tab.grid;
  const dirty = g ? g.dirtyCount() : 0;
  const bits = [];
  bits.push(`<span class="pill">${fmtNum(res.rows.length)}${res.truncated ? '+ (capped)' : ''} rows</span>`);
  bits.push(`<span class="pill">${fmtMs(res.elapsedMs)}</span>`);
  if (res.source) bits.push(`<span class="pill">${esc(res.source.schema)}.${esc(res.source.table)}</span>`);
  if (!res.editable) bits.push(`<span class="pill warn" title="${esc(res.notEditableReason || '')}">read-only</span>`);
  const nFilters = g ? g.activeFilters() : 0;
  if (nFilters) bits.push(`<span class="pill on">${nFilters} filter${nFilters > 1 ? 's' : ''}</span>`);

  const filterBtn =
    `<button class="btn small ${g && g.filterVisible ? 'primary' : 'ghost'}" data-act="filter" title="Filter results (Ctrl+Shift+F)">Filter</button>` +
    (nFilters ? '<button class="btn small ghost" data-act="clearFilters">Clear</button>' : '');

  const actions = res.editable
    ? `<span class="spacer"></span>
       ${filterBtn}
       <button class="btn small ghost" data-act="add">+ Row</button>
       <button class="btn small ghost" data-act="del">Delete row</button>
       <button class="btn small ${dirty ? 'primary' : ''}" data-act="commit" ${dirty ? '' : 'disabled'}>Commit${dirty ? ` (${g.changeSummary()})` : ''}</button>
       <button class="btn small ghost" data-act="discard" ${dirty ? '' : 'disabled'}>Discard</button>
       <button class="btn small ghost" data-act="csv">CSV</button>`
    : `<span class="spacer"></span>${filterBtn}<button class="btn small ghost" data-act="csv">CSV</button>`;

  el.gridToolbar.innerHTML = bits.join('') + actions;
}

el.gridToolbar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const tab = activeTab();
  if (!tab || !tab.grid) return;
  switch (act.dataset.act) {
    case 'add': tab.grid.addRow(); break;
    case 'del': tab.grid.toggleDelete(); break;
    case 'commit': commitGrid(); break;
    case 'discard': tab.grid.discard(); renderGridToolbar(); break;
    case 'csv': exportCsv(); break;
    case 'filter': tab.grid.toggleFilter(); renderGridToolbar(); break;
    case 'clearFilters': tab.grid.clearFilters(); renderGridToolbar(); break;
  }
});

el.resultTabs.addEventListener('click', async (e) => {
  const r = e.target.closest('[data-r]');
  if (!r) return;
  const tab = activeTab();
  if (!tab) return;
  const idx = Number(r.dataset.r);
  if (idx === tab.activeResult) return;
  if (tab.grid && tab.grid.dirtyCount()) {
    const ok = await api.ui.confirm({
      title: 'Uncommitted changes',
      message: `Switching result sets discards ${tab.grid.changeSummary()}.`,
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return;
    tab.grid.discard();
  }
  tab.activeResult = idx;
  renderResults();
});

function renderError(res) {
  const e = res.error;
  const box = document.createElement('div');
  box.className = 'error-box';
  const rows = [];
  rows.push(`<div class="emsg">${esc(e.message)}</div>`);
  if (e.code) rows.push(`<div class="erow"><b>SQLSTATE</b> ${esc(e.code)}</div>`);
  if (e.detail) rows.push(`<div class="erow"><b>Detail</b> ${esc(e.detail)}</div>`);
  if (e.hint) rows.push(`<div class="erow"><b>Hint</b> ${esc(e.hint)}</div>`);
  if (e.where) rows.push(`<div class="erow"><b>Context</b> ${esc(e.where)}</div>`);
  if (e.statement) {
    const stmt = e.statement;
    if (e.position) {
      const p = Math.max(0, Number(e.position) - 1);
      const before = stmt.slice(0, p);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = stmt.indexOf('\n', p) === -1 ? stmt.length : stmt.indexOf('\n', p);
      const line = stmt.slice(lineStart, lineEnd);
      const caret = ' '.repeat(p - lineStart) + '^';
      rows.push(`<pre>${esc(line)}\n<span class="caret">${esc(caret)}</span></pre>`);
    } else {
      rows.push(`<pre>${esc(stmt.trim().slice(0, 2000))}</pre>`);
    }
  }
  box.innerHTML = rows.join('');
  el.gridHost.append(box);
}

async function commitGrid() {
  const tab = activeTab();
  if (!tab || !tab.grid) return;
  const change = tab.grid.buildChanges();
  if (!change) return;
  const summary = tab.grid.changeSummary();
  const ok = await api.ui.confirm({
    title: 'Commit changes',
    message: `Apply ${summary} to ${change.source.schema}.${change.source.table}?`,
    detail: 'Runs inside a single transaction; any failure rolls the whole batch back.',
    confirmLabel: 'Commit',
    destructive: !!change.deletes.length,
  });
  if (!ok) return;
  try {
    const applied = await api.query.apply(tab.connId, change);
    toast(`Committed: ${applied.updated} updated, ${applied.inserted} inserted, ${applied.deleted} deleted.`, 'ok');
    tab.grid.discard();
    if (tab.grid.activeFilters()) tab.grid.applyFilters();
    else await runScript(false);
  } catch (err) {
    const pg = err.pgError || {};
    toast(`Commit failed (rolled back): ${pg.detail || err.message}`, 'err');
  }
}

async function exportCsv() {
  const tab = activeTab();
  if (!tab || !tab.grid) return;
  const name = `${tab.title.replace(/[^\w.-]+/g, '_')}.csv`;
  const path = await api.files.saveCsv(name, tab.grid.toCsv());
  if (path) toast(`Saved ${path}`, 'ok');
}

/* ----------------------------- toolbar ----------------------------- */

function updateToolbar() {
  const tab = activeTab();
  const running = !!(tab && tab.running);
  el.btnRun.disabled = running;
  el.btnRunAll.disabled = running;
  el.btnCancel.classList.toggle('hidden', !running);
  const n = editor ? editor.statementCount() : 0;
  el.editorHint.textContent = tab && tab.connId && state.conns.has(tab.connId)
    ? `${n} statement${n === 1 ? '' : 's'}`
    : 'not connected';
}

function setStatus(text) { el.statusLeft.textContent = text; }

function renderStatus() {
  const tab = activeTab();
  const conn = tab && tab.connId ? state.conns.get(tab.connId) : null;
  el.statusRight.textContent = conn
    ? `${conn.name} · ${conn.database}${conn.readOnly ? ' · read-only' : ''}`
    : 'no connection';
}

el.btnRun.addEventListener('click', () => runScript(false));
el.btnRunAll.addEventListener('click', () => runScript(true));
el.btnCancel.addEventListener('click', cancelQuery);
el.btnNewConn.addEventListener('click', () => openConnectionDialog(null));

/* ------------------------------ modals ------------------------------ */

function showOverlay(node, { onClose } = {}) {
  el.overlay.innerHTML = '';
  el.overlay.append(node);
  el.overlay.classList.remove('hidden');
  const close = () => {
    el.overlay.classList.add('hidden');
    el.overlay.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    editor.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  el.overlay.onmousedown = (e) => { if (e.target === el.overlay) close(); };
  return close;
}

function openConnectionDialog(record) {
  const r = record || { name: '', host: 'localhost', port: 5432, database: 'postgres', user: '', ssl: 'disable', readOnly: false };
  const node = document.createElement('div');
  node.className = 'modal';
  node.innerHTML = `
    <h2>${record ? 'Edit connection' : 'New connection'}</h2>
    <div class="body">
      <div class="field"><label>Name</label><input id="f-name" value="${esc(r.name)}" placeholder="Local dev" /></div>
      <div class="row2">
        <div class="field"><label>Host</label><input id="f-host" value="${esc(r.host)}" /></div>
        <div class="field"><label>Port</label><input id="f-port" value="${esc(r.port)}" /></div>
      </div>
      <div class="row3">
        <div class="field"><label>Database</label><input id="f-db" value="${esc(r.database)}" /></div>
        <div class="field"><label>User</label><input id="f-user" value="${esc(r.user)}" /></div>
      </div>
      <div class="row3">
        <div class="field"><label>Password${r.hasPassword ? ' (stored — leave blank to keep)' : ''}</label><input id="f-pass" type="password" value="" /></div>
        <div class="field"><label>SSL</label>
          <select id="f-ssl">
            <option value="disable"${r.ssl === 'disable' ? ' selected' : ''}>disable</option>
            <option value="require"${r.ssl === 'require' ? ' selected' : ''}>require (no cert check)</option>
            <option value="verify"${r.ssl === 'verify' ? ' selected' : ''}>verify-full</option>
          </select>
        </div>
      </div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px">
        <input id="f-ro" type="checkbox" ${r.readOnly ? 'checked' : ''} style="width:auto" />
        <label for="f-ro" style="cursor:pointer">Treat as read-only (disable grid editing)</label>
      </div>
      <div class="form-msg" id="f-msg"></div>
    </div>
    <div class="foot">
      <button class="btn" id="f-test">Test</button>
      ${record ? '<button class="btn ghost" id="f-del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">${record ? 'Save' : 'Save & connect'}</button>
    </div>`;

  const close = showOverlay(node);
  const g = (id) => node.querySelector('#' + id);
  const msg = g('f-msg');
  const collect = () => ({
    id: record ? record.id : undefined,
    savedId: record ? record.id : undefined,
    name: g('f-name').value.trim() || 'Untitled',
    host: g('f-host').value.trim() || 'localhost',
    port: Number(g('f-port').value) || 5432,
    database: g('f-db').value.trim() || 'postgres',
    user: g('f-user').value.trim(),
    password: g('f-pass').value,
    ssl: g('f-ssl').value,
    readOnly: g('f-ro').checked,
  });

  g('f-test').addEventListener('click', async () => {
    msg.className = 'form-msg';
    msg.textContent = 'Testing…';
    try {
      const info = await api.connections.test(collect());
      msg.className = 'form-msg ok';
      msg.textContent = `OK — PostgreSQL ${info.serverVersion}, database "${info.database}".`;
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  g('f-save').addEventListener('click', async () => {
    const data = collect();
    // Blank password on an existing record means "keep the stored one".
    if (record && data.password === '') delete data.password;
    try {
      const savedRec = await api.connections.save(data);
      await refreshSaved();
      close();
      if (!record) await connect(savedRec.id);
      else {
        const live = [...state.conns.values()].find((c) => c.savedId === savedRec.id);
        if (live) live.name = savedRec.name;
        renderConnBar();
      }
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  if (record) {
    g('f-del').addEventListener('click', async () => {
      const ok = await api.ui.confirm({
        title: 'Delete connection',
        message: `Delete "${record.name}"?`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      const live = [...state.conns.values()].find((c) => c.savedId === record.id);
      if (live) await disconnect(live.id);
      await api.connections.remove(record.id);
      await refreshSaved();
      close();
    });
  }

  g('f-cancel').addEventListener('click', close);
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter') g('f-save').click(); });
  setTimeout(() => g('f-name').focus(), 0);
}

function promptPassword(name) {
  return new Promise((resolve) => {
    const node = document.createElement('div');
    node.className = 'modal';
    node.style.width = '400px';
    node.innerHTML = `
      <h2>Password for ${esc(name)}</h2>
      <div class="body"><div class="field"><label>Password</label><input id="p-pass" type="password" /></div></div>
      <div class="foot"><span class="spacer"></span>
        <button class="btn ghost" id="p-cancel">Cancel</button>
        <button class="btn primary" id="p-ok">Connect</button></div>`;
    let done = false;
    const close = showOverlay(node, { onClose: () => { if (!done) resolve(null); } });
    const input = node.querySelector('#p-pass');
    const ok = () => { done = true; const v = input.value; close(); resolve(v); };
    node.querySelector('#p-ok').addEventListener('click', ok);
    node.querySelector('#p-cancel').addEventListener('click', () => { done = true; close(); resolve(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => input.focus(), 0);
  });
}

/* ----------------------------- palette ----------------------------- */

function openPalette(items, { placeholder = 'Search…', onPick }) {
  const node = document.createElement('div');
  node.className = 'palette';
  node.innerHTML = `<input type="text" placeholder="${esc(placeholder)}" spellcheck="false" /><div class="list"></div>`;
  const close = showOverlay(node);
  const input = node.querySelector('input');
  const list = node.querySelector('.list');
  let filtered = items;
  let sel = 0;

  const draw = () => {
    if (!filtered.length) { list.innerHTML = '<div class="empty">No matches</div>'; return; }
    list.innerHTML = filtered.slice(0, 300).map((it, i) => `
      <div class="pitem${i === sel ? ' sel' : ''}" data-i="${i}">
        ${it.kind ? `<span class="p-kind kind ${esc(it.kindClass || '')}">${esc(it.kind)}</span>` : ''}
        <span class="p-main">${esc(it.label)}</span>
        ${it.sub ? `<span class="p-sub">${esc(it.sub)}</span>` : ''}
      </div>`).join('');
    const selEl = list.querySelector('.pitem.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  };

  const apply = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? items.filter((it) => (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q))
      : items;
    sel = 0;
    draw();
  };

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(filtered.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const item = filtered[sel];
      if (item) { close(); onPick(item); }
      e.preventDefault();
    }
  });
  list.addEventListener('click', (e) => {
    const it = e.target.closest('[data-i]');
    if (!it) return;
    const item = filtered[Number(it.dataset.i)];
    close();
    onPick(item);
  });
  draw();
  setTimeout(() => input.focus(), 0);
}

function openTablePalette() {
  const conn = state.conns.get(state.activeConnId);
  if (!conn || !conn.tree) { toast('Connect first.'); return; }
  const items = [];
  for (const s of conn.tree.schemas) {
    for (const r of s.relations) {
      items.push({
        label: s.name === 'public' ? r.name : `${s.name}.${r.name}`,
        sub: `${r.columns.length} cols`,
        kind: kindLabel(r.kind),
        kindClass: r.kind,
        schema: s.name,
        name: r.name,
      });
    }
  }
  openPalette(items, {
    placeholder: 'Open table…',
    onPick: (it) => openTableTab(it.schema, it.name),
  });
}

function openCommandPalette() {
  const cmds = [
    { label: 'New query tab', run: () => newTab() },
    { label: 'New connection…', run: () => openConnectionDialog(null) },
    { label: 'Refresh schema', run: () => state.activeConnId && loadSchema(state.activeConnId) },
    { label: 'Run current statement', run: () => runScript(false) },
    { label: 'Run whole script', run: () => runScript(true) },
    { label: 'Export result as CSV…', run: exportCsv },
    { label: 'Commit grid changes', run: commitGrid },
    { label: 'Open SQL file…', run: openFile },
    { label: 'Save SQL as…', run: saveFile },
    { label: 'Copy result as TSV', run: () => {
        const t = activeTab();
        if (t && t.grid) { api.ui.copy(t.grid.copyAllAsTsv()); toast('Result copied.'); }
      } },
    ...[...state.conns.values()].map((c) => ({
      label: `Disconnect ${c.name}`, sub: c.database, run: () => disconnect(c.id),
    })),
    ...state.saved
      .filter((s) => ![...state.conns.values()].some((c) => c.savedId === s.id))
      .map((s) => ({ label: `Connect to ${s.name}`, sub: `${s.host}:${s.port}`, run: () => connect(s.id) })),
  ];
  openPalette(cmds, { placeholder: 'Command…', onPick: (it) => it.run() });
}

/* ------------------------------- files ------------------------------- */

async function openFile() {
  const f = await api.files.open();
  if (!f) return;
  const name = f.path.split(/[\\/]/).pop();
  const tab = newTab({ title: name, sql: f.text });
  tab.filePath = f.path;
  renderTabs();
}

async function saveFile() {
  const tab = activeTab();
  if (!tab) return;
  const path = await api.files.save(`${tab.title.replace(/[^\w.-]+/g, '_')}.sql`, editor.getValue());
  if (path) {
    tab.filePath = path;
    tab.title = path.split(/[\\/]/).pop();
    renderTabs();
    toast(`Saved ${path}`, 'ok');
  }
}

/* ---------------------------- persistence ---------------------------- */

let saveTimer = null;
function saveWorkspace() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const current = activeTab();
    const ws = {
      tabs: state.tabs.map((t) => ({
        title: t.title,
        sql: t === current ? editor.getValue() : t.editorState.doc.toString(),
        savedId: t.connId && state.conns.get(t.connId) ? state.conns.get(t.connId).savedId : null,
      })),
      activeIndex: state.tabs.findIndex((t) => t.id === state.activeTabId),
      sidebarWidth: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
      editorHeight: getComputedStyle(document.documentElement).getPropertyValue('--editor-h').trim(),
    };
    api.workspace.set(ws).catch(() => {});
  }, 600);
}

async function restoreWorkspace() {
  let ws = null;
  try { ws = await api.workspace.get(); } catch { /* first run */ }
  if (ws && ws.sidebarWidth) document.documentElement.style.setProperty('--sidebar-w', ws.sidebarWidth);
  if (ws && ws.editorHeight) document.documentElement.style.setProperty('--editor-h', ws.editorHeight);

  if (ws && ws.tabs && ws.tabs.length) {
    for (const t of ws.tabs) newTab({ title: t.title, sql: t.sql, connId: null });
    const idx = Math.max(0, Math.min(state.tabs.length - 1, ws.activeIndex ?? 0));
    selectTab(state.tabs[idx].id);
  } else {
    newTab({ title: 'Query 1', sql: '-- Connect on the left, then Ctrl+Enter to run.\nselect version();\n' });
  }
}

/* ----------------------------- resizers ----------------------------- */

function makeResizer(node, axis, varName, min, max) {
  node.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const rect = axis === 'x'
      ? el.sidebar.getBoundingClientRect()
      : $('editor-pane').getBoundingClientRect();
    const startSize = axis === 'x' ? rect.width : rect.height;
    const areaH = el.workarea.getBoundingClientRect().height;
    const move = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
      let next = startSize + delta;
      next = Math.max(min, Math.min(max(), next));
      document.documentElement.style.setProperty(
        varName, axis === 'x' ? `${Math.round(next)}px` : `${((next / areaH) * 100).toFixed(1)}%`
      );
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      saveWorkspace();
      const t = activeTab();
      if (t && t.grid) t.grid.render();
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

makeResizer(el.sidebarResizer, 'x', '--sidebar-w', 180, () => window.innerWidth * 0.5);
makeResizer(el.paneResizer, 'y', '--editor-h', 80, () => el.workarea.getBoundingClientRect().height - 120);

window.addEventListener('resize', () => {
  const t = activeTab();
  if (t && t.grid) t.grid.render();
});

/* ------------------------------- menu ------------------------------- */

api.ui.onMenu((cmd) => {
  const tab = activeTab();
  switch (cmd) {
    case 'connection:new': openConnectionDialog(null); break;
    case 'tab:new': newTab(); break;
    case 'tab:close': if (tab) closeTab(tab.id); break;
    case 'tab:next': cycleTab(1); break;
    case 'tab:prev': cycleTab(-1); break;
    case 'query:run': runScript(false); break;
    case 'query:runAll': runScript(true); break;
    case 'query:cancel': cancelQuery(); break;
    case 'grid:commit': commitGrid(); break;
    case 'grid:discard': if (tab && tab.grid) { tab.grid.discard(); renderGridToolbar(); } break;
    case 'grid:addRow': if (tab && tab.grid) tab.grid.addRow(); break;
    case 'grid:deleteRow': if (tab && tab.grid) tab.grid.toggleDelete(); break;
    case 'grid:filter':
      if (tab && tab.grid) { tab.grid.toggleFilter(); renderGridToolbar(); }
      break;
    case 'grid:clearFilters':
      if (tab && tab.grid) { tab.grid.clearFilters(); renderGridToolbar(); }
      break;
    case 'result:csv': exportCsv(); break;
    case 'palette:tables': openTablePalette(); break;
    case 'palette:commands': openCommandPalette(); break;
    case 'focus:editor': editor.focus(); break;
    case 'schema:refresh': if (state.activeConnId) loadSchema(state.activeConnId); break;
    case 'file:open': openFile(); break;
    case 'file:save': saveFile(); break;
  }
});

/* ------------------------------- boot ------------------------------- */

async function boot() {
  editor = new SqlEditor(el.editorHost, {
    onChange: () => { updateToolbar(); saveWorkspace(); },
    onRun: () => runScript(false),
    onRunAll: () => runScript(true),
    onCursor: (c) => {
      const tab = activeTab();
      const conn = tab && tab.connId ? state.conns.get(tab.connId) : null;
      el.statusRight.textContent =
        `Ln ${c.line}, Col ${c.col}${c.selected ? ` · ${c.selected} selected` : ''}` +
        (conn ? `   ·   ${conn.name} · ${conn.database}` : '');
    },
  });

  await refreshSaved();
  await restoreWorkspace();

  // Auto-attach a single saved connection so the first run just works.
  if (state.saved.length === 1) await connect(state.saved[0].id);
  for (const t of state.tabs) if (!t.connId) t.connId = state.activeConnId;

  updateToolbar();
  renderStatus();
  renderTree();
  editor.focus();
  // Readiness signal: connections restored, schema loaded, first paint done.
  document.body.dataset.ready = '1';
}

/** Debug snapshot for the smoke harness (and for poking around in devtools). */
window.__cobalt = () => ({
  activeTabId: state.activeTabId,
  activeConnId: state.activeConnId,
  connections: [...state.conns.keys()],
  tabs: state.tabs.map((t) => ({
    id: t.id, title: t.title, connId: t.connId, running: t.running,
    results: t.results.length, activeResult: t.activeResult,
    firstResult: t.results[t.activeResult]
      ? (t.results[t.activeResult].error
          ? { error: t.results[t.activeResult].error.message }
          : { rows: (t.results[t.activeResult].rows || []).length, editable: t.results[t.activeResult].editable })
      : null,
  })),
});

boot();
