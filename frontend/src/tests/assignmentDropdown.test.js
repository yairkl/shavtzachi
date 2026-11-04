import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = (extra = {}) => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', '']],
  Posts: [H.Posts, ['Gate', '8', '06:00', '06:00', '0', '1', 'guard', 'TRUE']],
  Unavailabilities: [H.Unavailabilities],
  ...extra,
});
const at = (h, day = 10) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (who, h1, h2, day = 10) => ({ soldier_name: who, post_name: 'Gate', role_id: 0, start: at(h1, day), end: at(h2, day) });
const lastRule = (fake) => { const v = fake.tab('Schedule').validations; return v[v.length - 1]; };

describe('assignment dropdown in the Schedule cells', () => {
  it('every save puts a soldier dropdown over the whole schedule', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14)]);
    const v = lastRule(fake);
    expect(v.rule.condition).toEqual({ type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Soldiers'!$A$2:$A" }] });
    expect(v.rule.showCustomUi).toBe(true);
    expect(v.rule.strict).toBe(false); // typing something else is still allowed
    const used = fake.rows('Schedule');
    expect(v.range).toMatchObject({ startRowIndex: 2, startColumnIndex: 2 });
    expect(v.range.endRowIndex).toBeGreaterThanOrEqual(used.length);
    expect(v.range.endColumnIndex).toBeGreaterThanOrEqual(Math.max(...used.map((r) => r.length)));
  });

  it('covers empty slots too, so an unassigned slot can be filled from the list', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14), asg('Eli', 14, 22)]);
    const v = lastRule(fake);
    // the schedule has rows after the last shift's row too (e.g. the 22:00 row): all inside the dropdown range
    expect(v.range.endRowIndex).toBeGreaterThanOrEqual(fake.rows('Schedule').length);
  });

  it('follows the Soldiers name column when the columns are reordered or the tab is renamed', async () => {
    const { service, fake } = await makeService(tabs({ Soldiers: [['Skills', 'Division', 'Name'], ['guard', '1', 'Dan'], ['guard', '2', 'Eli']] }));
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14)]);
    expect(lastRule(fake).rule.condition.values[0].userEnteredValue).toBe("='Soldiers'!$C$2:$C");
  });

  it('is re-applied after every save and grows with the schedule', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14)]);
    const first = lastRule(fake).range.endRowIndex;
    await service.saveAssignments(at(6, 14), at(30, 14), [asg('Eli', 6, 14, 14)]);
    expect(lastRule(fake).range.endRowIndex).toBeGreaterThan(first);
  });

  it('a Soldiers tab without a Name column: saving adds the missing column and the dropdown points at it', async () => {
    const { service, fake } = await makeService(tabs({ Soldiers: [['Division'], ['1']] }));
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14)]);
    expect(fake.rows('Soldiers')[0]).toEqual(['Division', 'Name', 'Skills', 'Excluded Posts']);
    expect(lastRule(fake).rule.condition.values[0].userEnteredValue).toBe("='Soldiers'!$B$2:$B");
    expect(JSON.stringify(fake.rows('Schedule'))).toContain('Dan');
  });

  it('no Soldiers tab at all: no dropdown, and saving still works', async () => {
    const { service, fake } = await makeService({ Posts: tabs().Posts, Unavailabilities: tabs().Unavailabilities });
    await service.saveAssignments(at(6), at(30), [asg('Dan', 6, 14)]);
    expect(JSON.stringify(fake.rows('Schedule'))).toContain('Dan');
  });

  it('a name picked into a single cell lasts for the whole shift of its post (8h = two 4h rows)', async () => {
    const { service } = await makeService(tabs({
      Schedule: [
        ['Date', 'Time', 'Gate'], ['', '', ''],
        ['10/03/2025', '06:00 - 10:00', 'Dan'], // picked from the dropdown, not merged
        ['', '10:00 - 14:00', ''],
        ['', '14:00 - 18:00', 'Eli'], // next one is already there: the first must stop before it
        ['', '18:00 - 22:00', ''],
      ],
    }));
    service.clearCache();
    const found = await service.getAssignmentsInRange('2025-03-10T00:00:00', '2025-03-11T00:00:00');
    const dan = found.find((a) => a.soldier_name === 'Dan');
    expect(dan.end.getHours()).toBe(14); // 06:00 -> 14:00, not just 06:00 -> 10:00
    const eli = found.find((a) => a.soldier_name === 'Eli');
    expect(eli.start.getHours()).toBe(14);
    expect(eli.end.getHours()).toBe(22);
  });

  it('a picked name never runs into the next filled cell', async () => {
    const { service } = await makeService(tabs({
      Schedule: [
        ['Date', 'Time', 'Gate'], ['', '', ''],
        ['10/03/2025', '06:00 - 10:00', 'Dan'],
        ['', '10:00 - 14:00', 'Eli'], // directly after: Dan keeps only his own row
      ],
    }));
    const found = await service.getAssignmentsInRange('2025-03-10T00:00:00', '2025-03-11T00:00:00');
    expect(found.find((a) => a.soldier_name === 'Dan').end.getHours()).toBe(10);
  });
});
