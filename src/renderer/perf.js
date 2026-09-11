/**
 * Performance tools: the benchmark comparison and the EXPLAIN plan tree.
 */

import { ratioLabel } from '../shared/stats.js';

let ctx = null;
export function wire(context) { ctx = context; }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ms = (v) => {
  if (v == null) return '—';
  if (v < 1) return `${v.toFixed(3)} ms`;
  if (v < 100) return `${v.toFixed(2)} ms`;
  if (v < 1000) return `${v.toFixed(1)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
};

const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const firstLine = (sql) => {
  const t = String(sql).trim().split('\n')[0];
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
};

/* ---------------------------- setup dialog ---------------------------- */

export function openBenchmarkDialog(variants, onRun) {
  const anyWrites = variants.some((v) => !v.readOnly);
  const node = document.createElement('div');
  node.className = 'modal bench-modal';
  node.innerHTML = `
    <h2>Benchmark ${variants.length} statement${variants.length > 1 ? 's' : ''}</h2>
    <div class="body">
      <div class="bench-variants">
        ${variants.map((v, i) => `
          <div class="bench-variant${v.readOnly ? '' : ' writes'}">
            <span class="bv-label">${esc(v.label)}</span>
            <code>${esc(firstLine(v.sql))}</code>
            ${v.readOnly ? '' : '<span class="ro-flag writes-flag">WRITES</span>'}
          </div>`).join('')}
      </div>
      <div class="row3">
        <div class="field"><label>Timed runs each</label><input id="b-runs" type="number" min="1" max="500" value="10" /></div>
        <div class="field"><label>Warmup runs (discarded)</label><input id="b-warm" type="number" min="0" max="50" value="2" /></div>
      </div>
      <label class="checkline"><input id="b-rollback" type="checkbox" ${anyWrites ? 'checked' : ''} />
        Roll back each run${anyWrites ? ' — required, these statements write' : ''}</label>
      <label class="checkline"><input id="b-plans" type="checkbox" checked />
        Collect a plan for each variant (adds one EXPLAIN ANALYZE per statement)</label>
      <p class="bench-note">
        Runs are interleaved rather than grouped, so a busy moment on the machine hits
        every variant instead of landing on whichever went first.
      </p>
      <div class="form-msg" id="b-msg"></div>
    </div>
    <div class="foot">
      <span class="spacer"></span>
      <button class="btn ghost" id="b-cancel">Cancel</button>
      <button class="btn primary" id="b-run">Run benchmark</button>
    </div>`;

  const close = ctx.showOverlay(node);
  const $ = (id) => node.querySelector('#' + id);
  if (anyWrites) $('b-rollback').disabled = true;   // not optional for writes

  $('b-cancel').addEventListener('click', close);
  $('b-run').addEventListener('click', () => {
    const opts = {
      runs: Number($('b-runs').value) || 10,
      warmups: Number($('b-warm').value) || 0,
      rollback: $('b-rollback').checked,
      collectPlans: $('b-plans').checked,
    };
    close();
    onRun(opts);
  });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('b-run').click(); });
  setTimeout(() => $('b-runs').focus(), 0);
}

/* -------------------------- benchmark results -------------------------- */

export function renderBenchmark(host, res) {
  const box = document.createElement('div');
  box.className = 'perf-box';
  const { variants, comparison, opts } = res;
  const slowest = Math.max(...variants.filter((v) => v.stats).map((v) => v.stats.p95 || v.stats.max));

  const verdict = (() => {
    const c = comparison;
    if (!c.ranked.length) return '<div class="verdict none">Nothing was measured.</div>';
    if (c.verdict === 'single') {
      return `<div class="verdict single">Median <b>${ms(c.ranked[0].stats.median)}</b> over ${c.ranked[0].stats.n} runs.</div>`;
    }
    if (c.verdict === 'tie') {
      return `<div class="verdict tie"><b>Too close to call.</b> The fastest is ${ratioLabel(c.ratio)},
        but the timings overlap — treat these as equivalent on this machine.</div>`;
    }
    return `<div class="verdict win"><b>${esc(c.winner.label)}</b> wins — ${ratioLabel(c.ratio)}
      than ${esc(c.ranked[1].label)} (median ${ms(c.winner.stats.median)} vs ${ms(c.ranked[1].stats.median)}).</div>`;
  })();

  const rows = comparison.ranked.map((v, i) => {
    const s = v.stats;
    const rel = slowest ? ((s.median / slowest) * 100) : 0;
    const spread = slowest ? (((s.p75 - s.p25) / slowest) * 100) : 0;
    const offset = slowest ? ((s.p25 / slowest) * 100) : 0;
    return `<tr class="${i === 0 && comparison.verdict !== 'tie' ? 'best' : ''}">
      <td class="bv"><span class="bv-label">${esc(v.label)}</span></td>
      <td class="bar-cell">
        <div class="bar-track">
          <div class="bar-fill" style="width:${rel.toFixed(1)}%"></div>
          <div class="bar-iqr" style="left:${offset.toFixed(1)}%;width:${Math.max(spread, 0.4).toFixed(1)}%"></div>
        </div>
      </td>
      <td class="n strong">${ms(s.median)}</td>
      <td class="n">${ms(s.min)}</td>
      <td class="n">${ms(s.p95)}</td>
      <td class="n">${ms(s.max)}</td>
      <td class="n dim">±${ms(s.stddev)}</td>
      <td class="n dim">${num(v.rowCount)}</td>
      <td class="n dim">${v.plan ? ms(v.plan.planningMs) : '—'}</td>
      <td class="n dim">${v.plan ? ms(v.plan.executionMs) : '—'}</td>
    </tr>
    <tr class="sqlrow"><td></td><td colspan="9"><code>${esc(firstLine(v.sql))}</code></td></tr>`;
  }).join('');

  const failed = variants.filter((v) => v.error).map((v) =>
    `<div class="bench-failed"><b>${esc(v.label)}</b> ${esc(v.error.message)}</div>`).join('');

  box.innerHTML = `
    ${verdict}
    <table class="bench-table">
      <thead><tr>
        <th></th><th></th>
        <th class="n">median</th><th class="n">min</th><th class="n">p95</th><th class="n">max</th>
        <th class="n">std dev</th><th class="n">rows</th><th class="n">plan</th><th class="n">exec</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${failed}
    <div class="bench-foot">
      ${opts.runs} timed run${opts.runs > 1 ? 's' : ''} each, interleaved${opts.warmups ? `, after ${opts.warmups} discarded warmup${opts.warmups > 1 ? 's' : ''}` : ''}${opts.rollback ? ', each rolled back' : ''}
      · total ${ms(res.elapsedMs)}${res.cancelled ? ' · cancelled early' : ''}
      <span class="spacer"></span>
      <button class="btn small ghost" data-perf="copy">Copy summary</button>
      ${variants.some((v) => v.plan && v.plan.plan) ? '<button class="btn small ghost" data-perf="plans">Show plans</button>' : ''}
    </div>
    <div class="bench-plans hidden" id="bench-plans">
      ${variants.filter((v) => v.plan && v.plan.plan).map((v) => `
        <div class="bench-plan">
          <div class="bench-plan-head"><span class="bv-label">${esc(v.label)}</span> plan</div>
          ${planTreeHtml(v.plan.plan, v.plan.executionMs)}
        </div>`).join('')}
    </div>`;

  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-perf]');
    if (!act) return;
    if (act.dataset.perf === 'plans') {
      const el = box.querySelector('#bench-plans');
      el.classList.toggle('hidden');
      act.textContent = el.classList.contains('hidden') ? 'Show plans' : 'Hide plans';
    } else if (act.dataset.perf === 'copy') {
      ctx.copy(benchmarkText(res));
      ctx.toast('Benchmark summary copied.');
    }
  });

  host.append(box);
}

function benchmarkText(res) {
  const lines = [`Benchmark — ${res.opts.runs} runs each, interleaved`];
  for (const v of res.comparison.ranked) {
    lines.push(`${v.label}  median ${ms(v.stats.median)}  min ${ms(v.stats.min)}  p95 ${ms(v.stats.p95)}  n=${v.stats.n}`);
    lines.push(`    ${firstLine(v.sql)}`);
  }
  const c = res.comparison;
  if (c.verdict === 'tie') lines.push('Verdict: too close to call.');
  else if (c.winner) lines.push(`Verdict: ${c.winner.label} is ${ratioLabel(c.ratio)}.`);
  return lines.join('\n');
}

/* ------------------------------ plan tree ------------------------------ */

/** Time spent in this node alone, excluding its children. */
function selfTime(node) {
  const total = (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 1);
  const kids = (node.Plans || []).reduce(
    (a, c) => a + (c['Actual Total Time'] ?? 0) * (c['Actual Loops'] ?? 1), 0);
  return Math.max(0, total - kids);
}

function collectNodes(node, out = []) {
  out.push(node);
  for (const c of node.Plans || []) collectNodes(c, out);
  return out;
}

function planTreeHtml(root, executionMs) {
  const all = collectNodes(root);
  const worstSelf = Math.max(...all.map(selfTime), 0);

  const render = (node, depth) => {
    const self = selfTime(node);
    const est = node['Plan Rows'];
    const act = node['Actual Rows'];
    const loops = node['Actual Loops'] ?? 1;
    const actTotal = act == null ? null : act * loops;
    // A plan that is wrong about row counts is usually why it picked the wrong shape.
    const misestimate = est != null && actTotal != null && est > 0
      ? Math.max(actTotal / est, est / Math.max(actTotal, 1))
      : null;
    const hot = worstSelf > 0 && self === worstSelf && self > 0;
    const share = executionMs ? (self / executionMs) * 100 : 0;

    const rel = node['Relation Name']
      ? ` on <span class="pn-rel">${esc(node['Relation Name'])}</span>${node.Alias && node.Alias !== node['Relation Name'] ? ` <span class="dim">${esc(node.Alias)}</span>` : ''}`
      : '';
    const idx = node['Index Name'] ? ` using <span class="pn-idx">${esc(node['Index Name'])}</span>` : '';

    return `
      <div class="plan-node${hot ? ' hot' : ''}" style="--depth:${depth}">
        <div class="pn-main">
          <span class="pn-type">${esc(node['Node Type'])}</span>${rel}${idx}
          ${hot ? '<span class="pn-badge hot-badge">slowest</span>' : ''}
          ${misestimate && misestimate >= 10 ? `<span class="pn-badge miss">rows off ${misestimate.toFixed(0)}x</span>` : ''}
          ${node['Parallel Aware'] ? '<span class="pn-badge">parallel</span>' : ''}
        </div>
        <div class="pn-stats">
          ${act != null ? `<span title="time in this node alone">self ${ms(self)}${share ? ` · ${share.toFixed(0)}%` : ''}</span>` : ''}
          ${act != null ? `<span title="rows: actual vs planned">rows ${num(actTotal)}${est != null ? ` / est ${num(est)}` : ''}</span>` : `<span>est rows ${num(est)}</span>`}
          ${loops > 1 ? `<span>${num(loops)} loops</span>` : ''}
          ${node['Total Cost'] != null ? `<span class="dim">cost ${Number(node['Total Cost']).toFixed(0)}</span>` : ''}
          ${node['Shared Hit Blocks'] != null ? `<span class="dim" title="buffers hit / read">buf ${num(node['Shared Hit Blocks'])}/${num(node['Shared Read Blocks'] || 0)}</span>` : ''}
        </div>
        ${node['Filter'] ? `<div class="pn-extra">Filter: <code>${esc(node['Filter'])}</code>${node['Rows Removed by Filter'] ? ` <span class="dim">(dropped ${num(node['Rows Removed by Filter'])})</span>` : ''}</div>` : ''}
        ${node['Index Cond'] ? `<div class="pn-extra">Index cond: <code>${esc(node['Index Cond'])}</code></div>` : ''}
        ${node['Hash Cond'] ? `<div class="pn-extra">Hash cond: <code>${esc(node['Hash Cond'])}</code></div>` : ''}
        ${node['Sort Key'] ? `<div class="pn-extra">Sort key: <code>${esc(node['Sort Key'].join(', '))}</code>${node['Sort Method'] ? ` <span class="dim">${esc(node['Sort Method'])}</span>` : ''}</div>` : ''}
      </div>
      ${(node.Plans || []).map((c) => render(c, depth + 1)).join('')}`;
  };

  return `<div class="plan-tree">${render(root, 0)}</div>`;
}

export function renderPlan(host, res) {
  const box = document.createElement('div');
  box.className = 'perf-box';
  if (res.error) {
    box.innerHTML = `<div class="verdict none">${esc(res.error.message)}</div>`;
    host.append(box);
    return;
  }
  const all = collectNodes(res.plan);
  const seqScans = all.filter((n) => n['Node Type'] === 'Seq Scan' && (n['Actual Rows'] ?? n['Plan Rows']) > 1000);
  const misses = all.filter((n) => {
    const est = n['Plan Rows'];
    const act = (n['Actual Rows'] ?? null);
    if (est == null || act == null || est <= 0) return false;
    const loops = n['Actual Loops'] ?? 1;
    const total = act * loops;
    return Math.max(total / est, est / Math.max(total, 1)) >= 10;
  });

  const hints = [];
  if (seqScans.length) {
    hints.push(`${seqScans.length} sequential scan${seqScans.length > 1 ? 's' : ''} over more than a thousand rows — ` +
      `${seqScans.map((n) => n['Relation Name']).filter(Boolean).join(', ') || 'see the tree'}. An index may help.`);
  }
  if (misses.length) {
    hints.push(`${misses.length} node${misses.length > 1 ? 's are' : ' is'} out by 10x or more on row counts, ` +
      'which is usually why the planner chose this shape. Consider ANALYZE.');
  }

  box.innerHTML = `
    <div class="plan-head">
      ${res.analyze
        ? `<span class="pill on">executed</span>
           <span class="pill">planning ${ms(res.planningMs)}</span>
           <span class="pill">execution ${ms(res.executionMs)}</span>
           ${res.rolledBack ? '<span class="pill warn">rolled back</span>' : ''}`
        : '<span class="pill">estimated only — no rows were read</span>'}
      <span class="spacer"></span>
      <button class="btn small ghost" data-perf="copyplan">Copy plan</button>
    </div>
    ${hints.map((h) => `<div class="plan-hint">${esc(h)}</div>`).join('')}
    ${planTreeHtml(res.plan, res.executionMs)}`;

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-perf="copyplan"]')) {
      ctx.copy(JSON.stringify(res.plan, null, 2));
      ctx.toast('Plan JSON copied.');
    }
  });
  host.append(box);
}
