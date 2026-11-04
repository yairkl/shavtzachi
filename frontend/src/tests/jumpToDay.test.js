/**
 * Jumping to a day in a long schedule: header link, clickable day list, "open this day" link,
 * Name Box shortcuts and the app button's address.
 */
import { describe, it, expect } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { makeService } from './helpers/fakeSheets';
import { DAY_TAB, dayRanges, dayName, rowDays, MAX_JUMP_DAYS } from '../services/dayView';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = () => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', '']],
  Posts: [H.Posts, ['Gate', '8', '06:00', '06:00', '0', '1', 'guard', 'TRUE']],
  Unavailabilities: [H.Unavailabilities],
});
const at = (day, h) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (who, day, h1, h2) => ({ soldier_name: who, post_name: 'Gate', role_id: 0, start: at(day, h1), end: at(day, h2) });
const key = (day) => `2025-03-${String(day).padStart(2, '0')}`;

/** 100 days of one 8h shift each */
const hundredDays = () => Array.from({ length: 100 }, (_, i) => {
  const d = new Date(2025, 0, 1 + i);
  return { soldier_name: i % 2 ? 'Dan' : 'Eli', post_name: 'Gate', role_id: 0, start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6).toISOString(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 14).toISOString() };
});

describe('dayRanges', () => {
  it('lists every day with the rows it covers, for text and real dates', () => {
    const grid = [[], [], ['10/03/2025', 'a'], ['', 'b'], ['', 'c'], ['11/03/2025', 'd'], [45728, 'e'], ['', 'f']];
    expect(dayRanges(grid)).toEqual([
      { day: '2025-03-10', startRow: 3, endRow: 5 },
      { day: '2025-03-11', startRow: 6, endRow: 6 },
      { day: '2025-03-12', startRow: 7, endRow: 8 },
    ]);
    expect(rowDays([[], [], ['10/03/2025'], ['']], 3, 4)).toEqual(['2025-03-10', '2025-03-10']);
    expect(dayRanges([])).toEqual([]);
  });

  it('names are valid Name Box shortcuts', () => {
    expect(dayName('2025-03-10')).toBe('Day_2025_03_10');
    expect(dayName('2025-03-10')).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});

describe('jumping around a long schedule', () => {
  it('puts a "jump to a day" link in the Schedule header corner that leads to the clickable day list', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14)]);
    const a1 = fake.tab('Schedule').values[0][0];
    const dayViewGid = fake.tab(DAY_TAB).properties.sheetId;
    expect(a1).toMatch(new RegExp(`^=HYPERLINK\\("#gid=${dayViewGid}&range=[A-Z]+3","Date ▸ jump to a day"\\)$`));
  });

  it('the Schedule tab is still read correctly with that link in the corner', async () => {
    const { service } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14)]);
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    expect(back.map((x) => x.soldier_name).sort()).toEqual(['Dan', 'Eli']);
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 11, 14, 22)]); // and re-saving keeps working
    expect((await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00'))).toHaveLength(3);
  });

  it('lists every day in the Day View as a link to the first row of that day', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(13, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14)]);
    const scheduleGid = fake.tab('Schedule').properties.sheetId;
    const grid = fake.rows('Schedule');
    const expected = dayRanges(grid);
    expect(expected.map((d) => d.day)).toEqual([key(10), key(11), key(12)]);
    const links = fake.rows(DAY_TAB).flat().filter((c) => typeof c === 'string' && c.startsWith(`=HYPERLINK("#gid=${scheduleGid}&range=A`) && !c.includes('&"'));
    expect(links).toHaveLength(3);
    links.forEach((l, i) => expect(l).toBe(`=HYPERLINK("#gid=${scheduleGid}&range=A${expected[i].startRow}","${expected[i].day}")`));
    // and each row really is where that day starts in the Schedule tab
    expected.forEach((d) => expect(grid[d.startRow - 1][0]).toMatch(/^\d{2}\/\d{2}\/2025$/));
  });

  it('"Open <day> in the Schedule tab" follows the day chosen in the dropdown (evaluated)', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(13, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14)]);
    const scheduleGid = fake.tab('Schedule').properties.sheetId;
    const cell = fake.rows(DAY_TAB)[1][1];
    expect(cell).toContain(`HYPERLINK("#gid=${scheduleGid}&range=A"`);
    // evaluate the address part with the spreadsheet engine (HYPERLINK itself is a spreadsheet-only function)
    const swapped = fake.rows(DAY_TAB).map((r) => r.map((c) => (typeof c === 'string' ? c.replace(/HYPERLINK\(/g, 'CONCATENATE(') : c)));
    const hf = HyperFormula.buildFromSheets({ Schedule: fake.rows('Schedule'), [DAY_TAB]: swapped }, { licenseKey: 'gpl-v3' });
    const id = hf.getSheetId(DAY_TAB);
    const expectedRows = Object.fromEntries(dayRanges(fake.rows('Schedule')).map((d) => [d.day, d.startRow]));
    for (const day of [key(10), key(11), key(12)]) {
      hf.setCellContents({ sheet: id, row: 0, col: 1 }, day);
      const text = hf.getCellValue({ sheet: id, row: 1, col: 1 });
      expect(text).toBe(`#gid=${scheduleGid}&range=A${expectedRows[day]}Open ${day} in the Schedule tab ▸`);
    }
  });

  it('adds a Name Box shortcut per day covering exactly that day, and replaces them on every save', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(13, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14)]);
    expect(fake.namedRanges.map((n) => n.name)).toEqual(['Day_2025_03_10', 'Day_2025_03_11', 'Day_2025_03_12']);
    const grid = fake.rows('Schedule');
    for (const n of fake.namedRanges) {
      const day = n.name.replace('Day_', '').replace(/_/g, '-');
      const r = dayRanges(grid).find((d) => d.day === day);
      expect(n.range).toMatchObject({ sheetId: fake.tab('Schedule').properties.sheetId, startRowIndex: r.startRow - 1, endRowIndex: r.endRow, startColumnIndex: 0 });
    }
    await service.saveAssignments(at(10, 6), at(14, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14), asg('Eli', 13, 6, 14)]);
    expect(fake.namedRanges).toHaveLength(4); // replaced, not duplicated
    await service.saveAssignments(at(10, 6), at(14, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14), asg('Eli', 13, 6, 14)]);
    expect(fake.namedRanges).toHaveLength(4);
  });

  it('leaves named ranges the user made alone', async () => {
    const { service, fake } = await makeService(tabs());
    fake.namedRanges.push({ namedRangeId: 'mine', name: 'My_Range', range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 } });
    await service.saveAssignments(at(10, 6), at(12, 6), [asg('Dan', 10, 6, 14)]);
    expect(fake.namedRanges.some((n) => n.name === 'My_Range')).toBe(true);
  });

  it('works for a 120-day schedule: every day linked, the most recent shortcuts kept, nothing breaks', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(new Date(2025, 0, 1).toISOString(), new Date(2025, 4, 1).toISOString(), hundredDays());
    const grid = fake.rows('Schedule');
    const days = dayRanges(grid);
    expect(days).toHaveLength(120); // the saved window (Jan 1 - May 1) is the grid: empty days are rows too
    expect(fake.namedRanges).toHaveLength(Math.min(120, MAX_JUMP_DAYS));
    const links = fake.rows(DAY_TAB).flat().filter((c) => typeof c === 'string' && /^=HYPERLINK\("#gid=\d+&range=A\d+","\d{4}-\d{2}-\d{2}"\)$/.test(c));
    expect(links).toHaveLength(120);
    // the last link leads to the last day
    expect(links[119]).toContain(`range=A${days[119].startRow}`);
    expect(links[119]).toContain(days[119].day);
  });

  it('scheduleDayUrl opens the Schedule tab at the first row of the day', async () => {
    const { service, fake } = await makeService(tabs());
    await service.saveAssignments(at(10, 6), at(13, 6), [asg('Dan', 10, 6, 14), asg('Eli', 11, 6, 14), asg('Dan', 12, 6, 14)]);
    const res = await service.scheduleDayUrl(key(11));
    const row = dayRanges(fake.rows('Schedule')).find((d) => d.day === key(11)).startRow;
    expect(res.row).toBe(row);
    expect(res.url).toBe(`https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=${fake.tab('Schedule').properties.sheetId}&range=A${row}`);
    await expect(service.scheduleDayUrl('2030-01-01')).rejects.toThrow(/not in the saved schedule/);
  });

  it('scheduleDayUrl explains when nothing is saved yet', async () => {
    const { service } = await makeService(tabs());
    await expect(service.scheduleDayUrl(key(10))).rejects.toThrow(/no saved schedule/i);
  });
});
