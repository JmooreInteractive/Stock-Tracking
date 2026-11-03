// Reading and writing the tracker worksheet (CSV, TSV and Excel).
// The layout mirrors STOCK_TRACKER_WORKSHEET_V4 ("Tracker" tab): three header rows,
// a STARTING POINT row, then one row per logged day, with a NOTES column (and SOURCES next to it).

import {
  DEFAULT_PORTFOLIO,
  GENERAL_NOTE,
  cellToNotes,
  cellToSources,
  computeRows,
  formatDateUS,
  formatMoney,
  formatPct,
  formatShares,
  isoToUTCDate,
  notesToCell,
  parseDate,
  parseNumber,
  sourcesToCell,
  uid,
} from './model.js';

export const SHEET_NAME = 'Tracker';
export const TITLE = 'Stock Tracker  |  Record closing prices MWF. Yellow = enter data. Blue = auto-calculated.';
export const LEGEND = [
  'YELLOW cells = you fill these in (enter data here)',
  'BLUE cells = automatic calculations (do not edit)',
];
const FIRST_DATA_ROW = 4; // 1-based worksheet row of STARTING POINT

/** Column numbers (1-based) for a portfolio of n stocks. With 3 stocks this is exactly A…V of the worksheet, plus W for sources. */
export function sheetLayout(n) {
  const c = {
    track: 1,
    date: 2,
    price: (i) => 3 + 3 * i,
    shares: (i) => 4 + 3 * i,
    value: (i) => 5 + 3 * i,
  };
  c.sp = 3 + 3 * n;
  c.total = c.sp + 1;
  c.pct = (i) => c.total + 1 + i;
  c.spPct = c.total + n + 1;
  c.dayPct = c.spPct + 1;
  c.totalPct = c.dayPct + 2; // one spacer column before it, like the worksheet
  c.notes = c.totalPct + 2; // and one spacer after it
  c.sources = c.notes + 1;
  c.last = c.sources;
  return c;
}

export function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function headerRows(portfolio) {
  const n = portfolio.stocks.length;
  const L = sheetLayout(n);
  const groups = new Array(L.last).fill('');
  const heads = new Array(L.last).fill('');
  groups[L.track - 1] = 'DATE';
  heads[L.track - 1] = 'Track';
  heads[L.date - 1] = 'Date';
  portfolio.stocks.forEach((s, i) => {
    groups[L.price(i) - 1] = s.symbol;
    heads[L.price(i) - 1] = 'Price';
    heads[L.shares(i) - 1] = 'Shares';
    heads[L.value(i) - 1] = 'Value ($)';
    heads[L.pct(i) - 1] = `Stock ${i + 1} %`;
  });
  groups[L.sp - 1] = portfolio.benchmark.name || 'S&P 500';
  heads[L.sp - 1] = 'S&P Price';
  groups[L.total - 1] = 'PORTFOLIO TOTAL';
  heads[L.total - 1] = 'Total Value ($)';
  groups[L.pct(0) - 1] = '% CHANGE VS. DAY 1';
  groups[L.spPct - 1] = 'S&P % CHG';
  heads[L.spPct - 1] = 'S&P %';
  groups[L.dayPct - 1] = 'PORTFOLIO % CHG';
  heads[L.dayPct - 1] = 'Portfolio %';
  groups[L.totalPct - 1] = 'TOTAL PORTFOLIO % CHG';
  heads[L.totalPct - 1] = 'TOTAL Portfolio %';
  heads[L.notes - 1] = 'NOTES';
  heads[L.sources - 1] = 'SOURCES';
  return { groups, heads, L };
}

// ---------- plain-text exports (CSV / TSV) ----------

/** The worksheet as a 2-D array of display strings (what a CSV export of the sheet looks like). */
export function buildMatrix(portfolio, entries) {
  const { groups, heads, L } = headerRows(portfolio);
  const rows = computeRows(portfolio, entries);
  const out = [[TITLE, ...new Array(L.last - 1).fill('')], groups, heads];
  for (const r of rows) out.push(rowValues(portfolio, r, L));
  out.push(new Array(L.last).fill(''));
  for (const line of LEGEND) out.push([line, ...new Array(L.last - 1).fill('')]);
  return out;
}

function rowValues(portfolio, r, L) {
  const v = new Array(L.last).fill('');
  v[L.track - 1] = String(r.track);
  v[L.date - 1] = formatDateUS(r.date);
  r.stocks.forEach((s, i) => {
    v[L.price(i) - 1] = formatMoney(s.price);
    v[L.shares(i) - 1] = formatShares(s.shares);
    v[L.value(i) - 1] = formatMoney(s.value);
    v[L.pct(i) - 1] = formatPct(s.pctFromStart);
  });
  v[L.sp - 1] = formatMoney(r.sp);
  v[L.total - 1] = formatMoney(r.total);
  v[L.spPct - 1] = formatPct(r.spDayPct);
  v[L.dayPct - 1] = formatPct(r.dayPct);
  v[L.totalPct - 1] = formatPct(r.totalPct);
  v[L.notes - 1] = notesToCell(r.entry, portfolio);
  v[L.sources - 1] = sourcesToCell(r.entry);
  return v;
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(matrix) {
  return matrix.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One tracker row, tab-separated, ready to paste into the matching row of an existing sheet. */
export function rowAsTSV(portfolio, entries, entryId) {
  const { L } = headerRows(portfolio);
  const row = computeRows(portfolio, entries).find((r) => r.entry.id === entryId);
  if (!row) return '';
  return rowValues(portfolio, row, L)
    .map((s) => s.replace(/\t/g, ' ').replace(/\r?\n/g, ' | '))
    .join('\t');
}

/** RFC 4180 CSV parser (quoted fields, doubled quotes, embedded newlines, CRLF). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------- import ----------

const text = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v)).trim();

/**
 * Reads a tracker worksheet (as a 2-D array of cell values from CSV or Excel) back into
 * { portfolio, entries }. Columns are located by their headers, so the original 3-stock
 * sheet, this app's own export, or a sheet with more stocks all work.
 */
export function parseWorksheet(matrix, current = DEFAULT_PORTFOLIO) {
  const h = matrix.findIndex((row) => {
    const lower = (row || []).map((v) => text(v).toLowerCase());
    return lower.includes('track') && lower.includes('date') && lower.includes('price');
  });
  if (h < 0) throw new Error('Could not find the header row (Track | Date | Price …) in that file.');
  const lower = matrix[h].map((v) => text(v).toLowerCase());
  const groups = (matrix[h - 1] || []).map(text);
  const dateCol = lower.indexOf('date');
  const spCol = lower.findIndex((v) => v.includes('s&p') && v.includes('price'));
  const notesCol = lower.indexOf('notes');
  const sourcesCol = lower.indexOf('sources');

  const cols = [];
  lower.forEach((v, c) => {
    if (v !== 'price') return;
    const symbol = (groups[c] || groups[c - 1] || `STOCK${cols.length + 1}`).toUpperCase().replace(/\s+/g, '');
    cols.push({
      symbol,
      price: c,
      shares: lower[c + 1]?.startsWith('share') ? c + 1 : -1,
      value: lower[c + 2]?.startsWith('value') ? c + 2 : -1,
    });
  });
  if (!cols.length) throw new Error('No "Price" columns found under the ticker headings.');
  const symbols = cols.map((c) => c.symbol);

  const byDate = new Map();
  const startCells = new Map();
  for (let r = h + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const date = parseDate(row[dateCol]);
    if (!date) continue;
    const prices = {};
    for (const c of cols) {
      const p = parseNumber(row[c.price]);
      if (p != null) prices[c.symbol] = p;
    }
    const sp = spCol >= 0 ? parseNumber(row[spCol]) : null;
    const { notes, sources } = cellToNotes(notesCol >= 0 ? text(row[notesCol]) : '', symbols);
    if (sourcesCol >= 0) sources.push(...cellToSources(text(row[sourcesCol])));
    if (!Object.keys(prices).length && sp == null && !Object.keys(notes).length && !sources.length) continue;
    byDate.set(date, { id: uid(), date, prices, sp, notes, sources: dedupeSources(sources) });
    startCells.set(date, row);
  }
  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) throw new Error('Found the tracker headers but no rows with a date and prices.');

  const startRow = startCells.get(entries[0].date);
  const stocks = cols.map((c) => {
    const existing = current.stocks.find((s) => s.symbol === c.symbol);
    const price = parseNumber(startRow[c.price]);
    let investment = c.value >= 0 ? parseNumber(startRow[c.value]) : null;
    if (investment == null && c.shares >= 0 && price != null) {
      const sh = parseNumber(startRow[c.shares]);
      if (sh != null) investment = Math.round(sh * price * 100) / 100;
    }
    return {
      symbol: c.symbol,
      tvSymbol: existing?.tvSymbol || c.symbol,
      investment: investment ?? existing?.investment ?? 1000,
    };
  });
  const benchmark = { ...current.benchmark };
  if (spCol >= 0 && groups[spCol]) benchmark.name = groups[spCol];
  return { portfolio: { stocks, benchmark }, entries };
}

function dedupeSources(list) {
  const seen = new Set();
  return list.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ---------- Excel ----------

const FILL_INPUT = 'FFFFF2CC'; // yellow — you enter these
const FILL_CALC = 'FFDDEBF7'; // blue — formulas
const FILL_HEAD = 'FF1F3864';
const FMT_MONEY = '"$"#,##0.00';
const FMT_PCT = '0.00%';

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

/**
 * Builds the worksheet with live formulas in every blue cell (with cached results, so it
 * also reads correctly in viewers that don't recalculate). Pass the ExcelJS module in.
 */
export function buildWorkbook(ExcelJS, portfolio, entries) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stock Tracker';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }] });
  const { groups, heads, L } = headerRows(portfolio);
  const n = portfolio.stocks.length;
  const A = colLetter;
  const S = FIRST_DATA_ROW;

  ws.getCell(1, 1).value = TITLE;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  groups.forEach((g, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = g || null;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = solid(FILL_HEAD);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  heads.forEach((t, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = t || null;
    cell.font = { bold: true };
    cell.fill = solid('FFD9D9D9');
    cell.border = BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  portfolio.stocks.forEach((_, i) => ws.mergeCells(2, L.price(i), 2, L.value(i)));
  if (n > 1) ws.mergeCells(2, L.pct(0), 2, L.pct(n - 1));
  ws.mergeCells(2, L.track, 2, L.date);
  ws.getRow(2).height = 30;

  const rows = computeRows(portfolio, entries);
  const res = (v) => (v == null ? '' : v);
  rows.forEach((r, idx) => {
    const R = S + idx;
    const first = idx === 0;
    const set = (col, value, kind, numFmt) => {
      const cell = ws.getCell(R, col);
      cell.value = value;
      cell.fill = solid(kind === 'input' ? FILL_INPUT : FILL_CALC);
      cell.border = BORDER;
      if (numFmt) cell.numFmt = numFmt;
      return cell;
    };
    set(L.track, r.track, 'calc').alignment = { horizontal: 'left' };
    set(L.date, isoToUTCDate(r.date), 'input', 'm/d/yyyy');

    r.stocks.forEach((s, i) => {
      const P = `${A(L.price(i))}${R}`;
      const D = `${A(L.shares(i))}${R}`;
      set(L.price(i), s.price ?? null, 'input', FMT_MONEY);
      if (first) {
        const inv = portfolio.stocks[i].investment;
        set(L.value(i), inv ?? null, 'input', FMT_MONEY);
        set(L.shares(i), { formula: `IF(OR(${P}="",${A(L.value(i))}${R}=""),"",${A(L.value(i))}${R}/${P})`, result: res(s.shares) }, 'calc', '0.0000');
      } else {
        set(L.shares(i), { formula: `${A(L.shares(i))}$${S}`, result: res(s.shares) }, 'calc', '0.0000');
        set(L.value(i), { formula: `IF(${P}="","",${P}*${D})`, result: res(s.value) }, 'calc', FMT_MONEY);
      }
      const P0 = `${A(L.price(i))}$${S}`;
      set(L.pct(i), { formula: `IF(OR(${P}="",${P0}=""),"",${P}/${P0}-1)`, result: res(s.pctFromStart) }, 'calc', FMT_PCT);
    });

    const valueRefs = portfolio.stocks.map((_, i) => `${A(L.value(i))}${R}`).join(',');
    const M = `${A(L.total)}${R}`;
    const Mprev = `${A(L.total)}${R - 1}`;
    const SP = `${A(L.sp)}${R}`;
    const SPprev = `${A(L.sp)}${R - 1}`;
    set(L.sp, r.sp ?? null, 'input', FMT_MONEY);
    set(L.total, { formula: `IF(COUNT(${valueRefs})<${n},"",SUM(${valueRefs}))`, result: res(r.total) }, 'calc', FMT_MONEY);
    if (first) {
      set(L.spPct, { formula: `IF(${SP}="","",0)`, result: res(r.spDayPct) }, 'calc', FMT_PCT);
      set(L.dayPct, { formula: `IF(${M}="","",0)`, result: res(r.dayPct) }, 'calc', FMT_PCT);
    } else {
      set(L.spPct, { formula: `IF(OR(${SP}="",${SPprev}=""),"",${SP}/${SPprev}-1)`, result: res(r.spDayPct) }, 'calc', FMT_PCT);
      set(L.dayPct, { formula: `IF(OR(${M}="",${Mprev}=""),"",${M}/${Mprev}-1)`, result: res(r.dayPct) }, 'calc', FMT_PCT);
    }
    const M0 = `${A(L.total)}$${S}`;
    set(L.totalPct, { formula: `IF(OR(${M}="",${M0}=""),"",${M}/${M0}-1)`, result: res(r.totalPct) }, 'calc', FMT_PCT);
    const notes = notesToCell(r.entry, portfolio);
    const sources = sourcesToCell(r.entry);
    set(L.notes, notes || null, 'input').alignment = { wrapText: true, vertical: 'top' };
    set(L.sources, sources || null, 'input').alignment = { wrapText: true, vertical: 'top' };
  });

  const legendRow = S + rows.length + 1;
  LEGEND.forEach((line, i) => {
    const cell = ws.getCell(legendRow + i, 1);
    cell.value = line;
    cell.fill = solid(i === 0 ? FILL_INPUT : FILL_CALC);
    cell.font = { bold: true };
  });

  const widths = { [L.track]: 17, [L.date]: 11, [L.sp]: 12, [L.total]: 15, [L.notes]: 60, [L.sources]: 70 };
  portfolio.stocks.forEach((_, i) => {
    widths[L.price(i)] = 11;
    widths[L.shares(i)] = 10;
    widths[L.value(i)] = 13;
    widths[L.pct(i)] = 11;
  });
  for (let c = 1; c <= L.last; c++) ws.getColumn(c).width = widths[c] ?? (c === L.totalPct - 1 || c === L.totalPct + 1 ? 3 : 13);
  return wb;
}

/** Converts an Excel workbook to a 2-D array for parseWorksheet (first sheet that looks like a tracker). */
export async function xlsxToMatrix(ExcelJS, arrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  const plain = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) return plain(v.result);
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
      if ('text' in v) return plain(v.text);
      if ('hyperlink' in v) return v.hyperlink;
      return '';
    }
    return v;
  };
  let fallback = null;
  for (const ws of wb.worksheets) {
    const m = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const arr = [];
      for (let c = 1; c <= Math.max(ws.columnCount, row.cellCount); c++) arr.push(plain(row.getCell(c).value));
      m.push(arr);
    }
    fallback ??= m;
    if (m.some((row) => row.some((v) => text(v).toLowerCase() === 'track'))) return m;
  }
  return fallback || [];
}

export { GENERAL_NOTE };
