import {
  DEFAULT_PORTFOLIO,
  GENERAL_NOTE,
  allSymbols,
  completeRows,
  computeRows,
  formatDateUS,
  formatMoney,
  formatShares,
  formatSignedPct,
  isHttpUrl,
  parseNumber,
  renameSymbolInEntries,
  sortEntries,
  todayISO,
  uid,
} from './model.js';
import { buildMatrix, buildWorkbook, parseCSV, parseWorksheet, rowAsTSV, toCSV, xlsxToMatrix } from './spreadsheet.js';
import { closeOn, loadMarketData, newsFor, timeAgo, tradingViewUrl, yahooNewsUrl, yahooQuoteUrl } from './market.js';
import { buildPerformance, comparisonStats, mountPerfChart, perfPng, readColors, renderCompareTable, renderSeriesToggles } from './perf.js';

const STORE_KEY = 'stockTracker:v1';
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const SYMBOL_RE = /^[A-Za-z0-9^.=-]{1,15}$/;

let state;
let market = { mode: 'loading', symbols: {} };
let draft;
let dirty = false;

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder. Text is always set via text nodes, never innerHTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') {
      if (isHttpUrl(v)) el.href = v;
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 4200);
}

const signClass = (n) => (n == null ? '' : n > 0.00005 ? 'pos' : n < -0.00005 ? 'neg' : '');
const stockLabel = (sym) => (sym === state.portfolio.benchmark.symbol ? state.portfolio.benchmark.name || sym : sym);
const marketName = (sym) => market.symbols?.[sym]?.name || '';

function download(filename, blob) {
  const a = h('a', { download: filename });
  a.href = URL.createObjectURL(blob);
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

let excelPromise;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelPromise ??= new Promise((resolve, reject) => {
    const s = h('script', { src: EXCELJS_URL });
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => {
      excelPromise = null;
      reject(new Error('Could not load the Excel library. Check your connection, or use Download CSV.'));
    };
    document.head.append(s);
  });
  return excelPromise;
}

// ---------------------------------------------------------------- state

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save in this browser (storage blocked). Download a backup to keep your work.', 'warn');
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function defaultState() {
  const [cfg, seed] = await Promise.all([
    fetchJSON('tracker.config.json').catch(() => null),
    fetchJSON('data/seed-history.json').catch(() => null),
  ]);
  const portfolio = cfg?.stocks?.length ? { stocks: cfg.stocks, benchmark: cfg.benchmark || DEFAULT_PORTFOLIO.benchmark } : structuredClone(DEFAULT_PORTFOLIO);
  return { portfolio, entries: seed?.entries || [], ui: {} };
}

function normalizeState(s) {
  s.ui ||= {};
  s.ui.focus ||= s.portfolio.stocks[0]?.symbol || s.portfolio.benchmark.symbol;
  s.ui.interval ||= '1';
  s.ui.compare ??= true;
  s.ui.perfMode = s.ui.perfMode === 'value' ? 'value' : 'pct';
  s.ui.perfHidden = Array.isArray(s.ui.perfHidden) ? s.ui.perfHidden : [];
  s.entries = sortEntries(
    (s.entries || []).map((e) => ({ id: e.id || uid(), date: e.date, prices: e.prices || {}, sp: e.sp ?? null, notes: e.notes || {}, sources: e.sources || [] })),
  );
  if (!allSymbols(s.portfolio).includes(s.ui.focus)) s.ui.focus = s.portfolio.stocks[0]?.symbol || s.portfolio.benchmark.symbol;
  return s;
}

const rows = () => computeRows(state.portfolio, state.entries);
const entryByDate = (date) => state.entries.find((e) => e.date === date);

// ---------------------------------------------------------------- summary tiles

function renderKPIs() {
  const done = completeRows(rows());
  const el = $('#kpis');
  el.replaceChildren();
  if (!done.length) {
    el.append(h('div', { class: 'kpi wide' }, h('span', { class: 'kpi-label' }, 'Getting started'), h('span', { class: 'kpi-sub' }, 'Log your STARTING POINT prices below to begin tracking.')));
    return;
  }
  const last = done[done.length - 1];
  const first = done[0];
  const gap = last.totalPct != null && last.spTotalPct != null ? last.totalPct - last.spTotalPct : null;
  const tile = (label, value, sub, cls = '') => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label), h('span', { class: `kpi-value ${cls}` }, value), h('span', { class: 'kpi-sub' }, sub));
  el.append(
    tile('Portfolio value', formatMoney(last.total), `as of ${formatDateUS(last.date)} · ${last.index ? `Track ${last.index}` : 'starting point'}`),
    tile('Since start', formatSignedPct(last.totalPct), `${formatMoney(last.total - first.total)} vs ${formatMoney(first.total)} on ${formatDateUS(first.date)}`, signClass(last.totalPct)),
    tile(
      `${state.portfolio.benchmark.name || 'Benchmark'} since start`,
      formatSignedPct(last.spTotalPct),
      gap == null ? '' : `Portfolio is ${Math.abs(gap * 100).toFixed(2)} pts ${gap >= 0 ? 'ahead of' : 'behind'} the index`,
      signClass(last.spTotalPct),
    ),
    tile('Last session', formatSignedPct(last.dayPct), `${state.portfolio.benchmark.name || 'Index'} ${formatSignedPct(last.spDayPct)} same day`, signClass(last.dayPct)),
  );
}

// ---------------------------------------------------------------- performance comparison

function perfText(mode, start) {
  if (!start) return '';
  return mode === 'pct'
    ? `Change since the starting point on ${formatDateUS(start.date)}. Every line starts at 0%, so a $8 stock and a $600 stock compare directly.`
    : `Dollar value of each holding and the whole portfolio. The dashed ${state.portfolio.benchmark.name || 'index'} line is what the starting ${formatMoney(start.total)} would be worth in the index.`;
}

function renderPerf() {
  const all = rows();
  const mode = state.ui.perfMode;
  const hidden = new Set(state.ui.perfHidden);
  const card = $('.perf-card');
  const colors = readColors(card);
  const model = buildPerformance(state.portfolio, all, mode);
  $('#perf-sub').textContent = perfText(mode, all[0]);
  document.querySelectorAll('#perf-mode .seg-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  renderSeriesToggles($('#perf-series'), model, {
    hidden,
    colors,
    onToggle: (key) => {
      const set = new Set(state.ui.perfHidden);
      set.has(key) ? set.delete(key) : set.add(key);
      state.ui.perfHidden = [...set];
      persist();
      renderPerf();
    },
  });
  mountPerfChart($('#perf-chart'), model, { hidden, colors, height: window.innerWidth < 560 ? 280 : 340 });
  renderCompareTable($('#perf-table'), comparisonStats(mode === 'pct' ? model : buildPerformance(state.portfolio, all, 'pct')), {
    colors,
    hidden,
    benchLabel: state.portfolio.benchmark.name || 'index',
  });
  $('#btn-perf-png').disabled = all.length < 2;
}

async function downloadPerfPng() {
  const all = rows();
  const mode = state.ui.perfMode;
  try {
    const blob = await perfPng(buildPerformance(state.portfolio, all, mode), {
      hidden: new Set(state.ui.perfHidden),
      colors: readColors($('.perf-card')),
      title: mode === 'pct' ? `Performance since ${formatDateUS(all[0].date)} (% change)` : `Holding values since ${formatDateUS(all[0].date)} ($)`,
      subtitle: `Logged closes ${formatDateUS(all[0].date)} – ${formatDateUS(all[all.length - 1].date)} · ${all.length} days`,
    });
    download(`performance-${mode === 'pct' ? 'percent' : 'value'}-${todayISO()}.png`, blob);
  } catch (err) {
    toast(err.message, 'warn');
  }
}

// ---------------------------------------------------------------- focus, chart, news

function focusItems() {
  return [...state.portfolio.stocks.map((s) => ({ ...s, label: s.symbol })), { ...state.portfolio.benchmark, label: state.portfolio.benchmark.name || state.portfolio.benchmark.symbol }];
}

function renderFocus() {
  const tabs = $('#focus-tabs');
  tabs.replaceChildren(
    ...focusItems().map((it) =>
      h('button', { type: 'button', role: 'tab', class: 'seg-btn', 'aria-selected': String(it.symbol === state.ui.focus), onclick: () => setFocus(it.symbol) }, it.label),
    ),
  );
  const link = $('#focus-quote-link');
  link.href = yahooQuoteUrl(state.ui.focus);
  link.textContent = `${stockLabel(state.ui.focus)} on Yahoo Finance ↗`;
}

function setFocus(sym) {
  state.ui.focus = sym;
  persist();
  renderFocus();
  renderChart();
  renderNews();
}

function renderChart() {
  const items = focusItems();
  const focus = items.find((i) => i.symbol === state.ui.focus) || items[0];
  const wrap = $('#chart');
  const compare = state.ui.compare ? state.portfolio.stocks.filter((s) => s.symbol !== focus.symbol) : [];
  const chart = document.createElement('tv-advanced-chart');
  chart.setAttribute('symbol', focus.tvSymbol || focus.symbol);
  chart.setAttribute('interval', state.ui.interval);
  chart.setAttribute('chart-type', 'area');
  if (compare.length) chart.setAttribute('compare-symbols', JSON.stringify(compare.map((s) => ({ symbol: s.tvSymbol || s.symbol, position: 'new-pane' }))));
  chart.setAttribute('allow-symbol-change', '');
  wrap.replaceChildren(chart);
  $('#tv-link').href = tradingViewUrl(focus.tvSymbol || focus.symbol);
  $('#chart-interval').value = state.ui.interval;
  $('#chart-compare').checked = state.ui.compare;

  Promise.race([customElements.whenDefined('tv-advanced-chart'), new Promise((r) => setTimeout(() => r('timeout'), 8000))]).then((res) => {
    if (res === 'timeout' && wrap.contains(chart)) {
      wrap.replaceChildren(h('div', { class: 'chart-fallback' }, h('p', {}, 'The TradingView chart could not load (offline or blocked by a content blocker).'), h('a', { class: 'btn small', href: tradingViewUrl(focus.tvSymbol || focus.symbol), target: '_blank', rel: 'noopener' }, `Open ${focus.label} on TradingView ↗`)));
    }
  });
}

function renderNews() {
  const sym = state.ui.focus;
  const label = stockLabel(sym);
  const list = $('#news-list');
  const status = $('#news-status');
  const items = newsFor(market, sym);
  const err = market.symbols?.[sym]?.errors?.news;
  const tickerTag = sym === state.portfolio.benchmark.symbol ? '' : sym;

  $('#news-title').textContent = `Yahoo Finance articles · ${label}`;
  if (market.mode === 'loading') status.textContent = 'Loading headlines…';
  else if (market.mode === 'none') status.textContent = 'An in-app headline list needs the GitHub Pages workflow or the local server (see README). Meanwhile, open Yahoo Finance below and paste article links as sources.';
  else if (!market.symbols?.[sym]) status.textContent = `${label} isn't in the published headline data yet. Add it to tracker.config.json, or use the links below.`;
  else if (err && !items.length) status.textContent = `Couldn't load ${label} headlines (${err}). Use the links below.`;
  else {
    const when = market.generatedAt ? new Date(market.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    status.textContent = `${items.length} articles · ${market.mode === 'live' ? 'live' : 'updated'} ${when}${market.mode === 'snapshot' ? ' (refreshes on weekdays)' : ''}`;
  }

  const added = new Set(draft.sources.map((s) => s.url));
  list.replaceChildren(
    ...items.map((n) =>
      h(
        'li',
        { class: 'news-item' },
        h('div', { class: 'news-body' }, h('a', { class: 'news-title', href: n.link, target: '_blank', rel: 'noopener' }, n.title), h('span', { class: 'news-meta' }, [n.publisher, timeAgo(n.published)].filter(Boolean).join(' · '))),
        added.has(n.link)
          ? h('button', { type: 'button', class: 'btn tiny done', disabled: true, title: 'Already in this day’s sources' }, '✓ Added')
          : h('button', { type: 'button', class: 'btn tiny', title: `Add to ${formatDateUS(draft.date)} sources`, onclick: () => addSource({ title: n.title, url: n.link, ticker: tickerTag, publisher: n.publisher || '' }) }, '+ Source'),
      ),
    ),
  );
  $('#news-links').replaceChildren(
    h('a', { href: yahooNewsUrl(sym), target: '_blank', rel: 'noopener' }, `All ${label} news on Yahoo Finance ↗`),
    h('a', { href: yahooQuoteUrl(sym), target: '_blank', rel: 'noopener' }, `${label} quote ↗`),
  );
}

async function refreshMarket(refresh = false) {
  if (refresh) {
    market = { ...market, mode: market.mode === 'none' ? 'loading' : market.mode };
    $('#news-status').textContent = 'Refreshing…';
  }
  market = await loadMarketData(allSymbols(state.portfolio), { refresh });
  const pill = $('#data-mode');
  pill.hidden = market.mode === 'none';
  pill.textContent = market.mode === 'live' ? '● Live data' : 'Daily data snapshot';
  pill.title = market.mode === 'live' ? 'Prices and headlines fetched live from Yahoo Finance by serve.py' : 'Prices and headlines published by the scheduled GitHub Action';
  renderNews();
  renderPriceGrid();
}

// ---------------------------------------------------------------- daily log form

function blankDraft(date) {
  return { id: null, date, prices: {}, sp: null, notes: {}, sources: [] };
}

function loadDraft(date) {
  const e = entryByDate(date);
  draft = e ? structuredClone(e) : blankDraft(date);
  dirty = false;
  $('#entry-date').value = date;
  $('#autofill-status').textContent = '';
  renderForm();
  renderNews();
  renderSheet();
}

function markDirty() {
  dirty = true;
  renderPreview();
}

/** Entries with the draft applied, so the preview shows what saving would produce. */
function entriesWithDraft() {
  const others = state.entries.filter((e) => e.id !== draft.id && e.date !== draft.date);
  return sortEntries([...others, { ...draft, id: draft.id || '__draft__' }]);
}

function draftRow() {
  return computeRows(state.portfolio, entriesWithDraft()).find((r) => r.date === draft.date);
}

function renderForm() {
  const existing = entryByDate(draft.date);
  const sorted = entriesWithDraft();
  const idx = sorted.findIndex((e) => e.date === draft.date);
  $('#entry-badge').textContent = `${existing ? 'Editing' : 'New'} · ${idx === 0 ? 'STARTING POINT' : `Track ${idx}`}`;
  $('#entry-badge').className = `badge ${existing ? 'edit' : 'new'}`;
  $('#btn-delete').hidden = !existing;
  $('#btn-copy-row').disabled = !existing;
  renderPriceGrid();
  renderNotes();
  renderSources();
}

function priceInput(sym, value, onInput) {
  return h('input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'cell-input',
    value: value == null ? '' : Number.isInteger(Math.round(value * 1e6) / 1e4) ? value.toFixed(2) : String(value),
    placeholder: '0.00',
    'aria-label': `${stockLabel(sym)} closing price`,
    oninput: (ev) => {
      onInput(parseNumber(ev.target.value));
      markDirty();
    },
  });
}

function renderPriceGrid() {
  if (!draft) return;
  const grid = $('#price-grid');
  const head = h('div', { class: 'pt-row pt-head', role: 'row' }, h('span', { role: 'columnheader' }, 'Ticker'), h('span', { role: 'columnheader' }, 'Close'), h('span', { role: 'columnheader' }, 'Value'), h('span', { role: 'columnheader' }, 'vs. day 1'));
  const stockRows = state.portfolio.stocks.map((s) =>
    h(
      'div',
      { class: 'pt-row', role: 'row' },
      h('span', { class: 'pt-sym', role: 'cell' }, s.symbol, marketName(s.symbol) || s.name ? h('small', {}, marketName(s.symbol) || s.name) : null),
      h('span', { role: 'cell' }, priceInput(s.symbol, draft.prices[s.symbol], (v) => (v == null ? delete draft.prices[s.symbol] : (draft.prices[s.symbol] = v)))),
      h('span', { class: 'calc', role: 'cell', 'data-calc': `value:${s.symbol}` }),
      h('span', { class: 'calc', role: 'cell', 'data-calc': `pct:${s.symbol}` }),
    ),
  );
  const b = state.portfolio.benchmark;
  const benchRow = h(
    'div',
    { class: 'pt-row bench', role: 'row' },
    h('span', { class: 'pt-sym', role: 'cell' }, b.name || b.symbol, h('small', {}, b.symbol)),
    h('span', { role: 'cell' }, priceInput(b.symbol, draft.sp, (v) => (draft.sp = v))),
    h('span', { class: 'calc', role: 'cell', 'data-calc': 'spDay' }),
    h('span', { class: 'calc', role: 'cell', 'data-calc': 'spTotal' }),
  );
  grid.replaceChildren(head, ...stockRows, benchRow);
  renderPreview();
}

function renderPreview() {
  const r = draftRow();
  if (!r) return;
  const set = (key, text, n) => {
    const el = document.querySelector(`[data-calc="${CSS.escape(key)}"]`);
    if (el) {
      el.textContent = text;
      el.className = `calc ${signClass(n)}`;
    }
  };
  r.stocks.forEach((s) => {
    set(`value:${s.symbol}`, s.value == null ? '—' : formatMoney(s.value));
    set(`pct:${s.symbol}`, formatSignedPct(s.pctFromStart), s.pctFromStart);
  });
  set('spDay', r.spDayPct == null ? '—' : `${formatSignedPct(r.spDayPct)} day`, r.spDayPct);
  set('spTotal', formatSignedPct(r.spTotalPct), r.spTotalPct);

  const missing = state.portfolio.stocks.filter((s) => draft.prices[s.symbol] == null).map((s) => s.symbol);
  const stat = (label, value, n) => h('div', { class: 'stat' }, h('span', {}, label), h('b', { class: signClass(n) }, value));
  $('#entry-preview').replaceChildren(
    stat('Total value', r.total == null ? '—' : formatMoney(r.total)),
    stat('Day change', formatSignedPct(r.dayPct), r.dayPct),
    stat('Since start', formatSignedPct(r.totalPct), r.totalPct),
    ...(missing.length ? [h('p', { class: 'fine warn-text' }, `Enter ${missing.join(', ')} to calculate the total.`)] : []),
  );

  const startBox = $('#start-investments');
  startBox.hidden = r.index !== 0;
  if (r.index === 0) {
    startBox.replaceChildren(
      h('p', { class: 'fine' }, h('b', {}, 'Starting point. '), 'Shares = starting investment ÷ these prices: ', state.portfolio.stocks.map((s, i) => `${i ? ', ' : ''}${s.symbol} ${formatMoney(s.investment)} → ${formatShares(r.stocks[i].shares) || '—'} sh`).join(''), '. Change investments in Portfolio settings.'),
    );
  }
}

function renderNotes() {
  const keys = [{ key: GENERAL_NOTE, label: `Market / ${state.portfolio.benchmark.name || 'overall'}` }, ...state.portfolio.stocks.map((s) => ({ key: s.symbol, label: `${s.symbol} analysis` }))];
  $('#notes-grid').replaceChildren(
    ...keys.map(({ key, label }) =>
      h(
        'label',
        { class: 'note' },
        h('span', {}, label),
        h('textarea', {
          rows: 2,
          class: 'cell-input',
          placeholder: key === GENERAL_NOTE ? 'What moved the market today?' : `Why did ${key} move? Earnings, news, sector…`,
          oninput: (ev) => {
            const v = ev.target.value;
            if (v.trim()) draft.notes[key] = v;
            else delete draft.notes[key];
            dirty = true;
          },
        }),
      ),
    ),
  );
  // set values after creation so textarea content isn't parsed
  [...$('#notes-grid').querySelectorAll('textarea')].forEach((ta, i) => (ta.value = draft.notes[keys[i].key] || ''));

  const sel = $('#source-ticker');
  sel.replaceChildren(h('option', { value: '' }, 'General'), ...state.portfolio.stocks.map((s) => h('option', { value: s.symbol }, s.symbol)));
  sel.value = state.portfolio.stocks.some((s) => s.symbol === state.ui.focus) ? state.ui.focus : '';
}

function renderSources() {
  const list = $('#source-list');
  if (!draft.sources.length) {
    list.replaceChildren(h('li', { class: 'empty muted' }, 'No sources yet.'));
    return;
  }
  list.replaceChildren(
    ...draft.sources.map((s, i) =>
      h(
        'li',
        {},
        s.ticker ? h('span', { class: 'tag' }, s.ticker) : h('span', { class: 'tag general' }, 'General'),
        h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title || s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove source ${s.title || s.url}`, onclick: () => removeSource(i) }, '×'),
      ),
    ),
  );
}

function addSource(src) {
  if (!isHttpUrl(src.url)) return toast('Sources need a full link starting with http:// or https://', 'warn');
  if (draft.sources.some((s) => s.url === src.url)) return toast('That link is already a source for this day.');
  draft.sources.push(src);
  dirty = true;
  renderSources();
  renderNews();
  toast(`Added to ${formatDateUS(draft.date)} sources. Save the entry to keep it.`);
}

function removeSource(i) {
  draft.sources.splice(i, 1);
  dirty = true;
  renderSources();
  renderNews();
}

function autofill() {
  const status = $('#autofill-status');
  if (market.mode === 'none' || market.mode === 'loading') {
    status.textContent = market.mode === 'loading' ? 'Still loading market data…' : 'No price data in this setup. Enter closes by hand (Yahoo Finance → Historical Data), or see README for auto-fill.';
    return;
  }
  const filled = [];
  const missing = [];
  const live = [];
  for (const sym of allSymbols(state.portfolio)) {
    const close = closeOn(market, sym, draft.date);
    if (close != null) {
      if (sym === state.portfolio.benchmark.symbol) draft.sp = close;
      else draft.prices[sym] = close;
      filled.push(sym);
    } else {
      missing.push(stockLabel(sym));
      const lv = market.symbols?.[sym]?.live;
      if (lv?.date === draft.date) live.push(`${stockLabel(sym)} ${formatMoney(lv.price)}`);
    }
  }
  if (filled.length) markDirty();
  renderPriceGrid();
  status.textContent = filled.length
    ? `Filled ${filled.length} of ${filled.length + missing.length} closes for ${formatDateUS(draft.date)} from Yahoo Finance.${missing.length ? ` Not available: ${missing.join(', ')}.` : ''}`
    : live.length
      ? `Market is still open on ${formatDateUS(draft.date)}, so there are no closes yet (now: ${live.join(', ')}).`
      : `No closing prices for ${formatDateUS(draft.date)} yet${market.mode === 'snapshot' ? ' (the snapshot updates after the close on weekdays)' : ''}.`;
}

function saveDraft(ev) {
  ev?.preventDefault();
  const hasContent = Object.keys(draft.prices).length || draft.sp != null || Object.keys(draft.notes).length || draft.sources.length;
  if (!draft.date) return toast('Pick a date first.', 'warn');
  if (!hasContent) return toast('Nothing to save yet. Enter prices, notes or sources.', 'warn');
  const first = state.entries[0];
  if (first && draft.date < first.date && !confirm(`${formatDateUS(draft.date)} is before your starting point (${formatDateUS(first.date)}). It will become the new STARTING POINT and share counts will be recalculated. Continue?`)) return;
  const entry = { ...structuredClone(draft), id: draft.id || uid() };
  state.entries = sortEntries([...state.entries.filter((e) => e.id !== entry.id && e.date !== entry.date), entry]);
  persist();
  draft = structuredClone(entry);
  dirty = false;
  const r = rows().find((x) => x.entry.id === entry.id);
  const missing = state.portfolio.stocks.filter((s) => entry.prices[s.symbol] == null).map((s) => s.symbol);
  toast(`Saved ${formatDateUS(entry.date)} (${r.index === 0 ? 'starting point' : `Track ${r.index}`}).${missing.length ? ` Missing ${missing.join(', ')}, so totals stay blank.` : ''}`, missing.length ? 'warn' : 'ok');
  renderAll();
}

function deleteDraft() {
  const e = entryByDate(draft.date);
  if (!e || !confirm(`Delete the ${formatDateUS(e.date)} entry? This can't be undone (unless you have a backup).`)) return;
  state.entries = state.entries.filter((x) => x.id !== e.id);
  persist();
  toast(`Deleted ${formatDateUS(e.date)}.`);
  loadDraft(draft.date);
  renderKPIs();
  renderPerf();
}

async function copyRow() {
  const e = entryByDate(draft.date);
  if (!e) return;
  const tsv = rowAsTSV(state.portfolio, state.entries, e.id);
  try {
    await navigator.clipboard.writeText(tsv);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = tsv;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Row copied. Click column A of the matching row in your spreadsheet and paste.', 'ok');
}

// ---------------------------------------------------------------- spreadsheet table

function renderSheet() {
  const table = $('#sheet');
  const all = rows();
  const stocks = state.portfolio.stocks;
  const b = state.portfolio.benchmark;
  const th = (text, attrs = {}) => h('th', attrs, text);
  const group = h(
    'tr',
    { class: 'group' },
    th('', { colspan: 2 }),
    ...stocks.map((s) => th(s.symbol, { colspan: 3 })),
    th(b.name || 'S&P 500'),
    th('Portfolio'),
    th('% change vs. day 1', { colspan: stocks.length }),
    th(`${b.name || 'S&P'} %`),
    th('Portfolio %'),
    th('Total %'),
    th('', { colspan: 2 }),
  );
  const head = h(
    'tr',
    {},
    th('Track'),
    th('Date'),
    ...stocks.flatMap(() => [th('Price'), th('Shares'), th('Value')]),
    th('Price'),
    th('Total value'),
    ...stocks.map((s) => th(s.symbol)),
    th('day'),
    th('day'),
    th('since start'),
    th('Notes'),
    th('Sources'),
  );
  const td = (text, cls = '', n) => h('td', { class: `${cls} ${signClass(n)}`.trim() }, text);
  const body = all.map((r) => {
    const notes = [r.entry.notes?.[GENERAL_NOTE], ...stocks.map((s) => (r.entry.notes?.[s.symbol] ? `${s.symbol}: ${r.entry.notes[s.symbol]}` : ''))].filter(Boolean).join(' · ');
    const tr = h(
      'tr',
      {
        class: r.date === draft?.date ? 'current' : '',
        tabindex: 0,
        title: `Edit ${formatDateUS(r.date)}`,
        onclick: () => switchDate(r.date, true),
        onkeydown: (ev) => ev.key === 'Enter' && switchDate(r.date, true),
      },
      td(String(r.track), 'calc track'),
      td(formatDateUS(r.date), 'in'),
      ...r.stocks.flatMap((s) => [td(formatMoney(s.price) || '—', 'in num'), td(formatShares(s.shares), 'calc num'), td(formatMoney(s.value), 'calc num')]),
      td(formatMoney(r.sp) || '—', 'in num'),
      td(formatMoney(r.total), 'calc num strong'),
      ...r.stocks.map((s) => td(formatSignedPct(s.pctFromStart), 'calc num', s.pctFromStart)),
      td(formatSignedPct(r.spDayPct), 'calc num', r.spDayPct),
      td(formatSignedPct(r.dayPct), 'calc num', r.dayPct),
      td(formatSignedPct(r.totalPct), 'calc num strong', r.totalPct),
      h('td', { class: 'in notes-cell', title: notes }, notes),
      td(r.entry.sources?.length ? String(r.entry.sources.length) : '', 'in num'),
    );
    return tr;
  });
  if (!body.length) body.push(h('tr', {}, h('td', { colspan: 99, class: 'empty muted' }, 'No entries yet.')));
  table.replaceChildren(h('thead', {}, group, head), h('tbody', {}, ...body));
}

function switchDate(date, scroll = false) {
  if (date === draft?.date) {
    if (scroll) $('.log-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (dirty && !confirm(`Discard unsaved changes for ${formatDateUS(draft.date)}?`)) {
    $('#entry-date').value = draft.date;
    return;
  }
  loadDraft(date);
  if (scroll) $('.log-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- export / import / backup

const stamp = () => todayISO();

async function exportXlsx() {
  const btn = $('#btn-xlsx');
  btn.disabled = true;
  try {
    const ExcelJS = await loadExcelJS();
    const wb = buildWorkbook(ExcelJS, state.portfolio, state.entries);
    const buf = await wb.xlsx.writeBuffer();
    download(`STOCK_TRACKER_WORKSHEET_${stamp()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    toast('Excel file downloaded: yellow cells are your inputs, blue cells are live formulas.', 'ok');
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

function exportCsv() {
  const csv = toCSV(buildMatrix(state.portfolio, state.entries));
  download(`STOCK_TRACKER_WORKSHEET_${stamp()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

async function importSheet(file) {
  try {
    let matrix;
    if (/\.xlsx$/i.test(file.name)) {
      const ExcelJS = await loadExcelJS();
      matrix = await xlsxToMatrix(ExcelJS, await file.arrayBuffer());
    } else {
      matrix = parseCSV(await file.text());
    }
    const { portfolio, entries } = parseWorksheet(matrix, state.portfolio);
    const range = `${formatDateUS(entries[0].date)} – ${formatDateUS(entries[entries.length - 1].date)}`;
    const ok = confirm(
      `Import ${entries.length} days (${range}) for ${portfolio.stocks.map((s) => s.symbol).join(', ')}?\n\nThis replaces the ${state.entries.length} days currently in the tracker. Starting investments: ${portfolio.stocks.map((s) => `${s.symbol} ${formatMoney(s.investment)}`).join(', ')}.`,
    );
    if (!ok) return;
    state.portfolio = portfolio;
    state.entries = entries;
    normalizeState(state);
    persist();
    renderAll(true);
    refreshMarket();
    toast(`Imported ${entries.length} days.`, 'ok');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'warn');
  }
}

function backup() {
  download(`stock-tracker-backup-${stamp()}.json`, new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data?.portfolio?.stocks || !Array.isArray(data.entries)) throw new Error('not a Stock Tracker backup');
    if (!confirm(`Restore ${data.entries.length} days from ${file.name}? This replaces what's in the tracker now.`)) return;
    state = normalizeState(data);
    persist();
    renderAll(true);
    refreshMarket();
    toast('Backup restored.', 'ok');
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'warn');
  }
}

// ---------------------------------------------------------------- settings

function openSettings() {
  const stocksBox = $('#settings-stocks');
  const row = (s = { symbol: '', tvSymbol: '', investment: '' }) =>
    h(
      'div',
      { class: 'st-row', 'data-original': s.symbol },
      h('label', {}, h('span', {}, 'Yahoo symbol'), h('input', { name: 'symbol', value: s.symbol, required: true, placeholder: 'TTWO', autocapitalize: 'characters' })),
      h('label', {}, h('span', {}, 'TradingView symbol'), h('input', { name: 'tvSymbol', value: s.tvSymbol || '', placeholder: 'NASDAQ:TTWO' })),
      h('label', {}, h('span', {}, 'Starting investment ($)'), h('input', { name: 'investment', value: s.investment ?? '', inputmode: 'decimal', placeholder: '1000' })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove stock', onclick: (ev) => ev.target.closest('.st-row').remove() }, '×'),
    );
  stocksBox.replaceChildren(h('div', { class: 'st-rows' }, ...state.portfolio.stocks.map(row)));
  $('#btn-add-stock').onclick = () => stocksBox.firstChild.append(row());
  const b = state.portfolio.benchmark;
  $('#settings-bench').replaceChildren(
    h(
      'div',
      { class: 'st-row bench' },
      h('label', {}, h('span', {}, 'Yahoo symbol'), h('input', { name: 'bsymbol', value: b.symbol, required: true })),
      h('label', {}, h('span', {}, 'TradingView symbol'), h('input', { name: 'btvSymbol', value: b.tvSymbol || '' })),
      h('label', {}, h('span', {}, 'Name'), h('input', { name: 'bname', value: b.name || '' })),
    ),
  );
  $('#settings').showModal();
}

function saveSettings(ev) {
  if (ev.submitter?.value !== 'save') return;
  ev.preventDefault();
  const rowsEl = [...document.querySelectorAll('#settings-stocks .st-row')];
  const stocks = [];
  const renames = [];
  for (const r of rowsEl) {
    const symbol = r.querySelector('[name=symbol]').value.trim().toUpperCase();
    const tvSymbol = r.querySelector('[name=tvSymbol]').value.trim().toUpperCase() || symbol;
    const investment = parseNumber(r.querySelector('[name=investment]').value);
    if (!symbol) continue;
    if (!SYMBOL_RE.test(symbol)) return toast(`"${symbol}" doesn't look like a ticker symbol.`, 'warn');
    if (stocks.some((s) => s.symbol === symbol)) return toast(`${symbol} is listed twice.`, 'warn');
    if (!(investment > 0)) return toast(`Enter a starting investment for ${symbol}.`, 'warn');
    const prev = state.portfolio.stocks.find((s) => s.symbol === symbol);
    stocks.push(prev?.name ? { symbol, name: prev.name, tvSymbol, investment } : { symbol, tvSymbol, investment });
    if (r.dataset.original && r.dataset.original !== symbol) renames.push([r.dataset.original, symbol]);
  }
  if (!stocks.length) return toast('Keep at least one stock.', 'warn');
  const bsymbol = $('[name=bsymbol]').value.trim().toUpperCase();
  if (!SYMBOL_RE.test(bsymbol)) return toast('Check the benchmark symbol.', 'warn');
  const benchmark = { symbol: bsymbol, tvSymbol: $('[name=btvSymbol]').value.trim().toUpperCase() || bsymbol, name: $('[name=bname]').value.trim() || bsymbol };

  let entries = state.entries;
  for (const [from, to] of renames) entries = renameSymbolInEntries(entries, from, to);
  state.portfolio = { stocks, benchmark };
  state.entries = entries;
  normalizeState(state);
  persist();
  $('#settings').close();
  renderAll(true);
  refreshMarket();
  toast('Portfolio updated.', 'ok');
}

async function resetAll() {
  if (!confirm('Reset the tracker to the original worksheet data and default portfolio? Everything you logged in this browser will be replaced. Download a backup first if you need it.')) return;
  state = normalizeState(await defaultState());
  persist();
  $('#settings').close();
  renderAll(true);
  refreshMarket();
  toast('Tracker reset.');
}

// ---------------------------------------------------------------- wiring

function renderAll(reloadDraft = false) {
  renderKPIs();
  renderPerf();
  renderFocus();
  renderChart();
  if (reloadDraft || !draft) loadDraft(draft?.date || todayISO());
  else {
    renderForm();
    renderNews();
    renderSheet();
  }
}

function wire() {
  $('#entry-form').addEventListener('submit', saveDraft);
  $('#entry-date').addEventListener('change', (ev) => ev.target.value && switchDate(ev.target.value));
  $('#btn-autofill').addEventListener('click', autofill);
  $('#btn-delete').addEventListener('click', deleteDraft);
  $('#btn-copy-row').addEventListener('click', copyRow);
  $('#btn-add-source').addEventListener('click', () => {
    const url = $('#source-url').value.trim();
    addSource({ url, title: $('#source-title').value.trim(), ticker: $('#source-ticker').value });
    if (draft.sources.some((s) => s.url === url)) {
      $('#source-url').value = '';
      $('#source-title').value = '';
    }
  });
  $('#source-url').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $('#btn-add-source').click();
    }
  });
  $('#btn-refresh-news').addEventListener('click', () => refreshMarket(true));
  $('#chart-interval').addEventListener('change', (ev) => {
    state.ui.interval = ev.target.value;
    persist();
    renderChart();
  });
  $('#chart-compare').addEventListener('change', (ev) => {
    state.ui.compare = ev.target.checked;
    persist();
    renderChart();
  });
  $('#btn-xlsx').addEventListener('click', exportXlsx);
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#import-file').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) importSheet(f);
  });
  $('#btn-backup').addEventListener('click', backup);
  $('#restore-file').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) restore(f);
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#btn-settings-cancel').addEventListener('click', () => $('#settings').close());
  $('#btn-reset').addEventListener('click', resetAll);
  window.addEventListener('beforeunload', (ev) => {
    if (dirty) ev.preventDefault();
  });

  document.querySelectorAll('#perf-mode .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.ui.perfMode = b.dataset.mode;
      persist();
      renderPerf();
    }),
  );
  $('#btn-perf-png').addEventListener('click', downloadPerfPng);
  // redraw the SVG when its width changes, or when the OS switches light/dark
  let lastWidth = 0;
  let frame = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w === lastWidth) return;
    lastWidth = w;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderPerf);
  }).observe($('#perf-chart'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderPerf);
}

async function init() {
  const saved = readStore();
  state = normalizeState(saved?.portfolio && Array.isArray(saved.entries) ? saved : await defaultState());
  if (!saved) persist();
  wire();
  renderAll(true);
  refreshMarket();
}

init();
