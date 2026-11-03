import { describe, it, expect } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { buildFormattingRequests, isOurRule, RED } from '../services/sheetFormatting';
import { toSheetDateTime } from '../lib/sheetModel';

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};

const tabs = () => ({
  Soldiers: [H.Soldiers, ['Dan', '1', 'guard', '']],
  // reordered on purpose
  Posts: [['Slots', 'Is Active', 'Name', 'Shift Length', 'Start Time', 'End Time'], ['guard', 'TRUE', 'Gate', '8', '06:00', '18:00']],
  Unavailabilities: [['Reason', 'End', 'Start', 'Soldier'], ['x', '2025-03-10 12:00', '2025-03-10 08:00', 'Dan']],
});

const colOf = (header, name) => header.indexOf(name);
const at = (sheet, name, header) => (sheet.validations || []).filter((v) => v.range.startColumnIndex === colOf(header, name));

describe('sheet formatting for direct editing', () => {
  it('formats every data tab, using the real column positions, without touching data', async () => {
    const { service, fake } = await makeService(tabs());
    const before = JSON.stringify(['Soldiers', 'Posts', 'Unavailabilities'].map((t) => fake.rows(t)));
    expect(await service.applyFormatting()).toBe(3);
    expect(JSON.stringify(['Soldiers', 'Posts', 'Unavailabilities'].map((t) => fake.rows(t)))).toBe(before);

    for (const t of ['Soldiers', 'Posts', 'Unavailabilities']) {
      const sheet = fake.tab(t);
      expect(sheet.properties.gridProperties.frozenRowCount).toBe(1);
      expect(sheet.formatting.some((f) => f.range.startRowIndex === 0)).toBe(true); // header style
      expect(Object.keys(sheet.notes || {}).length).toBeGreaterThan(0);
      expect(sheet.dimensions.length).toBeGreaterThan(0);
    }

    const posts = fake.tab('Posts');
    const ph = tabs().Posts[0];
    // Is Active is column B here and gets a TRUE/FALSE dropdown; name is column C
    expect(at(posts, 'Is Active', ph)[0].rule.condition).toEqual({ type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'TRUE' }, { userEnteredValue: 'FALSE' }] });
    expect(at(posts, 'Is Active', ph)[0].rule.showCustomUi).toBe(true);
    expect(at(posts, 'Shift Length', ph)[0].rule.condition.type).toBe('NUMBER_BETWEEN');
    expect(at(posts, 'Name', ph)[0].rule.condition.values[0].userEnteredValue).toBe('=COUNTIF($C$2:$C,C2)<=1');
    // time columns are shown as hh:mm
    expect(posts.formatting.some((f) => f.range.startColumnIndex === colOf(ph, 'Start Time') && f.cell.userEnteredFormat.numberFormat.pattern === 'hh:mm')).toBe(true);
    // every rule is non-blocking: manual editing is never refused
    for (const t of ['Soldiers', 'Posts', 'Unavailabilities']) fake.tab(t).validations.forEach((v) => expect(v.rule.strict).toBe(false));
  });

  it('the Unavailabilities soldier dropdown points at the Soldiers name column', async () => {
    const { service, fake } = await makeService({
      ...tabs(),
      Soldiers: [['Skills', 'Name'], ['guard', 'Dan']], // name is column B here
    });
    await service.applyFormatting();
    const un = at(fake.tab('Unavailabilities'), 'Soldier', ['Reason', 'End', 'Start', 'Soldier'])[0];
    expect(un.rule.condition).toEqual({ type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Soldiers'!$B$2:$B" }] });
    const rules = fake.tab('Unavailabilities').conditionalFormats.map((r) => r.booleanRule.condition.values[0].userEnteredValue).join('\n');
    expect(rules).toContain(`INDIRECT("'Soldiers'!$B$2:$B")`);
    // end before start is highlighted, using the right letters (End = B, Start = C)
    expect(rules).toContain('IFERROR(VALUE(B2)<=VALUE(C2),FALSE)');
  });

  it('is idempotent and keeps rules the user added themselves', async () => {
    const { service, fake } = await makeService(tabs());
    const foreign = { ranges: [{ sheetId: fake.tab('Soldiers').properties.sheetId, startRowIndex: 1, endRowIndex: 50, startColumnIndex: 0, endColumnIndex: 1 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=A2="VIP"' }] }, format: { backgroundColor: { red: 0, green: 1, blue: 0 } } } };
    fake.tab('Soldiers').conditionalFormats.push(foreign);
    await service.applyFormatting();
    const counts = () => ['Soldiers', 'Posts', 'Unavailabilities'].map((t) => fake.tab(t).conditionalFormats.length);
    const first = counts();
    await service.applyFormatting();
    await service.applyFormatting();
    expect(counts()).toEqual(first);
    expect(fake.tab('Soldiers').conditionalFormats).toContainEqual(foreign);
    expect(fake.tab('Soldiers').conditionalFormats.filter(isOurRule).length).toBe(first[0] - 1);
  });

  it('can be limited to specific tabs', async () => {
    const { service, fake } = await makeService(tabs());
    expect(await service.applyFormatting({ tabs: ['Posts'] })).toBe(1);
    expect(fake.tab('Posts').validations.length).toBeGreaterThan(0);
    expect(fake.tab('Soldiers').validations).toBeUndefined();
  });

  it('creating missing tabs formats them automatically; existing tabs are left alone', async () => {
    const { service, fake } = await makeService({ Soldiers: [H.Soldiers, ['Dan', '', 'guard', '']], Posts: [H.Posts] });
    const changes = await service.ensureSchema({ force: true });
    expect(changes.join(' ')).toMatch(/Created the "Unavailabilities" tab/);
    expect(changes.join(' ')).toMatch(/Formatted Unavailabilities/);
    expect(fake.tab('Unavailabilities').validations.length).toBeGreaterThan(0);
    expect(fake.tab('Soldiers').validations).toBeUndefined();
  });

  it('a newly created spreadsheet comes formatted', async () => {
    const { service, fake } = await makeService({});
    await service.createSpreadsheet('x');
    for (const t of ['Soldiers', 'Posts', 'Unavailabilities']) expect(fake.tab(t).validations.length).toBeGreaterThan(0);
  });

  it('health suggests formatting until it is applied', async () => {
    const { service } = await makeService(tabs());
    const hint = (h) => h.issues.find((i) => /not set up for editing by hand/.test(i.message));
    expect(hint(await service.getHealth())).toBeTruthy();
    await service.applyFormatting();
    expect(hint(await service.getHealth())).toBeFalsy();
  });

  it('data written by the app matches the validation rules (TRUE/FALSE, ISO dates) and reads back', async () => {
    const { service, fake } = await makeService({ Soldiers: [H.Soldiers, ['Dan', '', 'guard', '']], Posts: [H.Posts], Unavailabilities: [H.Unavailabilities] });
    await service.createPost({ name: 'Gate', shift_length_hours: 8, start_time: '06:00', end_time: '18:00', cooldown_hours: 0, intensity_weight: 1, slots: ['guard'], is_active: false, active_from: '2025-03-01T00:00:00', active_until: '2025-04-01T08:30:00' });
    await service.createUnavailability({ soldier_id: 1, start_datetime: '2025-03-10T08:00:00', end_datetime: '2025-03-10T12:00:00', reason: 'r' });
    expect(fake.rows('Posts')[1]).toEqual(['Gate', '8', '06:00', '18:00', '0', '1', 'guard', 'FALSE', '2025-03-01 00:00', '2025-04-01 08:30']);
    expect(fake.rows('Unavailabilities')[1]).toEqual(['Dan', '2025-03-10 08:00', '2025-03-10 12:00', 'r']);
    const post = (await service.getPosts())[0];
    expect(post).toMatchObject({ is_active: false, active_from: '2025-03-01T00:00:00', active_until: '2025-04-01T08:30:00' });
    expect((await service.getUnavailabilities())[0]).toMatchObject({ start_datetime: '2025-03-10T08:00:00', end_datetime: '2025-03-10T12:00:00' });
  });

  it('every highlight formula is well-formed (balanced parentheses and quotes)', () => {
    const sheets = ['Soldiers', 'Posts', 'Unavailabilities'].map((tab, i) => ({
      tab, title: tab, sheetId: i + 1, rowCount: 1000, conditionalFormats: [],
      columns: Object.fromEntries({ Soldiers: ['name', 'division', 'skills', 'excluded_posts'], Posts: ['name', 'shift_length_hours', 'start_time', 'end_time', 'cooldown_hours', 'intensity_weight', 'slots', 'is_active', 'active_from', 'active_until'], Unavailabilities: ['soldier', 'start', 'end', 'reason'] }[tab].map((f, j) => [f, j])),
    }));
    const reqs = buildFormattingRequests(sheets);
    const formulas = reqs.flatMap((r) => {
      if (r.addConditionalFormatRule) return [r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue];
      if (r.setDataValidation?.rule.condition.type === 'CUSTOM_FORMULA') return [r.setDataValidation.rule.condition.values[0].userEnteredValue];
      return [];
    });
    expect(formulas.length).toBeGreaterThan(10);
    for (const f of formulas) {
      expect(f.startsWith('='), f).toBe(true);
      expect(f.split('(').length, f).toBe(f.split(')').length);
      expect((f.match(/"/g) || []).length % 2, f).toBe(0);
    }
    expect(reqs.filter((r) => r.addConditionalFormatRule && isOurRule(r.addConditionalFormatRule.rule)).length).toBeGreaterThan(5);
    expect(isOurRule({ booleanRule: { format: { backgroundColor: RED } } })).toBe(true);
    expect(isOurRule({ booleanRule: { format: { backgroundColor: { red: 0, green: 1, blue: 0 } } } })).toBe(false);
  });
});

describe('toSheetDateTime', () => {
  it('normalises to yyyy-MM-dd HH:mm and leaves junk alone', () => {
    expect(toSheetDateTime('2025-03-10T08:00:00')).toBe('2025-03-10 08:00');
    expect(toSheetDateTime('10/03/2025 8:05')).toBe('2025-03-10 08:05');
    expect(toSheetDateTime('')).toBe('');
    expect(toSheetDateTime(undefined)).toBe('');
    expect(toSheetDateTime('not a date')).toBe('not a date');
  });
});
