/**
 * "Day View": a tab with a day dropdown (cell B1) that shows just that day of the Schedule tab.
 *
 * Everything is formulas, so picking another day in the dropdown updates the table instantly, inside
 * Google Sheets. Because the Schedule tab stores a shift as a merged cell (the name only in its first row),
 * the view first expands every shift over all the rows it covers (using its post's shift length, like the
 * live checks do) and then shows the rows of the chosen day. A night shift that started the evening before
 * therefore still appears at the top of the next day.
 *
 * Layout (1-based rows):
 *   1        A1 "Day"  B1 <the dropdown>   D1 first row of the day   F1 number of rows
 *   3-4      headers copied from the Schedule tab
 *   5..      the chosen day (up to M rows)
 *   below    hidden helper layers: day key per Schedule row, shift position, who is on duty
 *   right    the list of days that feeds the dropdown (UNIQUE of the day keys)
 *
 * The expansion uses shift lengths baked in when the tab is written, so it is regenerated on every save
 * and by "Check schedule".
 */
import { colLetter } from '../lib/sheetModel';
import { planLiveChecks, FIRST_ROW } from './liveChecks';

export const DAY_TAB = 'Day View';
export const DAY_MAX_ROWS = 1500;
export const OUT_FIRST_ROW = 5; // first output row

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The key of a day: "yyyy-mm-dd". Unlike "03/11/2025" it means the same day in every spreadsheet locale, which
 * matters because Google Sheets turns a date-like text picked in the dropdown into a real date.
 */
export const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** A spreadsheet date serial (days since 1899-12-30) as a day key. */
export function serialToKey(n) {
  const d = new Date(Math.round((n - 25569) * 86400000));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Convert the text of a Schedule "Date" cell (dd/MM/yyyy as written by the app, or already ISO) to a day key. */
export function dayKeyFromText(text) {
  const t = String(text ?? '').trim();
  if (t.length === 10 && t[2] === '/') return `${t.slice(6)}-${t.slice(3, 5)}-${t.slice(0, 2)}`;
  return t;
}

/**
 * The calendar day of every Schedule row (the Date column is only filled in the first row of a day).
 * Mirrors the sheet formula: dd/MM/yyyy text becomes a yyyy-mm-dd key; a real date (number) is formatted by the sheet.
 */
export function rowDays(grid, first, last) {
  const out = [];
  let current = '';
  for (let s = first; s <= last; s++) {
    const raw = grid[s - 1]?.[0];
    const text = raw === undefined || raw === null ? '' : typeof raw === 'number' ? serialToKey(raw) : dayKeyFromText(raw);
    if (text) current = text;
    out.push(current);
  }
  return out;
}

/** Plan the Day View for a Schedule grid; null when there is nothing to show. */
export function planDayView(grid, posts) {
  const plan = planLiveChecks(grid, posts, { maxRows: DAY_MAX_ROWS });
  if (!plan) return null;
  // Start the window on the first row of a day, so every row in it has a day.
  let first = plan.firstRow;
  while (first < plan.lastRow && !String(grid[first - 1]?.[0] ?? '').trim()) first += 1;
  const days = rowDays(grid, first, plan.lastRow);
  const counts = new Map();
  days.forEach((d) => { if (d) counts.set(d, (counts.get(d) || 0) + 1); });
  const dayList = [...counts.keys()];
  if (!dayList.length) return null;
  const maxPerDay = Math.max(...counts.values());
  const outRows = Math.min(Math.max(maxPerDay + 6, 12), 400);
  const rows = plan.lastRow - first + 1;
  const base = OUT_FIRST_ROW + outRows + 5; // first helper row
  return { ...plan, first, rows, dayList, outRows, base };
}

/** Row numbers of the three hidden helper layers for Schedule row s. */
export const layerRows = (p) => ({
  key: (s) => p.base + (s - p.first),
  pos: (s) => p.base + p.rows + 2 + (s - p.first),
  who: (s) => p.base + 2 * (p.rows + 2) + (s - p.first),
});

export const daysColumn = (p) => Math.max(...p.columns.map((c) => c.index)) + 3; // 0-based index of the day list column

/**
 * The cells of the Day View tab as a 2D array of strings (formulas start with "=").
 * `selected` is the day written into B1.
 */
export function buildDayViewCells(p, scheduleTitle, selected) {
  const sched = q(scheduleTitle);
  const L = layerRows(p);
  const lastS = p.lastRow;
  const width = Math.max(...p.columns.map((c) => c.index)) + 1;
  const dcol = daysColumn(p);
  const height = L.who(lastS);
  const cells = Array.from({ length: height }, () => Array(Math.max(width, dcol + 1)).fill(''));
  const set = (row1, col, v) => { cells[row1 - 1][col] = v; };

  const KEY = `$A$${L.key(p.first)}:$A$${L.key(lastS)}`;

  set(1, 0, 'Day');
  set(1, 1, selected);
  set(1, 2, 'starts at row #');
  set(1, 3, `=IFERROR(MATCH($H$1,${KEY},0),0)`);
  set(1, 4, 'rows');
  set(1, 5, `=COUNTIF(${KEY},$H$1)`);
  // B1 may hold text or a real date (Google Sheets converts a date-like pick); H1 is its yyyy-mm-dd key
  set(1, 6, 'key');
  set(1, 7, '=IF(ISNUMBER($B$1),TEXT($B$1,"yyyy-mm-dd"),TRIM($B$1))');

  // headers (copied from the Schedule tab)
  set(3, 0, 'Date');
  set(3, 1, 'Time');
  for (const col of p.columns) {
    set(3, col.index, `=IF(LEN(${sched}!${col.letter}1)=0,"",${sched}!${col.letter}1)`);
    set(4, col.index, `=IF(LEN(${sched}!${col.letter}2)=0,"",${sched}!${col.letter}2)`);
  }

  // the chosen day
  const whoRange = (letter) => `$${letter}$${L.who(p.first)}:$${letter}$${L.who(lastS)}`;
  for (let i = 1; i <= p.outRows; i++) {
    const r = OUT_FIRST_ROW + i - 1;
    set(r, 0, `=IF(${i}>$F$1,"",$H$1)`);
    set(r, 1, `=IF(${i}>$F$1,"",INDEX(${sched}!$B$${p.first}:$B$${lastS},$D$1+${i}-1))`);
    for (const col of p.columns) set(r, col.index, `=IF(${i}>$F$1,"",INDEX(${whoRange(col.letter)},$D$1+${i}-1))`);
  }

  // the list of days for the dropdown
  set(3, dcol, 'Days');
  set(4, dcol, `=IFERROR(UNIQUE(FILTER(${KEY},${KEY}<>"")),"")`);

  // hidden helper layers
  set(L.key(p.first) - 1, 0, 'Helper layers (hidden): day of each Schedule row, position within a shift, who is on duty.');
  for (let s = p.first; s <= lastS; s++) {
    const a = `${sched}!A${s}`;
    const t = `TRIM(${a})`;
    const day = `IF(ISNUMBER(${a}),TEXT(${a},"yyyy-mm-dd"),IF(AND(LEN(${t})=10,MID(${t},3,1)="/"),RIGHT(${t},4)&"-"&MID(${t},4,2)&"-"&LEFT(${t},2),${t}))`;
    set(L.key(s), 0, s === p.first ? `=IF(LEN(TRIM(${a}))>0,${day},"")` : `=IF(LEN(TRIM(${a}))>0,${day},A${L.key(s - 1)})`);
    for (const col of p.columns) {
      const S = `${sched}!${col.letter}${s}`;
      const filled = `LEN(TRIM(${S}))>0`;
      const prev = `${col.letter}${L.pos(s - 1)}`;
      set(L.pos(s), col.index, s === p.first || col.n <= 1
        ? `=IF(${filled},1,0)`
        : `=IF(${filled},1,IF(AND(${prev}>0,${prev}<${col.n}),${prev}+1,0))`);
      set(L.who(s), col.index, s === p.first
        ? `=IF(${filled},TRIM(${S}),"")`
        : `=IF(${col.letter}${L.pos(s)}=0,"",IF(${filled},TRIM(${S}),${col.letter}${L.who(s - 1)}))`);
    }
  }
  return cells;
}

/** Approximate payload size, to refuse absurdly large schedules. */
export function dayViewSize(cells) {
  let n = 0;
  for (const row of cells) for (const v of row) n += v.length + 20;
  return n;
}

export { colLetter, FIRST_ROW };
