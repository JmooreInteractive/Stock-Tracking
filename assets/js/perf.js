// Performance comparison: every tracked stock, the S&P 500 and the whole portfolio on ONE
// axis, either indexed to the starting point (% change) or in dollars. Hand-built SVG so it
// follows the page theme, has a crosshair + keyboard readout, and exports to PNG.

import { formatDateUS, formatMoney, formatSignedPct } from './model.js';

export const PORTFOLIO_KEY = '__portfolio__';
const SVGNS = 'http://www.w3.org/2000/svg';
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ---------------------------------------------------------------- data (pure)

/**
 * One series per stock, plus the benchmark and the portfolio, with one value per logged day.
 * mode "pct": change since the STARTING POINT (every line starts at 0%).
 * mode "value": dollars — each holding, the portfolio total, and the benchmark as
 *               "the same starting dollars invested in the index".
 */
export function buildPerformance(portfolio, rows, mode = 'pct') {
  const startTotal = rows[0]?.total ?? null;
  const b = portfolio.benchmark;
  const series = portfolio.stocks.map((s, i) => ({
    key: s.symbol,
    label: s.symbol,
    name: s.name || '',
    kind: 'stock',
    slot: i,
    values: rows.map((r) => (mode === 'pct' ? r.stocks[i]?.pctFromStart : r.stocks[i]?.value) ?? null),
    levels: rows.map((r) => r.stocks[i]?.price ?? null),
  }));
  series.push({
    key: b.symbol,
    label: b.name || b.symbol,
    name: mode === 'value' && startTotal != null ? `${formatMoney(startTotal)} invested in the index` : 'benchmark',
    kind: 'bench',
    values: rows.map((r) =>
      mode === 'pct' ? r.spTotalPct : r.spTotalPct != null && startTotal != null ? startTotal * (1 + r.spTotalPct) : null,
    ),
    levels: rows.map((r) => r.sp),
  });
  series.push({
    key: PORTFOLIO_KEY,
    label: 'Portfolio',
    name: 'all holdings',
    kind: 'portfolio',
    values: rows.map((r) => (mode === 'pct' ? r.totalPct : r.total) ?? null),
    levels: rows.map((r) => r.total),
  });
  return { mode, dates: rows.map((r) => r.date), tracks: rows.map((r) => r.track), series };
}

/**
 * Per-series comparison figures, best performer first:
 * latest level, change since start, gap to the benchmark (percentage points),
 * and the biggest gain / loss between two consecutive logged days.
 */
export function comparisonStats(pctModel) {
  const bench = pctModel.series.find((s) => s.kind === 'bench');
  const stats = pctModel.series.map((s) => {
    let last = -1;
    for (let j = s.values.length - 1; j >= 0; j--) {
      if (s.values[j] != null) {
        last = j;
        break;
      }
    }
    let best = null;
    let worst = null;
    let prev = -1;
    s.levels.forEach((lvl, j) => {
      if (lvl == null) return;
      if (prev >= 0 && s.levels[prev]) {
        const move = { pct: lvl / s.levels[prev] - 1, date: pctModel.dates[j], from: pctModel.dates[prev] };
        if (!best || move.pct > best.pct) best = move;
        if (!worst || move.pct < worst.pct) worst = move;
      }
      prev = j;
    });
    const sinceStart = last >= 0 ? s.values[last] : null;
    const benchAt = last >= 0 ? bench?.values[last] : null;
    return {
      key: s.key,
      label: s.label,
      name: s.name,
      kind: s.kind,
      slot: s.slot,
      latest: last >= 0 ? s.levels[last] : null,
      latestDate: last >= 0 ? pctModel.dates[last] : null,
      sinceStart,
      vsBench: s.kind !== 'bench' && sinceStart != null && benchAt != null ? sinceStart - benchAt : null,
      best,
      worst,
    };
  });
  return stats.sort((a, b) => (b.sinceStart ?? -Infinity) - (a.sinceStart ?? -Infinity));
}

/** Round-number axis ticks covering [min, max]. */
export function niceTicks(min, max, count = 5) {
  if (!(max > min)) {
    const pad = Math.abs(min) * 0.05 || 0.01;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f > 5 ? 10 : f > 2.5 ? 5 : f > 2 ? 2.5 : f > 1 ? 2 : 1) * mag;
  const k0 = Math.floor(min / step + 1e-9);
  const k1 = Math.ceil(max / step - 1e-9);
  const ticks = [];
  for (let k = k0; k <= k1; k++) ticks.push(k === 0 ? 0 : Number((k * step).toPrecision(12)));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], step, ticks };
}

export function formatTick(v, mode, step, hi) {
  if (mode === 'pct') {
    if (Math.abs(v) < 1e-12) return '0%';
    const d = step * 100 < 1 ? 1 : 0;
    return `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
  }
  if (Math.abs(v) < 1e-9) return '$0';
  if (hi >= 10000) return `$${Number((v / 1000).toFixed(step % 1000 === 0 ? 0 : 1))}K`;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function formatValue(v, mode) {
  return mode === 'pct' ? formatSignedPct(v) : v == null ? '—' : formatMoney(v);
}

const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const dayMs = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

// ---------------------------------------------------------------- colors

/** Resolves the chart tokens from CSS so the SVG carries real colors (needed for PNG export). */
export function readColors(el) {
  const cs = getComputedStyle(el);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    portfolio: v('--chart-portfolio'),
    bench: v('--chart-bench'),
    grid: v('--chart-grid'),
    axis: v('--chart-axis'),
    surface: v('--surface'),
    text: v('--text'),
    muted: v('--muted'),
  };
}

/** Color follows the entity: stock N always gets categorical slot N, whatever is toggled. */
export function seriesColor(s, colors) {
  if (s.kind === 'bench') return colors.bench;
  if (s.kind === 'portfolio') return colors.portfolio;
  return colors.series[s.slot % 8];
}

export function seriesDash(s) {
  if (s.kind === 'bench') return '6 4';
  if (s.kind === 'stock' && s.slot >= 8) return '2 3'; // past 8 stocks, a dash pattern keeps them distinct
  return null;
}

// ---------------------------------------------------------------- svg building

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, val] of Object.entries(attrs)) if (val != null) node.setAttribute(k, String(val));
  if (text != null) node.textContent = text;
  return node;
}

let measureCtx;
function textWidth(text, font) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Spread labels so none overlap, keeping each as close to its line end as possible. */
function placeLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].ly = Math.max(sorted[i].y, i ? sorted[i - 1].ly + gap : top);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const limit = i === sorted.length - 1 ? bottom : sorted[i + 1].ly - gap;
    if (sorted[i].ly > limit) sorted[i].ly = limit;
  }
  return sorted;
}

/**
 * Builds the chart SVG. Returns { svg, geom } — geom is what the hover layer needs.
 * opts: width, height, hidden (Set of keys), colors, header {title, subtitle} (export only),
 *       legend (export only), labels (allow direct end labels).
 */
export function buildChartSVG(model, opts) {
  const { width, height, hidden, colors, header, legend } = opts;
  const visible = model.series.filter((s) => !hidden.has(s.key));
  const mode = model.mode;
  const svg = el('svg', { xmlns: SVGNS, width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': FONT });
  svg.append(el('rect', { x: 0, y: 0, width, height, fill: colors.surface }));

  let top = 12;
  if (header) {
    svg.append(el('text', { x: 24, y: 34, 'font-size': 20, 'font-weight': 700, fill: colors.text }, header.title));
    if (header.subtitle) svg.append(el('text', { x: 24, y: 58, 'font-size': 13, fill: colors.muted }, header.subtitle));
    top = 74;
  }
  if (legend) {
    let x = 24;
    let y = top + 10;
    for (const s of visible) {
      const label = s.kind === 'stock' && s.name ? `${s.label} · ${s.name}` : s.label;
      const w = 22 + textWidth(label, `600 13px ${FONT}`) + 22;
      if (x + w > width - 24 && x > 24) {
        x = 24;
        y += 22;
      }
      svg.append(el('line', { x1: x, x2: x + 16, y1: y, y2: y, stroke: seriesColor(s, colors), 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': seriesDash(s) }));
      svg.append(el('text', { x: x + 22, y: y + 4.5, 'font-size': 13, 'font-weight': 600, fill: colors.text }, label));
      x += w;
    }
    top = y + 22;
  }

  // y domain over what's visible (always include 0 on the % scale)
  const vals = visible.flatMap((s) => s.values.filter((v) => v != null));
  let min = vals.length ? Math.min(...vals) : 0;
  let max = vals.length ? Math.max(...vals) : 0;
  if (mode === 'pct') {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  } else {
    const pad = (max - min) * 0.06;
    min -= pad;
    max += pad;
  }
  const { lo, hi, step, ticks } = niceTicks(min, max, 6);
  const tickLabels = ticks.map((t) => formatTick(t, mode, step, hi));
  const tickFont = `12px ${FONT}`;
  const left = 14 + Math.max(...tickLabels.map((t) => textWidth(t, tickFont)));

  // direct end labels: only when few enough series that they stay readable (≤ 4)
  const last = (s) => {
    for (let j = s.values.length - 1; j >= 0; j--) if (s.values[j] != null) return j;
    return -1;
  };
  const labelFont = `600 12px ${FONT}`;
  const wantLabels = opts.labels && visible.length <= 4 && width >= 520;
  const labelText = (s) => `${s.label}  ${formatValue(s.values[last(s)], mode)}`;
  const labelW = wantLabels ? Math.max(0, ...visible.filter((s) => last(s) >= 0).map((s) => textWidth(labelText(s), labelFont))) : 0;
  const right = wantLabels ? labelW + 30 : 18;
  const bottom = height - 30;
  const plot = { x0: left, x1: width - right, y0: top, y1: bottom };

  const t0 = dayMs(model.dates[0]);
  const t1 = dayMs(model.dates[model.dates.length - 1]);
  const xs = model.dates.map((d) => (t1 > t0 ? plot.x0 + ((dayMs(d) - t0) / (t1 - t0)) * (plot.x1 - plot.x0) : (plot.x0 + plot.x1) / 2));
  const y = (v) => plot.y1 - ((v - lo) / (hi - lo)) * (plot.y1 - plot.y0);

  // grid + y ticks (hairlines, solid); the 0% line is the baseline
  const grid = el('g', { 'shape-rendering': 'crispEdges' });
  ticks.forEach((t, i) => {
    const yy = Math.round(y(t)) + 0.5;
    const isZero = mode === 'pct' && Math.abs(t) < 1e-12;
    grid.append(el('line', { x1: plot.x0, x2: plot.x1, y1: yy, y2: yy, stroke: isZero ? colors.axis : colors.grid, 'stroke-width': 1 }));
    grid.append(el('text', { x: plot.x0 - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 12, fill: colors.muted, 'font-variant-numeric': 'tabular-nums' }, tickLabels[i]));
  });
  svg.append(grid);

  // x ticks: as many dates as fit without crowding
  const minGap = 58;
  let lastX = -Infinity;
  const xg = el('g');
  model.dates.forEach((d, i) => {
    const isEnd = i === model.dates.length - 1;
    if (xs[i] - lastX < minGap && !isEnd) return;
    if (isEnd && xs[i] - lastX < minGap && xg.lastChild) xg.lastChild.remove();
    xg.append(el('text', { x: xs[i], y: plot.y1 + 20, 'text-anchor': i === 0 && xs[i] - plot.x0 < 20 ? 'start' : isEnd ? 'end' : 'middle', 'font-size': 12, fill: colors.muted }, shortDate(d)));
    lastX = xs[i];
  });
  svg.append(xg);

  // lines: benchmark and portfolio drawn first so stock lines sit on top
  const order = [...visible].sort((a, b) => (a.kind === 'stock') - (b.kind === 'stock'));
  const lines = el('g', { fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  for (const s of order) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xs[i].toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d) lines.append(el('path', { d, stroke: seriesColor(s, colors), 'stroke-dasharray': seriesDash(s) }));
  }
  svg.append(lines);

  // end dots (8px with a 2px surface ring) + optional direct labels with leader lines
  const ends = el('g');
  const labelItems = [];
  for (const s of order) {
    const j = last(s);
    if (j < 0) continue;
    ends.append(el('circle', { cx: xs[j], cy: y(s.values[j]), r: 4, fill: seriesColor(s, colors), stroke: colors.surface, 'stroke-width': 2 }));
    if (wantLabels) labelItems.push({ s, x: xs[j], y: y(s.values[j]) });
  }
  svg.append(ends);
  if (wantLabels) {
    const lx = plot.x1 + 12;
    for (const it of placeLabels(labelItems, 16, plot.y0 + 6, plot.y1 - 2)) {
      if (Math.abs(it.ly - it.y) > 1.5 || it.x < plot.x1 - 1) {
        svg.append(el('polyline', { points: `${it.x + 6},${it.y} ${lx - 4},${it.ly}`, fill: 'none', stroke: colors.axis, 'stroke-width': 1 }));
      }
      const t = el('text', { x: lx, y: it.ly + 4, 'font-size': 12 });
      t.append(el('tspan', { fill: colors.muted, 'font-weight': 600 }, `${it.s.label}  `));
      t.append(el('tspan', { fill: colors.text, 'font-weight': 700 }, formatValue(it.s.values[last(it.s)], mode)));
      svg.append(t);
    }
  }
  return { svg, geom: { xs, y, plot, visible } };
}

// ---------------------------------------------------------------- interactive mount

/**
 * Renders the chart into `container` with a crosshair tooltip (pointer + keyboard).
 * Every value it shows is also in the comparison table, so the tooltip never gates data.
 */
export function mountPerfChart(container, model, { hidden, colors, height }) {
  container.replaceChildren();
  const visible = model.series.filter((s) => !hidden.has(s.key));
  if (model.dates.length < 2 || !visible.length) {
    container.removeAttribute('tabindex');
    container.onfocus = container.onblur = container.onkeydown = null;
    const msg = document.createElement('p');
    msg.className = 'perf-empty muted';
    msg.textContent = model.dates.length < 2 ? 'Log at least two days to draw the comparison.' : 'Pick at least one series above to plot.';
    container.append(msg);
    return;
  }
  const width = Math.max(280, Math.floor(container.clientWidth));
  const { svg, geom } = buildChartSVG(model, { width, height, hidden, colors, labels: true });
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('perf-svg');

  const cross = el('line', { y1: geom.plot.y0, y2: geom.plot.y1, stroke: colors.axis, 'stroke-width': 1, visibility: 'hidden', 'shape-rendering': 'crispEdges' });
  const dots = el('g');
  svg.append(cross, dots);
  const hit = el('rect', { x: geom.plot.x0 - 12, y: geom.plot.y0, width: geom.plot.x1 - geom.plot.x0 + 24, height: geom.plot.y1 - geom.plot.y0, fill: 'transparent', class: 'perf-hit' });
  svg.append(hit);

  const tip = document.createElement('div');
  tip.className = 'perf-tip';
  tip.hidden = true;
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  container.append(svg, tip, live);
  container.tabIndex = 0;
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Performance chart. Use the left and right arrow keys to read each logged day. The table below lists the same figures.');

  let current = -1;
  const show = (i, announce = false) => {
    current = i;
    const x = geom.xs[i];
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    dots.replaceChildren();
    const rowsAt = geom.visible
      .map((s) => ({ s, v: s.values[i] }))
      .filter((r) => r.v != null)
      .sort((a, b) => b.v - a.v);
    for (const r of rowsAt) dots.append(el('circle', { cx: x, cy: geom.y(r.v), r: 4, fill: seriesColor(r.s, colors), stroke: colors.surface, 'stroke-width': 2 }));

    const head = document.createElement('div');
    head.className = 'perf-tip-head';
    const track = model.tracks[i];
    head.textContent = `${formatDateUS(model.dates[i])} · ${typeof track === 'number' ? `Track ${track}` : 'Starting point'}`;
    const list = document.createElement('ul');
    for (const r of rowsAt) {
      const li = document.createElement('li');
      const key = document.createElement('span');
      key.className = 'key';
      key.style.borderTopColor = seriesColor(r.s, colors);
      if (seriesDash(r.s)) key.style.borderTopStyle = 'dashed';
      const val = document.createElement('b');
      val.textContent = formatValue(r.v, model.mode);
      const name = document.createElement('span');
      name.textContent = r.s.label;
      li.append(key, val, name);
      list.append(li);
    }
    tip.replaceChildren(head, list);
    tip.hidden = false;
    const cw = container.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.left = `${x + 14 + tw > cw ? Math.max(0, x - 14 - tw) : x + 14}px`;
    tip.style.top = `${geom.plot.y0}px`;
    if (announce) live.textContent = `${head.textContent}. ${rowsAt.map((r) => `${r.s.label} ${formatValue(r.v, model.mode)}`).join(', ')}`;
  };
  const hide = () => {
    current = -1;
    cross.setAttribute('visibility', 'hidden');
    dots.replaceChildren();
    tip.hidden = true;
  };
  const nearest = (clientX) => {
    const px = clientX - svg.getBoundingClientRect().left;
    let best = 0;
    geom.xs.forEach((x, i) => {
      if (Math.abs(x - px) < Math.abs(geom.xs[best] - px)) best = i;
    });
    return best;
  };
  hit.addEventListener('pointermove', (ev) => show(nearest(ev.clientX)));
  hit.addEventListener('pointerdown', (ev) => show(nearest(ev.clientX)));
  hit.addEventListener('pointerleave', (ev) => ev.pointerType === 'mouse' && hide());
  container.onfocus = () => show(current >= 0 ? current : geom.xs.length - 1, true);
  container.onblur = hide;
  container.onkeydown = (ev) => {
    const n = geom.xs.length;
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n };
    if (ev.key === 'Escape') return hide();
    if (!(ev.key in moves)) return;
    ev.preventDefault();
    show(Math.min(n - 1, Math.max(0, (current < 0 ? n - 1 : current) + moves[ev.key])), true);
  };
}

// ---------------------------------------------------------------- legend chips + table

/** Legend that doubles as the series filter. Chips keep their color when others are hidden. */
export function renderSeriesToggles(container, model, { hidden, colors, onToggle }) {
  container.replaceChildren(
    ...model.series.map((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('aria-pressed', String(!hidden.has(s.key)));
      btn.title = `${hidden.has(s.key) ? 'Show' : 'Hide'} ${s.label}${s.name && s.kind === 'stock' ? ` (${s.name})` : ''}`;
      const key = document.createElement('span');
      key.className = 'key';
      key.style.borderTopColor = seriesColor(s, colors);
      if (seriesDash(s)) key.style.borderTopStyle = 'dashed';
      const label = document.createElement('span');
      label.textContent = s.label;
      btn.append(key, label);
      btn.addEventListener('click', () => onToggle(s.key));
      return btn;
    }),
  );
}

export function renderCompareTable(table, stats, { colors, hidden, benchLabel }) {
  const th = (t, attrs = {}) => {
    const c = document.createElement('th');
    Object.assign(c, attrs);
    c.textContent = t;
    return c;
  };
  const td = (t, cls = '') => {
    const c = document.createElement('td');
    c.className = cls;
    c.textContent = t;
    return c;
  };
  const sign = (n) => (n == null ? '' : n > 0.00005 ? 'pos' : n < -0.00005 ? 'neg' : '');
  const move = (m) => (m ? `${formatSignedPct(m.pct)} · ${formatDateUS(m.date).replace(/\/\d{4}$/, '')}` : '—');

  const caption = document.createElement('caption');
  caption.className = 'sr-only';
  caption.textContent = 'Each series compared since the starting point, best performer first';
  const head = document.createElement('tr');
  head.append(
    th('Series', { scope: 'col' }),
    th('Since start', { scope: 'col' }),
    th(`vs ${benchLabel}`, { scope: 'col', title: 'Percentage points ahead of (+) or behind (−) the index over the same period' }),
    th('Latest', { scope: 'col' }),
    th('Best move', { scope: 'col', title: 'Largest gain between two consecutive logged days' }),
    th('Worst move', { scope: 'col', title: 'Largest drop between two consecutive logged days' }),
  );
  const body = stats.map((s) => {
    const tr = document.createElement('tr');
    if (hidden.has(s.key)) tr.className = 'off';
    const name = document.createElement('th');
    name.scope = 'row';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.borderTopColor = seriesColor(s, colors);
    if (seriesDash(s)) key.style.borderTopStyle = 'dashed';
    const label = document.createElement('span');
    label.textContent = s.label;
    name.append(key, label);
    if (s.name && s.kind === 'stock') {
      const small = document.createElement('small');
      small.textContent = s.name;
      name.append(small);
    }
    const latest = s.latest == null ? '—' : s.kind === 'bench' ? s.latest.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatMoney(s.latest);
    const vs = s.vsBench == null ? '—' : `${s.vsBench >= 0 ? '+' : '-'}${Math.abs(s.vsBench * 100).toFixed(2)} pts`;
    tr.append(
      name,
      td(formatSignedPct(s.sinceStart), `num strong ${sign(s.sinceStart)}`),
      td(vs, `num ${sign(s.vsBench)}`),
      td(latest, 'num'),
      td(move(s.best), `num ${sign(s.best?.pct)}`),
      td(move(s.worst), `num ${sign(s.worst?.pct)}`),
    );
    return tr;
  });
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  tbody.append(...body);
  table.replaceChildren(caption, thead, tbody);
}

// ---------------------------------------------------------------- PNG export

export async function perfPng(model, { hidden, colors, title, subtitle, width = 1200, height = 640, scale = 2 }) {
  const { svg } = buildChartSVG(model, { width, height, hidden, colors, header: { title, subtitle }, legend: true, labels: true });
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not draw the chart image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
