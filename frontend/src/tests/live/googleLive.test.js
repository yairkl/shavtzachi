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
import { HyperFormula } from 'hyperformula';
import { makeService } from '../helpers/fakeSheets';
import { CHECK_TAB } from '../../services/liveChecks';
import { DAY_TAB } from '../../services/dayView';
import { generateShifts, solveShiftAssignmentGreedy } from '../../lib/schedulerCore';

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const MODE = TOKEN ? 'live' : (process.env.LIVE_DRYRUN ? 'fake' : null);

const DAY = ['2025-03-10T06:00:00', '2025-03-11T06:00:00'];

describe.skipIf(!MODE)(`real Google Sheets behaviour (${MODE})`, () => {
  let service; let id; let fake;

  const put = (range, values) => service.client.put(`/${id}/values/${range}?valueInputOption=USER_ENTERED`, { values });

  beforeAll(async () => {
    if (MODE === 'live') {
      service = new GSheetsService();
      service.setAccessToken(TOKEN);
    } else {
      ({ service, fake } = await makeService({}));
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


  /** The FLAGS layer of the helper tab as the spreadsheet computes it (Google for real, a formula engine in dry-run). */
  const computedFlags = async () => {
    service.clearCache();
    let rows;
    if (MODE === 'live') {
      rows = await service.fetchSheetValues(`'${CHECK_TAB}'!A1:Z600`);
    } else {
      const hf = HyperFormula.buildFromSheets({ Schedule: fake.rows('Schedule'), [CHECK_TAB]: fake.rows(CHECK_TAB) }, { licenseKey: 'gpl-v3' });
      rows = hf.getSheetValues(hf.getSheetId(CHECK_TAB)).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
    }
    const label = rows.findIndex((r) => r[0] === 'Problems (D, C)');
    expect(label).toBeGreaterThan(0);
    return rows.slice(label).flatMap((r) => r.slice(2)).filter((v) => v === 'D' || v === 'C');
  };

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

  it('accepts the formatting/validation rules and shows typed dates and times unambiguously', async () => {
    await service.applyFormatting(); // Google validates every formula and rule on write
    await service.applyFormatting(); // idempotent: replaces its own rules
    const { metadata } = await service.fetchAllData();
    const rules = (title) => metadata.find((m) => m.properties.title === title).conditionalFormats || [];
    const n = rules('Posts').length;
    expect(n).toBeGreaterThan(0);
    await service.applyFormatting();
    service.clearCache();
    expect((await service.fetchAllData()).metadata.find((m) => m.properties.title === 'Posts').conditionalFormats).toHaveLength(n);

    // Type like a person: with the ISO / 24h formats applied, Google hands the values back unambiguously.
    const un = (await service.fetchAllData()).raw.Unavailabilities.length;
    await put(`'Unavailabilities'!A${un + 1}`, [['Dan', '2025-03-12 09:30', '2025-03-12 17:00', 'typed after formatting']]);
    await put("'Posts'!A100", [['Typed', '6', '6:00 PM', '6:00 AM', '', '', 'guard', 'TRUE', '', '']]);
    service.clearCache();
    const { raw } = await service.fetchAllData();
    console.log('Typed unavailability as Google returns it:', JSON.stringify(raw.Unavailabilities[raw.Unavailabilities.length - 1]));
    const added = (await service.getUnavailabilities()).find((u) => u.reason === 'typed after formatting');
    expect(added).toMatchObject({ start_datetime: '2025-03-12T09:30:00', end_datetime: '2025-03-12T17:00:00' });
    const typed = (await service.getPosts()).find((p) => p.name === 'Typed');
    expect(typed).toMatchObject({ start_time: '18:00', end_time: '06:00', is_active: true });
    expect((await service.getHealth()).issues.some((i) => /not set up for editing/.test(i.message))).toBe(false);
  }, 120000);

  it('accepts the schedule rule marks and colour rules, and flags a double booking', async () => {
    const day = ['2025-03-25T06:00:00', '2025-03-26T06:00:00'];
    const clash = (role) => ({ soldier_name: 'Dan', post_name: 'Gate', role_id: role, start: '2025-03-25T06:00:00', end: '2025-03-25T14:00:00' });
    const saved = await service.saveAssignments(day[0], day[1], [clash(0), clash(1)]);
    expect(saved.violations.some((v) => v.type === 'overlap')).toBe(true);
    expect(saved.liveChecks.ok).toBe(true);
    // the formulas are evaluated by the spreadsheet: both clashing cells are flagged
    expect((await computedFlags()).filter((f) => f === 'D').length).toBeGreaterThanOrEqual(2);
    const { metadata } = await service.fetchAllData();
    const schedule = metadata.find((m) => m.properties.title === 'Schedule');
    expect(schedule.conditionalFormats.length).toBeGreaterThanOrEqual(11); // 10 division colours + double-booking rule
    const checked = await service.checkSchedule();
    expect(checked.violations.length).toBeGreaterThan(0);
    // a clean save removes the marks again
    await service.saveAssignments(day[0], day[1], []);
    expect((await service.checkSchedule()).violations.filter((v) => v.start && new Date(v.start) >= new Date(day[0]) && new Date(v.start) < new Date(day[1]))).toEqual([]);
  }, 120000);

  it('flags a double booking between shifts of different durations (12h Clinic vs 8h Gate starting on other rows)', async () => {
    const day = ['2025-03-27T00:00:00', '2025-03-28T00:00:00'];
    await service.saveAssignments(day[0], day[1], [
      { soldier_name: 'Gil', post_name: 'Clinic', role_id: 0, start: '2025-03-27T00:00:00', end: '2025-03-27T12:00:00' },
      { soldier_name: 'Gil', post_name: 'Gate', role_id: 0, start: '2025-03-27T06:00:00', end: '2025-03-27T14:00:00' },
      { soldier_name: 'Dan', post_name: 'Gate', role_id: 1, start: '2025-03-27T06:00:00', end: '2025-03-27T14:00:00' },
    ]);
    const flags = await computedFlags();
    expect(flags.filter((f) => f === 'D')).toHaveLength(2); // Gil on both, Dan fine
    await service.saveAssignments(day[0], day[1], []);
  }, 120000);

  it('Day View: the spreadsheet computes the chosen day, with a night shift carried over midnight', async () => {
    await service.saveAssignments('2025-03-29T00:00:00', '2025-03-31T00:00:00', [
      { soldier_name: 'Gil', post_name: 'Clinic', role_id: 0, start: '2025-03-29T22:00:00', end: '2025-03-30T10:00:00' },
      { soldier_name: 'Dan', post_name: 'Gate', role_id: 0, start: '2025-03-30T06:00:00', end: '2025-03-30T14:00:00' },
    ]);
    const res = await service.openDayView('2025-03-30');
    expect(res.selected).toBe('2025-03-30');
    service.clearCache();
    let rows;
    if (MODE === 'live') {
      rows = await service.fetchSheetValues(`'${DAY_TAB}'!A1:H40`);
    } else {
      const hf = HyperFormula.buildFromSheets({ Schedule: fake.rows('Schedule'), [DAY_TAB]: fake.rows(DAY_TAB) }, { licenseKey: 'gpl-v3' });
      rows = hf.getSheetValues(hf.getSheetId(DAY_TAB)).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
    }
    const shown = rows.slice(4).filter((r) => r[1]);
    const text = JSON.stringify(shown);
    expect(text).toContain('Gil'); // the Clinic night shift started the evening before and is still on duty after midnight
    expect(text).toContain('Dan');
    expect(shown.every((r) => !r[0] || r[0].includes('2025-03-30'))).toBe(true);
    // jumping: Name Box shortcuts exist for the days, and (on real Google) the day list shows clickable day names
    service.clearCache();
    const named = (await service.fetchAllData()).namedRanges.map((n) => n.name);
    expect(named).toEqual(expect.arrayContaining(['Day_2025_03_29', 'Day_2025_03_30']));
    if (MODE === 'live') {
      const grid = await service.fetchSheetValues(`'${DAY_TAB}'!A3:Z40`);
      const column = grid.map((r) => r.find((v) => /^2025-03-\d\d$/.test(v)));
      expect(column.filter(Boolean)).toEqual(expect.arrayContaining(['2025-03-29', '2025-03-30']));
      const corner = await service.fetchSheetValues("'Schedule'!A1:A1");
      expect(corner[0][0]).toContain('jump to a day');
    }
    await service.saveAssignments('2025-03-29T00:00:00', '2025-03-31T00:00:00', []);
  }, 120000);

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
