/**
 * Health and memory: what the server is holding and what Cobalt itself costs.
 *
 * The two halves are side by side on purpose. "It feels slow" almost always
 * resolves to one of them, and the useful first question is which — a renderer
 * sitting on a 200MB result set looks nothing like a server whose cache hit
 * ratio has fallen through the floor.
 *
 * Counters are shown as totals with the uptime beside them rather than as
 * rates. A rate needs two samples and a clock; inventing a per-second number
 * from one reading would be worse than an honest total.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ctx = {
  showOverlay: () => () => {},
  stats: async () => null,
  metrics: async () => null,
  grids: () => ({ tabs: 0, rows: 0, cells: 0 }),
  connName: () => '',
  copy: () => {},
  toast: () => {},
};

export function wire(c) { ctx = { ...ctx, ...c }; }

const REFRESH_MS = 2000;

export function bytes(n) {
  // Unknown is not zero: Number(null) is 0, and reporting "0 B" for a value we
  // could not read would be a lie about the thing being measured.
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function duration(seconds) {
  if (seconds == null || seconds === '') return '—';
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—');
const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(2)}%`);

/** A cache that misses more than a few percent of the time is worth a look. */
export function hitVerdict(ratio) {
  if (ratio == null) return { level: 'none', text: 'no reads recorded yet' };
  if (ratio >= 0.99) return { level: 'good', text: 'almost everything is served from memory' };
  if (ratio >= 0.95) return { level: 'ok', text: 'mostly from memory' };
  return { level: 'warn', text: 'a lot is coming off disk — the cache may be too small for the working set' };
}

export async function openHealth(connId) {
  const node = document.createElement('div');
  node.className = 'modal health-modal';
  const close = ctx.showOverlay(node, { onClose: () => stopTimer() });

  let stats = null;
  let metrics = null;
  let error = null;
  let timer = null;

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const load = async () => {
    const [s, m] = await Promise.all([
      ctx.stats(connId).catch((e) => { error = e.message; return null; }),
      ctx.metrics().catch(() => null),
    ]);
    if (s) { stats = s; error = null; }
    metrics = m;
    draw();
  };

  const draw = () => {
    const g = ctx.grids();
    const hit = stats ? hitVerdict(stats.cacheHitRatio) : { level: 'none', text: '' };

    node.innerHTML = `
      <h2>Health &amp; memory<span class="hint"> · ${esc(ctx.connName(connId))}</span></h2>
      <div class="body">
        <div class="proc-bar">
          <label class="op-check"><input type="checkbox" id="hl-auto" ${timer ? 'checked' : ''} />
            <span>Keep refreshing</span></label>
          <span class="spacer"></span>
          <button class="btn small ghost" data-hl="copy">Copy as text</button>
          <button class="btn small" data-hl="refresh">Refresh</button>
        </div>
        ${error ? `<div class="im-error">${esc(error)}</div>` : ''}

        <div class="hl-cols">
          <section class="hl-col">
            <h3>The server${stats ? ` <span class="hint">${esc(stats.engineLabel || '')}</span>` : ''}</h3>
            ${stats ? serverHtml(stats, hit) : '<div class="hint">Reading…</div>'}
          </section>

          <section class="hl-col">
            <h3>Cobalt</h3>
            ${metrics ? appHtml(metrics, g) : '<div class="hint">Reading…</div>'}
          </section>
        </div>

        ${stats ? tablesHtml(stats) : ''}
      </div>
      <div class="foot">
        <span class="hint">${stats && stats.since
    ? `Server counters are totals since ${esc(String(stats.since).slice(0, 19))}.`
    : 'Server counters are totals since the server last started.'}</span>
        <span class="spacer"></span>
        <button class="btn ghost" data-hl="close">Close</button>
      </div>`;
  };

  const stat = (label, value, note = '', cls = '') =>
    `<div class="hl-stat ${cls}"><span class="hl-k">${esc(label)}</span>
       <span class="hl-v">${esc(value)}</span>
       ${note ? `<span class="hl-note">${esc(note)}</span>` : ''}</div>`;

  const serverHtml = (s, hit) => `
    ${stat('database size', bytes(s.sizeBytes), s.database || '')}
    ${stat('cache hit ratio', pct(s.cacheHitRatio), hit.text, `hl-${hit.level}`)}
    ${stat('connections', `${num(s.connections)} of ${num(s.maxConnections)}`,
    s.connectionsAll > s.connections ? `${num(s.connectionsAll)} across all databases` : '')}
    ${stat('uptime', duration(s.uptimeSeconds))}

    <h4>Memory settings</h4>
    ${s.memory.map((m) => stat(m.name, m.value == null ? '—' : String(m.value), m.note || '')).join('')}

    <h4>Since start</h4>
    <div class="hl-counters">
      ${s.counters.map((c) => `<div class="hl-counter${c.warn ? ' warn' : ''}" ${c.note ? `title="${esc(c.note)}"` : ''}>
        <span class="hl-cv">${num(c.value)}</span><span class="hl-ck">${esc(c.name)}</span>
      </div>`).join('')}
    </div>`;

  const appHtml = (m, g) => {
    const byType = new Map();
    for (const p of m.processes) {
      const key = p.type || 'other';
      const cur = byType.get(key) || { memoryBytes: 0, cpuPercent: 0, count: 0 };
      cur.memoryBytes += p.memoryBytes || 0;
      cur.cpuPercent += p.cpuPercent || 0;
      cur.count++;
      byType.set(key, cur);
    }
    const sysNote = m.system
      ? `${bytes(m.system.totalBytes - m.system.freeBytes)} of ${bytes(m.system.totalBytes)} used on this machine`
      : '';
    return `
      ${stat('memory', bytes(m.totalMemoryBytes), sysNote)}
      ${stat('cpu', `${m.totalCpuPercent}%`, 'across every Cobalt process')}
      ${stat('uptime', duration(m.uptimeSeconds))}

      <h4>Per process</h4>
      ${[...byType.entries()].map(([type, v]) =>
    stat(type + (v.count > 1 ? ` ×${v.count}` : ''), bytes(v.memoryBytes), `${v.cpuPercent.toFixed(1)}% cpu`)).join('')}

      <h4>What is loaded</h4>
      ${stat('open tabs', num(g.tabs))}
      ${stat('rows held in grids', num(g.rows), 'fetched pages still in memory')}
      ${stat('staged edits', num(g.dirty), g.dirty ? 'not written yet' : '')}

      <h4>Built on</h4>
      ${stat('electron', m.versions.electron)}
      ${stat('chromium', m.versions.chrome)}
      ${stat('node', m.versions.node)}`;
  };

  const tablesHtml = (s) => {
    const section = (title, rows, cols, note) => (rows.length ? `
      <section class="hl-table">
        <h4>${esc(title)}${note ? `<span class="hint"> · ${esc(note)}</span>` : ''}</h4>
        <table>
          <tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>
          ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.cls || ''}">${esc(c.get(r))}</td>`).join('')}</tr>`).join('')}
        </table>
      </section>` : '');

    return `
      ${section('Biggest tables', s.biggest, [
    { label: 'table', get: (r) => `${r.schema}.${r.name}` },
    { label: 'total', cls: 'n', get: (r) => bytes(r.bytes) },
    { label: 'data', cls: 'n', get: (r) => bytes(r.tableBytes) },
    { label: 'indexes', cls: 'n', get: (r) => bytes(r.indexBytes) },
  ])}
      ${section('Dead rows waiting on vacuum', s.vacuum, [
    { label: 'table', get: (r) => `${r.schema}.${r.name}` },
    { label: 'dead', cls: 'n', get: (r) => num(r.deadTuples) },
    { label: 'live', cls: 'n', get: (r) => num(r.liveTuples) },
    { label: 'last vacuum', get: (r) => (r.lastVacuum ? String(r.lastVacuum).slice(0, 19) : 'never') },
  ], 'space the table is holding but not using')}
      ${section('Indexes nothing has read', s.unusedIndexes, [
    { label: 'index', get: (r) => r.name },
    { label: 'on', get: (r) => `${r.schema}.${r.table}` },
    { label: 'size', cls: 'n', get: (r) => (r.bytes ? bytes(r.bytes) : '') },
  ], 'cost on every write, and nothing has scanned them since the counters were reset')}`;
  };

  node.addEventListener('change', (e) => {
    if (e.target.id !== 'hl-auto') return;
    if (e.target.checked) timer = setInterval(load, REFRESH_MS);
    else stopTimer();
    draw();
  });

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    if (b.dataset.hl === 'close') { close(); return; }
    if (b.dataset.hl === 'refresh') { await load(); return; }
    if (b.dataset.hl === 'copy') {
      ctx.copy(asText(stats, metrics, ctx.grids()));
      ctx.toast('Copied.');
    }
  });

  await load();
}

/** The same snapshot as plain text, for pasting into an issue. */
export function asText(stats, metrics, grids) {
  const lines = [];
  if (stats) {
    lines.push(`Server (${stats.engineLabel || ''}${stats.database ? ` · ${stats.database}` : ''})`);
    lines.push(`  size            ${bytes(stats.sizeBytes)}`);
    lines.push(`  cache hit       ${pct(stats.cacheHitRatio)}`);
    lines.push(`  connections     ${stats.connections} of ${stats.maxConnections}`);
    lines.push(`  uptime          ${duration(stats.uptimeSeconds)}`);
    for (const m of stats.memory) lines.push(`  ${m.name.padEnd(24)}${m.value}`);
    for (const c of stats.counters) lines.push(`  ${c.name.padEnd(24)}${num(c.value)}`);
  }
  if (metrics) {
    lines.push('', 'Cobalt');
    lines.push(`  memory          ${bytes(metrics.totalMemoryBytes)}`);
    lines.push(`  cpu             ${metrics.totalCpuPercent}%`);
    for (const p of metrics.processes) {
      lines.push(`  ${String(p.type).padEnd(16)}${bytes(p.memoryBytes)} · ${p.cpuPercent}% cpu`);
    }
  }
  if (grids) {
    lines.push('', `Loaded: ${grids.tabs} tabs, ${num(grids.rows)} rows, ${grids.dirty} staged edits`);
  }
  return lines.join('\n');
}
