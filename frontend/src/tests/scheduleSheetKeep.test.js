import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { buildDivisionColoringRules } from '../services/gsheetsUtils';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = (extra = {}) => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '3', 'guard', '']],
  Posts: [H.Posts, ['Gate', '4', '06:00', '06:00', '0', '1', 'guard', 'TRUE'], ['Fort', '24', '06:00', '06:00', '0', '1', 'guard', 'TRUE']],
  Unavailabilities: [H.Unavailabilities],
  ...extra,
});
const at = (h, day = 10) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (soldier_name, post_name, h1, h2, day = 10) => ({ soldier_name, post_name, role_id: 0, start: at(h1, day), end: at(h2, day) });

describe('colour rules stay close to the cells in use (they used to cover 1000 x 100 cells and loaded slowly)', () => {
  it('limits every rule to the rows and columns of the written schedule', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10), asg('Eli', 'Gate', 10, 14), asg('Avi', 'Fort', 6, 30)]);
    const sheet = fake.tab('Schedule');
    expect(sheet.conditionalFormats).toHaveLength(5);
    const used = fake.rows('Schedule');
    for (const rule of sheet.conditionalFormats) {
      const r = rule.ranges[0];
      expect(r.startRowIndex).toBe(2);
      expect(r.endRowIndex).toBeLessThan(100);
      expect(r.endRowIndex).toBeGreaterThanOrEqual(used.length);
      expect(r.endColumnIndex).toBeLessThanOrEqual(10);
      expect(r.endColumnIndex).toBeGreaterThanOrEqual(Math.max(...used.map((x) => x.length)));
    }
  });

  it('later days are covered too (the rules grow with the schedule)', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10)]);
    const first = fake.tab('Schedule').conditionalFormats[0].ranges[0].endRowIndex;
    await service.saveAssignments(at(6, 14), at(30, 14), [asg('Eli', 'Gate', 6, 10, 14)]);
    const second = fake.tab('Schedule').conditionalFormats[0].ranges[0].endRowIndex;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeGreaterThanOrEqual(fake.rows('Schedule').length);
  });

  it('the builder keeps the old wide default when no extent is given', () => {
    const r = buildDivisionColoringRules(5)[0].addConditionalFormatRule.rule.ranges[0];
    expect([r.endRowIndex, r.endColumnIndex]).toEqual([1000, 100]);
    const small = buildDivisionColoringRules(5, { rows: 20, cols: 8 })[0].addConditionalFormatRule.rule.ranges[0];
    expect([small.endRowIndex, small.endColumnIndex]).toEqual([20, 8]);
  });
});

describe('a dropdown on the Schedule cells survives saving', () => {
  const dropdown = { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Soldiers'!$A$2:$A" }] }, strict: false, showCustomUi: true };

  it('is put back over the whole written grid after every save, even when the layout changes', async () => {
    const { service, fake } = await makeService(tabs({ Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 10:00', 'Dan']] }));
    fake.tab('Schedule').validations = [{ range: { sheetId: fake.tab('Schedule').properties.sheetId, startRowIndex: 2, endRowIndex: 40, startColumnIndex: 2, endColumnIndex: 10 }, rule: dropdown }];

    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10), asg('Eli', 'Fort', 6, 30)]);
    let restored = fake.tab('Schedule').validations.filter((v) => v !== fake.tab('Schedule').validations[0]);
    expect(restored).toHaveLength(1);
    expect(restored[0].rule).toEqual(dropdown);
    const used = fake.rows('Schedule');
    expect(restored[0].range).toMatchObject({ startRowIndex: 2, startColumnIndex: 2 });
    expect(restored[0].range.endRowIndex).toBeGreaterThanOrEqual(used.length);

    // another day, different shift lengths -> different layout: the dropdown still covers everything
    await service.saveAssignments(at(6, 12), at(30, 12), [asg('Avi', 'Fort', 6, 30, 12)]);
    const last = fake.tab('Schedule').validations[fake.tab('Schedule').validations.length - 1];
    expect(last.rule).toEqual(dropdown);
    expect(last.range.endRowIndex).toBeGreaterThanOrEqual(fake.rows('Schedule').length);
  });

  it('a dropdown set up by hand is kept as it is (not replaced by the default)', async () => {
    const { service, fake } = await makeService(tabs({ Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 10:00', 'Dan']] }));
    fake.tab('Schedule').validations = [{ range: { sheetId: fake.tab('Schedule').properties.sheetId, startRowIndex: 2, endRowIndex: 40, startColumnIndex: 2, endColumnIndex: 10 }, rule: dropdown }];
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10)]);
    const all = fake.tab('Schedule').validations;
    expect(all[all.length - 1].rule).toEqual(dropdown);
  });

  it('a failure while reading the dropdown does not block saving', async () => {
    const { service, fake } = await makeService(tabs({ Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 10:00', 'Dan']] }));
    const get = fake.get.bind(fake);
    fake.get = async (url) => { if (/dataValidation/.test(decodeURIComponent(url))) throw new Error('boom'); return get(url); };
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10)]);
    expect(JSON.stringify(fake.rows('Schedule'))).toContain('Dan'); // saved despite the failed read
  });
});

describe('diagnostic report', () => {
  it('describes how the Schedule tab is coloured and sized', async () => {
    const { service } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10)]);
    const report = await service.getDiagnosticReport();
    expect(report).toMatch(/grid: \d+ rows x \d+ columns; merged ranges: \d+/);
    expect(report).toMatch(/colour rule 1: rows 3-\d+, cols 3-\d+ ::/);
    expect(report).toContain('INDIRECT');
  });
});
