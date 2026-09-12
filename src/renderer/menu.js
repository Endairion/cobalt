/**
 * A small floating menu, shared by the connection rows and the result grid.
 *
 * `items` is a list of `{ label, sub?, danger?, disabled?, run }` plus
 * `{ sep: true }` separators and `{ header: 'text' }` captions.
 * `anchor` is an element or a `{ left, top, right, bottom }` rectangle, so it
 * can hang off a button or off the pointer for a right-click.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function showMenu(items, anchor, opts = {}) {
  // Only a top-level menu clears the field; a submenu sits alongside its parent.
  if (!opts.parent) document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    if (it.header) return `<div class="ctx-header">${esc(it.header)}</div>`;
    const kids = it.items && it.items.length;
    return `<div class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${kids ? ' has-sub' : ''}" ${it.disabled ? '' : `data-i="${i}"`}>
      <span class="ctx-label">${esc(it.label)}</span>
      ${it.sub ? `<span class="ctx-sub">${esc(it.sub)}</span>` : ''}
      ${kids ? '<span class="ctx-arrow">›</span>' : ''}
    </div>`;
  }).join('');
  document.body.append(menu);

  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
  // Flip above the anchor when there is no room below it.
  const below = (r.bottom ?? r.top) + 4;
  const top = below + menu.offsetHeight > window.innerHeight - 8
    ? Math.max(6, (r.top ?? r.bottom) - menu.offsetHeight - 4)
    : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = () => {
    closeChild();
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const closeAll = () => { if (opts.parent) document.querySelectorAll('.ctx-menu').forEach((n) => n.remove()); else close(); };
  const onDown = (e) => {
    // A press anywhere in the open chain belongs to that menu, not to dismissal.
    // Checking only this element closed the parent — and with it the submenu —
    // the instant you pressed a submenu item, so the click never arrived.
    if (e.target && e.target.closest && e.target.closest('.ctx-menu')) return;
    close();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  // Nested items open a second menu beside the row, the way a menu bar does.
  let child = null;
  const closeChild = () => { if (child) { child(); child = null; } };

  menu.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const item = items[Number(row.dataset.i)];
    if (!item || !item.items || !item.items.length) {
      if (menu.dataset.openSub && menu.dataset.openSub !== row.dataset.i) {
        closeChild();
        delete menu.dataset.openSub;
        menu.querySelectorAll('.ctx-item.open').forEach((n) => n.classList.remove('open'));
      }
      return;
    }
    if (menu.dataset.openSub === row.dataset.i) return;
    closeChild();
    menu.querySelectorAll('.ctx-item.open').forEach((n) => n.classList.remove('open'));
    row.classList.add('open');
    menu.dataset.openSub = row.dataset.i;
    const r2 = row.getBoundingClientRect();
    child = showMenu(item.items, { left: r2.right - 4, top: r2.top - 5, bottom: r2.top - 5 }, { parent: menu });
  });

  menu.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const item = items[Number(row.dataset.i)];
    if (item.items && item.items.length) return;   // a group header, not an action
    closeAll();
    item.run();
  });

  return close;
}
