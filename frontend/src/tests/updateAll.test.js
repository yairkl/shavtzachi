/**
 * "Update whole spreadsheet": an existing, older spreadsheet gets every feature without losing anything.
 */
import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { DAY_TAB } from '../services/dayView';
import { CHECK_TAB } from '../services/liveChecks';

/** A spreadsheet as the very first versions left it: bare headers, 1/0 flags, a 4h schedule grid, nothing formatted. */
const oldSheet = () => ({
  Soldiers: [['Name', 'Division', 'Skills', 'Excluded Posts'], ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '3', 'guard,medic', '']],
  Posts: [['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
    ['Gate', '4', '06:00', '05:59', '8', '1', 'guard,guard', '1', '', ''],
    ['Fort', '24', '06:00', '05:59', '0', '1', 'guard', '1', '', '']],
  Unavailabilities: [['Soldier', 'Start', 'End', 'Reason'], ['Avi', '2025-03-11T08:00:00', '2025-03-11T20:00:00', 'Doctor']],
  Schedule: [
    ['Date', 'Time', 'Gate', '', 'Fort'],
    ['', '', 'Role 1', 'Role 2', ''],
    ['10/03/2025', '06:00 - 10:00', 'Dan', 'Eli', 'Avi'],
    ['', '10:00 - 14:00', 'Eli', 'Dan', ''],
    ['', '14:00 - 18:00', 'Dan', '', ''],
    ['11/03/2025', '06:00 - 10:00', 'Eli', 'Dan', ''],
  ],
});

const snapshot = async (service) => {
  service.clearCache();
  const a = await service.getAssignmentsInRange('2000-01-01T00:00:00', '2100-01-01T00:00:00');
  return a.map((x) => `${x.post_name}|${x.role_id}|${x.soldier_name}|${x.start.getTime()}|${x.end.getTime()}`).sort();
};

describe('applyAllFormatting', () => {
  it('brings an old spreadsheet up to date and keeps every assignment and every row of data', async () => {
    const { service, fake } = await makeService(oldSheet());
    const before = await snapshot(service);
    const dataBefore = ['Soldiers', 'Posts', 'Unavailabilities'].map((t) => JSON.stringify(fake.rows(t).slice(1)));
    expect(before.length).toBeGreaterThan(4);

    const res = await service.applyAllFormatting();
    expect(res.assignments).toBe(before.length);
    expect(res.steps.join('\n')).toMatch(/Formatted 3 data tab/);
    expect(res.steps.join('\n')).toMatch(/Rebuilt the Schedule tab/);

    // nothing lost
    expect(await snapshot(service)).toEqual(before);
    expect(['Soldiers', 'Posts', 'Unavailabilities'].map((t) => JSON.stringify(fake.rows(t).slice(1)))).toEqual(dataBefore);

    // data tabs: validation, notes, frozen header
    for (const t of ['Soldiers', 'Posts', 'Unavailabilities']) {
      expect(fake.tab(t).validations.length).toBeGreaterThan(0);
      expect(fake.tab(t).properties.gridProperties.frozenRowCount).toBe(1);
    }
    // schedule: colours, soldier dropdown, live-check rules
    const schedule = fake.tab('Schedule');
    expect(schedule.conditionalFormats.length).toBe(10 + 2);
    const kinds = new Set(schedule.validations.map((v) => v.rule.condition.type));
    expect(kinds.has('ONE_OF_RANGE')).toBe(true); // the plain soldier list over the whole schedule
    expect(kinds.has('ONE_OF_LIST')).toBe(true);  // and each slot's own list, best fit first
    // helper tabs, Day View, jump links and shortcuts
    expect(fake.tab(CHECK_TAB)).toBeTruthy();
    expect(fake.tab(DAY_TAB)).toBeTruthy();
    expect(fake.rows('Schedule')[0][0]).toContain('jump to a day');
    expect(fake.namedRanges.map((n) => n.name)).toEqual(['Day_2025_03_10', 'Day_2025_03_11']);
  });

  it('reports the schedule problems it finds (marked in the sheet) without touching the data', async () => {
    const sheet = oldSheet();
    sheet.Schedule[2][3] = 'Dan'; // Dan twice in the same row (Gate role 1 and role 2)
    const { service, fake } = await makeService(sheet);
    const res = await service.applyAllFormatting();
    expect(res.violations).toBeGreaterThan(0);
    expect(Object.keys(fake.tab('Schedule').notes || {}).length).toBeGreaterThan(0);
  });

  it('can be run again and again: nothing is duplicated and nothing changes', async () => {
    const { service, fake } = await makeService(oldSheet());
    await service.applyAllFormatting();
    const before = await snapshot(service);
    const counts = () => ({
      sheets: fake.sheets.length,
      rules: ['Soldiers', 'Posts', 'Unavailabilities', 'Schedule', DAY_TAB].map((t) => fake.tab(t).conditionalFormats.length),
      names: fake.namedRanges.length,
    });
    const first = counts();
    await service.applyAllFormatting();
    await service.applyAllFormatting();
    expect(counts()).toEqual(first);
    expect(await snapshot(service)).toEqual(before);
  });

  it('keeps a dropdown, colour rules and named ranges that the user made themselves', async () => {
    const { service, fake } = await makeService(oldSheet());
    const mine = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Dan' }, { userEnteredValue: 'Eli' }] }, strict: true, showCustomUi: true };
    const sheetId = fake.tab('Schedule').properties.sheetId;
    fake.tab('Schedule').validations = [{ range: { sheetId, startRowIndex: 2, endRowIndex: 20, startColumnIndex: 2, endColumnIndex: 6 }, rule: mine }];
    const foreign = { ranges: [{ sheetId: fake.tab('Soldiers').properties.sheetId, startRowIndex: 1, endRowIndex: 30, startColumnIndex: 0, endColumnIndex: 1 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=A2="VIP"' }] }, format: { backgroundColor: { red: 0, green: 1, blue: 0 } } } };
    fake.tab('Soldiers').conditionalFormats.push(foreign);
    fake.namedRanges.push({ namedRangeId: 'mine', name: 'My_Range', range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 } });
    await service.applyAllFormatting();
    const v = fake.tab('Schedule').validations;
    expect(v[v.length - 1].rule).toEqual(mine); // the user's dropdown is carried over the whole schedule, not replaced
    expect(fake.tab('Soldiers').conditionalFormats).toContainEqual(foreign);
    expect(fake.namedRanges.some((n) => n.name === 'My_Range')).toBe(true);
  });

  it('a spreadsheet with no saved schedule yet is formatted and told what happens at the first save', async () => {
    const sheet = oldSheet();
    delete sheet.Schedule;
    const { service, fake } = await makeService(sheet);
    const res = await service.applyAllFormatting();
    expect(res.assignments).toBe(0);
    expect(res.steps.join('\n')).toMatch(/first time you save/);
    expect(fake.tab('Posts').validations.length).toBeGreaterThan(0);
    expect(fake.tab('Schedule')).toBeUndefined();
  });

  it('a spreadsheet missing tabs and columns is repaired first', async () => {
    const { service, fake } = await makeService({ Soldiers: [['Name'], ['Dan']], Posts: [['Name', 'Slots'], ['Gate', 'guard']] });
    const res = await service.applyAllFormatting();
    expect(res.steps.join('\n')).toMatch(/Unavailabilities/);
    expect(fake.rows('Soldiers')[0]).toEqual(['Name', 'Division', 'Skills', 'Excluded Posts']);
    expect(fake.rows('Soldiers')[1]).toEqual(['Dan']);
  });
});
