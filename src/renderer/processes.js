/**
 * What the server is doing right now.
 *
 * Both engines can say which connections exist, what each is running and for
 * how long, and both can be told to stop one. The driver normalizes the columns,
 * so this panel is the same on either.
 *
 * Two deliberate choices. It does not poll on its own — a list that refreshes
 * under you while you are reading a query is worse than one you refresh — but
 * there is a toggle when you do want to watch. And your own connection is
 * marked, because killing it is a confusing way to find out which row was you.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ctx = {
  showOverlay: () => () => {},
  list: async () => [],
  kill: async () => false,
  confirm: async () => false,
  copy: () => {},
  toast: () => {},
  connName: () => '',
};

export function wire(c) { ctx = { ...ctx, ...c }; }

const REFRESH_MS = 2000;

const duration = (seconds) => {
  if (seconds == null) return '';
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export async function openProcessList(connId) {
  const node = document.createElement('div');
  node.className = 'modal process-modal';
  const close = ctx.showOverlay(node, { onClose: () => stopTimer() });

  let rows = [];
  let onlyActive = true;
  let timer = null;
  let error = null;

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const load = async () => {
    try {
      rows = await ctx.list(connId);
      error = null;
    } catch (err) {
      error = err.message;
      stopTimer();
    }
    draw();
  };

  const draw = () => {
    const shown = onlyActive ? rows.filter((r) => r.state !== 'idle' || r.is_self) : rows;
    const running = rows.filter((r) => r.state !== 'idle').length;

    node.innerHTML = `
      <h2>Server activity<span class="hint"> · ${esc(ctx.connName(connId))}</span></h2>
      <div class="body">
        <div class="proc-bar">
          <span class="pill">${rows.length} connection${rows.length === 1 ? '' : 's'}</span>
          <span class="pill${running ? ' on' : ''}">${running} running</span>
          <label class="op-check"><input type="checkbox" id="pl-active" ${onlyActive ? 'checked' : ''} />
            <span>Only what is doing something</span></label>
          <span class="spacer"></span>
          <label class="op-check"><input type="checkbox" id="pl-auto" ${timer ? 'checked' : ''} />
            <span>Keep refreshing</span></label>
          <button class="btn small" data-pl="refresh">Refresh</button>
        </div>
        ${error ? `<div class="im-error">${esc(error)}</div>` : ''}
        <div class="proc-table">
          <table>
            <tr>
              <th>id</th><th>user</th><th>database</th><th>state</th>
              <th>time</th><th>query</th><th></th>
            </tr>
            ${shown.length ? shown.map(rowHtml).join('')
    : '<tr><td colspan="7" class="hint" style="padding:10px">Nothing to show.</td></tr>'}
          </table>
        </div>
      </div>
      <div class="foot">
        <span class="hint">Cancel stops the statement; Kill closes the whole connection.</span>
        <span class="spacer"></span>
        <button class="btn ghost" data-pl="close">Close</button>
      </div>`;
  };

  const rowHtml = (r) => `
    <tr class="${r.is_self ? 'me' : ''}${r.state === 'idle' ? ' idle' : ''}">
      <td class="n">${esc(r.id)}${r.is_self ? '<span class="proc-me">you</span>' : ''}</td>
      <td>${esc(r.user)}</td>
      <td>${esc(r.database)}</td>
      <td>${esc(r.state)}${r.waiting ? `<span class="proc-wait" title="${esc(r.waiting)}">waiting</span>` : ''}</td>
      <td class="n">${esc(duration(r.seconds))}</td>
      <td class="proc-q" title="${esc(r.query)}">${esc((r.query || '').replace(/\s+/g, ' ').slice(0, 160))}</td>
      <td class="proc-act">
        ${r.is_self ? '' : `
          <button class="btn small ghost" data-cancel="${esc(r.id)}" ${r.state === 'idle' ? 'disabled' : ''}>Cancel</button>
          <button class="btn small ghost danger-text" data-kill="${esc(r.id)}">Kill</button>`}
      </td>
    </tr>`;

  node.addEventListener('change', (e) => {
    if (e.target.id === 'pl-active') { onlyActive = e.target.checked; draw(); return; }
    if (e.target.id === 'pl-auto') {
      if (e.target.checked) { timer = setInterval(load, REFRESH_MS); }
      else stopTimer();
      draw();
    }
  });

  node.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pl], [data-cancel], [data-kill]');
    if (!btn) return;
    if (btn.dataset.pl === 'close') { close(); return; }
    if (btn.dataset.pl === 'refresh') { await load(); return; }

    const terminate = btn.dataset.kill !== undefined;
    const pid = Number(terminate ? btn.dataset.kill : btn.dataset.cancel);
    const target = rows.find((r) => Number(r.id) === pid);
    // Killing someone else's connection is not a thing to do by mis-click.
    const ok = await ctx.confirm({
      title: terminate ? 'Kill connection' : 'Cancel query',
      message: terminate
        ? `Close connection ${pid} and roll back whatever it was doing?`
        : `Stop the statement running on connection ${pid}?`,
      detail: target && target.query ? target.query.slice(0, 400) : undefined,
      confirmLabel: terminate ? 'Kill it' : 'Cancel it',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ctx.kill(connId, pid, { terminate });
      ctx.toast(terminate ? `Connection ${pid} closed.` : `Asked ${pid} to stop.`);
      await load();
    } catch (err) { ctx.toast(err.message, 'err'); }
  });

  await load();
}
