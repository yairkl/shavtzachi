/**
 * The Day View tab as the app writes it, evaluated by a spreadsheet engine on what ended up in the (fake) spreadsheet.
 */
import { describe, it, expect } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { makeService } from './helpers/fakeSheets';
import { DAY_TAB, OUT_FIRST_ROW } from '../services/dayView';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = () => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '3', 'guard', '']],
  Posts: [H.Posts,
    ['Fort', '24', '06:00', '06:00', '0', '1', 'guard', 'TRUE'],
    ['Gate', '4', '06:00', '06:00', '0', '1', 'guard', 'TRUE'],
    ['Tower', '8', '06:00', '06:00', '0', '1', 'guard', 'TRUE'],
  ],
  Unavailabilities: [H.Unavailabilities],
});
const at = (day, h) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (who, post, d1, h1, d2, h2) => ({ soldier_name: who, post_name: post, role_id: 0, start: at(d1, h1), end: at(d2, h2) });

/** Evaluate the Day View exactly as it is stored in the fake spreadsheet. */
function engine(fake) {
  const hf = HyperFormula.buildFromSheets({ Schedule: fake.rows('Schedule'), [DAY_TAB]: fake.rows(DAY_TAB) }, { licenseKey: 'gpl-v3' });
  const id = hf.getSheetId(DAY_TAB);
  const val = (r1, c) => hf.getCellValue({ sheet: id, row: r1 - 1, col: c });
  const header = Array.from({ length: fake.rows(DAY_TAB)[2].length }, (_, c) => val(3, c)); // row 3 (evaluated): Date, Time, post names
  return {
    hf,
    pick: (day) => hf.setCellContents({ sheet: id, row: 0, col: 1 }, day),
    /** { time -> { post -> name } } for the rows of the chosen day */
    shown: () => {
      const out = {};
      for (let r = OUT_FIRST_ROW; val(r, 1) !== '' && val(r, 1) !== null; r++) {
        out[val(r, 1)] = Object.fromEntries(header.map((h, c) => [h, val(r, c)]).filter(([h, v], i) => i > 1 && h && h !== 'Days' && h !== 'Jump to a day' && v !== '' && v !== null));
      }
      return out;
    },
    count: () => val(1, 5),
  };
}

describe('Day View written by the app', () => {
  it('is created on save with a day dropdown, frozen header, hidden helper rows and division colours', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Fort', 10, 6, 11, 6), asg('Eli', 'Gate', 11, 6, 11, 10)]);
    const sheet = fake.tab(DAY_TAB);
    expect(sheet).toBeTruthy();
    expect(fake.rows(DAY_TAB)[0][1]).toMatch(/^2025-03-1[012]$/); // a valid day is selected (the saved window covers 10th to 12th)
    const dropdown = sheet.validations.find((v) => v.range.startRowIndex === 0 && v.range.startColumnIndex === 1);
    expect(dropdown.rule.condition.type).toBe('ONE_OF_RANGE');
    expect(dropdown.rule.showCustomUi).toBe(true);
    expect(sheet.properties.gridProperties.frozenRowCount).toBe(4);
    expect(sheet.dimensions.some((d) => d.properties.hiddenByUser === true && d.range.dimension === 'ROWS')).toBe(true);
    const rules = sheet.conditionalFormats.map((r) => r.booleanRule.condition.values[0].userEnteredValue);
    expect(rules.length).toBe(10);
    expect(rules[0]).toContain('C5'); // relative to the first cell of the table
  });

  it('shows the chosen day from the saved (merged) schedule, including a night shift that crosses midnight', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [
      asg('Dan', 'Tower', 10, 22, 11, 6),   // 22:00 -> 06:00 next day
      asg('Eli', 'Gate', 11, 8, 11, 12),
      asg('Avi', 'Fort', 11, 6, 12, 6),
    ]);
    const e = engine(fake);
    // the app picks the coarsest row height that fits all shifts: 2h here
    e.pick('2025-03-10');
    const day10 = e.shown();
    expect(day10['22:00 - 00:00']).toEqual({ Tower: 'Dan' });
    e.pick('2025-03-11');
    const day11 = e.shown();
    expect(day11['00:00 - 02:00']).toEqual({ Tower: 'Dan' });          // carried over from the evening before
    expect(day11['04:00 - 06:00']).toEqual({ Tower: 'Dan' });
    expect(day11['06:00 - 08:00']).toEqual({ Fort: 'Avi' });           // Dan's night shift ended at 06:00
    expect(day11['08:00 - 10:00']).toEqual({ Fort: 'Avi', Gate: 'Eli' });
    expect(day11['10:00 - 12:00']).toEqual({ Fort: 'Avi', Gate: 'Eli' });
    expect(day11['12:00 - 14:00']).toEqual({ Fort: 'Avi' });           // the 4h Gate shift is over, the 24h Fort shift goes on
  });

  it('keeps the day you picked when the schedule is saved again', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Gate', 10, 6, 10, 10), asg('Eli', 'Gate', 11, 6, 11, 10)]);
    fake.tab(DAY_TAB).values[0][1] = '2025-03-10'; // the user picks the 10th in the sheet
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Gate', 10, 6, 10, 10), asg('Eli', 'Gate', 11, 6, 11, 10), asg('Avi', 'Tower', 11, 14, 11, 22)]);
    expect(fake.rows(DAY_TAB)[0][1]).toBe('2025-03-10');
  });

  it('every refresh replaces the tab (no duplicate sheets, rules or validations)', async () => {
    const { service, fake } = await makeService(tabs());
    for (let i = 0; i < 3; i++) await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Gate', 10, 6, 10, 10)]);
    expect(fake.sheets.filter((s) => s.properties.title === DAY_TAB)).toHaveLength(1);
    expect(fake.tab(DAY_TAB).conditionalFormats).toHaveLength(10);
  });

  it('openDayView selects the requested day and returns a link to the tab', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Gate', 10, 6, 10, 10), asg('Eli', 'Gate', 11, 6, 11, 10)]);
    const res = await service.openDayView('2025-03-10');
    expect(res.selected).toBe('2025-03-10');
    expect(res.missing).toBe(false);
    expect(res.url).toBe(`https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=${fake.tab(DAY_TAB).properties.sheetId}`);
    expect(fake.rows(DAY_TAB)[0][1]).toBe('2025-03-10');
    const other = await service.openDayView('2030-01-01'); // not in the schedule
    expect(other.missing).toBe(true);
    expect(other.selected).toBe('2025-03-10');
  });

  it('builds the tab on demand when it does not exist yet (e.g. a schedule saved before this feature)', async () => {
    const { service, fake } = await makeService({
      ...tabs(),
      Schedule: [['Date', 'Time', 'Gate'], ['', '', ''], ['10/03/2025', '06:00 - 10:00', 'Dan'], ['', '10:00 - 14:00', ''], ['11/03/2025', '06:00 - 10:00', 'Eli']],
    });
    const res = await service.openDayView('2025-03-11');
    expect(res.selected).toBe('2025-03-11');
    const e = engine(fake);
    expect(e.shown()['06:00 - 10:00']).toEqual({ Gate: 'Eli' });
  });

  it('says what is wrong when there is nothing to show', async () => {
    const { service } = await makeService(tabs());
    await expect(service.openDayView()).rejects.toThrow(/no saved schedule/i);
  });

  it('a problem building the Day View never blocks saving', async () => {
    const { service, fake } = await makeService(tabs());
    service.refreshDayView = async () => { throw new Error('boom'); };
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 'Gate', 10, 6, 10, 10)]);
    expect(JSON.stringify(fake.rows('Schedule'))).toContain('Dan');
  });

  it('check schedule refreshes it too', async () => {
    const { service, fake } = await makeService({
      ...tabs(),
      Schedule: [['Date', 'Time', 'Gate'], ['', '', ''], ['10/03/2025', '06:00 - 10:00', 'Dan']],
    });
    await service.checkSchedule();
    expect(fake.tab(DAY_TAB)).toBeTruthy();
  });
});
