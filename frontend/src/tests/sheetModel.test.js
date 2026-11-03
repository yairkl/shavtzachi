import { describe, it, expect } from 'vitest';
import {
  parseBool, isMonthFirstLocale, parseNumber, parseTime, parseDateTime, parseList, mapColumns, buildModel, colLetter, composeRow, toLocalIso,
} from '../lib/sheetModel';

describe('parseBool', () => {
  it.each([
    ['TRUE', true], ['true', true], ['1', true], ['Yes', true], ['y', true], ['כן', true], ['✓', true],
    ['FALSE', false], ['0', false], ['no', false], ['לא', false], ['inactive', false],
  ])('understands %s', (raw, expected) => {
    expect(parseBool(raw, !expected).value).toBe(expected);
  });
  it('treats blank as the default (not as false)', () => {
    expect(parseBool('', true).value).toBe(true);
    expect(parseBool(undefined, true).value).toBe(true);
    expect(parseBool('  ', false).value).toBe(false);
  });
  it('flags values it does not understand', () => {
    const r = parseBool('maybe', true);
    expect(r.recognized).toBe(false);
    expect(r.value).toBe(true);
  });
  it('accepts real booleans and numbers', () => {
    expect(parseBool(true).value).toBe(true);
    expect(parseBool(false, true).value).toBe(false);
    expect(parseBool(0, true).value).toBe(false);
  });
});

describe('parseNumber', () => {
  it.each([['4', 4], ['4.5', 4.5], ['4,5', 4.5], ['8h', 8], ['  12 hours ', 12], [6, 6], ['-2', -2]])('%s -> %s', (raw, n) => {
    expect(parseNumber(raw, 0).value).toBe(n);
  });
  it('falls back to the default for text or blanks', () => {
    expect(parseNumber('abc', 7)).toMatchObject({ value: 7, recognized: false });
    expect(parseNumber('', 7)).toMatchObject({ value: 7, recognized: true, blank: true });
    expect(parseNumber(undefined, 7).value).toBe(7);
  });
});

describe('parseTime', () => {
  it.each([
    ['06:00', '06:00'], ['6:00', '06:00'], ['6:00:00', '06:00'], ['06:00:30', '06:00'],
    ['6 AM', '06:00'], ['6:30 pm', '18:30'], ['12 AM', '00:00'], ['12:00 PM', '12:00'], ['6pm', '18:00'],
    ['0600', '06:00'], ['600', '06:00'], ['18', '18:00'], ['24:00', '00:00'], ['00:00', '00:00'],
    [0.25, '06:00'], [0.5, '12:00'], [0.75, '18:00'], [6, '06:00'],
    ['2025-01-01 06:00', '06:00'], ['01/02/2025 18:30', '18:30'], ['2025-01-01T07:15:00', '07:15'],
  ])('%s -> %s', (raw, expected) => {
    expect(parseTime(raw)).toBe(expected);
  });
  it.each([[''], [undefined], [null], ['abc'], ['25:00'], ['12:60'], ['13 PM'], ['0 AM'], [99], [-1], ['6:0:0:0']])('rejects %s', (raw) => {
    expect(parseTime(raw)).toBeNull();
  });
});

describe('parseDateTime', () => {
  const iso = (r) => { const p = parseDateTime(r); return p ? toLocalIso(p.date) : null; };
  it('reads ISO and common sheet formats (day-first)', () => {
    expect(iso('2025-03-04T05:06:00')).toBe('2025-03-04T05:06:00');
    expect(iso('2025-03-04 05:06')).toBe('2025-03-04T05:06:00');
    expect(iso('04/03/2025 05:06')).toBe('2025-03-04T05:06:00');
    expect(iso('4/3/2025 5:06')).toBe('2025-03-04T05:06:00');
    expect(iso('04.03.2025 05:06')).toBe('2025-03-04T05:06:00');
    expect(iso('31/12/2025')).toBe('2025-12-31T00:00:00');
    expect(iso('2025-12-31')).toBe('2025-12-31T00:00:00');
  });
  it('marks date-only values', () => {
    expect(parseDateTime('31/12/2025').dateOnly).toBe(true);
    expect(parseDateTime('31/12/2025 10:00').dateOnly).toBe(false);
  });
  it('reads Sheets serial numbers', () => {
    expect(iso(45658)).toBe('2025-01-01T00:00:00'); // 2025-01-01
    expect(iso(45658.5)).toBe('2025-01-01T12:00:00');
  });
  it.each([[''], [undefined], ['soon'], ['32/13/2025'], ['2025-13-45'], [12]])('rejects %s', (raw) => {
    expect(parseDateTime(raw)).toBeNull();
  });
});

describe('parseDateTime in month-first (US) spreadsheets', () => {
  const iso = (r, o) => { const p = parseDateTime(r, o); return p ? toLocalIso(p.date) : null; };
  it('reads 3/4/2025 as March 4th for en_US and as 3 April otherwise', () => {
    expect(iso('3/4/2025 08:00', { monthFirst: true })).toBe('2025-03-04T08:00:00');
    expect(iso('3/4/2025 08:00')).toBe('2025-04-03T08:00:00');
    expect(iso('12/31/2025', { monthFirst: true })).toBe('2025-12-31T00:00:00');
    expect(iso('12/31/2025')).toBeNull(); // day-first: month 31 does not exist -> reported, not guessed
  });
  it('ISO dates are never ambiguous', () => {
    expect(iso('2025-03-04 08:00', { monthFirst: true })).toBe('2025-03-04T08:00:00');
  });
  it('knows which locales are month-first', () => {
    expect([isMonthFirstLocale('en_US'), isMonthFirstLocale('en-US'), isMonthFirstLocale('en_GB'), isMonthFirstLocale('iw_IL'), isMonthFirstLocale(undefined)]).toEqual([true, true, false, false, false]);
  });
});

describe('parseList', () => {
  it('splits on commas, semicolons, newlines; trims; drops blanks and duplicates', () => {
    expect(parseList(' a, b ;c\nd,, A ,')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseList('')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList(5)).toEqual(['5']);
  });
});

describe('mapColumns', () => {
  it('maps by header regardless of order, case and extra columns', () => {
    const { map, positional } = mapColumns('Posts', ['notes', 'IS ACTIVE', 'name', 'Shift_Length', 'slots']);
    expect(positional).toBe(false);
    expect(map).toMatchObject({ is_active: 1, name: 2, shift_length_hours: 3, slots: 4 });
    expect(map.start_time).toBeUndefined();
  });
  it('falls back to the default order when no header is recognised', () => {
    const { map, positional, issues } = mapColumns('Soldiers', ['x', 'y', 'z']);
    expect(positional).toBe(true);
    expect(map).toMatchObject({ name: 0, division: 1, skills: 2, excluded_posts: 3 });
    expect(issues[0].level).toBe('warning');
  });
  it('uses column A for the name when its header is unknown but others are known', () => {
    const { map, issues } = mapColumns('Soldiers', ['Who', 'Division', 'Skills']);
    expect(map.name).toBe(0);
    expect(issues.some(i => /using column A/.test(i.message))).toBe(true);
  });
  it('reports a missing required column', () => {
    const { issues } = mapColumns('Unavailabilities', ['Soldier', 'Start']);
    expect(issues.some(i => i.level === 'error' && /"End"/.test(i.message))).toBe(true);
  });
  it('handles an empty header row', () => {
    expect(mapColumns('Posts', []).positional).toBe(true);
    expect(mapColumns('Posts', undefined).positional).toBe(true);
  });
});

describe('colLetter / composeRow', () => {
  it('converts indexes', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(colLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
  it('places fields by column map and preserves unknown columns', () => {
    const row = composeRow({ name: 2, skills: 0 }, { name: 'Dan', skills: 'a' }, ['old', 'KEEP', 'oldname', 'KEEP2']);
    expect(row).toEqual(['a', 'KEEP', 'Dan', 'KEEP2']);
    expect(composeRow({ name: 3 }, { name: 'x' })).toEqual(['', '', '', 'x']);
    expect(composeRow({ name: 0 }, { other: 'ignored' })).toEqual([]);
  });
});

describe('buildModel', () => {
  const header = {
    Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
    Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
    Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
  };

  it('parses a clean sheet', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '1', 'guard, medic', 'Gate'], ['Eli', '', 'guard', '']],
      Posts: [header.Posts, ['Gate', '4', '06:00', '18:00', '8', '1.5', 'guard', '1', '', '']],
      Unavailabilities: [header.Unavailabilities, ['Dan', '2025-01-02T08:00:00', '2025-01-02T12:00:00', 'Doctor']],
    });
    expect(m.issues).toEqual([]);
    expect(m.soldiers).toEqual([
      { id: 1, name: 'Dan', division: 1, skills: ['guard', 'medic'], excluded_posts: ['Gate'] },
      { id: 2, name: 'Eli', division: null, skills: ['guard'], excluded_posts: [] },
    ]);
    expect(m.posts[0]).toMatchObject({ id: 1, name: 'Gate', shift_length_hours: 4, start_time: '06:00', end_time: '18:00', cooldown_hours: 8, intensity_weight: 1.5, is_active: true });
    expect(m.posts[0].slots).toEqual([{ role_index: 0, skill: 'guard' }]);
    expect(m.unavailabilities[0]).toMatchObject({ soldier_id: 1, soldier_name: 'Dan', start_datetime: '2025-01-02T08:00:00', reason: 'Doctor' });
  });

  it('treats a blank or TRUE "Is Active" as active (the imported-sheet bug)', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'guard', '']],
      Posts: [header.Posts,
        ['A', '4', '06:00', '18:00', '0', '1', 'guard', 'TRUE', '', ''],
        ['B', '4', '06:00', '18:00', '0', '1', 'guard', '', '', ''],
        ['C', '4', '06:00', '18:00', '0', '1', 'guard', 'Yes', '', ''],
        ['D', '4', '06:00', '18:00', '0', '1', 'guard'],
        ['E', '4', '06:00', '18:00', '0', '1', 'guard', 'FALSE', '', ''],
        ['F', '4', '06:00', '18:00', '0', '1', 'guard', '0', '', '']],
      Unavailabilities: [header.Unavailabilities],
    });
    expect(Object.fromEntries(m.posts.map(p => [p.name, p.is_active]))).toEqual({ A: true, B: true, C: true, D: true, E: false, F: false });
  });

  it('works without an Is Active column at all', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'guard', '']],
      Posts: [['Name', 'Shift Length', 'Slots'], ['Gate', '8', 'guard']],
      Unavailabilities: null,
    });
    expect(m.posts[0]).toMatchObject({ is_active: true, shift_length_hours: 8, start_time: '00:00', end_time: '00:00' });
    expect(m.issues.some(i => /Missing column "Is Active"/.test(i.message))).toBe(true);
    expect(m.missingTabs).toEqual(['Unavailabilities']);
  });

  it('normalises times, numbers and dates written by hand', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'guard', '']],
      Posts: [header.Posts, ['Gate', '6h', '6:00 AM', '6 PM', '2,5', '', 'guard', 'yes', '01/02/2025', '28/02/2025']],
      Unavailabilities: [header.Unavailabilities],
    });
    expect(m.posts[0]).toMatchObject({ shift_length_hours: 6, start_time: '06:00', end_time: '18:00', cooldown_hours: 2.5, intensity_weight: 1 });
    expect(m.posts[0].active_from).toBe('2025-02-01T00:00:00');
    expect(m.posts[0].active_until).toBe('2025-03-01T00:00:00'); // date-only "until" includes that whole day
  });

  it('survives garbage without throwing and explains every problem', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['', '', 'guard', ''], ['Dan', 'abc', ' Guard ,, ', ''], ['dan', '', 'x', ''], [], ['Eli']],
      Posts: [header.Posts,
        ['', '4', '', '', '', '', 'guard'],
        ['Gate', 'abc', '25:99', 'late', 'x', '-3', '', 'maybe', 'never', 'someday'],
        ['gate', '4', '', '', '', '', 'guard'],
        ['Zero', '0', '06:00', '18:00', '', '', 'guard']],
      Unavailabilities: [header.Unavailabilities,
        ['', '2025-01-01', '2025-01-02', ''],
        ['Ghost', '2025-01-01 08:00', '2025-01-01 12:00', ''],
        ['Dan', 'soon', 'later', ''],
        ['Dan', '2025-01-03 12:00', '2025-01-03 08:00', ''],
        ['DAN', '05/01/2025', '06/01/2025', 'leave']],
    });
    expect(m.soldiers.map(s => s.name)).toEqual(['Dan', 'Eli']);
    expect(m.soldiers[0]).toMatchObject({ division: null, skills: ['guard'] });
    expect(m.posts.map(p => p.name)).toEqual(['Gate', 'Zero']);
    expect(m.posts[0]).toMatchObject({ shift_length_hours: 4, start_time: '00:00', cooldown_hours: 0, intensity_weight: 1, slots: [], is_active: true, active_from: null, active_until: null });
    expect(m.posts[1].shift_length_hours).toBe(4);
    expect(m.unavailabilities).toHaveLength(2);
    expect(m.unavailabilities[1]).toMatchObject({ soldier_name: 'Dan', start_datetime: '2025-01-05T00:00:00', end_datetime: '2025-01-07T00:00:00' });
    const text = m.issues.map(i => i.message).join('\n');
    for (const needle of ['no name', 'Division "abc"', 'Duplicate name', 'Duplicate post', 'Shift length "abc"', 'not a valid time', 'Cooldown', 'Intensity', 'Is Active value "maybe"', 'Active From', 'Active Until', 'no required skills', 'not in the Soldiers sheet', 'Could not read', 'End is not after start', 'out of range']) {
      expect(text).toContain(needle);
    }
  });

  it('matches skills, posts and soldiers case-insensitively', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'GUARD', 'gate']],
      Posts: [header.Posts, ['Gate', '4', '06:00', '18:00', '0', '1', 'Guard', '1', '', '']],
      Unavailabilities: [header.Unavailabilities, ['dan', '2025-01-01 08:00', '2025-01-01 10:00', '']],
    });
    expect(m.soldiers[0].skills).toEqual(['Guard']);
    expect(m.soldiers[0].excluded_posts).toEqual(['Gate']);
    expect(m.unavailabilities[0]).toMatchObject({ soldier_id: 1, soldier_name: 'Dan' });
    expect(m.issues).toEqual([]);
  });

  it('warns about skills nobody has and unknown excluded posts', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'guard', 'Nowhere']],
      Posts: [header.Posts, ['Gate', '4', '06:00', '18:00', '0', '1', 'sniper', '1', '', '']],
      Unavailabilities: [header.Unavailabilities],
    });
    const text = m.issues.map(i => i.message).join('\n');
    expect(text).toContain('requires skill "sniper"');
    expect(text).toContain('"Nowhere", which is not a post');
  });

  it('keeps row-based ids stable across blank rows', () => {
    const m = buildModel({
      Soldiers: [header.Soldiers, ['Dan', '', 'g', ''], [], ['Eli', '', 'g', '']],
      Posts: [header.Posts], Unavailabilities: [header.Unavailabilities],
    });
    expect(m.soldiers.map(s => [s.id, s.name])).toEqual([[1, 'Dan'], [3, 'Eli']]);
  });

  it('reports missing and empty tabs', () => {
    const m = buildModel({ Soldiers: null, Posts: null, Unavailabilities: null, Schedule: null });
    expect(m.missingTabs).toEqual(['Soldiers', 'Posts', 'Unavailabilities']);
    expect(m.issues.filter(i => i.level === 'error')).toHaveLength(2);
    const empty = buildModel({ Soldiers: [], Posts: [], Unavailabilities: [] });
    expect(empty.issues.some(i => /No soldiers found/.test(i.message))).toBe(true);
    expect(empty.soldiers).toEqual([]);
  });

  it('handles a sheet with reordered columns and a header-less first row', () => {
    const m = buildModel({
      Soldiers: [['Skills', 'Name'], ['guard', 'Dan']],
      Posts: [['stuff', 'more'], ['Gate', '4', '06:00', '18:00', '0', '1', 'guard', '1']],
      Unavailabilities: [],
    });
    expect(m.soldiers[0]).toMatchObject({ name: 'Dan', skills: ['guard'] });
    // Unrecognised headers -> positional; the first row is treated as the header.
    expect(m.posts[0]).toMatchObject({ name: 'Gate' });
    expect(m.issues.some(i => /Header row was not recognised/.test(i.message))).toBe(true);
  });
});
