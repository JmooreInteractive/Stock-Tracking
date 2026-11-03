// Closing prices + Yahoo Finance headlines.
// Order of preference:
//   1. api/market   — live, when running `python3 serve.py` on your computer
//   2. data/market.json — snapshot the GitHub Action publishes with the site (weekdays)
//   3. nothing — the UI falls back to direct Yahoo Finance links
// (Browsers can't call Yahoo Finance directly: it doesn't allow cross-site requests.)

export const yahooNewsUrl = (sym) => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/news/`;
export const yahooQuoteUrl = (sym) => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/`;
export const yahooHistoryUrl = (sym) => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/history/`;
export const tradingViewUrl = (tvSymbol) => `https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol.replace(':', '-'))}/`;

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('not JSON');
  return res.json();
}

export async function loadMarketData(symbols, { refresh = false } = {}) {
  const qs = `symbols=${encodeURIComponent(symbols.join(','))}${refresh ? '&refresh=1' : ''}`;
  try {
    const data = await getJSON(`api/market?${qs}`);
    if (data?.symbols) return { mode: 'live', ...data };
  } catch {
    /* not running the local server */
  }
  try {
    const data = await getJSON(`data/market.json?t=${Date.now()}`);
    if (data?.symbols) return { mode: 'snapshot', ...data };
  } catch {
    /* no snapshot published yet */
  }
  return { mode: 'none', symbols: {} };
}

/** Official close for a ticker on a date, if the data has it. */
export function closeOn(market, symbol, isoDate) {
  return market?.symbols?.[symbol]?.closes?.[isoDate] ?? null;
}

export function newsFor(market, symbol) {
  return market?.symbols?.[symbol]?.news || [];
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const diff = Math.max(0, now - Date.parse(iso)) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
