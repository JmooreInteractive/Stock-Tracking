import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeRows } from '../assets/js/model.js';
import { PORTFOLIO_KEY, buildPerformance, comparisonStats, formatTick, niceTicks, seriesColor, seriesDash } from '../assets/js/perf.js';

const config = JSON.parse(readFileSync(new URL('../tracker.config.json', import.meta.url), 'utf8'));
const seed = JSON.parse(readFileSync(new URL('../data/seed-history.json', import.meta.url), 'utf8'));
const rows = computeRows(config, seed.entries);
const pct2 = (n) => Math.round(n * 10000) / 100;

test('% mode: every series starts at 0 and matches the worksheet % columns', () => {
  const m = buildPerformance(config, rows, 'pct');
  assert.deepEqual(m.series.map((s) => s.key), ['TTWO', 'SKYD', 'META', '^GSPC', PORTFOLIO_KEY]);
  for (const s of m.series) assert.equal(s.values[0], 0, `${s.key} starts at 0%`);
  const last = m.dates.length - 1;
  assert.equal(m.dates[last], '2026-11-06');
  const at = (key) => pct2(m.series.find((s) => s.key === key).values[last]);
  assert.equal(at('TTWO'), 3.95);
  assert.equal(at('SKYD'), 12.82);
  assert.equal(at('META'), -12.11);
  assert.equal(at(PORTFOLIO_KEY), -3.19); // worksheet T14
  assert.equal(at('^GSPC'), -7.79); // 7376.86 vs the 8,000 starting value
});

test('$ mode: holdings in dollars, index scaled to the same starting dollars', () => {
  const m = buildPerformance(config, rows, 'value');
  const s = Object.fromEntries(m.series.map((x) => [x.key, x.values]));
  assert.equal(Math.round(s.TTWO[0]), 4000);
  assert.equal(Math.round(s[PORTFOLIO_KEY][0]), 10000);
  assert.equal(Math.round(s['^GSPC'][0]), 10000);
  assert.equal(Math.round(s[PORTFOLIO_KEY][10] * 100) / 100, 9680.58);
  assert.equal(Math.round(s['^GSPC'][10] * 100) / 100, 9221.07); // $10,000 × 7,376.86 / 8,000
});

test('comparison table: ranked by change since start, gap to S&P, best and worst moves', () => {
  const stats = comparisonStats(buildPerformance(config, rows, 'pct'));
  assert.deepEqual(stats.map((s) => s.key), ['SKYD', 'TTWO', PORTFOLIO_KEY, '^GSPC', 'META']);
  const skyd = stats[0];
  assert.equal(skyd.latest, 8.01);
  assert.equal(pct2(skyd.vsBench), 20.61);
  assert.deepEqual([pct2(skyd.best.pct), skyd.best.date], [10.85, '2026-10-21']);
  assert.deepEqual([pct2(skyd.worst.pct), skyd.worst.date], [-4.53, '2026-11-06']);
  const meta = stats.find((s) => s.key === 'META');
  assert.equal(pct2(meta.vsBench), -4.32);
  assert.deepEqual([pct2(meta.worst.pct), meta.worst.date], [-6.98, '2026-10-22']);
  assert.equal(stats.find((s) => s.key === '^GSPC').vsBench, null);
});

test('missing prices break the line instead of inventing a value', () => {
  const entries = structuredClone(seed.entries);
  delete entries[2].prices.META; // 10/22
  const m = buildPerformance(config, computeRows(config, entries), 'pct');
  assert.equal(m.series.find((s) => s.key === 'META').values[2], null);
  assert.equal(m.series.find((s) => s.key === PORTFOLIO_KEY).values[2], null);
  const meta = comparisonStats(m).find((s) => s.key === 'META');
  // moves skip the gap: 10/23 is compared with the last logged price (10/21)
  assert.deepEqual([pct2(meta.worst.pct), meta.worst.from, meta.worst.date], [-7.87, '2026-10-21', '2026-10-23']);
});

test('axis ticks are round numbers and labels read cleanly', () => {
  assert.deepEqual(niceTicks(-0.1211, 0.1817, 6).ticks, [-0.2, -0.1, 0, 0.1, 0.2]);
  assert.deepEqual(niceTicks(-0.1211, 0.0395, 6).ticks, [-0.15, -0.1, -0.05, 0, 0.05]);
  assert.deepEqual(niceTicks(0, 10200, 6).ticks, [0, 2500, 5000, 7500, 10000, 12500]);
  assert.equal(formatTick(0.1, 'pct', 0.05, 0.2), '+10%');
  assert.equal(formatTick(-0.005, 'pct', 0.005, 0.02), '-0.5%');
  assert.equal(formatTick(0, 'pct', 0.05, 0.2), '0%');
  assert.equal(formatTick(2500, 'value', 2500, 12500), '$2.5K');
  assert.equal(formatTick(10000, 'value', 2500, 12500), '$10K');
  assert.equal(formatTick(0, 'value', 2500, 12500), '$0');
  assert.equal(formatTick(4500, 'value', 500, 6000), '$4,500');
});

test('color follows the stock, not its rank or visibility', () => {
  const colors = { series: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'], bench: 'gray', portfolio: 'ink' };
  const m = buildPerformance(config, rows, 'pct');
  assert.deepEqual(m.series.map((s) => seriesColor(s, colors)), ['c1', 'c2', 'c3', 'gray', 'ink']);
  assert.equal(seriesDash(m.series[3]), '6 4', 'the index line is dashed');
  assert.equal(seriesDash(m.series[0]), null);
});
