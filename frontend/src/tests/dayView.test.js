/**
 * The Day View formulas are evaluated by a spreadsheet engine (HyperFormula) and compared with what the
 * schedule actually says, including shifts that run past midnight.
 */
import { describe, it, expect } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { planDayView, buildDayViewCells, layerRows, rowDays, dayKey, dayViewSize, DAY_TAB, OUT_FIRST_ROW } from '../services/dayView';

const pad = (n) => String(n).padStart(2, '0');
const dateLabel = (d) => dayKey(new Date(2025, 2, 10 + d)); // the key shown in the dropdown (yyyy-mm-dd)
const scheduleDate = (d) => { const x = new Date(2025, 2, 10 + d); return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()}`; }; // as the app writes it in the Schedule tab

/**
 * 1-hour rows, `days` days. posts: [{name, hours}], shifts: [{post, day, hour, who}]
 * Only the first row of a shift holds the name (like a merged cell).
 */
function makeSchedule(days, posts, shifts) {
  const header0 = ['Date', 'Time', ...posts.map((p) => p.name)];
  const grid = [header0, ['', '', ...posts.map(() => '')]];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) grid.push([h === 0 ? scheduleDate(d) : '', `${pad(h)}:00 - ${pad((h + 1) % 24)}:00`, ...posts.map(() => '')]);
  }
  const col = (name) => 2 + posts.findIndex((p) => p.name === name);
  shifts.forEach((s) => { grid[2 + s.day * 24 + s.hour][col(s.post)] = s.who; });
  return { grid, col };
}

const modelPosts = (posts) => posts.map((p) => ({ name: p.name, shift_length_hours: p.hours, cooldown_hours: 0 }));

function open(grid, posts, selected) {
  const plan = planDayView(grid, modelPosts(posts));
  const cells = buildDayViewCells(plan, 'Schedule', selected);
  const hf = HyperFormula.buildFromSheets({ Schedule: grid, [DAY_TAB]: cells }, { licenseKey: 'gpl-v3' });
  const id = hf.getSheetId(DAY_TAB);
  const val = (row1, col0) => hf.getCellValue({ sheet: id, row: row1 - 1, col: col0 });
  return {
    plan, cells, hf,
    select: (day) => hf.setCellContents({ sheet: id, row: 0, col: 1 }, day),
    firstRow: () => val(1, 3),
    rowCount: () => val(1, 5),
    /** the shown table: [[time, ...names]] for the rows of the chosen day */
    table: () => {
      const n = val(1, 5);
      return Array.from({ length: n }, (_, i) => [val(OUT_FIRST_ROW + i, 1), ...posts.map((_p, c) => val(OUT_FIRST_ROW + i, 2 + c))]);
    },
    val,
  };
}

const posts = [{ name: 'Fort', hours: 24 }, { name: 'Gate', hours: 4 }, { name: 'Tower', hours: 8 }];

describe('Day View formulas', () => {
  it('shows only the chosen day and says where it starts and how many rows it has', () => {
    const { grid } = makeSchedule(3, posts, [{ post: 'Gate', day: 0, hour: 6, who: 'Ann' }, { post: 'Gate', day: 1, hour: 6, who: 'Ben' }, { post: 'Gate', day: 2, hour: 6, who: 'Cy' }]);
    const v = open(grid, posts, dateLabel(1));
    expect(v.rowCount()).toBe(24);
    expect(v.firstRow()).toBe(25);
    const t = v.table();
    expect(t).toHaveLength(24);
    expect(t[0][0]).toBe('00:00 - 01:00');
    expect(t[6]).toEqual(['06:00 - 07:00', '', 'Ben', '']);
    expect(t[10]).toEqual(['10:00 - 11:00', '', '', '']); // the 4h Gate shift (06-10) is over
    v.select(dateLabel(2));
    expect(v.table()[6][2]).toBe('Cy');
    expect(v.table().flat().includes('Ben')).toBe(false);
  });

  it('expands shifts over every row they cover, so a night shift carries over midnight', () => {
    const { grid } = makeSchedule(2, posts, [{ post: 'Tower', day: 0, hour: 22, who: 'Dan' }]); // 22:00 -> 06:00 next day
    const v = open(grid, posts, dateLabel(0));
    const col = (t) => t.map((r) => r[3]);
    expect(col(v.table()).slice(20, 24)).toEqual(['', '', 'Dan', 'Dan']);
    v.select(dateLabel(1));
    expect(col(v.table()).slice(0, 8)).toEqual(['Dan', 'Dan', 'Dan', 'Dan', 'Dan', 'Dan', '', '']); // 00:00-06:00 still Dan
  });

  it('a 24h shift fills the rest of its first day and the start of the next', () => {
    const { grid } = makeSchedule(2, posts, [{ post: 'Fort', day: 0, hour: 6, who: 'Eli' }]);
    const v = open(grid, posts, dateLabel(0));
    expect(v.table().map((r) => r[1]).filter(Boolean)).toHaveLength(18); // 06:00..23:00
    v.select(dateLabel(1));
    expect(v.table().map((r) => r[1]).slice(0, 7)).toEqual(['Eli', 'Eli', 'Eli', 'Eli', 'Eli', 'Eli', '']);
  });

  it('copies the header rows and the time labels', () => {
    const { grid } = makeSchedule(1, posts, []);
    const v = open(grid, posts, dateLabel(0));
    expect([v.val(3, 0), v.val(3, 1), v.val(3, 2), v.val(3, 3), v.val(3, 4)]).toEqual(['Date', 'Time', 'Fort', 'Gate', 'Tower']);
    expect(v.val(OUT_FIRST_ROW, 0)).toBe(dateLabel(0));
    expect(v.val(OUT_FIRST_ROW + 23, 1)).toBe('23:00 - 00:00');
  });

  it('copes with the selected cell holding a real date (Google Sheets converts a picked date-like text)', () => {
    const { grid } = makeSchedule(2, posts, [{ post: 'Gate', day: 1, hour: 6, who: 'Ben' }]);
    const v = open(grid, posts, 45727); // 2025-03-11 as a number
    expect(v.rowCount()).toBe(24);
    expect(v.table()[6][2]).toBe('Ben');
  });

  it('an unknown day shows nothing', () => {
    const { grid } = makeSchedule(2, posts, [{ post: 'Gate', day: 0, hour: 6, who: 'Ann' }]);
    const v = open(grid, posts, '2020-01-01');
    expect(v.rowCount()).toBe(0);
    expect(v.firstRow()).toBe(0);
    expect(v.val(OUT_FIRST_ROW, 2)).toBe('');
    v.select('');
    expect(v.rowCount()).toBe(0);
  });

  it('works when the Date column holds real dates (numbers) instead of text', () => {
    const { grid } = makeSchedule(2, posts, [{ post: 'Gate', day: 1, hour: 6, who: 'Ben' }]);
    grid[2][0] = 45726; // 2025-03-10 as a spreadsheet date
    grid[26][0] = 45727; // 2025-03-11
    const v = open(grid, posts, '2025-03-11');
    expect(v.rowCount()).toBe(24);
    expect(v.table()[6][2]).toBe('Ben');
  });

  it('has no formula errors apart from the day list (UNIQUE/FILTER are spreadsheet-only)', () => {
    const { grid } = makeSchedule(3, posts, [{ post: 'Tower', day: 1, hour: 22, who: 'Dan' }]);
    const v = open(grid, posts, dateLabel(1));
    const sheet = v.hf.getSheetValues(v.hf.getSheetId(DAY_TAB));
    const errors = [];
    sheet.forEach((row, r) => row.forEach((x, c) => { if (x && typeof x === 'object' && !(r === 3 && c === v.plan.columns.length + 4)) errors.push(`${r + 1}:${c}:${x.value}`); }));
    const dcol = Math.max(...v.plan.columns.map((c) => c.index)) + 3;
    expect(errors.filter((e) => !e.startsWith(`4:${dcol}:`))).toEqual([]);
  });

  it('the dropdown list formula and plan describe the days', () => {
    const { grid } = makeSchedule(3, posts, []);
    const plan = planDayView(grid, modelPosts(posts));
    expect(plan.dayList).toEqual([dateLabel(0), dateLabel(1), dateLabel(2)]);
    expect(plan.outRows).toBe(30); // 24 rows per day + margin
    const cells = buildDayViewCells(plan, 'Schedule', dateLabel(0));
    expect(cells[3][Math.max(...plan.columns.map((c) => c.index)) + 3]).toMatch(/^=IFERROR\(UNIQUE\(FILTER\(/);
    expect(dayViewSize(cells)).toBeLessThan(2_000_000);
  });

  it('layers do not overlap the visible area or each other', () => {
    const { grid } = makeSchedule(2, posts, []);
    const plan = planDayView(grid, modelPosts(posts));
    const L = layerRows(plan);
    expect(L.key(plan.first)).toBeGreaterThan(OUT_FIRST_ROW + plan.outRows);
    expect(L.pos(plan.first)).toBeGreaterThan(L.key(plan.lastRow));
    expect(L.who(plan.first)).toBeGreaterThan(L.pos(plan.lastRow));
  });

  it('nothing to show without a schedule or without any day', () => {
    expect(planDayView([], [])).toBeNull();
    expect(planDayView([['Date', 'Time', 'Gate'], ['', '', ''], ['', '00:00 - 01:00', '']], modelPosts(posts))).toBeNull();
  });
});

describe('rowDays', () => {
  it('carries the date forward over the rest of the day', () => {
    const grid = [[], [], ['10/03/2025', 'a'], ['', 'b'], ['11/03/2025', 'c'], ['', 'd']];
    expect(rowDays(grid, 3, 6)).toEqual(['2025-03-10', '2025-03-10', '2025-03-11', '2025-03-11']);
    expect(rowDays([[], [], [45726, 'a'], ['', 'b']], 3, 4)).toEqual(['2025-03-10', '2025-03-10']); // real dates too
  });
});

describe('Day View agrees with the schedule on random data', () => {
  let seed = 424242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  it('every day, every column, every row', () => {
    for (let run = 0; run < 25; run++) {
      const days = 2 + Math.floor(rnd() * 3);
      const ps = [{ name: 'A', hours: pick([1, 2, 4, 8]) }, { name: 'B', hours: pick([3, 6, 12]) }, { name: 'C', hours: pick([8, 24]) }].slice(0, 2 + Math.floor(rnd() * 2));
      const people = ['Ann', 'Ben', 'Cy', 'Dee'];
      const total = days * 24;
      const shifts = [];
      for (const p of ps) {
        let at = Math.floor(rnd() * 6);
        while (at < total) {
          if (rnd() < 0.75) shifts.push({ post: p.name, day: Math.floor(at / 24), hour: at % 24, who: pick(people), n: p.hours });
          at += p.hours + (rnd() < 0.25 ? Math.floor(rnd() * 4) : 0);
        }
      }
      const { grid } = makeSchedule(days, ps, shifts);
      const v = open(grid, ps, dateLabel(0));
      for (let d = 0; d < days; d++) {
        v.select(dateLabel(d));
        const shown = v.table();
        expect(shown, `run ${run} day ${d}`).toHaveLength(24);
        for (let h = 0; h < 24; h++) {
          const abs = d * 24 + h;
          ps.forEach((p, c) => {
            const cover = shifts.find((s) => s.post === p.name && s.day * 24 + s.hour <= abs && abs < s.day * 24 + s.hour + s.n);
            expect(shown[h][1 + c], `run ${run} day ${d} ${pad(h)}:00 ${p.name}`).toBe(cover ? cover.who : '');
          });
        }
      }
    }
  }, 120000);
});
