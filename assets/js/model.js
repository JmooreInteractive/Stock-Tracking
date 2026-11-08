// Pure portfolio math, parsing and formatting helpers.
// No DOM access here, so the same code runs in the browser and in Node tests.

export const DEFAULT_PORTFOLIO = {
  stocks: [
    { symbol: 'TTWO', tvSymbol: 'NASDAQ:TTWO', investment: 4000 },
    { symbol: 'SKYD', tvSymbol: 'NYSE:SKYD', investment: 1000 },
    { symbol: 'META', tvSymbol: 'NASDAQ:META', investment: 5000 },
  ],
  benchmark: { symbol: '^GSPC', tvSymbol: 'SP:SPX', name: 'S&P 500' },
};

export const GENERAL_NOTE = 'general';

// ---------- numbers & dates ----------

/** Parse "$1,234.56", " 19.3517 ", 12.5 → number; blanks / junk → null. */
export function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** Accepts Date, Excel serial number, "M/D/YYYY" or "YYYY-MM-DD"; returns "YYYY-MM-DD" or null. */
export function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Spreadsheet libraries hand back dates as UTC midnight.
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number') {
    if (value < 20000 || value > 80000) return null; // not a plausible Excel date serial
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return parseDate(d);
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDate(year, +m[1], +m[2]);
  }
  return null;
}

function validDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** "2026-10-20" → "10/20/2026" (the worksheet's format). */
export function formatDateUS(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

export function isoToUTCDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(n) {
  return n == null ? '' : moneyFmt.format(n);
}

export function formatPct(n, digits = 2) {
  return n == null ? '' : `${(n * 100).toFixed(digits)}%`;
}

export function formatSignedPct(n, digits = 2) {
  if (n == null) return '—';
  const s = (n * 100).toFixed(digits);
  return `${n > 0 && Number(s) !== 0 ? '+' : ''}${s}%`;
}

export function formatShares(n) {
  return n == null ? '' : n.toFixed(4);
}

// ---------- portfolio math (mirrors the worksheet formulas) ----------

export function sortEntries(entries) {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Builds one computed row per entry, oldest first. The first entry is the
 * STARTING POINT: its prices and each stock's starting investment fix the share counts.
 *   Value        = Price × Shares
 *   Stock %      = Price ÷ starting Price − 1            (% change vs. day 1)
 *   S&P % CHG    = S&P ÷ previous row's S&P − 1          (day over day)
 *   Portfolio %  = Total ÷ previous row's Total − 1      (day over day)
 *   TOTAL %      = Total ÷ starting Total − 1
 */
export function computeRows(portfolio, entries) {
  const sorted = sortEntries(entries);
  if (!sorted.length) return [];
  const start = sorted[0];
  const shares = {};
  for (const s of portfolio.stocks) {
    const p = parseNumber(start.prices?.[s.symbol]);
    shares[s.symbol] = p && s.investment ? s.investment / p : null;
  }
  const startSp = parseNumber(start.sp);
  let startTotal = null;
  let prev = null;

  return sorted.map((entry, i) => {
    const stocks = portfolio.stocks.map((s) => {
      const price = parseNumber(entry.prices?.[s.symbol]);
      const startPrice = parseNumber(start.prices?.[s.symbol]);
      const sh = shares[s.symbol];
      return {
        symbol: s.symbol,
        price,
        shares: sh,
        value: price != null && sh != null ? price * sh : null,
        pctFromStart: price != null && startPrice ? price / startPrice - 1 : null,
      };
    });
    const complete = stocks.length > 0 && stocks.every((s) => s.value != null);
    const total = complete ? stocks.reduce((sum, s) => sum + s.value, 0) : null;
    if (i === 0) startTotal = total;
    const sp = parseNumber(entry.sp);
    const row = {
      entry,
      index: i,
      track: i === 0 ? 'STARTING POINT' : i,
      date: entry.date,
      stocks,
      total,
      sp,
      spDayPct: i === 0 ? (sp != null ? 0 : null) : sp != null && prev?.sp ? sp / prev.sp - 1 : null,
      spTotalPct: sp != null && startSp ? sp / startSp - 1 : null,
      dayPct: i === 0 ? (total != null ? 0 : null) : total != null && prev?.total ? total / prev.total - 1 : null,
      totalPct: total != null && startTotal ? total / startTotal - 1 : null,
      complete: complete && sp != null,
    };
    prev = row;
    return row;
  });
}

/** Rows that have every price filled in, newest last. */
export function completeRows(rows) {
  return rows.filter((r) => r.total != null);
}

// ---------- notes & sources <-> single spreadsheet cells ----------

const URL_RE = /https?:\/\/[^\s|<>"]+/g;

export function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** NOTES cell: market/general notes first, then one "TICKER: text" block per stock. */
export function notesToCell(entry, portfolio) {
  const parts = [];
  const general = entry.notes?.[GENERAL_NOTE]?.trim();
  if (general) parts.push(general);
  for (const s of portfolio.stocks) {
    const t = entry.notes?.[s.symbol]?.trim();
    if (t) parts.push(`${s.symbol}: ${t}`);
  }
  return parts.join('\n');
}

/** SOURCES cell: one "[TICKER] Title — URL" line per source. */
export function sourcesToCell(entry) {
  return (entry.sources || [])
    .map((src) => {
      const tag = src.ticker ? `[${src.ticker}] ` : '';
      const title = src.title?.trim() ? `${src.title.trim()} — ` : '';
      return `${tag}${title}${src.url}`;
    })
    .join('\n');
}

/** Reverse of notesToCell. Bare URLs found in the notes are pulled out as sources. */
export function cellToNotes(text, symbols) {
  const notes = {};
  const sources = [];
  if (!text) return { notes, sources };
  const known = new Set(symbols.map((s) => s.toUpperCase()));
  let current = GENERAL_NOTE;
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine;
    for (const url of line.match(URL_RE) || []) {
      sources.push({ title: '', url: url.replace(/[).,;]+$/, ''), ticker: current === GENERAL_NOTE ? '' : current });
    }
    line = line.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim();
    const m = line.match(/^([A-Za-z0-9^.=-]{1,12}):\s*(.*)$/);
    if (m && known.has(m[1].toUpperCase())) {
      current = m[1].toUpperCase();
      line = m[2];
    }
    if (!line) continue;
    notes[current] = notes[current] ? `${notes[current]}\n${line}` : line;
  }
  return { notes, sources };
}

/**
 * Reverse of sourcesToCell; also tolerates plain URLs separated by spaces, "|" or ";".
 * Free text typed next to a bare URL (e.g. "https://… Many companies losing money …")
 * is returned as `rest` so it can be kept as a note instead of being dropped.
 */
export function extractSources(text) {
  const sources = [];
  const rest = [];
  if (!text) return { sources, rest: '' };
  for (const line of String(text).split(/\r?\n|\s\|\s/)) {
    const m = line.trim().match(/^(?:\[([^\]]+)\]\s*)?(?:(.*?)\s+—\s+)?(https?:\/\/\S+)\s*$/);
    if (m) {
      sources.push({ ticker: (m[1] || '').trim(), title: (m[2] || '').trim(), url: m[3] });
      continue;
    }
    for (const url of line.match(URL_RE) || []) sources.push({ ticker: '', title: '', url: url.replace(/[).,;]+$/, '') });
    const leftover = line.replace(URL_RE, ' ').replace(/\s{2,}/g, ' ').trim();
    if (leftover) rest.push(leftover);
  }
  return { sources, rest: rest.join('\n') };
}

export function cellToSources(text) {
  return extractSources(text).sources;
}

// ---------- misc ----------

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function allSymbols(portfolio) {
  return [...portfolio.stocks.map((s) => s.symbol), portfolio.benchmark.symbol];
}

/** Rename a ticker everywhere it is used as a key inside entries. */
export function renameSymbolInEntries(entries, from, to) {
  if (from === to) return entries;
  return entries.map((e) => {
    const prices = { ...e.prices };
    const notes = { ...e.notes };
    if (from in prices) {
      prices[to] = prices[from];
      delete prices[from];
    }
    if (from in notes) {
      notes[to] = notes[from];
      delete notes[from];
    }
    const sources = (e.sources || []).map((s) => (s.ticker === from ? { ...s, ticker: to } : s));
    return { ...e, prices, notes, sources };
  });
}
