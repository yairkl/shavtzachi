/**
 * Live smoke test against the REAL Google Sheets API.
 *
 *   GOOGLE_ACCESS_TOKEN=ya29... npm run test:live
 *
 * Get a token by signing in to the app and copying localStorage.google_access_token from DevTools
 * (it lasts about an hour), or from https://developers.google.com/oauthplayground (Sheets API v4 +
 * Drive API v3 file scope).  It creates a throw-away spreadsheet in that account, runs the same
 * scenarios as the fake-based tests, then tries to delete it (needs a Drive write scope; if the token
 * cannot delete, the file "Shavtzachi live test ..." is left for you to remove).
 *
 * LIVE_DRYRUN=1 runs the very same test against the in-memory fake, to check the test itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { GSheetsService } from '../../services/gsheetsService';
import { makeService } from '../helpers/fakeSheets';
import { generateShifts, solveShiftAssignmentGreedy } from '../../lib/schedulerCore';

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const MODE = TOKEN ? 'live' : (process.env.LIVE_DRYRUN ? 'fake' : null);

const DAY = ['2025-03-10T06:00:00', '2025-03-11T06:00:00'];

describe.skipIf(!MODE)(`real Google Sheets behaviour (${MODE})`, () => {
  let service; let id;

  const put = (range, values) => service.client.put(`/${id}/values/${range}?valueInputOption=USER_ENTERED`, { values });

  beforeAll(async () => {
    if (MODE === 'live') {
      service = new GSheetsService();
      service.setAccessToken(TOKEN);
    } else {
      ({ service } = await makeService({}));
    }
    service.CACHE_TTL = 0;
    id = await service.createSpreadsheet(`Shavtzachi live test ${new Date().toISOString()}`);
    // Type values exactly as a person would: Google parses them (TRUE -> checkbox-like boolean, 6:00 -> time, dates -> date cells).
    await put("'Soldiers'!A2", [['Dan', '1', 'guard', ''], ['Eli', '2', 'Guard, medic', ''], ['Avi', '1', 'guard', ''], ['Ben', '2', 'guard', ''], ['Gil', '1', 'medic', '']]);
    await put("'Posts'!A2", [
      ['Gate', '8', '6:00', '6:00 PM', '0', '1', 'guard, guard', 'TRUE', '', ''],
      ['Clinic', '12', '0:00', '0:00', '', '', 'medic', '', '', ''],
      ['Off', '4', '', '', '', '', 'guard', 'FALSE', '', ''],
    ]);
    await put("'Unavailabilities'!A2", [['Ben', '2025-03-10 08:00', '2025-03-10 20:00', 'typed ISO'], ['Gil', '2025-03-10', '2025-03-10', 'date only']]);
  }, 60000);

  afterAll(async () => {
    if (MODE !== 'live' || !id) return;
    try {
      await axios.delete(`https://www.googleapis.com/drive/v3/files/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    } catch {
      console.warn(`Could not delete the test spreadsheet (token lacks Drive write access). Delete it manually: https://docs.google.com/spreadsheets/d/${id}`);
    }
  });

  it('understands values as Google actually returns them', async () => {
    service.clearCache();
    const { raw } = await service.fetchAllData();
    console.log('Google returned for Posts:', JSON.stringify(raw.Posts));
    console.log('Google returned for Unavailabilities:', JSON.stringify(raw.Unavailabilities));

    const posts = await service.getPosts();
    const byName = Object.fromEntries(posts.map((p) => [p.name, p]));
    expect(byName.Gate).toMatchObject({ is_active: true, start_time: '06:00', end_time: '18:00', shift_length_hours: 8 });
    expect(byName.Gate.slots).toHaveLength(2);
    expect(byName.Clinic).toMatchObject({ is_active: true, start_time: '00:00', end_time: '00:00' }); // blank flag -> active
    expect(byName.Off.is_active).toBe(false);

    const un = await service.getUnavailabilities();
    const ben = un.find((u) => u.soldier_name === 'Ben');
    expect(ben).toMatchObject({ start_datetime: '2025-03-10T08:00:00', end_datetime: '2025-03-10T20:00:00' });
    const gil = un.find((u) => u.soldier_name === 'Gil');
    expect(gil.start_datetime).toBe('2025-03-10T00:00:00');
    expect(gil.end_datetime).toBe('2025-03-11T00:00:00'); // a date-only end covers the whole day

    const health = await service.getHealth();
    expect(health.issues.filter((i) => i.level === 'error')).toEqual([]);
  }, 60000);

  const draft = async (win = DAY) => {
    const soldiers = await service.getSoldiers();
    const unav = await service.getUnavailabilities();
    soldiers.forEach((s) => { s.unavailabilities = unav.filter((u) => u.soldier_name === s.name); });
    const posts = (await service.getPosts()).filter((p) => p.is_active);
    const shifts = generateShifts(posts, win[0], win[1], true);
    const assignments = solveShiftAssignmentGreedy(shifts, soldiers, await service.getHistoryScores(win[0]), await service.getAssignmentsInRange(win[0], win[1]));
    return assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() }));
  };
  const keyOf = (a) => `${a.post_name}|${a.role_id}|${new Date(a.start).getTime()}|${new Date(a.end).getTime()}|${a.soldier_name}`;

  it('generates, saves and reads back every assignment (8h/12h shifts, multi-role post)', async () => {
    const a = await draft();
    expect(a.length).toBeGreaterThanOrEqual(7);
    await service.saveAssignments(DAY[0], DAY[1], a);
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-01-01T00:00:00', '2026-01-01T00:00:00');
    expect(back.map(keyOf).sort()).toEqual(a.map(keyOf).sort());
  }, 90000);

  it('keeps other days when saving a new day, and clearing a day removes only that day', async () => {
    const day2 = ['2025-03-11T06:00:00', '2025-03-12T06:00:00'];
    const before = await service.getAssignmentsInRange('2025-01-01T00:00:00', '2026-01-01T00:00:00');
    const a2 = await draft(day2);
    await service.saveAssignments(day2[0], day2[1], a2);
    const mid = await service.getAssignmentsInRange('2025-01-01T00:00:00', '2026-01-01T00:00:00');
    // A shift straddling the midnight/06:00 boundary belongs to both days and is replaced, not duplicated.
    const overlapsDay2 = (a) => new Date(a.start) < new Date(day2[1]) && new Date(a.end) > new Date(day2[0]);
    const kept = before.filter((a) => !overlapsDay2(a));
    expect(mid.map(keyOf).sort()).toEqual([...kept, ...a2].map(keyOf).sort());
    await service.saveAssignments(day2[0], day2[1], []);
    const after = await service.getAssignmentsInRange('2025-01-01T00:00:00', '2026-01-01T00:00:00');
    expect(after.map(keyOf).sort()).toEqual(kept.map(keyOf).sort());
  }, 120000);

  it('a failing batch changes nothing (Google applies batchUpdate atomically)', async () => {
    const before = JSON.stringify((await service.fetchAllData()).raw.Schedule);
    await expect(service.batchUpdate([
      { repeatCell: { range: { sheetId: (await service.fetchAllData()).metadata.find((m) => m.properties.title === 'Schedule').properties.sheetId }, cell: {}, fields: 'userEnteredValue' } },
      { updateSheetProperties: { properties: { sheetId: -1 }, fields: 'gridProperties(rowCount)' } },
    ])).rejects.toThrow();
    service.clearCache();
    expect(JSON.stringify((await service.fetchAllData()).raw.Schedule)).toBe(before);
  }, 60000);

  it('repairs a missing tab and a missing column without touching data', async () => {
    const { metadata } = await service.fetchAllData();
    const un = metadata.find((m) => m.properties.title === 'Unavailabilities');
    await service.batchUpdate([{ deleteSheet: { sheetId: un.properties.sheetId } }]);
    service.clearCache();
    expect((await service.getHealth()).missingTabs).toEqual(['Unavailabilities']);
    const changes = await service.ensureSchema({ force: true });
    expect(changes.join(' ')).toMatch(/Unavailabilities/);
    expect((await service.getHealth()).missingTabs).toEqual([]);
    expect((await service.getSoldiers()).map((s) => s.name)).toContain('Dan');
  }, 60000);

  it('grows the grid for a schedule wider than the default 26 columns', async () => {
    const wide = Array.from({ length: 30 }, (_, i) => [`W${i + 1}`, '12', '0:00', '0:00', '0', '1', 'guard', 'TRUE', '', '']);
    await service.appendRows("'Posts'!A:J", wide);
    service.clearCache();
    const win = ['2025-03-20T00:00:00', '2025-03-21T00:00:00'];
    // enough people so every wide post can be staffed
    await service.appendSoldiers(Array.from({ length: 40 }, (_, i) => ({ name: `Extra ${i + 1}`, division: 1, skills: ['guard'], excluded_posts: [] })));
    const a = await draft(win);
    await service.saveAssignments(win[0], win[1], a);
    service.clearCache();
    const back = await service.getAssignmentsInRange(win[0], win[1]);
    expect(back.map(keyOf).sort()).toEqual(a.map(keyOf).sort());
  }, 180000);
});
