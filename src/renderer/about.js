/**
 * About and version history.
 *
 * Both read the same changelog data the repo's CHANGELOG.md is generated from,
 * so what the app claims and what the file says cannot disagree.
 */

import { grouped, compareVersions } from '../shared/changelog.js';

let ctx = null;
export function wire(context) { ctx = context; }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TYPE_CLASS = { added: 'added', changed: 'changed', fixed: 'fixed', removed: 'removed' };

function releaseHtml(r, { open }) {
  return `<details class="rel"${open ? ' open' : ''}>
    <summary>
      <span class="rel-ver">${esc(r.version)}</span>
      <span class="rel-title">${esc(r.title)}</span>
      <span class="rel-date">${esc(r.date)}</span>
    </summary>
    ${r.summary ? `<p class="rel-summary">${esc(r.summary)}</p>` : ''}
    ${grouped(r).map((g) => `
      <div class="rel-group">
        <span class="rel-type ${TYPE_CLASS[g.type] || ''}">${esc(g.label)}</span>
        <ul>${g.items.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul>
      </div>`).join('')}
  </details>`;
}

/** Full history. `highlight` opens just those versions (used by What's New). */
export function openChangelog({ releases, highlight = null, title = 'Version history' } = {}) {
  const list = releases || ctx.info().releases;
  const node = document.createElement('div');
  node.className = 'modal changelog-modal';
  node.innerHTML = `
    <h2>${esc(title)}</h2>
    <div class="body changelog-body">
      ${list.map((r, i) => releaseHtml(r, {
        open: highlight ? highlight.includes(r.version) : i === 0,
      })).join('')}
    </div>
    <div class="foot">
      <span class="hint">Cobalt ${esc(ctx.info().version)}</span>
      <span class="spacer"></span>
      <button class="btn primary" id="cl-close">Close</button>
    </div>`;
  const close = ctx.showOverlay(node);
  node.querySelector('#cl-close').addEventListener('click', close);
  setTimeout(() => node.querySelector('#cl-close').focus(), 0);
}

/**
 * Shown on first launch of a version the user has not seen before.
 * `from` is the version they were last on — not the oldest release listed, which
 * is a different thing and would read as if they had already seen it.
 */
export function openWhatsNew(releases, from) {
  if (!releases || !releases.length) return;
  const title = releases.length === 1
    ? `What's new in ${releases[0].version}`
    : (from ? `What's new since ${from}` : "What's new");
  openChangelog({ releases, highlight: releases.map((r) => r.version), title });
}

export function openAbout() {
  const info = ctx.info();
  const conn = ctx.activeConnection();
  const rows = [
    ['Version', info.version],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node', info.node],
    ['pg driver', info.pg || 'unknown'],
    ['Platform', info.platform],
  ];
  if (conn) rows.push(['Connected to', `${conn.name} · ${conn.database} · PostgreSQL ${conn.serverVersion}`]);

  const node = document.createElement('div');
  node.className = 'modal about-modal';
  node.innerHTML = `
    <div class="about-head">
      <span class="about-mark"></span>
      <div>
        <div class="about-name">Cobalt</div>
        <div class="about-ver">Version ${esc(info.version)} — ${esc(info.releases[0].title)}</div>
      </div>
    </div>
    <div class="body">
      <table class="about-table">
        ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}
      </table>
    </div>
    <div class="foot">
      <button class="btn ghost" id="ab-history">Version history</button>
      <button class="btn ghost" id="ab-copy">Copy details</button>
      <span class="spacer"></span>
      <button class="btn primary" id="ab-close">Close</button>
    </div>`;
  const close = ctx.showOverlay(node);
  node.querySelector('#ab-close').addEventListener('click', close);
  node.querySelector('#ab-history').addEventListener('click', () => { close(); openChangelog(); });
  node.querySelector('#ab-copy').addEventListener('click', () => {
    ctx.copy(rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
    ctx.toast('Version details copied.');
  });
  setTimeout(() => node.querySelector('#ab-close').focus(), 0);
}

export { compareVersions };
