/**
 * The live double-booking / cooldown formulas are evaluated by a real spreadsheet engine (HyperFormula)
 * and compared with the app's own rule engine, including shifts of very different durations.
 */
import { describe, it, expect } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { planLiveChecks, buildLiveCheckCells, buildLiveCheckRules, isLiveCheckRule, CHECK_TAB, FIRST_ROW, estimateSize, FORMULA_BUDGET, MAX_ROWS } from '../services/liveChecks';
import { validateAssignments } from '../lib/scheduleValidation';
import { colLetter } from '../lib/sheetModel';

const STEP = 60; // minutes per row in these tests

const pad = (n) => String(n).padStart(2, '0');
const label = (row) => {
  const a = (row * STEP) / 60; // hour at start of this row
  const b = a + STEP / 60;
  return `${pad(a % 24)}:00 - ${pad(b % 24)}:00`;
};

/**
 * Build a Schedule grid from shifts: posts = [{name, roles, hours, cooldown}], shifts = [{post, role, startRow, who}]
 * (startRow is 0-based among data rows). Only the first row of each shift holds the name, like a merged cell.
 */
function makeGrid(posts, shifts, rows) {
  const header0 = ['Date', 'Time'];
  const header1 = ['', ''];
  const colOf = {};
  posts.forEach((p) => {
    for (let r = 0; r < p.roles; r++) {
      colOf[`${p.name}|${r}`] = header0.length;
      header0.push(r === 0 ? p.name : '');
      header1.push(p.roles > 1 ? `Role ${r + 1}` : '');
    }
  });
  const grid = [header0, header1];
  for (let i = 0; i < rows; i++) grid.push(['', label(i), ...Array(header0.length - 2).fill('')]);
  shifts.forEach((s) => { grid[2 + s.startRow][colOf[`${s.post}|${s.role}`]] = s.who; });
  return { grid, colOf };
}

/** Evaluate the helper tab with a spreadsheet engine; returns { flagAt(sheetRow, colIndex), values } */
function evaluate(grid, postsModel) {
  const plan = planLiveChecks(grid, postsModel);
  const cells = buildLiveCheckCells(plan, 'Schedule');
  const hf = HyperFormula.buildFromSheets({ Schedule: grid, [CHECK_TAB]: cells }, { licenseKey: 'gpl-v3' });
  const id = hf.getSheetId(CHECK_TAB);
  return {
    plan,
    hf,
    flagAt: (sheetRow, colIndex) => {
      const v = hf.getCellValue({ sheet: id, row: sheetRow - 1 + 2 * plan.offset, col: colIndex });
      if (v && typeof v === 'object') throw new Error(`formula error at ${colLetter(colIndex)}${sheetRow}: ${v.value} ${v.message}`);
      return v;
    },
    whoAt: (sheetRow, colIndex) => hf.getCellValue({ sheet: id, row: sheetRow - 1 + plan.offset, col: colIndex }),
    posAt: (sheetRow, colIndex) => hf.getCellValue({ sheet: id, row: sheetRow - 1, col: colIndex }),
  };
}

const post = (name, hours, cooldown = 0) => ({ name, shift_length_hours: hours, cooldown_hours: cooldown });
const row = (i) => FIRST_ROW + i; // sheet row of data row i

describe('planLiveChecks', () => {
  it('derives rows per shift and rest rows from each post, using the row duration in the Time column', () => {
    const { grid } = makeGrid([{ name: 'Fort', roles: 1 }, { name: 'Gate', roles: 2 }], [], 24);
    const plan = planLiveChecks(grid, [post('Fort', 24, 8), post('Gate', 4, 2)]);
    expect(plan.step).toBe(60);
    expect(plan.columns.map((c) => [c.letter, c.post, c.role, c.n, c.k])).toEqual([['C', 'Fort', 0, 24, 8], ['D', 'Gate', 0, 4, 2], ['E', 'Gate', 1, 4, 2]]);
  });

  it('works out the row duration from the labels (4h rows)', () => {
    const grid = [['Date', 'Time', 'Gate'], ['', '', ''], ['', '06:00 - 10:00', ''], ['', '10:00 - 14:00', '']];
    expect(planLiveChecks(grid, [post('Gate', 8, 4)]).columns[0]).toMatchObject({ n: 2, k: 1 });
  });

  it('nothing to plan without a schedule', () => {
    expect(planLiveChecks([], [])).toBeNull();
    expect(planLiveChecks([['Date', 'Time']], [])).toBeNull();
  });
});

describe('live formulas (evaluated by a spreadsheet engine)', () => {
  const posts = [{ name: 'Fort', roles: 1 }, { name: 'Gate', roles: 1 }, { name: 'Tower', roles: 1 }];
  const model = [post('Fort', 24, 0), post('Gate', 4, 0), post('Tower', 8, 0)];

  it('CRITICAL CASE: a 4h shift inside a 24h shift by the same person is double-booked on both', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Fort', role: 0, startRow: 0, who: 'Dan' },   // rows 0-23 (merged: only the first row is filled)
      { post: 'Gate', role: 0, startRow: 10, who: 'Dan' },  // rows 10-13, not on the same row as the Fort's name cell
    ], 24);
    const ev = evaluate(grid, model);
    expect(ev.flagAt(row(0), colOf['Fort|0'])).toBe('D');
    expect(ev.flagAt(row(10), colOf['Gate|0'])).toBe('D');
  });

  it('a plain same-row duplicate is double-booked (what the old row check found)', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Gate', role: 0, startRow: 4, who: 'Dan' },
      { post: 'Tower', role: 0, startRow: 4, who: 'Dan' },
    ], 24);
    const ev = evaluate(grid, model);
    expect(ev.flagAt(row(4), colOf['Gate|0'])).toBe('D');
    expect(ev.flagAt(row(4), colOf['Tower|0'])).toBe('D');
  });

  it('different people never conflict; touching shifts are not an overlap', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Fort', role: 0, startRow: 0, who: 'Dan' },
      { post: 'Gate', role: 0, startRow: 10, who: 'Eli' },
      { post: 'Tower', role: 0, startRow: 0, who: 'Avi' },
      { post: 'Gate', role: 0, startRow: 8, who: 'Dan' },
    ], 24);
    const ev = evaluate(grid, model);
    expect(ev.flagAt(row(0), colOf['Fort|0'])).toBe('D'); // Dan is on the Fort all day and on the Gate 08-12
    expect(ev.flagAt(row(10), colOf['Gate|0'])).toBe('');
    expect(ev.flagAt(row(0), colOf['Tower|0'])).toBe('');
    const touching = makeGrid(posts, [{ post: 'Gate', role: 0, startRow: 0, who: 'Dan' }, { post: 'Tower', role: 0, startRow: 4, who: 'Dan' }], 24);
    const ev2 = evaluate(touching.grid, model);
    expect(ev2.flagAt(row(0), touching.colOf['Gate|0'])).toBe('');
    expect(ev2.flagAt(row(4), touching.colOf['Tower|0'])).toBe('');
  });

  it('expands a shift over its rows and stops at the end of the shift', () => {
    const { grid, colOf } = makeGrid(posts, [{ post: 'Gate', role: 0, startRow: 2, who: 'Dan' }], 12);
    const ev = evaluate(grid, model);
    const c = colOf['Gate|0'];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ev.whoAt(row(i), c))).toEqual(['', '', 'Dan', 'Dan', 'Dan', 'Dan', '', '']);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => ev.posAt(row(i), c))).toEqual([0, 0, 1, 2, 3, 4, 0]);
  });

  it('a name typed by hand into an empty slot immediately conflicts with the person already on duty', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Tower', role: 0, startRow: 0, who: 'Dan' },
      { post: 'Tower', role: 0, startRow: 8, who: 'Dan' },
    ], 24);
    const clean = evaluate(grid, model);
    expect(clean.flagAt(row(0), colOf['Tower|0'])).toBe('');
    // the user now types Dan into the Gate at row 6 (inside Tower's first shift)
    clean.hf.setCellContents({ sheet: clean.hf.getSheetId('Schedule'), row: row(6) - 1, col: colOf['Gate|0'] }, 'Dan');
    const id = clean.hf.getSheetId(CHECK_TAB);
    const flag = (r, c) => clean.hf.getCellValue({ sheet: id, row: r - 1 + 2 * clean.plan.offset, col: c });
    expect(flag(row(6), colOf['Gate|0'])).toBe('D');
    expect(flag(row(0), colOf['Tower|0'])).toBe('D'); // recalculated live, the Tower shift is flagged too
  });

  it('cooldown: too little rest after a shift is flagged, exactly the cooldown is allowed', () => {
    const cm = [post('Fort', 24, 0), post('Gate', 4, 8), post('Tower', 8, 0)];
    const gate = makeGrid(posts, [
      { post: 'Gate', role: 0, startRow: 0, who: 'Dan' },    // 00-04, needs 8h rest
      { post: 'Tower', role: 0, startRow: 7, who: 'Dan' },   // starts 07:00 -> only 3h rest
      { post: 'Tower', role: 0, startRow: 16, who: 'Eli' },
    ], 24);
    const ev = evaluate(gate.grid, cm);
    expect(ev.flagAt(row(0), gate.colOf['Gate|0'])).toBe('C');
    expect(ev.flagAt(row(7), gate.colOf['Tower|0'])).toBe('C'); // the later shift is flagged too
    const exact = makeGrid(posts, [{ post: 'Gate', role: 0, startRow: 0, who: 'Dan' }, { post: 'Tower', role: 0, startRow: 12, who: 'Dan' }], 24);
    const ev2 = evaluate(exact.grid, cm);
    expect(ev2.flagAt(row(0), exact.colOf['Gate|0'])).toBe(''); // 04:00 -> 12:00 is exactly 8h
    const short = makeGrid(posts, [{ post: 'Gate', role: 0, startRow: 0, who: 'Dan' }, { post: 'Tower', role: 0, startRow: 11, who: 'Dan' }], 24);
    expect(evaluate(short.grid, cm).flagAt(row(0), short.colOf['Gate|0'])).toBe('C'); // 7h
  });

  it('cooldown also applies between consecutive shifts of the same post', () => {
    const cm = [post('Fort', 24, 0), post('Gate', 4, 4), post('Tower', 8, 0)];
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Gate', role: 0, startRow: 0, who: 'Dan' },
      { post: 'Gate', role: 0, startRow: 4, who: 'Dan' }, // straight after: 0h rest
      { post: 'Gate', role: 0, startRow: 12, who: 'Dan' }, // starts exactly 4h after the previous one ends: ok
    ], 24);
    const ev = evaluate(grid, cm);
    expect(ev.flagAt(row(0), colOf['Gate|0'])).toBe('C');
    expect(ev.flagAt(row(4), colOf['Gate|0'])).toBe('C');
    expect(ev.flagAt(row(12), colOf['Gate|0'])).toBe(''); // exactly 4h of rest after the previous shift: allowed
  });

  it('shifts clipped by the end of the grid and the first rows do not break the windows', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Tower', role: 0, startRow: 20, who: 'Dan' }, // 8h shift but only 4 rows left
      { post: 'Gate', role: 0, startRow: 0, who: 'Dan' },
    ], 24);
    const ev = evaluate(grid, [post('Fort', 24, 8), post('Gate', 4, 8), post('Tower', 8, 8)]);
    expect(ev.flagAt(row(20), colOf['Tower|0'])).toBe('');
    expect(ev.flagAt(row(0), colOf['Gate|0'])).toBe('');
  });

  it('unknown posts are treated as one-row shifts and never error', () => {
    const { grid, colOf } = makeGrid([{ name: 'Mystery', roles: 1 }, { name: 'Gate', roles: 1 }], [
      { post: 'Mystery', role: 0, startRow: 3, who: 'Dan' }, { post: 'Gate', role: 0, startRow: 3, who: 'Dan' }], 8);
    const ev = evaluate(grid, [post('Gate', 4, 0)]);
    expect(ev.flagAt(row(3), colOf['Mystery|0'])).toBe('D');
    expect(ev.flagAt(row(3), colOf['Gate|0'])).toBe('D');
  });

  it('names are compared ignoring case and extra spaces', () => {
    const { grid, colOf } = makeGrid(posts, [
      { post: 'Gate', role: 0, startRow: 4, who: 'dan ' },
      { post: 'Tower', role: 0, startRow: 4, who: 'DAN' },
    ], 12);
    expect(evaluate(grid, model).flagAt(row(4), colOf['Gate|0'])).toBe('D');
  });

  it('no formula errors anywhere, and a plausible size', () => {
    const { grid } = makeGrid(posts, [{ post: 'Fort', role: 0, startRow: 0, who: 'Dan' }], 48);
    const ev = evaluate(grid, model);
    const sheet = ev.hf.getSheetValues(ev.hf.getSheetId(CHECK_TAB));
    expect(sheet.flat().filter((v) => v && typeof v === 'object')).toEqual([]);
    expect(estimateSize(buildLiveCheckCells(ev.plan, 'Schedule'))).toBeLessThan(1_000_000);
  });
});

describe('formulas agree with the rule engine on random schedules', () => {
  // small deterministic generator
  let seed = 20260211;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  it('double booking (D) matches exactly; cooldown (C) matches when not double-booked', () => {
    let checked = 0; let withD = 0; let withC = 0;
    for (let run = 0; run < 60; run++) {
      const rows = 48;
      const postDefs = Array.from({ length: 2 + Math.floor(rnd() * 4) }, (_, i) => ({
        name: `P${i}`, roles: 1 + Math.floor(rnd() * 2), hours: pick([1, 2, 3, 4, 6, 8, 12, 24]), cooldown: pick([0, 0, 1, 2, 4, 8]),
      }));
      const people = ['Ann', 'Ben', 'Cy', 'Dee', 'Eli'].slice(0, 2 + Math.floor(rnd() * 4));
      // random non-overlapping shifts per column
      const shifts = [];
      for (const p of postDefs) {
        for (let role = 0; role < p.roles; role++) {
          let at = Math.floor(rnd() * 6);
          while (at + p.hours <= rows) {
            if (rnd() < 0.7) shifts.push({ post: p.name, role, startRow: at, who: pick(people), n: p.hours });
            at += p.hours + (rnd() < 0.3 ? Math.floor(rnd() * 5) : 0);
          }
        }
      }
      const { grid, colOf } = makeGrid(postDefs, shifts, rows);
      const model = postDefs.map((p) => post(p.name, p.hours, p.cooldown));
      const ev = evaluate(grid, model);

      const soldiers = people.map((name, i) => ({ id: i + 1, name, skills: [], excluded_posts: [] }));
      const t0 = new Date(2025, 0, 1, 0, 0, 0).getTime();
      const slots = shifts.map((s) => ({
        soldier_id: soldiers.find((x) => x.name === s.who).id,
        soldier_name: s.who, post_name: s.post, role_id: s.role,
        start: new Date(t0 + s.startRow * STEP * 60000), end: new Date(t0 + (s.startRow + s.n) * STEP * 60000),
      }));
      const warnings = validateAssignments(slots, postDefs.map((p) => ({ name: p.name, cooldown_hours: p.cooldown })), soldiers, []);
      const expect_ = slots.map((_, i) => ({ overlap: warnings.some((w) => w.slotIndex === i && w.type === 'overlap'), cooldown: warnings.some((w) => w.slotIndex === i && w.type === 'cooldown') }));

      shifts.forEach((s, i) => {
        const flag = ev.flagAt(row(s.startRow), colOf[`${s.post}|${s.role}`]);
        const ctx = `run ${run} shift ${JSON.stringify(s)} flag=${flag} expected=${JSON.stringify(expect_[i])}`;
        expect(flag.includes('D'), ctx).toBe(expect_[i].overlap);
        if (!expect_[i].overlap) expect(flag.includes('C'), ctx).toBe(expect_[i].cooldown);
        checked++; if (expect_[i].overlap) withD++; if (expect_[i].cooldown) withC++;
      });
    }
    // the random schedules must actually exercise both rules
    expect(checked).toBeGreaterThan(500);
    expect(withD).toBeGreaterThan(30);
    expect(withC).toBeGreaterThan(30);
  }, 120000);
});

describe('long schedules: only the most recent rows get live checks', () => {
  const longModel = [post('Gate', 4, 0), post('Tower', 4, 0)];
  it('covers the last rows, leaves older rows empty, and has no formula errors', () => {
    const postDefs = [{ name: 'Gate', roles: 1 }, { name: 'Tower', roles: 1 }];
    const { grid, colOf } = makeGrid(postDefs, [
      { post: 'Gate', role: 0, startRow: 10, who: 'Dan' },   // old day: outside the window
      { post: 'Tower', role: 0, startRow: 10, who: 'Dan' },
      { post: 'Gate', role: 0, startRow: 380, who: 'Dan' },  // recent: inside
      { post: 'Tower', role: 0, startRow: 380, who: 'Dan' },
    ], 400);
    const plan = planLiveChecks(grid, longModel);
    expect(plan.firstRow).toBe(plan.lastRow - 336 + 1);
    const ev = evaluate(grid, longModel);
    expect(ev.flagAt(row(380), colOf['Gate|0'])).toBe('D');
    expect(ev.flagAt(row(10), colOf['Gate|0'])).toBe(''); // not covered live
    const sheet = ev.hf.getSheetValues(ev.hf.getSheetId(CHECK_TAB));
    expect(sheet.flat().filter((v) => v && typeof v === 'object')).toEqual([]);
    expect(estimateSize(buildLiveCheckCells(plan, 'Schedule'))).toBeLessThan(5_000_000);
  });

  it('a shift that began just before the window start does not break anything', () => {
    const { grid, colOf } = makeGrid([{ name: 'Gate', roles: 1 }], [{ post: 'Gate', role: 0, startRow: 400 - 340, who: 'Dan' }], 400);
    const ev = evaluate(grid, [post('Gate', 24, 0)]);
    expect(ev.flagAt(row(400 - 340), colOf['Gate|0'])).toBe('');
  });
});

describe('conditional-format rules for the Schedule tab', () => {
  it('read the flags of the helper tab for the same cell, with red taking priority over amber', () => {
    const { grid } = makeGrid([{ name: 'Gate', roles: 1 }], [], 10);
    const plan = planLiveChecks(grid, [post('Gate', 4, 0)]);
    const rules = buildLiveCheckRules(7, plan, { rowCount: 500, columnCount: 30 });
    expect(rules).toHaveLength(2);
    const formulas = rules.map((r) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue);
    for (const f of formulas) {
      expect(f).toContain(`ADDRESS(ROW()+${2 * plan.offset},COLUMN(),4)`);
      expect(f).toContain("'Schedule Check'!");
      expect(f.split('(').length).toBe(f.split(')').length);
      expect((f.match(/"/g) || []).length % 2).toBe(0);
    }
    expect(isLiveCheckRule(rules[0].addConditionalFormatRule.rule)).toBe(true);
    expect(isLiveCheckRule({ booleanRule: { condition: { values: [{ userEnteredValue: '=A1>1' }] } } })).toBe(false);
    // red is added last at index 0 so it ranks above amber
    expect(rules[1].addConditionalFormatRule.rule.booleanRule.format.backgroundColor.red).toBeCloseTo(0.96);
  });
});

describe('speed budget', () => {
  const wide = (cols, rows) => {
    const posts = Array.from({ length: cols / 2 }, (_, i) => ({ name: `P${i}`, roles: 2 }));
    return makeGrid(posts, [], rows).grid;
  };
  const model = (cols) => Array.from({ length: cols / 2 }, (_, i) => post(`P${i}`, 8, 4));
  const formulas = (cells) => cells.flat().filter((v) => String(v).startsWith('=')).length;

  it('never writes more helper formulas than the budget, however wide or long the schedule is', () => {
    for (const [cols, rows] of [[4, 100], [12, 336], [24, 2000], [60, 3000]]) {
      const grid = wide(cols, rows);
      const plan = planLiveChecks(grid, model(cols));
      expect(formulas(buildLiveCheckCells(plan, 'Schedule'))).toBeLessThanOrEqual(FORMULA_BUDGET + 3 * cols);
    }
  });

  it('wide schedules check fewer of the most recent rows, small ones keep the full window', () => {
    expect(planLiveChecks(wide(4, 600), model(4)).lastRow - planLiveChecks(wide(4, 600), model(4)).firstRow + 1).toBe(MAX_ROWS);
    const w = planLiveChecks(wide(24, 600), model(24));
    expect(w.lastRow - w.firstRow + 1).toBeLessThan(MAX_ROWS);
    expect(w.lastRow - w.firstRow + 1).toBeGreaterThanOrEqual(24);
  });

  it('colours only the checked block, once per rule (INDIRECT is recalculated on every change)', () => {
    const grid = wide(6, 500);
    const plan = planLiveChecks(grid, model(6));
    const rules = buildLiveCheckRules(7, plan);
    for (const r of rules) {
      const range = r.addConditionalFormatRule.rule.ranges[0];
      expect(range.endRowIndex).toBe(plan.lastRow);
      expect(range.startRowIndex).toBe(plan.firstRow - 1);
      expect(range.endColumnIndex).toBe(Math.max(...plan.columns.map((c) => c.index)) + 1);
      const f = r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue;
      expect(f.match(/INDIRECT/g)).toHaveLength(1);
    }
  });
});
