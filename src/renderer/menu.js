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

export function showMenu(items, anchor) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    if (it.header) return `<div class="ctx-header">${esc(it.header)}</div>`;
    return `<div class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" ${it.disabled ? '' : `data-i="${i}"`}>
      <span class="ctx-label">${esc(it.label)}</span>
      ${it.sub ? `<span class="ctx-sub">${esc(it.sub)}</span>` : ''}
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

  return close;
}
