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
// Two formulas per column per row (position, who) plus one per row: keep the Day View's helper layers within this many.
export const DAY_FORMULA_BUDGET = 12000;
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

export const MAX_JUMP_DAYS = 366;

/**
 * Every day of the Schedule tab with its rows: [{ day, startRow, endRow }] (1-based sheet rows), in order.
 * Used for the jump links and the Name Box shortcuts, so it covers the whole tab, not just the Day View window.
 */
export function dayRanges(grid) {
  const lastRow = grid.length;
  if (lastRow < FIRST_ROW) return [];
  const days = rowDays(grid, FIRST_ROW, lastRow);
  const out = [];
  days.forEach((day, i) => {
    if (!day) return;
    const s = FIRST_ROW + i;
    const last = out[out.length - 1];
    if (last && last.day === day) last.endRow = s;
    else out.push({ day, startRow: s, endRow: s });
  });
  return out;
}

/** The Name Box shortcut for a day: Day_2025_03_10 */
export const dayName = (day) => `Day_${String(day).replace(/[^A-Za-z0-9]/g, '_')}`;

/** Plan the Day View for a Schedule grid; null when there is nothing to show. */
export function planDayView(grid, posts) {
  const wide = planLiveChecks(grid, posts, { maxRows: DAY_MAX_ROWS });
  if (!wide) return null;
  const plan = planLiveChecks(grid, posts, { maxRows: Math.max(24, Math.min(DAY_MAX_ROWS, Math.floor(DAY_FORMULA_BUDGET / (2 * wide.columns.length + 1)))) });
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

export const daysColumn = (p) => Math.max(...p.columns.map((c) => c.index)) + 3; // 0-based index of the day list column (the clickable list is two columns further)

/**
 * The cells of the Day View tab as a 2D array of strings (formulas start with "=").
 * `selected` is the day written into B1.
 */
export function buildDayViewCells(p, scheduleTitle, selected, scheduleGid = null, jumpDays = []) {
  const sched = q(scheduleTitle);
  const L = layerRows(p);
  const lastS = p.lastRow;
  const width = Math.max(...p.columns.map((c) => c.index)) + 1;
  const dcol = daysColumn(p);
  const height = L.who(lastS);
  const height2 = Math.max(height, 4 + Math.min(jumpDays.length, MAX_JUMP_DAYS));
  const cells = Array.from({ length: height2 }, () => Array(Math.max(width, dcol + 3)).fill(''));
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

  // jump to the chosen day in the Schedule tab (to edit it there)
  if (scheduleGid !== null) {
    set(2, 1, `=IF($D$1=0,"",HYPERLINK("#gid=${scheduleGid}&range=A"&(${p.first}+$D$1-1),"Open "&$H$1&" in the Schedule tab ▸"))`);
  }

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

  // a clickable list of every day: one click jumps to that day in the Schedule tab
  if (scheduleGid !== null) {
    set(3, dcol + 2, 'Jump to a day');
    jumpDays.slice(-MAX_JUMP_DAYS).forEach((d, i) => {
      set(4 + i, dcol + 2, `=HYPERLINK("#gid=${scheduleGid}&range=A${d.startRow}","${d.day}")`);
    });
  }

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
