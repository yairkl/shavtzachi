/**
 * End to end: spreadsheet (as a user may have left it) -> model -> shifts -> assignments -> saved schedule -> read back.
 * Uses an in-memory fake of the Google Sheets API.
 */
import { describe, it, expect } from 'vitest';
import { makeService, FakeSheets } from './helpers/fakeSheets';
import { buildScheduleRequests } from '../services/gsheetsUtils';
import { generateShifts, solveShiftAssignmentGreedy, diagnoseInputs, summarizeUnfilled } from '../lib/schedulerCore';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const DAY = ['2025-03-10T00:00:00', '2025-03-11T00:00:00'];

/** Mirror of what the app does when the user clicks "Generate". */
async function draft(service, [start, end] = DAY) {
  const soldiers = await service.getSoldiers();
  const unav = await service.getUnavailabilities();
  soldiers.forEach((s) => { s.unavailabilities = unav.filter((u) => u.soldier_name === s.name); });
  const posts = (await service.getPosts()).filter((p) => p.is_active);
  const shifts = generateShifts(posts, start, end, true);
  const history = await service.getHistoryScores(start);
  const existing = await service.getAssignmentsInRange(start, end);
  const assignments = solveShiftAssignmentGreedy(shifts, soldiers, history, existing);
  return { soldiers, posts, shifts, assignments };
}

const people = (n, skill = 'guard') => Array.from({ length: n }, (_, i) => [`Soldier ${i + 1}`, String((i % 2) + 1), skill, '']);

describe('imported / hand-edited spreadsheets', () => {
  it('generates and assigns shifts when "Is Active" is TRUE, blank or missing and times are loosely formatted', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ...people(4)],
      Posts: [
        H.Posts,
        ['Gate', '6h', '6:00', '18:00:00', '', '', 'guard', 'TRUE', '', ''],
        ['Tower', '12', '6 PM', '6 AM', '0', '1', 'Guard', '', '', ''],
        ['Office', '8', '', '', '', '', 'guard', 'FALSE', '', ''],
      ],
      Unavailabilities: [H.Unavailabilities],
    });
    const { shifts, assignments } = await draft(service);
    const names = new Set(shifts.map((s) => s.post_name));
    expect(names).toEqual(new Set(['Gate', 'Tower']));
    expect(shifts.filter((s) => s.post_name === 'Gate')).toHaveLength(2); // 06-12, 12-18
    expect(shifts.length).toBeGreaterThan(2);
    expect(assignments.length).toBe(shifts.length);
    const health = await service.getHealth();
    expect(health.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('works with reordered columns, extra columns and different header spelling', async () => {
    const { service } = await makeService({
      Soldiers: [['notes', 'skills', 'NAME'], ['x', 'guard', 'Dan'], ['y', 'guard', 'Eli']],
      posts: [['slots', 'active', 'Shift-Length', 'name', 'start time', 'end time'], ['guard', 'yes', '12', 'Gate', '00:00', '00:00']],
      Unavailabilities: [['Reason', 'End', 'Start', 'Soldier'], ['leave', '2025-03-10 23:00', '2025-03-10 00:00', 'Dan']],
    });
    const { shifts, assignments } = await draft(service);
    expect(shifts).toHaveLength(2);
    expect(assignments).toHaveLength(2);
    // Dan is on leave the whole day, so Eli covers both shifts.
    expect(new Set(assignments.map((a) => a.soldier_name))).toEqual(new Set(['Eli']));
  });

  it('does not throw when tabs are missing, and tells the user what to fix', async () => {
    const { service } = await makeService({ Notes: [['hello']] });
    const health = await service.getHealth();
    expect(health.missingTabs).toEqual(['Soldiers', 'Posts', 'Unavailabilities']);
    expect(health.issues.some((i) => i.level === 'error' && i.sheet === 'Soldiers')).toBe(true);
    const { shifts, assignments } = await draft(service);
    expect(shifts).toEqual([]);
    expect(assignments).toEqual([]);
    expect(diagnoseInputs([], [], DAY[0], DAY[1]).map((d) => d.message).join(' ')).toMatch(/no soldiers.*no posts/i);
  });

  it('repairs the structure on demand: creates tabs, headers and missing columns without touching data', async () => {
    const { service, fake } = await makeService({
      Soldiers: [['Name', 'Skills'], ['Dan', 'guard']],
      Posts: [['Name', 'Slots'], ['Gate', 'guard']],
    });
    const changes = await service.ensureSchema({ force: true });
    expect(changes.join('\n')).toMatch(/Created the "Unavailabilities" tab/);
    expect(fake.rows('Soldiers')[0]).toEqual(['Name', 'Skills', 'Division', 'Excluded Posts']);
    expect(fake.rows('Soldiers')[1]).toEqual(['Dan', 'guard']);
    expect(fake.rows('Posts')[0].slice(0, 2)).toEqual(['Name', 'Slots']);
    expect(fake.rows('Posts')[0]).toContain('Is Active');
    expect(fake.rows('Posts')[1]).toEqual(['Gate', 'guard']);
    expect(fake.rows('Unavailabilities')[0]).toEqual(H.Unavailabilities);
    // running it again changes nothing
    expect(await service.ensureSchema({ force: true })).toEqual([]);
  });

  it('writes new rows into the right columns when the sheet was reordered', async () => {
    const { service, fake } = await makeService({
      Soldiers: [['Skills', 'Name', 'Division', 'Excluded Posts'], ['guard', 'Dan', '1', '']],
      Posts: [H.Posts],
      Unavailabilities: [H.Unavailabilities],
    });
    await service.createSoldier({ name: 'Eli', division: 2, skills: ['guard', 'medic'], excluded_posts: [] });
    expect(fake.rows('Soldiers')[2]).toEqual(['guard, medic', 'Eli', '2']);
    await service.updateSoldier(1, { name: 'Daniel', division: 1, skills: ['guard'], excluded_posts: [] });
    expect(fake.rows('Soldiers')[1]).toEqual(['guard', 'Daniel', '1']);
    await service.deleteSoldier(2);
    expect((await service.getSoldiers()).map((s) => s.name)).toEqual(['Daniel']);
  });

  it('keeps unrelated columns when updating a row', async () => {
    const { service, fake } = await makeService({
      Soldiers: [['Name', 'Division', 'Skills', 'Excluded Posts', 'Phone'], ['Dan', '1', 'guard', '', '555-1234']],
      Posts: [H.Posts], Unavailabilities: [H.Unavailabilities],
    });
    await service.updateSoldier(1, { name: 'Dan', division: 2, skills: ['guard', 'medic'], excluded_posts: [] });
    expect(fake.rows('Soldiers')[1]).toEqual(['Dan', '2', 'guard, medic', '', '555-1234']);
  });

  it('rejects duplicates and blank names with a clear error instead of corrupting the sheet', async () => {
    const { service, fake } = await makeService({ Soldiers: [H.Soldiers, ['Dan', '', 'guard', '']], Posts: [H.Posts, ['Gate', '4', '', '', '', '', 'guard', '1']], Unavailabilities: [H.Unavailabilities] });
    await expect(service.createSoldier({ name: ' dan ', skills: [], excluded_posts: [] })).rejects.toThrow(/already exists/);
    await expect(service.createSoldier({ name: '  ', skills: [], excluded_posts: [] })).rejects.toThrow(/needs a name/);
    await expect(service.createPost({ name: 'GATE', slots: [] })).rejects.toThrow(/already exists/);
    await expect(service.updatePost('Missing', { name: 'x', slots: [] })).rejects.toThrow(/not found/);
    await expect(service.createUnavailability({ soldier_id: 99, start_datetime: 'a', end_datetime: 'b' })).rejects.toThrow(/Soldier not found/);
    expect(fake.rows('Soldiers')).toHaveLength(2);
  });

  it('creates posts that read back identically (round trip)', async () => {
    const { service } = await makeService({ Soldiers: [H.Soldiers, ...people(2)], Posts: [H.Posts], Unavailabilities: [H.Unavailabilities] });
    await service.createPost({ name: 'Gate', shift_length_hours: 4, start_time: '06:00', end_time: '22:00', cooldown_hours: 8, intensity_weight: 1.5, slots: ['guard', 'guard'], is_active: true });
    await service.createPost({ name: 'Off', shift_length_hours: 4, start_time: '06:00', end_time: '22:00', cooldown_hours: 0, intensity_weight: 1, slots: ['guard'], is_active: false, active_from: '2025-03-01T00:00:00', active_until: '2025-04-01T00:00:00' });
    const posts = await service.getPosts();
    expect(posts[0]).toMatchObject({ name: 'Gate', shift_length_hours: 4, start_time: '06:00', end_time: '22:00', cooldown_hours: 8, intensity_weight: 1.5, is_active: true });
    expect(posts[0].slots.map((s) => s.skill)).toEqual(['guard', 'guard']);
    expect(posts[1]).toMatchObject({ name: 'Off', is_active: false, active_from: '2025-03-01T00:00:00', active_until: '2025-04-01T00:00:00' });
  });

  it('bulk-imports soldiers in one request', async () => {
    const { service, fake } = await makeService({ Soldiers: [H.Soldiers], Posts: [H.Posts], Unavailabilities: [H.Unavailabilities] });
    await service.appendSoldiers([
      { name: 'A', division: 1, skills: ['x'], excluded_posts: [] },
      { name: 'B', division: null, skills: ['x', 'y'], excluded_posts: ['Gate'] },
    ]);
    expect(fake.rows('Soldiers').slice(1)).toEqual([['A', '1', 'x'], ['B', '', 'x, y', 'Gate']]);
    expect(fake.calls.filter(([m, u]) => m === 'POST' && /:append/.test(u))).toHaveLength(1);
  });
});

describe('spreadsheet locale', () => {
  it('a US-locale sheet with hand-typed 3/4/2025 means March 4th; the same text elsewhere means 3 April', async () => {
    const tabs = () => ({
      Soldiers: [H.Soldiers, ['Dan', '', 'guard', '']],
      Posts: [H.Posts, ['Gate', '4', '00:00', '00:00', '0', '1', 'guard', '1', '3/4/2025', '']],
      Unavailabilities: [H.Unavailabilities, ['Dan', '3/4/2025 8:00:00', '3/4/2025 12:00:00', '']],
    });
    const us = await makeService(tabs(), { locale: 'en_US' });
    expect((await us.service.getUnavailabilities())[0].start_datetime).toBe('2025-03-04T08:00:00');
    expect((await us.service.getPosts())[0].active_from).toBe('2025-03-04T00:00:00');
    const il = await makeService(tabs(), { locale: 'en_GB' });
    expect((await il.service.getUnavailabilities())[0].start_datetime).toBe('2025-04-03T08:00:00');
  });
});

describe('schedule tab', () => {
  const base = () => ({
    Soldiers: [H.Soldiers, ...people(3)],
    Posts: [H.Posts, ['Gate', '4', '00:00', '00:00', '0', '1', 'guard', '1', '', '']],
    Unavailabilities: [H.Unavailabilities],
  });

  it('saves a draft and reads the same assignments back; other days are preserved', async () => {
    const { service, fake } = await makeService(base());
    const d1 = await draft(service, ['2025-03-10T00:00:00', '2025-03-11T00:00:00']);
    expect(d1.assignments).toHaveLength(6);
    await service.saveAssignments('2025-03-10T00:00:00', '2025-03-11T00:00:00', d1.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() })));
    const back = await service.getAssignmentsInRange('2025-03-10T00:00:00', '2025-03-11T00:00:00');
    expect(back).toHaveLength(6);
    expect(back.map((a) => `${a.soldier_name}|${a.start.getTime()}`).sort()).toEqual(d1.assignments.map((a) => `${a.soldier_name}|${a.start.getTime()}`).sort());

    const d2 = await draft(service, ['2025-03-11T00:00:00', '2025-03-12T00:00:00']);
    await service.saveAssignments('2025-03-11T00:00:00', '2025-03-12T00:00:00', d2.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() })));
    const all = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-03-30T00:00:00');
    expect(all).toHaveLength(12);
    expect(fake.tab('Schedule').merges.length).toBeGreaterThan(0);

    // saving an empty day removes only that day
    await service.saveAssignments('2025-03-11T00:00:00', '2025-03-12T00:00:00', []);
    expect(await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-03-30T00:00:00')).toHaveLength(6);
  });

  it('keeps every role of a multi-slot post, even when it is the last column (Google trims trailing blanks)', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ...people(4)],
      Posts: [H.Posts, ['Zulu', '24', '00:00', '00:00', '0', '1', 'guard, guard, guard', '1', '', '']],
      Unavailabilities: [H.Unavailabilities],
    });
    const d = await draft(service);
    expect(d.assignments).toHaveLength(3);
    await service.saveAssignments(DAY[0], DAY[1], d.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() })));
    const back = await service.getAssignmentsInRange(DAY[0], DAY[1]);
    expect(back.map((a) => a.role_id).sort()).toEqual([0, 1, 2]);
  });

  it('is atomic: a failed save leaves the existing schedule untouched', async () => {
    const { service, fake } = await makeService(base());
    const d = await draft(service);
    const payload = d.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() }));
    await service.saveAssignments(DAY[0], DAY[1], payload);
    const before = JSON.stringify(fake.rows('Schedule'));
    fake.failNextBatch = Object.assign(new Error('boom'), { response: { status: 500, data: { error: { message: 'boom' } } } });
    await expect(service.saveAssignments(DAY[0], DAY[1], payload.slice(0, 2))).rejects.toThrow();
    expect(JSON.stringify(fake.rows('Schedule'))).toBe(before);
    expect(await service.getAssignmentsInRange(DAY[0], DAY[1])).toHaveLength(6);
  });

  it('grows the sheet grid when the schedule is bigger than the default 26 columns / 1000 rows', async () => {
    const posts = Array.from({ length: 30 }, (_, i) => [`Post ${i + 1}`, '12', '00:00', '00:00', '0', '1', 'guard', '1', '', '']);
    const { service, fake } = await makeService({
      Soldiers: [H.Soldiers, ...people(40)], Posts: [H.Posts, ...posts], Unavailabilities: [H.Unavailabilities],
    });
    const d = await draft(service);
    expect(d.assignments.length).toBe(60);
    await service.saveAssignments(DAY[0], DAY[1], d.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() })));
    expect(fake.tab('Schedule').properties.gridProperties.columnCount).toBeGreaterThanOrEqual(32);
    expect(await service.getAssignmentsInRange(DAY[0], DAY[1])).toHaveLength(60);
  });

  it('reads a hand-written schedule: 1-digit hours, unknown people and posts, junk rows', async () => {
    const { service } = await makeService({
      ...base(),
      Schedule: [
        ['Date', 'Time', 'Gate', ''],
        ['', '', 'Role 1', 'Role 2'],
        ['10/03/2025', '6:00', 'soldier 1', 'Stranger'],
        ['', '7:00', '', ''],
        ['garbage', 'row', 'soldier 2', ''],
        ['10/03/2025', '8:00 - 9:00', 'Soldier 2', ''],
      ],
    });
    const found = await service.getAssignmentsInRange('2025-03-10T00:00:00', '2025-03-11T00:00:00');
    expect(found.map((a) => a.soldier_name).sort()).toEqual(['Soldier 1', 'Soldier 2', 'Stranger']);
    const health = await service.getHealth();
    expect(health.issues.some((i) => /Stranger/.test(i.message))).toBe(true);
    const scores = await service.getHistoryScores('2025-03-11T00:00:00');
    expect(Object.keys(scores).length).toBeGreaterThan(0);
  });

  it('does not crash on a completely nonsensical Schedule tab', async () => {
    const { service } = await makeService({ ...base(), Schedule: [['a'], ['b'], ['c', 'd', 'e'], [null, undefined, 5]] });
    await expect(service.getAssignmentsInRange(DAY[0], DAY[1])).resolves.toEqual([]);
    await expect(service.getHistoryScores()).resolves.toEqual({});
  });

  it('adopts existing assignments when drafting (no double-booking across the save boundary)', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ['Dan', '', 'guard', ''], ['Eli', '', 'guard', '']],
      Posts: [H.Posts, ['Gate', '4', '00:00', '00:00', '0', '1', 'guard', '1', '', '']],
      Unavailabilities: [H.Unavailabilities],
    });
    const d = await draft(service);
    expect(d.assignments).toHaveLength(6);
    // never the same soldier twice in the same shift window
    const seen = new Set();
    for (const a of d.assignments) {
      const k = `${a.soldier_name}|${a.start.getTime()}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

describe('schedule round trip with irregular shift times (regression: shifts not on the 4h grid were silently dropped)', () => {
  const roundTrip = async (posts, nSoldiers, window = ['2025-03-10T06:00:00', '2025-03-11T06:00:00']) => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ...people(nSoldiers)],
      Posts: [H.Posts, ...posts],
      Unavailabilities: [H.Unavailabilities],
    });
    const d = await draft(service, window);
    const payload = d.assignments.map((a) => ({ ...a, start: a.start.toISOString(), end: a.end.toISOString() }));
    await service.saveAssignments(window[0], window[1], payload);
    const back = await service.getAssignmentsInRange('2025-01-01T00:00:00', '2026-01-01T00:00:00');
    const key = (a) => `${a.post_name}|${a.role_id}|${new Date(a.start).getTime()}|${new Date(a.end).getTime()}|${a.soldier_name}`;
    return { saved: d.assignments.map(key).sort(), back: back.map(key).sort(), d };
  };

  it('8h and 12h shifts starting at 06:00', async () => {
    const { saved, back } = await roundTrip([
      ['Gate', '8', '06:00', '06:00', '0', '1', 'guard, guard', '1', '', ''],
      ['Clinic', '12', '00:00', '00:00', '0', '1', 'guard', '1', '', ''],
    ], 6);
    expect(saved.length).toBeGreaterThanOrEqual(7);
    expect(back).toEqual(saved);
  });

  it('3h, 5h and 90-minute shifts and a 20-minute offset', async () => {
    const { saved, back } = await roundTrip([
      ['A', '3', '06:20', '06:20', '0', '1', 'guard', '1', '', ''],
      ['B', '5', '07:00', '07:00', '0', '1', 'guard', '1', '', ''],
      ['C', '1.5', '08:00', '08:00', '0', '1', 'guard', '1', '', ''],
    ], 12);
    expect(saved.length).toBeGreaterThan(20);
    expect(back).toEqual(saved);
  });

  it('random posts and rosters always come back exactly as saved', async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let run = 0; run < 12; run++) {
      const posts = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => {
        const len = [1, 1.5, 2, 3, 4, 5, 6, 8, 12][Math.floor(rnd() * 9)];
        const start = `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${['00', '15', '30', '45'][Math.floor(rnd() * 4)]}`;
        const slots = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => 'guard').join(', ');
        return [`Post ${i + 1}`, String(len), start, start, String(Math.floor(rnd() * 3)), '1', slots, '1', '', ''];
      });
      const { saved, back } = await roundTrip(posts, 25);
      expect(back, `run ${run}: ${JSON.stringify(posts)}`).toEqual(saved);
    }
  });

  it('refuses to write a schedule that would lose assignments, leaving the sheet untouched', () => {
    const a = { post_name: 'P', role_id: 0, soldier_name: 'Dan', start: new Date(2025, 2, 10, 6), end: new Date(2025, 2, 10, 14) };
    const outside = { post_name: 'P', role_id: 0, soldier_name: 'Eli', start: new Date(2025, 2, 20, 6), end: new Date(2025, 2, 20, 14) };
    const reqs = buildScheduleRequests(1, [a, outside], new Date(2025, 2, 10, 6), new Date(2025, 2, 10, 14), 4);
    expect(reqs.stats).toEqual({ written: 1, skipped: 1 });
  });

  it('reads sheets that were saved by the old fixed 4-hour layout', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ...people(2)],
      Posts: [H.Posts, ['Gate', '4', '00:00', '00:00', '0', '1', 'guard', '1', '', '']],
      Unavailabilities: [H.Unavailabilities],
      Schedule: [
        ['Date', 'Time', 'Gate'],
        ['', '', ''],
        ['10/03/2025', '00:00 - 04:00', 'Soldier 1'],
        ['', '04:00 - 08:00', 'Soldier 2'],
        ['', '08:00 - 12:00', 'Soldier 2'],
      ],
    });
    const found = await service.getAssignmentsInRange('2025-03-10T00:00:00', '2025-03-11T00:00:00');
    expect(found.map((a) => [a.soldier_name, a.start.getHours(), a.end.getHours()])).toEqual([['Soldier 1', 0, 4], ['Soldier 2', 4, 8], ['Soldier 2', 8, 12]]);
  });
});

describe('diagnostics', () => {
  it('explains why nothing can be scheduled', () => {
    const soldiers = [{ id: 1, name: 'Dan', skills: ['guard'] }];
    const postBase = { shift_length_hours: 4, start_time: '00:00', end_time: '00:00', cooldown_hours: 0, intensity_weight: 1 };
    expect(diagnoseInputs([], soldiers, DAY[0], DAY[1])[0].message).toMatch(/no posts/i);
    expect(diagnoseInputs([{ ...postBase, name: 'A', slots: [{ role_index: 0, skill: 'guard' }], is_active: false }], soldiers, DAY[0], DAY[1])[0].message).toMatch(/inactive/i);
    const msgs = diagnoseInputs([
      { ...postBase, name: 'NoSlots', slots: [], is_active: true },
      { ...postBase, name: 'Sniper', slots: [{ role_index: 0, skill: 'sniper' }], is_active: true },
      { ...postBase, name: 'Later', slots: [{ role_index: 0, skill: 'guard' }], is_active: true, active_from: '2025-04-01T00:00:00' },
    ], soldiers, DAY[0], DAY[1]).map((d) => d.message).join('\n');
    expect(msgs).toMatch(/NoSlots.*no required skills/);
    expect(msgs).toMatch(/needs skill "sniper"/);
    expect(msgs).toMatch(/Later.*only becomes active/);
  });

  it('summarises unfilled slots with reasons', () => {
    const soldiers = [{ id: 1, name: 'Dan', skills: ['guard'] }];
    const slots = [
      { post_name: 'A', role_id: 0, skill: 'guard', soldier_id: 1 },
      { post_name: 'B', role_id: 0, skill: 'sniper', soldier_id: null },
      { post_name: 'C', role_id: 0, skill: 'guard', soldier_id: null },
    ];
    const r = summarizeUnfilled(slots, soldiers, [], DAY[0], DAY[1]);
    expect(r).toMatchObject({ total: 3, filled: 1, unfilled: 2 });
    expect(Object.keys(r.reasons).join(' ')).toMatch(/sniper/);
    const r2 = summarizeUnfilled([slots[2]], soldiers, [{ soldier_name: 'Dan', start_datetime: DAY[0], end_datetime: DAY[1] }], DAY[0], DAY[1]);
    expect(Object.keys(r2.reasons)[0]).toMatch(/unavailable/);
  });

  it('shift generation ignores broken posts instead of hanging', () => {
    const good = { name: 'G', shift_length_hours: 4, start_time: '00:00', end_time: '00:00', slots: [{ role_index: 0, skill: 'x' }], is_active: true };
    const posts = [
      good,
      { ...good, name: 'BadTime', start_time: 'soon' },
      { ...good, name: 'ZeroLen', shift_length_hours: 0 },
      { ...good, name: 'NaNLen', shift_length_hours: NaN },
      { ...good, name: 'NoSlots', slots: [] },
    ];
    const shifts = generateShifts(posts, '2025-03-10T00:00:00', '2025-03-11T00:00:00', true);
    expect(new Set(shifts.map((s) => s.post_name))).toEqual(new Set(['G']));
    expect(generateShifts([good], 'nonsense', '2025-03-11T00:00:00')).toEqual([]);
    expect(generateShifts([good], '2025-03-11T00:00:00', '2025-03-10T00:00:00')).toEqual([]);
  });

  it('a post window within one hour is not mistaken for 24h', () => {
    const post = { name: 'P', shift_length_hours: 1, start_time: '08:00', end_time: '08:30', slots: [{ role_index: 0, skill: 'x' }], is_active: true };
    const shifts = generateShifts([post], '2025-03-10T00:00:00', '2025-03-11T00:00:00');
    expect(shifts).toHaveLength(1);
    expect(shifts[0].start.getHours()).toBe(8);
  });
});

describe('FakeSheets sanity', () => {
  it('rejects writes outside the grid like the real API', async () => {
    const f = new FakeSheets({ T: [] }, { gridCols: 2 });
    await expect(f.put("/id/values/'T'!A1", { values: [['a', 'b', 'c']] })).rejects.toThrow(/exceeds grid/);
  });
});

describe('sheets written by earlier versions of the app / other tools', () => {
  it('reads the layout the original app created (1/0 flags, 05:59 end times, ISO strings, 4h schedule grid)', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ['Dan', '1', 'guard,medic', 'Tower'], ['Eli', '', 'guard', ''], ['Avi', '2', 'guard', '']],
      Posts: [H.Posts, ['Gate', '4', '06:00', '05:59', '8', '1.5', 'guard,guard', '1', '', ''], ['Tower', '6', '06:00', '05:59', '0', '1', 'medic', '0', '', '']],
      Unavailabilities: [H.Unavailabilities, ['Dan', '2025-03-10T08:00:00', '2025-03-10T12:00:00', 'Doctor']],
      Schedule: [['Date', 'Time', 'Gate', ''], ['', '', 'Role 1', 'Role 2'], ['09/03/2025', '06:00 - 10:00', 'Eli', 'Avi'], ['', '10:00 - 14:00', 'Eli', 'Avi']],
    });
    const posts = await service.getPosts();
    expect(posts.map((p) => [p.name, p.is_active, p.slots.length])).toEqual([['Gate', true, 2], ['Tower', false, 1]]);
    const { shifts, assignments } = await draft(service);
    expect(shifts.length).toBeGreaterThan(0);
    expect(assignments.length).toBe(shifts.length * 2); // Gate has two slots per shift
    expect((await service.getAssignmentsInRange('2025-03-09T00:00:00', '2025-03-10T00:00:00')).map((a) => a.soldier_name).sort()).toEqual(['Avi', 'Avi', 'Eli', 'Eli']); // two 4h rows per role
  });

  it.each([
    [['Name', 'Shift Length (hours)', 'Start Time', 'End Time', 'Cooldown (hours)', 'Intensity Weight', 'Required Skills', 'Active'], 'parenthesised units'],
    [['post_name', 'shift_length_hours', 'start_time', 'end_time', 'cooldown_hours', 'intensity_weight', 'slots', 'is_active'], 'snake_case'],
    [['NAME *', 'Shift length in hours', 'Start time', 'End time', 'Cooldown', 'Intensity', 'Skills needed per shift (slots)', 'Is active?'], 'decorated headers'],
  ])('recognises header variants: %j (%s)', async (header) => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ...people(3)],
      Posts: [header, ['Gate', '8', '06:00', '18:00', '0', '1', 'guard, guard', 'TRUE']],
      Unavailabilities: [H.Unavailabilities],
    });
    const post = (await service.getPosts())[0];
    expect(post).toMatchObject({ name: 'Gate', shift_length_hours: 8, start_time: '06:00', end_time: '18:00', is_active: true });
    expect(post.slots).toHaveLength(2);
  });

  it('builds a diagnostic report with headers, mapping and problems but no people names', async () => {
    const { service } = await makeService({
      Soldiers: [H.Soldiers, ['Secret Person', '1', 'guard', '']],
      Posts: [['Name', 'Weird Column', 'Slots'], ['Gate', 'x', 'sniper']],
      Unavailabilities: [H.Unavailabilities],
    });
    const report = await service.getDiagnosticReport();
    expect(report).toContain('## Posts');
    expect(report).toContain('"Weird Column"');
    expect(report).toContain('columns understood');
    expect(report).toMatch(/requires skill "sniper"/);
    expect(report).not.toContain('Secret Person');
  });
});
