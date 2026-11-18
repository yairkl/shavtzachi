/**
 * Every shift slot gets a dropdown listing everyone, best fit first, and a note saying who fits and why not.
 */
import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { listRule, isOurDropdown, LIST_MESSAGE, suggestionNote } from '../services/assignmentLists';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};
const tabs = (extra = {}) => ({
  Soldiers: [H.Soldiers,
    ['Dan', '1', 'guard', ''],
    ['Eli', '2', 'guard', ''],
    ['Avi', '3', 'guard,medic', ''],
    ['Cy', '1', 'guard', ''],
    ['Ben', '2', '', ''],
    ['Gil', '1', 'guard', 'Gate'], // excluded from the Gate
  ],
  Posts: [H.Posts,
    ['Gate', '8', '06:00', '06:00', '0', '1', 'guard', 'TRUE'],
    ['Clinic', '8', '06:00', '06:00', '0', '1', 'medic', 'TRUE'],
  ],
  Unavailabilities: [H.Unavailabilities, ['Eli', '2025-03-10 06:00', '2025-03-10 14:00', 'Doctor']],
  ...extra,
});
const at = (day, h) => new Date(2025, 2, day, h, 0, 0).toISOString();
const asg = (who, post, d, h1, h2) => ({ soldier_name: who, post_name: post, role_id: 0, start: at(d, h1), end: at(d, h2) });

/** The dropdown rule and note of the block of `post` that starts on `date` (dd/MM/yyyy) at its first row. */
function blockOf(fake, post, date, rowInDay = 0) {
  const grid = fake.rows('Schedule');
  const col = grid[0].indexOf(post);
  const first = grid.findIndex((r) => r[0] === date);
  const row = first + rowInDay;
  const rules = (fake.tab('Schedule').validations || []).filter((v) => v.range.startRowIndex === row && v.range.startColumnIndex === col);
  return { row, col, rule: rules[rules.length - 1]?.rule, note: (fake.tab('Schedule').notes || {})[`${row},${col}`], range: rules[rules.length - 1]?.range };
}
const names = (rule) => rule.condition.values.map((v) => v.userEnteredValue);

async function scenario() {
  const made = await makeService(tabs());
  const { service } = made;
  // Dan already worked two shifts the day before (16h); Avi is busy at the Clinic during the Gate slot on the 10th
  await service.saveAssignments(at(9, 6), at(10, 6), [asg('Dan', 'Gate', 9, 6, 14), asg('Dan', 'Gate', 9, 14, 22)]);
  await service.saveAssignments(at(10, 6), at(11, 6), [asg('Avi', 'Clinic', 10, 6, 14)]);
  return made;
}

describe('dropdown order', () => {
  it('offers everyone, those who fit first (fewest hours first), the unsuitable last', async () => {
    const { fake } = await scenario();
    const b = blockOf(fake, 'Gate', '10/03/2025');
    expect(b.rule).toBeTruthy();
    const list = names(b.rule);
    expect(new Set(list)).toEqual(new Set(['Dan', 'Eli', 'Avi', 'Cy', 'Ben', 'Gil'])); // everyone can still be picked
    expect(list.slice(0, 2)).toEqual(['Cy', 'Dan']);                                   // free and skilled; Cy has no hours yet
    expect(new Set(list.slice(2))).toEqual(new Set(['Eli', 'Avi', 'Ben', 'Gil']));       // unavailable, busy, no skill, excluded
    expect(b.rule.inputMessage).toBe(LIST_MESSAGE);
    expect(b.rule.strict).toBe(false); // typing another name is still allowed
    expect(b.rule.showCustomUi).toBe(true);
  });

  it('the Clinic slot ranks by the skill that slot needs', async () => {
    const { fake } = await scenario();
    const clinic = blockOf(fake, 'Clinic', '10/03/2025');
    expect(names(clinic.rule)[0]).toBe('Avi'); // the only medic comes first
  });

  it('the list covers the whole merged block', async () => {
    const { fake } = await scenario();
    const b = blockOf(fake, 'Gate', '10/03/2025');
    const merged = fake.tab('Schedule').merges.find((m) => m.startRowIndex === b.row && m.startColumnIndex === b.col);
    if (merged) expect([b.range.startRowIndex, b.range.endRowIndex]).toEqual([merged.startRowIndex, merged.endRowIndex]);
    expect(b.range.endColumnIndex).toBe(b.col + 1);
  });

  it('is based on the current schedule: assigning someone changes the order for the other slots', async () => {
    const { service, fake } = await scenario();
    const afternoon = () => names(blockOf(fake, 'Gate', '10/03/2025', 1).rule); // the empty 14:00-22:00 Gate slot
    // before: Cy and Eli (free from 14:00) carry no hours
    expect(afternoon().indexOf('Cy')).toBeLessThan(afternoon().indexOf('Dan'));
    expect(afternoon().indexOf('Eli')).toBeLessThan(afternoon().indexOf('Dan'));
    // Cy then takes the morning Gate and has just come off a shift: the same engine as the app's candidate list now
    // puts someone who is rested and has no hours (Eli) first, and Cy is no longer on top
    expect(afternoon()[0]).toBe('Cy');
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Avi', 'Clinic', 10, 6, 14), asg('Cy', 'Gate', 10, 6, 14)]);
    const after = afternoon();
    expect(after[0]).toBe('Eli');
    expect(after.indexOf('Eli')).toBeLessThan(after.indexOf('Cy'));
    expect(new Set(after)).toEqual(new Set(['Dan', 'Eli', 'Avi', 'Cy', 'Ben', 'Gil'])); // everyone is still offered
  });
});

describe('notes on the slots', () => {
  it('an empty slot says who fits best and why the others do not', async () => {
    const { fake } = await scenario();
    const note = blockOf(fake, 'Gate', '10/03/2025').note;
    expect(note).toMatch(/Best fits \(fewest hours first\):/);
    expect(note.indexOf('Cy')).toBeLessThan(note.indexOf('Dan'));
    expect(note).toMatch(/Not suitable:/);
    expect(note).toMatch(/Eli: unavailable/);
    expect(note).toMatch(/Avi: already on another shift then/);
    expect(note).toMatch(/Ben: lacks "guard"/);
    expect(note).toMatch(/Gil: excluded from this post/);
  });

  it('an assigned slot has no suggestion note, and shows its problem when it breaks a rule', async () => {
    const { service, fake } = await scenario();
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Eli', 'Gate', 10, 6, 14), asg('Avi', 'Clinic', 10, 6, 14)]);
    const eli = blockOf(fake, 'Gate', '10/03/2025');
    expect(eli.note).toMatch(/unavailable/); // Eli is unavailable then: the rule problem, not a suggestion
    expect(eli.note).not.toMatch(/Best fits/);
    const ok = blockOf(fake, 'Clinic', '10/03/2025');
    expect(ok.note || '').toBe(''); // Avi fits
  });

  it('says so when nobody fits cleanly', async () => {
    const { fake } = await makeService(tabs({ Soldiers: [H.Soldiers, ['Ben', '1', '', '']] }));
    expect(suggestionNote([{ soldier: { name: 'Ben' }, hard: ['skill_mismatch'], conflicts: ['skill_mismatch'], load: 0, skill: 'guard' }])).toMatch(/Nobody fits this slot cleanly/);
    void fake;
  });
});

describe('what is left alone', () => {
  it('a dropdown set up by hand is not replaced by the ordered lists', async () => {
    const { service, fake } = await makeService(tabs({ Schedule: [['Date', 'Time', 'Gate'], ['', ''], ['10/03/2025', '06:00 - 14:00', 'Dan']] }));
    const mine = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Dan' }, { userEnteredValue: 'Eli' }] }, inputMessage: 'My own list', strict: true, showCustomUi: true };
    fake.tab('Schedule').validations = [{ range: { sheetId: fake.tab('Schedule').properties.sheetId, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 6 }, rule: mine }];
    await service.saveAssignments(at(10, 6), at(11, 6), [asg('Dan', 'Gate', 10, 6, 14)]);
    const all = fake.tab('Schedule').validations;
    expect(all.every((v) => !isOurDropdown(v.rule) || v.rule.condition.type !== 'ONE_OF_LIST')).toBe(true);
    expect(all[all.length - 1].rule).toEqual(mine);
    expect(await service.refreshAssignmentLists()).toEqual({ ok: false, reason: 'custom-dropdown' });
  });

  it('refreshing twice gives the same lists and notes (no piling up)', async () => {
    const { service, fake } = await scenario();
    const snapshot = () => JSON.stringify([blockOf(fake, 'Gate', '10/03/2025').rule, blockOf(fake, 'Gate', '10/03/2025').note, Object.keys(fake.tab('Schedule').notes).length]);
    const first = snapshot();
    await service.refreshAssignmentLists();
    await service.refreshAssignmentLists();
    expect(snapshot()).toBe(first);
  });

  it('the schedule itself is not changed by refreshing the dropdowns', async () => {
    const { service, fake } = await scenario();
    const before = JSON.stringify(fake.rows('Schedule'));
    await service.refreshAssignmentLists();
    expect(JSON.stringify(fake.rows('Schedule'))).toBe(before);
  });

  it('no schedule yet: nothing to do', async () => {
    const { service } = await makeService(tabs());
    expect(await service.refreshAssignmentLists()).toEqual({ ok: false, reason: 'no-schedule' });
  });
});

describe('helpers', () => {
  it('listRule lists the names in the given order and marks itself as the app\'s', () => {
    const rule = listRule([{ soldier: { name: 'B' } }, { soldier: { name: 'A' } }]);
    expect(names(rule)).toEqual(['B', 'A']);
    expect(isOurDropdown(rule)).toBe(true);
    expect(isOurDropdown({ inputMessage: 'Pick a soldier' })).toBe(true);
    expect(isOurDropdown({ inputMessage: 'My list' })).toBe(false);
    expect(isOurDropdown({})).toBe(false);
  });
});
