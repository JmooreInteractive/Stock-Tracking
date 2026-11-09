import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

import { cellToNotes, cellToSources, computeRows, mergeEntries, notesToCell, parseDate, parseNumber, renameSymbolInEntries, sourcesToCell } from '../assets/js/model.js';
import { buildMatrix, buildWorkbook, parseCSV, parseWorksheet, rowAsTSV, toCSV, xlsxToMatrix } from '../assets/js/spreadsheet.js';

const worksheet = readFileSync(new URL('./fixtures/worksheet_v4.csv', import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../tracker.config.json', import.meta.url), 'utf8'));
const seed = JSON.parse(readFileSync(new URL('../data/seed-history.json', import.meta.url), 'utf8'));
const cents = (n) => Math.round(n * 100) / 100;
const pct2 = (n) => Math.round(n * 10000) / 100;

test('parses numbers and dates the way the worksheet writes them', () => {
  assert.equal(parseNumber(' $4,000.00 '), 4000);
  assert.equal(parseNumber('$694.25'), 694.25);
  assert.equal(parseNumber('(12.5)'), -12.5);
  assert.equal(parseNumber('  '), null);
  assert.equal(parseNumber('#VALUE!'), null);
  assert.equal(parseDate('10/20/2026'), '2026-10-20');
  assert.equal(parseDate('2026-11-02'), '2026-11-02');
  assert.equal(parseDate('2/30/2026'), null);
  assert.equal(parseDate(new Date(Date.UTC(2026, 10, 3))), '2026-11-03');
  assert.equal(parseDate(46329), '2026-11-03'); // Excel serial
  assert.equal(parseDate('STARTING POINT'), null);
});

test('imports the V4 worksheet CSV: portfolio, prices, notes and sources', () => {
  const { portfolio, entries } = parseWorksheet(parseCSV(worksheet));
  assert.deepEqual(portfolio.stocks.map((s) => [s.symbol, s.investment]), [['TTWO', 4000], ['SKYD', 1000], ['META', 5000]]);
  assert.equal(portfolio.stocks[0].tvSymbol, 'NASDAQ:TTWO');
  assert.equal(portfolio.benchmark.name, 'S&P 500');
  assert.equal(entries.length, 9, 'template rows without prices are skipped');
  assert.equal(entries[0].date, '2026-10-20');
  assert.deepEqual(entries[0].prices, { TTWO: 206.7, SKYD: 7.1, META: 694.25 });
  assert.equal(entries[0].sp, 8000);
  assert.equal(entries[8].date, '2026-11-02');
  assert.equal(entries[6].notes.general, 'Concerns over heavy AI spending');
  assert.equal(entries[7].notes.general, 'Many companies losing money do to quarter 3 earnings reports');
  assert.match(entries[7].sources[0].url, /^https:\/\/finance\.yahoo\.com\/markets\/article\/tech-stock-meltdown/);
});

test('calculations reproduce the worksheet values exactly', () => {
  // the V4 worksheet as handed in (S&P start 8,000), so every figure can be checked against it
  const rows = computeRows(config, parseWorksheet(parseCSV(worksheet)).entries);
  const byTrack = (t) => rows[t];
  assert.equal(rows[0].track, 'STARTING POINT');
  assert.equal(cents(rows[0].total), 10000);
  assert.equal(rows[0].stocks[0].shares.toFixed(4), '19.3517');
  assert.equal(rows[0].stocks[1].shares.toFixed(4), '140.8451');
  assert.equal(rows[0].stocks[2].shares.toFixed(4), '7.2020');
  // [track, total, S&P % (day), portfolio % (day), total %] straight from the worksheet
  const expected = [
    [1, 10121.55, -3.04, 1.22, 1.22],
    [2, 9791.69, -1.21, -3.26, -2.08],
    [3, 9745.36, -0.52, -0.47, -2.55],
    [4, 9453.28, 1.3, -3.0, -5.47],
    [5, 9284.73, 0.28, -1.78, -7.15],
    [6, 9352.91, -0.3, 0.73, -6.47],
    [7, 9229.0, -1.82, -1.32, -7.71],
    [8, 9223.76, -0.51, -0.06, -7.76],
  ];
  for (const [t, total, sp, day, all] of expected) {
    const r = byTrack(t);
    assert.equal(r.track, t);
    assert.equal(cents(r.total), total, `total, track ${t}`);
    assert.equal(pct2(r.spDayPct), sp, `S&P %, track ${t}`);
    assert.equal(pct2(r.dayPct), day, `portfolio %, track ${t}`);
    assert.equal(pct2(r.totalPct), all, `total %, track ${t}`);
  }
  assert.equal(cents(byTrack(8).stocks[0].value), 3717.46);
  assert.equal(Math.round(byTrack(8).stocks[1].pctFromStart * 100), 14);
});

test('a missing price leaves totals blank instead of erroring', () => {
  const entries = structuredClone(seed.entries);
  delete entries[3].prices.SKYD;
  const rows = computeRows(config, entries);
  assert.equal(rows[3].total, null);
  assert.equal(rows[3].dayPct, null);
  assert.equal(rows[4].dayPct, null, 'next day has no previous total to compare with');
  assert.ok(rows[4].totalPct != null);
});

test('notes and sources survive the trip through single spreadsheet cells', () => {
  const entry = {
    notes: { general: 'Rates up.\nTech weak.', TTWO: 'Earnings Thursday', META: 'Capex worries' },
    sources: [
      { ticker: 'TTWO', title: 'Take-Two preview', url: 'https://finance.yahoo.com/news/a.html' },
      { ticker: '', title: '', url: 'https://example.com/b' },
    ],
  };
  const notesCell = notesToCell(entry, config);
  assert.equal(notesCell, 'Rates up.\nTech weak.\nTTWO: Earnings Thursday\nMETA: Capex worries');
  assert.deepEqual(cellToNotes(notesCell, ['TTWO', 'SKYD', 'META']).notes, entry.notes);
  assert.deepEqual(cellToSources(sourcesToCell(entry)), entry.sources);
  assert.deepEqual(cellToSources('https://a.com/x | https://b.com/y').map((s) => s.url), ['https://a.com/x', 'https://b.com/y']);
});

test('CSV export matches the worksheet layout and re-imports losslessly', () => {
  const entries = parseWorksheet(parseCSV(worksheet)).entries;
  entries[8].notes = { general: 'Flat day, "quiet" tape', META: 'AI spend, again' };
  entries[8].sources = [{ ticker: 'META', title: 'Meta, capex', url: 'https://finance.yahoo.com/news/m.html' }];
  const matrix = buildMatrix(config, entries);
  const original = parseCSV(worksheet);
  assert.deepEqual(matrix[1].slice(0, 21), original[1].slice(0, 21), 'group header row');
  assert.deepEqual(matrix[2].slice(0, 22), original[2].slice(0, 22), 'column header row');
  assert.equal(matrix[2][22], 'SOURCES');
  assert.deepEqual(matrix[3].slice(0, 13), ['STARTING POINT', '10/20/2026', '$206.70', '19.3517', '$4,000.00', '$7.10', '140.8451', '$1,000.00', '$694.25', '7.2020', '$5,000.00', '$8,000.00', '$10,000.00']);

  const back = parseWorksheet(parseCSV(toCSV(matrix)), config);
  assert.equal(back.entries.length, entries.length);
  back.entries.forEach((e, i) => {
    assert.equal(e.date, entries[i].date);
    assert.deepEqual(e.prices, entries[i].prices);
    assert.equal(e.sp, entries[i].sp);
    assert.deepEqual(e.notes, entries[i].notes);
    assert.deepEqual(e.sources, entries[i].sources);
  });
  assert.deepEqual(back.portfolio.stocks.map((s) => s.investment), [4000, 1000, 5000]);
});

test('copied TSV row lines up with the worksheet columns', () => {
  const entries = structuredClone(seed.entries);
  entries[8].notes = { general: 'line one\nline two' };
  const cols = rowAsTSV(config, entries, entries[8].id).split('\t');
  assert.equal(cols.length, 23);
  assert.equal(cols[0], '8');
  assert.equal(cols[12], '$9,223.76'); // M: total value
  assert.equal(cols[19], '-7.76%'); // T: total portfolio %
  assert.equal(cols[21], 'line one | line two'); // V: notes, kept on one line
});

test('Excel export: live formulas with cached results, colors, and round trip', async () => {
  const wb = buildWorkbook(ExcelJS, config, seed.entries);
  const ws = wb.getWorksheet('Tracker');
  assert.equal(ws.getCell('A4').value, 'STARTING POINT');
  assert.equal(ws.getCell('E4').value, 4000);
  assert.equal(ws.getCell('D4').value.formula, 'IF(OR(C4="",E4=""),"",E4/C4)');
  assert.equal(ws.getCell('D12').value.formula, 'D$4');
  assert.equal(ws.getCell('M12').value.formula, 'IF(COUNT(E12,H12,K12)<3,"",SUM(E12,H12,K12))');
  assert.equal(cents(ws.getCell('M12').value.result), 9223.76);
  assert.equal(ws.getCell('Q12').value.formula, 'IF(OR(L12="",L11=""),"",L12/L11-1)');
  assert.equal(ws.getCell('T12').value.formula, 'IF(OR(M12="",M$4=""),"",M12/M$4-1)');
  assert.equal(ws.getCell('C12').fill.fgColor.argb, 'FFFFF2CC', 'price is a yellow input');
  assert.equal(ws.getCell('E12').fill.fgColor.argb, 'FFDDEBF7', 'value is a blue formula');
  assert.equal(ws.getCell('V2').value, null);
  assert.equal(ws.getCell('V3').value, 'NOTES');

  const buf = await wb.xlsx.writeBuffer();
  const back = parseWorksheet(await xlsxToMatrix(ExcelJS, buf), config);
  assert.equal(back.entries.length, seed.entries.length);
  assert.deepEqual(back.entries[8].prices, seed.entries[8].prices);
  assert.deepEqual(back.portfolio.stocks.map((s) => s.investment), [4000, 1000, 5000]);
});

test('imports the V41 Excel workbook (merged NOTES / Sources columns, Info & Setup sheet)', async () => {
  const buf = readFileSync(new URL('./fixtures/worksheet_v41.xlsx', import.meta.url));
  const { portfolio, entries } = parseWorksheet(await xlsxToMatrix(ExcelJS, buf), config);
  assert.deepEqual(portfolio.stocks.map((s) => [s.symbol, s.investment, s.name]), [
    ['TTWO', 4000, 'Take-Two Interactive Software'],
    ['SKYD', 1000, 'Paramount Skydance Cl B'], // 1000.0000000000001 in the sheet, rounded to cents
    ['META', 5000, 'Meta Platforms Inc'],
  ]);
  assert.deepEqual(entries.map((e) => e.date).slice(-3), ['2026-11-02', '2026-11-04', '2026-11-06']);
  assert.deepEqual(entries[10].prices, { TTWO: 214.87, SKYD: 8.01, META: 610.15 });
  assert.equal(entries[10].sp, 7376.86);
  assert.equal(entries[6].notes.general, 'Concerns over heavy AI spending');
  // a bare URL followed by a comment in the Sources cell keeps the comment as a note
  assert.equal(entries[7].notes.general, 'Many companies losing money do to quarter 3 earnings reports');
  assert.equal(entries[7].sources.length, 1);
  assert.equal(entries[9].sources.length, 6);
  assert.deepEqual(entries[9].sources.map((s) => s.ticker), ['TTWO', 'TTWO', 'SKYD', 'SKYD', 'SKYD', 'META']);
  assert.equal(entries[9].sources[0].title, 'Why Piper Sandler Thinks You Should Buy Take-Two Stock Before November 19');
  assert.deepEqual(entries.map((e) => e.date), seed.entries.map((e) => e.date), 'seed history covers the same days');
});

test('V42 workbook: researched sources added per day, real S&P start; the seed history is this file', async () => {
  const buf = readFileSync(new URL('./fixtures/worksheet_v42.xlsx', import.meta.url));
  const { entries } = parseWorksheet(await xlsxToMatrix(ExcelJS, buf), config);
  assert.equal(entries[0].sp, 7712.57, 'actual S&P 500 close on 10/20/2026');
  assert.equal(Math.round(computeRows(config, entries)[1].spDayPct * 10000) / 100, 0.58);
  assert.deepEqual(entries.map((e) => e.sources.length), [3, 4, 4, 2, 7, 2, 4, 6, 4, 9, 9]);
  // V41's own sources and notes are untouched and come first
  assert.equal(entries[9].sources[0].title, 'Why Piper Sandler Thinks You Should Buy Take-Two Stock Before November 19');
  assert.equal(entries[7].notes.general, 'Many companies losing money do to quarter 3 earnings reports');
  assert.ok(entries.every((e) => e.sources.every((s) => /^https:\/\//.test(s.url))));
  assert.ok(entries[4].sources.some((s) => s.ticker === 'TTWO' && /BofA/.test(s.title)));
  const strip = (list) => list.map(({ id, ...rest }) => rest); // eslint-disable-line no-unused-vars
  assert.deepEqual(strip(seed.entries), strip(entries));
});

test('importing merges by date and never drops what is already in the tracker', () => {
  const existing = [
    { id: 'a', date: '2026-11-04', prices: { TTWO: 1 }, sp: 1, notes: { general: 'mine', META: 'my META note' }, sources: [{ ticker: 'META', title: 'mine', url: 'https://x.test/mine' }] },
    { id: 'b', date: '2026-11-09', prices: { TTWO: 220 }, sp: 7400, notes: {}, sources: [] },
  ];
  const incoming = [
    { id: 'n1', date: '2026-11-02', prices: { TTWO: 192.1 }, sp: 7541.4, notes: {}, sources: [] },
    { id: 'n2', date: '2026-11-04', prices: { TTWO: 208.9 }, sp: 7688.62, notes: { general: 'from file' }, sources: [{ ticker: 'TTWO', title: 'file', url: 'https://x.test/file' }, { ticker: 'META', title: 'dup', url: 'https://x.test/mine' }] },
  ];
  const out = mergeEntries(existing, incoming);
  assert.deepEqual(out.map((e) => e.date), ['2026-11-02', '2026-11-04', '2026-11-09'], 'day only in the tracker (11/9) is kept');
  const nov4 = out[1];
  assert.equal(nov4.id, 'a');
  assert.deepEqual(nov4.prices, { TTWO: 208.9 }, 'prices come from the file');
  assert.equal(nov4.sp, 7688.62);
  assert.deepEqual(nov4.notes, { general: 'from file', META: 'my META note' });
  assert.deepEqual(nov4.sources.map((s) => s.url), ['https://x.test/file', 'https://x.test/mine'], 'union of sources, no duplicates');
});

test('works with a different number of stocks', async () => {
  const portfolio = { ...config, stocks: [...config.stocks, { symbol: 'NVDA', tvSymbol: 'NASDAQ:NVDA', investment: 2500 }] };
  const entries = [
    { id: 'a', date: '2026-11-02', prices: { TTWO: 200, SKYD: 8, META: 600, NVDA: 250 }, sp: 7500, notes: {}, sources: [] },
    { id: 'b', date: '2026-11-03', prices: { TTWO: 210, SKYD: 8, META: 600, NVDA: 275 }, sp: 7600, notes: { NVDA: 'Beat' }, sources: [] },
  ];
  const rows = computeRows(portfolio, entries);
  assert.equal(cents(rows[1].total), 4000 * 1.05 + 1000 + 5000 + 2500 * 1.1);
  const back = parseWorksheet(parseCSV(toCSV(buildMatrix(portfolio, entries))), portfolio);
  assert.deepEqual(back.portfolio.stocks.map((s) => s.symbol), ['TTWO', 'SKYD', 'META', 'NVDA']);
  assert.equal(back.entries[1].notes.NVDA, 'Beat');
  const wb = buildWorkbook(ExcelJS, portfolio, entries);
  assert.match(wb.getWorksheet('Tracker').getCell('P5').value.formula, /COUNT\(E5,H5,K5,N5\)<4/);
});

test('renaming a ticker carries its prices, notes and sources along', () => {
  const out = renameSymbolInEntries(
    [{ id: 'x', date: '2026-11-03', prices: { SKYD: 8 }, notes: { SKYD: 'n' }, sources: [{ ticker: 'SKYD', url: 'https://a.b' }] }],
    'SKYD',
    'PSKY',
  );
  assert.deepEqual(out[0].prices, { PSKY: 8 });
  assert.deepEqual(out[0].notes, { PSKY: 'n' });
  assert.equal(out[0].sources[0].ticker, 'PSKY');
});
