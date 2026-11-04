/**
 * End to end through the service: the app writes the schedule (merged cells and all) and the generated helper
 * tab, then a spreadsheet engine evaluates the formulas on exactly what ended up in the sheet.
 */
import { describe, it, expect } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { makeService } from './helpers/fakeSheets';
import { CHECK_TAB, isLiveCheckRule } from '../services/liveChecks';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};

const tabs = (postRows) => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '1', 'guard', '']],
  Posts: [H.Posts, ...postRows],
  Unavailabilities: [H.Unavailabilities],
});
const FORT = ['Fort', '24', '06:00', '06:00', '0', '1', 'guard', 'TRUE'];
const GATE = ['Gate', '4', '06:00', '06:00', '8', '1', 'guard', 'TRUE'];
const TOWER = ['Tower', '8', '06:00', '06:00', '0', '1', 'guard', 'TRUE'];

const at = (h, day = 10) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (soldier_name, post_name, h1, h2) => ({ soldier_name, post_name, role_id: 0, start: at(h1), end: at(h2) });

/** Load what is in the fake spreadsheet into a spreadsheet engine and return a way to read the FLAGS layer. */
function engine(fake) {
  const hf = HyperFormula.buildFromSheets({ Schedule: fake.rows('Schedule'), [CHECK_TAB]: fake.rows(CHECK_TAB) }, { licenseKey: 'gpl-v3' });
  const helperId = hf.getSheetId(CHECK_TAB);
  const scheduleId = hf.getSheetId('Schedule');
  // the layer offset is written into the sheet: find the "Problems" label row
  const labelRow = fake.rows(CHECK_TAB).findIndex((r) => r[0] === 'Problems (D, C)');
  const colOf = (post) => fake.rows('Schedule')[0].indexOf(post);
  const rowOf = (h) => fake.rows('Schedule').findIndex((r) => (r[1] || '').startsWith(`${String(h).padStart(2, '0')}:00`)); // first row starting at hour h
  return {
    hf,
    flag: (post, hour) => {
      const sRow = rowOf(hour);
      const v = hf.getCellValue({ sheet: helperId, row: labelRow + (sRow - 2), col: colOf(post) });
      if (v && typeof v === 'object') throw new Error(`formula error: ${v.value}`);
      return v;
    },
    type: (post, hour, name) => hf.setCellContents({ sheet: scheduleId, row: rowOf(hour), col: colOf(post) }, name),
    colOf, rowOf,
  };
}

describe('live checks written by the app', () => {
  it('CRITICAL CASE: a 24h Fort shift and a 4h Gate shift by the same person are flagged although they start on different rows', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE, TOWER]));
    const res = await service.saveAssignments(at(6), at(30), [
      asg('Dan', 'Fort', 6, 30),
      asg('Dan', 'Gate', 14, 18), // inside the Fort shift
      asg('Eli', 'Tower', 6, 14),
    ]);
    expect(res.violations.some((v) => v.type === 'overlap')).toBe(true); // the on-demand check agrees
    expect(res.liveChecks.ok).toBe(true);
    const e = engine(fake);
    expect(e.flag('Fort', 6)).toBe('D');
    expect(e.flag('Gate', 14)).toBe('D');
    expect(e.flag('Tower', 6)).toBe(''); // Eli is only on the Tower
  });

  it('clean schedules show no flags, and typing a conflicting name by hand flags it immediately', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE, TOWER]));
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Fort', 6, 30), asg('Eli', 'Gate', 14, 18), asg('Avi', 'Tower', 6, 14)]);
    const e = engine(fake);
    expect(['Fort', 'Gate', 'Tower'].map((p) => e.flag(p, p === 'Gate' ? 14 : 6))).toEqual(['', '', '']);
    // someone types Dan into the Tower at 14:00 (an empty slot) while he is on the Fort all day
    e.type('Tower', 14, 'Dan');
    expect(e.flag('Tower', 14)).toBe('D');
    expect(e.flag('Fort', 6)).toBe('D');
    // and fixes it
    e.type('Tower', 14, 'Avi');
    expect(e.flag('Tower', 14)).toBe('');
    expect(e.flag('Fort', 6)).toBe('');
  });

  it('flags too little rest after a post with a cooldown', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE, TOWER]));
    // Gate has an 8h cooldown: Dan finishes at 10:00 and starts the Tower at 14:00
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10), asg('Dan', 'Tower', 14, 22)]);
    const e = engine(fake);
    expect(e.flag('Gate', 6)).toBe('C');
    expect(e.flag('Tower', 14)).toBe('C');
  });

  it('adds the helper tab and exactly two rules once, however often it is refreshed', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE, TOWER]));
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Fort', 6, 30)]);
    const live = () => fake.tab('Schedule').conditionalFormats.filter(isLiveCheckRule).length;
    expect(fake.tab(CHECK_TAB)).toBeTruthy();
    expect(live()).toBe(2);
    await service.refreshLiveChecks();
    await service.refreshLiveChecks();
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Fort', 6, 30), asg('Eli', 'Gate', 6, 10)]);
    expect(live()).toBe(2);
    expect(fake.sheets.filter((s) => s.properties.title === CHECK_TAB)).toHaveLength(1);
  });

  it('picks up a changed shift length when refreshed', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE, TOWER]));
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Gate', 6, 10), asg('Dan', 'Tower', 10, 18)]);
    expect(engine(fake).flag('Gate', 6)).toBe('C'); // Gate cooldown 8h, only 0h rest before the Tower
    // the Gate's cooldown is edited by hand in the Posts tab: 0h
    fake.tab('Posts').values[2][4] = '0';
    await service.refreshLiveChecks();
    expect(engine(fake).flag('Gate', 6)).toBe('');
  });

  it('a schedule without a Schedule tab, or an emptied one, is handled', async () => {
    const { service, fake } = await makeService(tabs([FORT, GATE]));
    expect(await service.refreshLiveChecks()).toEqual({ ok: false, reason: 'no-schedule' });
    await service.saveAssignments(at(6), at(30), [asg('Dan', 'Fort', 6, 30)]);
    await service.saveAssignments(at(6), at(30), []); // nobody assigned any more
    // the day keeps its empty slots to fill in, and the live checks stay ready for the next entry
    expect(await service.getAssignmentsInRange(at(6), at(30))).toEqual([]);
    expect(fake.tab('Schedule').conditionalFormats.filter(isLiveCheckRule)).toHaveLength(2);
  });

  it('check schedule also refreshes the live checks for hand-made structure changes', async () => {
    const { service, fake } = await makeService({
      ...tabs([FORT, GATE]),
      Schedule: [
        ['Date', 'Time', 'Fort', 'Gate'],
        ['', '', '', ''],
        ['10/03/2025', '06:00 - 14:00', 'Dan', ''],
        ['', '14:00 - 22:00', '', 'Dan'],
        ['', '22:00 - 06:00', '', ''],
      ],
    });
    const res = await service.checkSchedule();
    expect(res.liveChecks.ok).toBe(true);
    expect(fake.tab(CHECK_TAB)).toBeTruthy();
    expect(res.violations.some((v) => v.type === 'overlap')).toBe(true); // Fort is 24h: Dan is also on the Gate at 14:00
  });
});
