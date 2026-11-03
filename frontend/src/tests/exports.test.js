import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduleRows, soldiersToCSV } from '../services/exportService';
import { makeService } from './helpers/fakeSheets';
import { gsheetsService } from '../services/gsheetsService';

const written = [];
vi.mock('xlsx', async (orig) => {
  const m = await orig();
  return { ...m, writeFile: (wb, name) => written.push({ name, rows: m.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]), sheet: wb.SheetNames[0] }) };
});

describe('scheduleRows', () => {
  const posts = [{ name: 'Gate', slots: [{ role_index: 0, skill: 'guard' }, { role_index: 1, skill: 'medic' }] }];
  it('accepts Date objects and ISO strings (regression: "e.split is not a function")', () => {
    const rows = scheduleRows([
      { post_name: 'Gate', role_id: 1, soldier_name: 'Eli', start: new Date(2025, 2, 10, 14), end: new Date(2025, 2, 10, 22) },
      { post_name: 'Gate', role_id: 0, soldier_name: 'Dan', start: '2025-03-10T06:00:00', end: '2025-03-10T14:00:00' },
    ], posts);
    expect(rows).toEqual([
      { Start: '2025-03-10 06:00', End: '2025-03-10 14:00', Post: 'Gate', Role: 'guard', Soldier: 'Dan' },
      { Start: '2025-03-10 14:00', End: '2025-03-10 22:00', Post: 'Gate', Role: 'medic', Soldier: 'Eli' },
    ]);
  });
  it('survives unknown posts and bad dates', () => {
    const rows = scheduleRows([{ post_name: 'Ghost', role_id: 2, soldier_name: 'X', start: 'nope', end: undefined }], posts);
    expect(rows[0]).toMatchObject({ Role: 'Role 3', Start: '', End: '', Soldier: 'X' });
  });
});

describe('soldiersToCSV', () => {
  it('quotes commas, quotes and line breaks, and keeps Hebrew and # intact', () => {
    const csv = soldiersToCSV([
      { name: 'Cohen, Dan', division: 1, skills: ['guard', 'medic'], excluded_posts: [] },
      { name: 'עמית "הגדול" #1', division: null, skills: ['רובאי'], excluded_posts: ['חמ"ל'] },
      { name: 'Line\nBreak', division: 2, skills: [], excluded_posts: [] },
    ]);
    expect(csv.split('\r\n')[0]).toBe('Name,Division,Skills,Excluded Posts');
    expect(csv).toContain('"Cohen, Dan",1,"guard, medic",');
    expect(csv).toContain('"עמית ""הגדול"" #1",,רובאי,"חמ""ל"');
    expect(csv).toContain('"Line\nBreak",2,,');
  });
});

describe('api.exportSchedule', () => {
  beforeEach(async () => {
    written.length = 0;
    const { fake } = await makeService({
      Soldiers: [['Name', 'Division', 'Skills'], ['Dan', '1', 'guard']],
      Posts: [['Name', 'Shift Length', 'Start Time', 'End Time', 'Slots', 'Is Active'], ['Gate', '8', '06:00', '06:00', 'guard', 'TRUE']],
      Unavailabilities: [['Soldier', 'Start', 'End', 'Reason']],
      Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 14:00', 'Dan']],
    });
    Object.assign(gsheetsService, { client: fake, spreadsheetId: 'test-sheet', CACHE_TTL: 0 });
  });

  it('exports saved assignments to an xlsx', async () => {
    const { exportSchedule } = await import('../services/api');
    await exportSchedule('2025-03-10T06:00:00', '2025-03-11T06:00:00');
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe('schedule_2025-03-10.xlsx');
    expect(written[0].rows).toEqual([{ Start: '2025-03-10 06:00', End: '2025-03-10 14:00', Post: 'Gate', Role: 'guard', Soldier: 'Dan' }]); // the row label says 06:00 - 14:00
  });

  it('explains when there is nothing to export instead of producing an empty file', async () => {
    const { exportSchedule } = await import('../services/api');
    await expect(exportSchedule('2030-01-01T06:00:00', '2030-01-02T06:00:00')).rejects.toThrow(/nothing to export/);
    expect(written).toHaveLength(0);
  });
});
