/**
 * Connection manager: the saved-connection list, its context menu, and the
 * picker that binds a query tab to a connection.
 *
 * This module owns no state of its own — the host app passes in everything it
 * needs through `wire()`, which keeps app.js the single source of truth.
 */

let ctx = null;

export function wire(context) { ctx = context; }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const COLORS = [
  { name: 'none', value: null },
  { name: 'blue', value: '#4c8dff' },
  { name: 'green', value: '#45c07d' },
  { name: 'amber', value: '#e0a33c' },
  { name: 'red', value: '#f2695c' },
  { name: 'purple', value: '#b07cf0' },
  { name: 'cyan', value: '#46bfd0' },
];

const describe = (c) => `${c.user ? c.user + '@' : ''}${c.host}:${c.port}/${c.database}`;

/* ------------------------- floating row menu ------------------------- */

export function openConnectionMenu(savedId, anchor) {
  const saved = ctx.saved().find((s) => s.id === savedId);
  if (!saved) return;
  const live = ctx.liveFor(savedId);

  const items = [];
  if (live) {
    items.push({ label: 'Use for current tab', run: () => ctx.useForCurrentTab(live.id) });
    items.push({ label: 'Open a tab on this connection', run: () => ctx.newTabOn(live.id) });
    items.push({ label: 'Refresh schema', run: () => ctx.loadSchema(live.id) });
    items.push({ label: 'Disconnect', run: () => ctx.disconnect(live.id) });
  } else {
    items.push({ label: 'Connect', run: () => ctx.connect(savedId) });
  }
  items.push({ sep: true });
  items.push({ label: 'Edit…', run: () => ctx.openConnectionDialog(saved) });
  items.push({ label: 'Duplicate', run: () => ctx.duplicate(savedId) });
  items.push({ label: 'Manage all…', run: () => openConnectionManager(savedId) });
  items.push({ sep: true });
  items.push({ label: 'Delete…', danger: true, run: () => ctx.deleteConnection(saved) });

  showMenu(items, anchor);
}

function showMenu(items, anchor) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
  document.body.append(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  menu.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const item = items[Number(row.dataset.i)];
    close();
    item.run();
  });
}

/* --------------------------- the manager --------------------------- */

export function openConnectionManager(selectId) {
  const node = document.createElement('div');
  node.className = 'modal manager';
  node.innerHTML = `
    <h2>Connections</h2>
    <div class="mgr">
      <div class="mgr-list">
        <input class="mgr-search" id="m-search" type="text" placeholder="Search connections…" spellcheck="false" />
        <div class="mgr-rows" id="m-rows"></div>
        <div class="mgr-list-foot">
          <button class="btn small" id="m-new">New</button>
          <button class="btn small ghost" id="m-dup" disabled>Duplicate</button>
          <span class="spacer"></span>
          <button class="btn small ghost" id="m-up" title="Move up" disabled>&#9650;</button>
          <button class="btn small ghost" id="m-down" title="Move down" disabled>&#9660;</button>
        </div>
      </div>
      <div class="mgr-form" id="m-form"></div>
    </div>
    <div class="foot">
      <span class="form-msg" id="m-msg"></span>
      <span class="spacer"></span>
      <button class="btn ghost" id="m-close">Close</button>
    </div>`;

  const close = ctx.showOverlay(node);
  const $ = (id) => node.querySelector('#' + id);
  let selected = selectId || null;
  let search = '';

  const rows = () => {
    const all = ctx.saved();
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter((c) =>
      (c.name + ' ' + describe(c) + ' ' + (c.group || '')).toLowerCase().includes(q));
  };

  function drawList() {
    const list = rows();
    if (!selected && list.length) selected = list[0].id;
    $('m-rows').innerHTML = list.length ? list.map((c) => {
      const live = ctx.liveFor(c.id);
      return `<div class="mgr-row${c.id === selected ? ' sel' : ''}" data-id="${esc(c.id)}">
        <span class="conn-color" style="background:${c.color ? esc(c.color) : 'transparent'}"></span>
        <span class="dot${live ? ' live' : ''}"></span>
        <span class="mgr-name">${esc(c.name)}</span>
        ${c.readOnly ? '<span class="ro-flag">RO</span>' : ''}
        <span class="mgr-sub">${esc(describe(c))}</span>
      </div>`;
    }).join('') : '<div class="mgr-empty">No matches</div>';

    const has = !!selected && list.some((c) => c.id === selected);
    $('m-dup').disabled = !has;
    $('m-up').disabled = !has || !!search;
    $('m-down').disabled = !has || !!search;
    drawForm();
  }

  function drawForm() {
    const c = ctx.saved().find((x) => x.id === selected);
    if (!c) { $('m-form').innerHTML = '<div class="mgr-empty">Select a connection, or add one.</div>'; return; }
    const live = ctx.liveFor(c.id);
    $('m-form').innerHTML = `
      <div class="field"><label>Name</label><input id="c-name" value="${esc(c.name)}" /></div>
      <div class="row2">
        <div class="field"><label>Host</label><input id="c-host" value="${esc(c.host)}" /></div>
        <div class="field"><label>Port</label><input id="c-port" value="${esc(c.port)}" /></div>
      </div>
      <div class="row3">
        <div class="field"><label>Database</label><input id="c-db" value="${esc(c.database)}" /></div>
        <div class="field"><label>User</label><input id="c-user" value="${esc(c.user || '')}" /></div>
      </div>
      <div class="row3">
        <div class="field"><label>Password${c.hasPassword ? ' (stored)' : ''}</label>
          <input id="c-pass" type="password" placeholder="${c.hasPassword ? 'unchanged' : ''}" /></div>
        <div class="field"><label>SSL</label>
          <select id="c-ssl">
            ${['disable', 'require', 'verify'].map((v) =>
              `<option value="${v}"${c.ssl === v ? ' selected' : ''}>${v}</option>`).join('')}
          </select></div>
      </div>
      <div class="row3">
        <div class="field"><label>Group</label>
          <input id="c-group" value="${esc(c.group || '')}" placeholder="e.g. Production" list="c-groups" />
          <datalist id="c-groups">${[...new Set(ctx.saved().map((x) => x.group).filter(Boolean))]
            .map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist></div>
        <div class="field"><label>Colour</label>
          <div class="swatches" id="c-colors">
            ${COLORS.map((col) => `<button class="swatch${(c.color || null) === col.value ? ' on' : ''}"
              data-color="${col.value || ''}" title="${col.name}"
              style="background:${col.value || 'transparent'}">${col.value ? '' : '/'}</button>`).join('')}
          </div></div>
      </div>
      <label class="checkline"><input id="c-ro" type="checkbox" ${c.readOnly ? 'checked' : ''} />
        Read-only — block all grid edits on this connection</label>
      <div class="mgr-actions">
        <button class="btn small" id="c-test">Test</button>
        <button class="btn small primary" id="c-save">Save</button>
        <span class="spacer"></span>
        ${live
          ? `<button class="btn small" id="c-use">Use for current tab</button>
             <button class="btn small ghost" id="c-disconnect">Disconnect</button>`
          : '<button class="btn small" id="c-connect">Connect</button>'}
        <button class="btn small ghost danger-text" id="c-delete">Delete</button>
      </div>`;

    let pendingColor = c.color || null;
    node.querySelector('#c-colors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      pendingColor = b.dataset.color || null;
      node.querySelectorAll('#c-colors .swatch').forEach((s) => s.classList.toggle('on', s === b));
    });

    const collect = () => ({
      id: c.id,
      savedId: c.id,
      name: $('c-name').value.trim() || 'Untitled',
      host: $('c-host').value.trim() || 'localhost',
      port: Number($('c-port').value) || 5432,
      database: $('c-db').value.trim() || 'postgres',
      user: $('c-user').value.trim(),
      ssl: $('c-ssl').value,
      group: $('c-group').value.trim(),
      color: pendingColor,
      readOnly: $('c-ro').checked,
      order: c.order,
    });

    const msg = (text, kind = '') => {
      const m = $('m-msg');
      m.className = `form-msg ${kind}`;
      m.textContent = text;
    };

    $('c-test').addEventListener('click', async () => {
      msg('Testing…');
      const data = collect();
      if ($('c-pass').value) data.password = $('c-pass').value;
      try {
        const info = await ctx.test(data);
        msg(`OK — PostgreSQL ${info.serverVersion}, database "${info.database}".`, 'ok');
      } catch (err) { msg(err.message, 'err'); }
    });

    $('c-save').addEventListener('click', async () => {
      const data = collect();
      if ($('c-pass').value) data.password = $('c-pass').value;
      try {
        await ctx.save(data);
        await ctx.refreshSaved();
        msg('Saved.', 'ok');
        drawList();
      } catch (err) { msg(err.message, 'err'); }
    });

    const connectBtn = $('c-connect');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        msg('Connecting…');
        const id = await ctx.connect(c.id);
        msg(id ? 'Connected.' : 'Could not connect.', id ? 'ok' : 'err');
        drawList();
      });
    }
    const useBtn = $('c-use');
    if (useBtn) useBtn.addEventListener('click', () => { ctx.useForCurrentTab(live.id); close(); });
    const discBtn = $('c-disconnect');
    if (discBtn) {
      discBtn.addEventListener('click', async () => { await ctx.disconnect(live.id); drawList(); });
    }
    $('c-delete').addEventListener('click', async () => {
      const gone = await ctx.deleteConnection(c);
      if (!gone) return;
      selected = null;
      drawList();
    });
  }

  $('m-search').addEventListener('input', (e) => { search = e.target.value; drawList(); });
  $('m-rows').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    selected = row.dataset.id;
    drawList();
  });
  $('m-rows').addEventListener('dblclick', async (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const live = ctx.liveFor(row.dataset.id);
    if (live) { ctx.useForCurrentTab(live.id); close(); }
    else { await ctx.connect(row.dataset.id); drawList(); }
  });

  $('m-new').addEventListener('click', () => { close(); ctx.openConnectionDialog(null); });
  $('m-dup').addEventListener('click', async () => {
    const copy = await ctx.duplicate(selected);
    if (copy) { selected = copy.id; drawList(); }
  });

  const move = async (delta) => {
    const all = ctx.saved().map((c) => c.id);
    const i = all.indexOf(selected);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= all.length) return;
    all.splice(j, 0, all.splice(i, 1)[0]);
    await ctx.reorder(all);
    drawList();
  };
  $('m-up').addEventListener('click', () => move(-1));
  $('m-down').addEventListener('click', () => move(1));
  $('m-close').addEventListener('click', close);

  drawList();
  setTimeout(() => $('m-search').focus(), 0);
}

/* --------------------- tab -> connection picker --------------------- */

export function openConnectionPicker(anchor) {
  const items = [];
  for (const s of ctx.saved()) {
    const live = ctx.liveFor(s.id);
    items.push({
      label: live ? s.name : `${s.name}  (connect)`,
      run: async () => {
        const conn = live || { id: await ctx.connect(s.id) };
        if (conn.id) ctx.useForCurrentTab(conn.id);
      },
    });
  }
  if (!items.length) items.push({ label: 'Add a connection…', run: () => ctx.openConnectionDialog(null) });
  else {
    items.push({ sep: true });
    items.push({ label: 'Manage connections…', run: () => openConnectionManager() });
  }
  showMenu(items, anchor);
}
