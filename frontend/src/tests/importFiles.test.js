import { describe, it, expect, beforeEach } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { gsheetsService } from '../services/gsheetsService';
import { importSoldiers, importPosts } from '../services/api';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const file = (text, name = 'data.csv') => new File([text], name, { type: 'text/csv' });

let fake;
beforeEach(async () => {
  const made = await makeService({ Soldiers: [H.Soldiers, ['Existing', '', 'guard', '']], Posts: [H.Posts], Unavailabilities: [H.Unavailabilities] });
  fake = made.fake;
  // the api module talks to the shared singleton
  gsheetsService.client = fake;
  gsheetsService.spreadsheetId = 'test-sheet';
  gsheetsService.CACHE_TTL = 0;
  gsheetsService._schemaOkFor = null;
});

describe('file import', () => {
  it('imports soldiers from a plain CSV and skips existing names', async () => {
    const { data } = await importSoldiers(file('Name,Division,Skills,Excluded Posts\nDan,1,"guard, medic",Gate\nexisting,2,guard,\n'));
    expect(data).toMatchObject({ imported: 1, skipped: 1 });
    expect(fake.rows('Soldiers').map((r) => r[0])).toEqual(['Name', 'Existing', 'Dan']);
  });

  it('handles semicolon-separated CSV with a BOM and Windows line endings', async () => {
    const { data } = await importSoldiers(file('﻿Name;Division;Skills\r\nDan;1;guard\r\nEli;2;medic\r\n'));
    expect(data.imported).toBe(2);
    expect(fake.rows('Soldiers')[2]).toEqual(['Dan', '1', 'guard']);
  });

  it('imports Hebrew headers and tab-separated files', async () => {
    const { data } = await importSoldiers(file('שם\tמחלקה\tכישורים\nדן\t1\tשמירה\n'));
    expect(data.imported).toBe(1);
    expect((await gsheetsService.getSoldiers()).find((s) => s.name === 'דן').skills).toEqual(['שמירה']);
  });

  it('reports bad rows instead of failing the whole import', async () => {
    const { data } = await importSoldiers(file('Name,Division,Skills\n,1,guard\nDan,abc,guard\nDan,2,guard\nEli,,\n'));
    expect(data.imported).toBe(2); // Dan (first) and Eli
    const text = data.issues.map((i) => i.message).join('\n');
    expect(text).toMatch(/no name/);
    expect(text).toMatch(/Division "abc"/);
    expect(text).toMatch(/Duplicate name/);
  });

  it('imports posts with loose formats and makes them schedulable', async () => {
    const { data } = await importPosts(file('Name,Shift Length,Start Time,End Time,Slots,Is Active\nGate,8h,6:00,6 PM,"guard, guard",TRUE\nTower,4,,,guard,\n'));
    expect(data.imported).toBe(2);
    const posts = await gsheetsService.getPosts();
    expect(posts.map((p) => [p.name, p.is_active, p.start_time, p.end_time, p.slots.length])).toEqual([
      ['Gate', true, '06:00', '18:00', 2],
      ['Tower', true, '00:00', '00:00', 1],
    ]);
  });

  it('prefers the matching tab in an xlsx workbook', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Other'], ['x']]), 'Notes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([H.Soldiers, ['Dan', 1, 'guard', '']]), 'Soldiers');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const { data } = await importSoldiers(new File([buf], 'people.xlsx'));
    expect(data.imported).toBe(1);
  });

  it('an empty or header-only file imports nothing and does not throw', async () => {
    expect((await importSoldiers(file(''))).data.imported).toBe(0);
    expect((await importPosts(file('Name,Slots\n'))).data.imported).toBe(0);
  });
});
