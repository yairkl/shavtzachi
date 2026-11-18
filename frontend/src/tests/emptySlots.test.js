/**
 * Every shift slot of the schedule is a merged block of the post's shift length, filled or not, so picking a name
 * in an empty slot fills the whole shift.
 */
import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { buildScheduleRequests } from '../services/gsheetsUtils';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = (posts, extra = {}) => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', ''], ['Eli', '2', 'guard', ''], ['Avi', '3', 'guard,medic', '']],
  Posts: [H.Posts, ...posts],
  Unavailabilities: [H.Unavailabilities],
  ...extra,
});
const GATE = ['Gate', '8', '06:00', '06:00', '0', '1', 'guard, guard', 'TRUE']; // 2 roles
const FORT = ['Fort', '24', '06:00', '06:00', '0', '1', 'guard', 'TRUE'];
const TOWER = ['Tower', '4', '06:00', '06:00', '0', '1', 'guard', 'TRUE'];
const OFF = ['Off', '4', '06:00', '06:00', '0', '1', 'guard', 'FALSE'];
const at = (day, h) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (who, post, role, d1, h1, d2, h2) => ({ soldier_name: who, post_name: post, role_id: role, start: at(d1, h1), end: at(d2, h2) });

const blocks = (fake) => fake.tab('Schedule').merges
  .filter((m) => m.startColumnIndex >= 2 && m.startRowIndex >= 2)
  .map((m) => ({ col: m.startColumnIndex, from: m.startRowIndex, to: m.endRowIndex }));
const overlaps = (list) => list.some((a, i) => list.some((b, j) => i < j && a.col === b.col && a.from < b.to && b.from < a.to));

describe('empty slots are merged to the shift length', () => {
  it('tiles every column with blocks of the post\'s shift length, filled or empty', async () => {
    const { service, fake } = await makeService(tabs([GATE, FORT, TOWER]));
    // one assignment only; the rest of the 24h window stays empty
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 0, 10, 6, 10, 14)]);
    const grid = fake.rows('Schedule');
    expect(grid[0].slice(2).filter(Boolean)).toEqual(['Fort', 'Gate', 'Tower']); // posts without assignments get columns too
    const step = 4; // hours per row: the gcd of the 4h, 8h and 24h shifts
    const b = blocks(fake);
    expect(overlaps(b)).toBe(false);
    const byCol = {};
    b.forEach((x) => { (byCol[x.col] ||= []).push(x); });
    // Fort (col 2): one 24h block; Gate (cols 3, 4): three 8h blocks; Tower (col 5): six 4h blocks
    expect(byCol[2].map((x) => x.to - x.from)).toEqual([24 / step]);
    expect(byCol[3].map((x) => x.to - x.from)).toEqual([8 / step, 8 / step, 8 / step]);
    expect(byCol[4].map((x) => x.to - x.from)).toEqual([8 / step, 8 / step, 8 / step]);
    expect(byCol[5]).toBeUndefined(); // 4h shifts are one 4h row each: nothing to merge
    // each column is covered without gaps from the first to the last row
    for (const col of [2, 3, 4]) {
      const list = [...byCol[col]].sort((x, y) => x.from - y.from);
      expect(list[0].from).toBe(2);
      list.slice(1).forEach((x, i) => expect(x.from).toBe(list[i].to));
      expect(list[list.length - 1].to).toBe(grid.length);
    }
  });

  it('the assignment is still read back exactly, and empty blocks read as nothing', async () => {
    const { service } = await makeService(tabs([GATE, FORT, TOWER]));
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 0, 10, 6, 10, 14), asg('Eli', 'Tower', 0, 10, 10, 10, 14)]);
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    expect(back.map((a) => `${a.soldier_name}|${a.post_name}|${a.start.getHours()}-${a.end.getHours()}`).sort()).toEqual(['Dan|Gate|6-14', 'Eli|Tower|10-14']);
  });

  it('a name picked into an empty slot fills the whole shift, with no manual merging', async () => {
    const { service, fake } = await makeService(tabs([GATE, FORT, TOWER]));
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Fort', 0, 10, 6, 11, 6)]);
    // the admin picks Eli in the second Gate block (14:00-22:00): top-left cell of that merged block
    const target = blocks(fake).filter((x) => x.col === 3).sort((a, b) => a.from - b.from)[1];
    fake.tab('Schedule').values[target.from][3] = 'Eli';
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    const eli = back.find((a) => a.soldier_name === 'Eli');
    expect(eli).toMatchObject({ post_name: 'Gate', role_id: 0 });
    expect(eli.start.getHours()).toBe(14);
    expect(eli.end.getHours()).toBe(22); // the full 8h shift
  });

  it('inactive posts get no columns, and slots never overlap an existing assignment', async () => {
    const { service, fake } = await makeService(tabs([GATE, OFF]));
    // a 6h assignment that does not match the 8h Gate slots (e.g. the shift length changed later)
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 0, 10, 8, 10, 14)]);
    expect(fake.rows('Schedule')[0].slice(2).filter(Boolean)).toEqual(['Gate']);
    expect(overlaps(blocks(fake))).toBe(false);
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    expect(back).toHaveLength(1);
    expect(back[0].start.getHours()).toBe(8);
  });

  it('a second day is added without disturbing the first, and every day is tiled', async () => {
    const { service, fake } = await makeService(tabs([GATE, TOWER]));
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 0, 10, 6, 10, 14)]);
    await service.saveAssignments(at(11, 6), at(12, 6), [asg('Eli', 'Tower', 0, 11, 10, 11, 14)]);
    const b = blocks(fake);
    expect(overlaps(b)).toBe(false);
    const gate = b.filter((x) => x.col === 2).sort((x, y) => x.from - y.from);
    expect(gate).toHaveLength(6); // 3 blocks a day x 2 days
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    expect(back.map((a) => a.soldier_name).sort()).toEqual(['Dan', 'Eli']);
  });

  it('empty blocks are shaded lightly so unfilled slots are easy to see', () => {
    const slot = { post_name: 'Gate', role_id: 0, start: new Date(2025, 2, 10, 6), end: new Date(2025, 2, 10, 14) };
    const reqs = buildScheduleRequests(1, [], new Date(2025, 2, 10, 6), new Date(2025, 2, 10, 14), null, { slots: [slot] });
    expect(reqs.stats.emptySlots).toBe(1);
    const rows = reqs.find((r) => r.updateCells).updateCells.rows;
    const emptyCell = rows[2].values[2];
    expect(emptyCell.userEnteredValue.stringValue).toBe('');
    expect(emptyCell.userEnteredFormat.backgroundColor.red).toBeGreaterThan(0.9);
    expect(reqs.slotPlacements).toEqual([{ slot, row: 2, col: 2 }]);
  });

  it('slot boundaries decide the row height, so an unassigned 3h post still lines up', async () => {
    const THREE = ['Three', '3', '06:00', '06:00', '0', '1', 'guard', 'TRUE'];
    const { service, fake } = await makeService(tabs([GATE, THREE]));
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 0, 10, 6, 10, 14)]);
    const labels = fake.rows('Schedule').slice(2).map((r) => r[1]);
    expect(labels[0]).toBe('06:00 - 07:00'); // 1h rows: the gcd of 8h and 3h shifts
    const three = blocks(fake).filter((x) => x.col === 4);
    expect(three).toHaveLength(8);
    expect(three.every((x) => x.to - x.from === 3)).toBe(true);
  });

  it('a timetable too fine to tile (6-minute shifts) still saves the assignments, without empty blocks', async () => {
    const ODD = ['Odd', '0.1', '06:00', '06:00', '0', '1', 'guard', 'TRUE']; // 6-minute shifts: 240 slots a day
    const { service, fake } = await makeService(tabs([GATE, ODD]));
    await service.saveAssignments(at(10, 6), at(20, 6), [asg('Dan', 'Gate', 0, 10, 6, 10, 14)]);
    service.clearCache();
    const back = await service.getAssignmentsInRange('2025-03-01T00:00:00', '2025-04-01T00:00:00');
    expect(back).toHaveLength(1);
    expect(fake.rows('Schedule').length).toBeLessThan(40); // not thousands of rows
  });
});
