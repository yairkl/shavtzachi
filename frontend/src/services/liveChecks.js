/**
 * Live double-booking and cooldown checks for the Schedule tab, done with spreadsheet formulas.
 *
 * Why a helper tab: in the Schedule tab a shift is a merged cell and the name is stored only in its
 * top-left cell, so a formula looking at a row cannot see a 24h shift that started rows earlier.
 * The helper tab ("Schedule Check") expands every shift over all the rows it covers, using the shift
 * length of its post (so a 24h post and a 4h post are compared correctly), and then flags problems:
 *
 *   D  the person is on another post at the same time (double booked)
 *   C  the person has less rest than a cooldown allows: another shift starts within this post's cooldown after
 *      this one ends, or an earlier shift ended less than ITS post's cooldown before this one starts
 *
 * It has three layers, stacked with the same column letters as the Schedule tab:
 *   rows s            POSITION  1..n  = which row of its shift this row is (0 = nobody)
 *   rows s + O        WHO       the person on duty in that row
 *   rows s + 2*O      FLAGS     "", "D" or "C" - only on the first row of a shift (D wins over C)
 * where s is the Schedule row and O the layer offset. The Schedule tab shows the flags through
 * conditional formatting (red = D, amber = C only).
 *
 * Shift lengths, cooldowns and the row duration are baked into the formulas when they are written.
 * The cells react live to edits of names in the Schedule tab; if you change a post's shift length or
 * cooldown, or add rows/columns, press "Check schedule" (or save in the app) to regenerate.
 */
import { colLetter, normalizeKey, parseTime, timeToMinutes } from '../lib/sheetModel';
import { mapScheduleColumns } from './gsheetsUtils';

export const CHECK_TAB = 'Schedule Check';
export const FIRST_ROW = 3; // first data row of the Schedule tab (1-based)
const MAX_FORMULA_CHARS = 5_000_000; // keep one request comfortably below Google's payload limits
// The Schedule tab keeps every saved day. Only the most recent rows get live checks (about two weeks of hourly
// rows); older days are still covered by "Check schedule".
export const MAX_ROWS = 336;
// Speed: every checked cell costs about three formulas (position, who, flags). Beyond this many formulas the spreadsheet
// gets noticeably slow (especially in the phone app), so wide schedules check fewer of the most recent rows.
export const FORMULA_BUDGET = 9000;

/** How many of the most recent rows can be checked live for this many Schedule columns. */
export const rowsForBudget = (columnCount, budget = FORMULA_BUDGET, cap = MAX_ROWS) =>
  Math.max(24, Math.min(cap, Math.floor(budget / (3 * Math.max(1, columnCount)))));

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

/** Minutes covered by one row, from the Time column ("06:00 - 10:00"). */
export function rowMinutes(grid) {
  for (let r = 2; r < grid.length; r++) {
    const label = String(grid[r]?.[1] ?? '');
    if (label.includes(' - ')) {
      const [a, b] = label.split(' - ');
      const sm = timeToMinutes(parseTime(a));
      const em = timeToMinutes(parseTime(b));
      if (sm !== null && em !== null) return ((em - sm) + 24 * 60) % (24 * 60) || 24 * 60;
    }
  }
  return 60;
}

/**
 * Work out, per Schedule column, how many rows a shift covers (n) and how many rows of rest are
 * required (k). Returns null when there is nothing to check.
 */
export function planLiveChecks(grid, posts, { maxRows = null, budget = FORMULA_BUDGET } = {}) {
  if (!grid || grid.length < FIRST_ROW) return null;
  const colToPost = mapScheduleColumns(grid);
  const indexes = Object.keys(colToPost).map(Number).sort((a, b) => a - b);
  if (!indexes.length) return null;
  const step = rowMinutes(grid);
  const lastRow = grid.length; // last data row, 1-based
  const byName = new Map(posts.map((p) => [normalizeKey(p.name), p]));

  const columns = indexes.map((index) => {
    const info = colToPost[index];
    const post = byName.get(normalizeKey(info.name));
    const n = post ? Math.max(1, Math.round((post.shift_length_hours * 60) / step)) : 1;
    const k = post ? Math.max(0, Math.ceil((post.cooldown_hours * 60) / step - 1e-9)) : 0;
    return { index, letter: colLetter(index), post: info.name, role: info.role_id, n, k };
  });
  const rows = lastRow - FIRST_ROW + 1;
  const limit = maxRows ?? rowsForBudget(columns.length, budget);
  const firstRow = Math.max(FIRST_ROW, lastRow - limit + 1);
  return { columns, rows, lastRow, firstRow, step, offset: rows + 3 };
}

/** The Schedule columns are not necessarily contiguous (a column without a header is skipped). */
function runs(cols) {
  const out = [];
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && c.index === last[last.length - 1].index + 1) last.push(c); else out.push([c]);
  }
  return out;
}

/**
 * Build the helper tab's cells: a 2D array of strings (formulas and labels), row 1 first.
 * `scheduleTitle` is the real title of the Schedule tab.
 */
export function buildLiveCheckCells(plan, scheduleTitle) {
  const { columns, lastRow, offset: O, firstRow: first } = plan;
  const sched = q(scheduleTitle);
  const heightRows = FIRST_ROW + 2 * O + plan.rows; // last row used by the FLAGS layer
  const width = Math.max(...columns.map((c) => c.index)) + 1;
  const cells = Array.from({ length: heightRows }, () => Array(width).fill(''));
  const set = (row1, colIdx, v) => { cells[row1 - 1][colIdx] = v; };

  set(1, 0, 'Generated by Shavtzachi from the Schedule tab - do not edit. Positions, then who is on duty, then problems (D = double-booked, C = cooldown).');
  set(first, 0, 'Row of the shift');
  set(first + O, 0, 'Who is on duty');
  set(first + 2 * O, 0, 'Problems (D, C)');
  if (first > FIRST_ROW) set(2, 0, `Only schedule rows ${first} to ${lastRow} (the most recent) are checked live; use "Check schedule" for older days.`);

  const byIndex = new Map(columns.map((c) => [c.index, c]));
  const colRuns = runs(columns);

  for (const col of columns) {
    const L = col.letter;
    for (let s = first; s <= lastRow; s++) {
      const S = `${sched}!${L}${s}`;
      const filled = `LEN(TRIM(${S}))>0`;

      // POSITION
      const prev = `${L}${s - 1}`;
      set(s, col.index, s === first || col.n <= 1
        ? `=IF(${filled},1,0)`
        : `=IF(${filled},1,IF(AND(${prev}>0,${prev}<${col.n}),${prev}+1,0))`);

      // WHO
      set(s + O, col.index, s === first
        ? `=IF(${filled},TRIM(${S}),"")`
        : `=IF(${L}${s}=0,"",IF(${filled},TRIM(${S}),${L}${s - 1 + O}))`);

      // FLAGS (only on the first row of a shift)
      const e1 = Math.min(s + col.n - 1, lastRow);
      const rect = (c1, c2, r1, r2) => `$${colLetter(c1)}$${r1 + O}:$${colLetter(c2)}$${r2 + O}`;
      const name = `TRIM(${S})`;

      // double booking: the name in any OTHER column during any row of this shift
      const dbl = [];
      for (const run of colRuns) {
        const lo = run[0].index; const hi = run[run.length - 1].index;
        if (col.index < lo || col.index > hi) {
          dbl.push(`COUNTIF(${rect(lo, hi, s, e1)},${name})`);
        } else {
          if (col.index > lo) dbl.push(`COUNTIF(${rect(lo, col.index - 1, s, e1)},${name})`);
          if (col.index < hi) dbl.push(`COUNTIF(${rect(col.index + 1, hi, s, e1)},${name})`);
        }
      }

      // Cooldown = rest needed after finishing a shift of a post. A shift is flagged when the same person
      //  - starts another shift within THIS post's cooldown after it ends, or
      //  - ended another shift less than THAT shift's post cooldown before it starts.
      const before = [];
      const after = [];
      if (col.k > 0 && e1 + 1 <= lastRow) {
        const lo = columns[0].index; const hi = columns[columns.length - 1].index;
        // the window covers every column between lo..hi; columns without a post header are empty there
        after.push(`COUNTIF(${rect(lo, hi, e1 + 1, Math.min(lastRow, e1 + col.k))},${name})`);
      }
      if (s - 1 >= first) {
        let group = null;
        const flush = () => {
          if (group && group.K > 0) before.push(`COUNTIF(${rect(group.lo, group.hi, Math.max(first, s - group.K), s - 1)},${name})`);
          group = null;
        };
        for (const other of columns) {
          if (group && other.index === group.hi + 1 && other.k === group.K) group.hi = other.index;
          else { flush(); group = { lo: other.index, hi: other.index, K: other.k }; }
        }
        flush();
      }

      const dblExpr = dbl.length ? `(${dbl.join('+')})>0` : 'FALSE()';
      const cdTerms = [...before, ...after];
      const cdExpr = cdTerms.length ? `(${cdTerms.join('+')})>0` : 'FALSE()';
      // Double booking wins: an overlapping shift naturally also "lacks rest", so only one flag is shown.
      set(s + 2 * O, col.index, `=IF(${filled},IF(${dblExpr},"D",IF(${cdExpr},"C","")),"")`);
    }
  }
  void byIndex;
  return cells;
}

/** Cheap size estimate so a huge schedule cannot produce an oversized request. */
export function estimateSize(cells) {
  let n = 0;
  for (const row of cells) for (const v of row) n += v.length + 20;
  return n;
}

/**
 * Conditional-format rules for the Schedule tab that colour cells by the helper tab's flags.
 * Red = double-booked, amber = cooldown only. They are recognisable by the helper tab's name.
 */
export function buildLiveCheckRules(sheetId, plan) {
  // INDIRECT is recalculated on every change, so colour exactly the block that is checked (not the whole 1000 x 100 grid)
  // and ask it once per rule. The flag cells hold exactly "D", "C" or nothing.
  const ref = `INDIRECT(${JSON.stringify(`${q(CHECK_TAB)}!`)}&ADDRESS(ROW()+${2 * plan.offset},COLUMN(),4))`;
  const range = {
    sheetId,
    startRowIndex: plan.firstRow - 1,
    endRowIndex: plan.lastRow,
    startColumnIndex: Math.min(...plan.columns.map((c) => c.index)),
    endColumnIndex: Math.max(...plan.columns.map((c) => c.index)) + 1,
  };
  const rule = (formula, format, index) => ({
    addConditionalFormatRule: {
      rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format } },
      index,
    },
  });
  return [
    rule(`=${ref}="C"`, { backgroundColor: { red: 1, green: 0.92, blue: 0.7 }, textFormat: { bold: true } }, 0),
    rule(`=${ref}="D"`, { backgroundColor: { red: 0.96, green: 0.78, blue: 0.78 }, textFormat: { bold: true } }, 0),
  ];
}

/** True for conditional-format rules created by buildLiveCheckRules (so they can be replaced, not duplicated). */
export const isLiveCheckRule = (rule) => {
  const f = rule?.booleanRule?.condition?.values?.[0]?.userEnteredValue;
  return typeof f === 'string' && f.includes(`${q(CHECK_TAB)}!`);
};

export { MAX_FORMULA_CHARS };
