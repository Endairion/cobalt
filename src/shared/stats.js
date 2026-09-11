'use strict';

/**
 * Timing statistics for the benchmark tool.
 *
 * Medians and quantiles rather than means: query timings are skewed by the
 * occasional slow sample (a checkpoint, a context switch, the OS deciding to do
 * something else), and one outlier drags a mean around far more than it should.
 */

/** Linear-interpolated quantile over a sorted copy of `values`. */
function quantile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  if (!s.length) return null;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.length > 1
    ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1)
    : 0;
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean,
    stddev: Math.sqrt(variance),
    p25: quantile(s, 0.25),
    median: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
  };
}

/**
 * Rank measured variants and say whether the gap is real.
 *
 * The verdict is deliberately conservative: a win only counts when the fastest
 * variant's p75 still beats the runner-up's p25, i.e. the bulk of the two
 * distributions do not overlap. Two queries a few percent apart on a noisy
 * laptop are a tie, and saying so is more useful than crowning a winner.
 */
function compare(variants) {
  const measured = variants.filter((v) => v.stats && v.stats.n > 0);
  if (measured.length === 0) return { ranked: [], verdict: 'none', winner: null };

  const ranked = [...measured].sort((a, b) => a.stats.median - b.stats.median);
  const best = ranked[0];

  if (ranked.length === 1) {
    return { ranked, verdict: 'single', winner: best, ratio: 1, separated: true };
  }

  const second = ranked[1];
  const ratio = second.stats.median / best.stats.median;
  const separated = best.stats.p75 < second.stats.p25;

  let verdict;
  if (!separated || ratio < 1.05) verdict = 'tie';
  else if (ratio >= 2) verdict = 'decisive';
  else verdict = 'clear';

  return { ranked, verdict, winner: verdict === 'tie' ? null : best, ratio, separated };
}

/** Human phrasing for a speed ratio. */
function ratioLabel(ratio) {
  if (!isFinite(ratio) || ratio <= 1) return 'about the same';
  if (ratio < 1.1) return `${((ratio - 1) * 100).toFixed(0)}% faster`;
  return `${ratio.toFixed(ratio < 10 ? 2 : 0)}x faster`;
}

module.exports = { quantile, summarize, compare, ratioLabel };
