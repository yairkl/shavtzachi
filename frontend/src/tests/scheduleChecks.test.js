import { describe, it, expect } from 'vitest';
import { validateAssignments, buildWarningMap } from '../lib/scheduleValidation';
import { buildDivisionColoringRules, DIVISION_COLORS, parseGrid } from '../services/gsheetsUtils';
import { makeService } from './helpers/fakeSheets';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};

const d = (h, day = 10) => new Date(2025, 2, day, h, 0, 0);
const dan = { id: 1, name: 'Dan', skills: ['guard'], excluded_posts: [] };
const posts = [
  { name: 'Gate', cooldown_hours: 8 },
  { name: 'Tower', cooldown_hours: 0 },
];
const slot = (over) => ({ soldier_id: 1, soldier_name: 'Dan', post_name: 'Gate', role_id: 0, skill: 'guard', start: d(6), end: d(14), ...over });
const types = (ws) => ws.map((w) => `${w.slotIndex}:${w.type}`).sort();

describe('validateAssignments', () => {
  it('flags double booking on both slots, once per pair', () => {
    const w = validateAssignments([slot(), slot({ post_name: 'Tower', start: d(10), end: d(18) })], posts, [dan]);
    expect(types(w.filter((x) => x.type === 'overlap'))).toEqual(['0:overlap', '1:overlap']);
    expect(w[0].message).toMatch(/double-booked/);
  });

  it('two different people at the same time is fine', () => {
    const eli = { id: 2, name: 'Eli', skills: ['guard'], excluded_posts: [] };
    expect(validateAssignments([slot(), slot({ soldier_id: 2, soldier_name: 'Eli', post_name: 'Tower' })], posts, [dan, eli])).toEqual([]);
  });

  it('flags too little rest, using the cooldown of either post, in either order', () => {
    // Gate (8h cooldown) 06-14, then Tower 18-22: only 4h rest after Gate
    const a = validateAssignments([slot(), slot({ post_name: 'Tower', start: d(18), end: d(22) })], posts, [dan]);
    expect(types(a)).toEqual(['0:cooldown', '1:cooldown']);
    expect(a.map((x) => x.message).join(' ')).toMatch(/Only 4\.0h rest/);
    // Same shifts listed in the opposite order give the same verdict
    const b = validateAssignments([slot({ post_name: 'Tower', start: d(18), end: d(22) }), slot()], posts, [dan]);
    expect(types(b)).toEqual(['0:cooldown', '1:cooldown']);
  });

  it('exactly the cooldown is allowed; one minute less is not', () => {
    const ok = validateAssignments([slot(), slot({ post_name: 'Tower', start: d(22), end: d(23) })], posts, [dan]);
    expect(ok).toEqual([]);
    const tight = validateAssignments([slot(), slot({ post_name: 'Tower', start: new Date(2025, 2, 10, 21, 59), end: d(23) })], posts, [dan]);
    expect(tight.some((x) => x.type === 'cooldown')).toBe(true);
  });

  it('shifts days apart never conflict', () => {
    expect(validateAssignments([slot(), slot({ start: d(6, 12), end: d(14, 12) })], posts, [dan])).toEqual([]);
  });

  it('flags missing skills, excluded posts and unavailability', () => {
    const w = validateAssignments(
      [slot({ skill: 'medic' }), slot({ post_name: 'Tower', start: d(22), end: d(23) })],
      posts,
      [{ ...dan, excluded_posts: ['Tower'] }],
      [{ soldier_id: 1, start_datetime: '2025-03-10T05:00:00', end_datetime: '2025-03-10T07:00:00', reason: 'Doctor' }],
    );
    expect(w.map((x) => x.type).sort()).toEqual(['excluded', 'skill', 'unavailability']);
    expect(w.find((x) => x.type === 'unavailability').message).toMatch(/Doctor/);
  });

  it('reports people who are not in the roster and ignores empty slots', () => {
    const w = validateAssignments([slot({ soldier_id: 'unknown:Ghost', soldier_name: 'Ghost' }), slot({ soldier_id: null })], posts, [dan]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ type: 'unknown', slotIndex: 0 });
    expect(w[0].message).toMatch(/Ghost/);
  });

  it('accepts ISO strings as well as Dates and survives a non-array', () => {
    const w = validateAssignments([slot({ start: '2025-03-10T06:00:00', end: '2025-03-10T14:00:00' }), slot({ post_name: 'Tower', start: '2025-03-10T10:00:00', end: '2025-03-10T12:00:00' })], posts, [dan]);
    expect(w.some((x) => x.type === 'overlap')).toBe(true);
    expect(validateAssignments(null, posts, [dan])).toEqual([]);
  });

  it('groups warnings per slot', () => {
    const map = buildWarningMap([{ slotIndex: 1, type: 'a' }, { slotIndex: 1, type: 'b' }, { slotIndex: 0, type: 'c' }]);
    expect(map[1]).toHaveLength(2);
    expect(map[0]).toHaveLength(1);
  });
});

describe('division colours in the Schedule tab', () => {
  const formulas = (reqs) => reqs.map((r) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue);

  it('uses 10 colours', () => {
    const reqs = buildDivisionColoringRules(5, { title: 'Soldiers', nameCol: 0, divisionCol: 1 });
    expect(reqs).toHaveLength(DIVISION_COLORS.length);
  });

  it('follows reordered Soldiers columns and the real tab title', () => {
    const f = formulas(buildDivisionColoringRules(5, { title: "Dan's Soldiers", nameCol: 2, divisionCol: 0 }));
    expect(f[0]).toContain(`INDIRECT("'Dan''s Soldiers'!$A$2:$A")`); // division column A
    expect(f[0]).toContain(`INDIRECT("'Dan''s Soldiers'!$C$2:$C")`); // name column C
  });

  it('wraps divisions above 10 around the palette and ignores unknown people', () => {
    const f = formulas(buildDivisionColoringRules(5)).slice(0, 10);
    expect(f[2]).toContain('MOD(');
    expect(f[2]).toMatch(/\)>0,MOD\(/); // division must be > 0, so unknown people get no colour
    expect(f[2]).toMatch(/\+1=3\)$/);
  });

  it('without a usable Soldiers tab no colour rules are added', () => {
    expect(buildDivisionColoringRules(5, null)).toHaveLength(0);
  });

  it('formulas are well-formed', () => {
    for (const f of formulas(buildDivisionColoringRules(5))) {
      expect(f.split('(').length).toBe(f.split(')').length);
      expect((f.match(/"/g) || []).length % 2).toBe(0);
    }
  });
});

describe('parseGrid reports where each assignment sits', () => {
  it('includes the 0-based row and column of the cell', () => {
    const grid = [['Date', 'Time', 'Gate', ''], ['', '', 'Role 1', 'Role 2'], ['10/03/2025', '06:00 - 10:00', 'Dan', 'Eli']];
    const a = parseGrid(grid, [], [], 4);
    expect(a.map((x) => [x.soldier_name, x.row, x.col]).sort()).toEqual([['Dan', 2, 2], ['Eli', 2, 3]]);
  });
});

describe('schedule rules in the spreadsheet', () => {
  const tabs = (extra = {}) => ({
    Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '12', 'guard', '']],
    Posts: [H.Posts, ['Gate', '8', '06:00', '06:00', '8', '1', 'guard', 'TRUE'], ['Tower', '4', '06:00', '06:00', '0', '1', 'guard', 'TRUE']],
    Unavailabilities: [H.Unavailabilities],
    ...extra,
  });
  const asg = (soldier_name, post_name, h1, h2, role_id = 0) => ({ soldier_name, post_name, role_id, start: d(h1).toISOString(), end: d(h2).toISOString() });
  const noteList = (fake) => Object.entries(fake.tab('Schedule').notes || {});

  it('saving marks every problem cell with a note, and a clean save has none', async () => {
    const { service, fake } = await makeService(tabs());
    const res = await service.saveAssignments(d(6).toISOString(), d(22).toISOString(), [
      asg('Dan', 'Gate', 6, 14),
      asg('Dan', 'Tower', 10, 14), // double booked with Gate
      asg('Eli', 'Gate', 14, 22, 1),
      asg('Eli', 'Tower', 22, 23), // starts the moment Gate ends: 0h rest, Gate needs 8h
    ]);
    expect(res.violations.some((v) => v.type === 'overlap')).toBe(true);
    expect(res.violations.some((v) => v.type === 'cooldown')).toBe(true);
    const notes = noteList(fake).map(([, text]) => text).join('\n');
    expect(notes).toMatch(/Dan is double-booked/);
    expect(notes).toMatch(/Only .*h rest/);

    const clean = await service.saveAssignments(d(6).toISOString(), d(22).toISOString(), [asg('Dan', 'Gate', 6, 14), asg('Eli', 'Tower', 6, 10)]);
    expect(clean.violations).toEqual([]);
    expect(noteList(fake)).toEqual([]); // earlier marks are cleared
  });

  it('checks a hand-edited schedule, marks it, and the marks disappear once it is fixed', async () => {
    const { service, fake } = await makeService(tabs({
      Schedule: [
        ['Date', 'Time', 'Gate', 'Tower'],
        ['', '', '', ''],
        ['10/03/2025', '06:00 - 10:00', 'Dan', 'Dan'], // typed Dan twice in the same row
        ['', '10:00 - 14:00', '', 'Eli'],
      ],
    }));
    const res = await service.checkSchedule();
    expect(res.total).toBe(3);
    expect(res.violations.filter((v) => v.type === 'overlap').length).toBeGreaterThanOrEqual(2);
    expect(res.marked).toBe(2);
    const keys = noteList(fake).map(([k]) => k).sort();
    expect(keys).toEqual(['2,2', '2,3']); // exactly the two Dan cells

    // fix the sheet by hand and re-check
    fake.tab('Schedule').values[2][3] = 'Avi';
    const again = await service.checkSchedule();
    expect(again.violations).toEqual([]);
    expect(noteList(fake)).toEqual([]);
  });

  it('flags unknown names, skills and unavailability typed straight into the sheet', async () => {
    const { service } = await makeService(tabs({
      Unavailabilities: [H.Unavailabilities, ['Eli', '2025-03-10 05:00', '2025-03-10 09:00', 'Doctor']],
      Soldiers: [H.Soldiers, ['Dan', '1', 'guard', 'Tower'], ['Eli', '2', 'guard', '']],
      Schedule: [['Date', 'Time', 'Gate', 'Tower'], ['', '', '', ''], ['10/03/2025', '06:00 - 10:00', 'Eli', 'Dan'], ['', '10:00 - 14:00', 'Ghost', '']],
    }));
    const res = await service.checkSchedule({ mark: false });
    const types = res.violations.map((v) => v.type).sort();
    expect(types).toEqual(['excluded', 'unavailability', 'unknown']);
  });

  it('with mark:false nothing is written', async () => {
    const { service, fake } = await makeService(tabs({ Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 10:00', 'Ghost']] }));
    const calls = fake.calls.length;
    await service.checkSchedule({ mark: false });
    expect(fake.calls.slice(calls).every(([m]) => m === 'GET')).toBe(true);
  });

  it('no Schedule tab means nothing to check', async () => {
    const { service } = await makeService(tabs());
    expect(await service.checkSchedule()).toEqual({ total: 0, violations: [], marked: 0 });
  });

  it('division colour rules written on save point at the real Soldiers columns', async () => {
    const { service, fake } = await makeService(tabs({ Soldiers: [['Skills', 'Division', 'Name'], ['guard', '1', 'Dan'], ['guard', '2', 'Eli']] }));
    await service.saveAssignments(d(6).toISOString(), d(22).toISOString(), [asg('Dan', 'Gate', 6, 14)]);
    const rules = fake.tab('Schedule').conditionalFormats.map((r) => r.booleanRule.condition.values[0].userEnteredValue);
    expect(rules.length).toBe(DIVISION_COLORS.length + 2); // 10 division colours + the 2 live-check rules
    expect(rules.some((f) => f.includes(`'Soldiers'!$C$2:$C`) && f.includes(`'Soldiers'!$B$2:$B`))).toBe(true);
  });
});
