/**
 * Contract test against Google's published Sheets v4 API description (the discovery document).
 *
 * Runs the app's real code paths against the in-memory fake, records every request body and
 * query it sends, and checks them against Google's own schema: unknown fields, wrong types,
 * invalid enum values, bad field masks. This catches the class of bug a fake cannot: a request
 * that our fake happily accepts but Google would reject.
 *
 * Needs network access to fetch the schema, so it only runs with CONTRACT=1 (npm run test:contract).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeService } from './helpers/fakeSheets';
import { generateShifts, solveShiftAssignmentGreedy } from '../lib/schedulerCore';

const ENABLED = process.env.CONTRACT === '1';
const DISCOVERY = 'https://sheets.googleapis.com/$discovery/rest?version=v4';

let doc;
beforeAll(async () => {
  if (!ENABLED) return;
  const res = await fetch(DISCOVERY);
  if (!res.ok) throw new Error(`Could not fetch the Google Sheets API description (${res.status})`);
  doc = await res.json();
}, 30000);

/** Validate `value` against schema `s`; returns a list of human-readable problems. */
function validate(value, s, path = '$') {
  const problems = [];
  const schemas = doc.schemas;
  if (s.$ref) return validate(value, schemas[s.$ref], path);
  if (value === null || value === undefined) return problems;

  switch (s.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
      if (s.properties) {
        for (const [k, v] of Object.entries(value)) {
          if (!(k in s.properties)) problems.push(`${path}.${k}: unknown field (allowed: ${Object.keys(s.properties).slice(0, 8).join(', ')}...)`);
          else problems.push(...validate(v, s.properties[k], `${path}.${k}`));
        }
      } else if (s.additionalProperties) {
        for (const [k, v] of Object.entries(value)) problems.push(...validate(v, s.additionalProperties, `${path}.${k}`));
      }
      return problems;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => problems.push(...validate(v, s.items, `${path}[${i}]`)));
      return problems;
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string, got ${typeof value}`];
      if (s.enum && !s.enum.includes(value)) return [`${path}: "${value}" is not one of ${s.enum.join(', ')}`];
      return problems;
    case 'integer':
      return Number.isInteger(value) ? problems : [`${path}: expected integer, got ${value}`];
    case 'number':
      return typeof value === 'number' ? problems : [`${path}: expected number`];
    case 'boolean':
      return typeof value === 'boolean' ? problems : [`${path}: expected boolean`];
    case 'any':
    default:
      return problems;
  }
}

/** Check a Google "fields" mask like sheets(properties(title,sheetId),merges) against a schema. */
function validateMask(mask, schemaName) {
  let i = 0;
  const problems = [];
  const parse = (schema, path) => {
    const s = schema.$ref ? doc.schemas[schema.$ref] : schema;
    const target = s.type === 'array' ? (s.items.$ref ? doc.schemas[s.items.$ref] : s.items) : s;
    while (i < mask.length) {
      let name = '';
      while (i < mask.length && !',()'.includes(mask[i])) name += mask[i++];
      const prop = target.properties?.[name];
      if (!prop) problems.push(`${path}.${name}: not a field of ${schemaName}`);
      if (mask[i] === '(') { i++; if (prop) parse(prop, `${path}.${name}`); else { let d = 1; while (d && i < mask.length) { if (mask[i] === '(') d++; if (mask[i] === ')') d--; i++; } } }
      if (mask[i] === ',') { i++; continue; }
      if (mask[i] === ')') { i++; return; }
    }
  };
  parse({ $ref: schemaName }, '$');
  return problems;
}

const H = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};

describe.skipIf(!ENABLED)('requests conform to the Google Sheets v4 API', () => {
  it('every request the app sends is valid', async () => {
    // Exercise every write path: schema repair, CRUD, bulk append, schedule save/clear.
    const { service, fake } = await makeService({
      Soldiers: [['Name', 'Skills'], ['Dan', 'guard'], ['Eli', 'guard'], ['Avi', 'guard']],
      Posts: [['Name', 'Slots'], ['Gate', 'guard, guard']],
    });
    await service.ensureSchema({ force: true });
    await service.createSoldier({ name: 'Ben', division: 1, skills: ['guard'], excluded_posts: [] });
    await service.updateSoldier(1, { name: 'Daniel', division: 2, skills: ['guard'], excluded_posts: [] });
    await service.deleteSoldier(4);
    await service.appendSoldiers([{ name: 'Gil', division: null, skills: ['guard'], excluded_posts: [] }]);
    await service.createPost({ name: 'Tower', shift_length_hours: 8, start_time: '06:00', end_time: '22:00', cooldown_hours: 0, intensity_weight: 1, slots: ['guard'], is_active: true });
    await service.updatePost('Tower', { name: 'Tower', shift_length_hours: 6, start_time: '06:00', end_time: '22:00', cooldown_hours: 0, intensity_weight: 1, slots: ['guard'], is_active: false });
    await service.deletePost('Tower');
    await service.createUnavailability({ soldier_id: 2, start_datetime: '2025-03-10T08:00:00', end_datetime: '2025-03-10T12:00:00', reason: 'x' });
    await service.updateUnavailability(1, { soldier_id: 2, start_datetime: '2025-03-10T09:00:00', end_datetime: '2025-03-10T12:00:00', reason: 'y' });
    await service.deleteUnavailability(1);

    const soldiers = await service.getSoldiers();
    const posts = (await service.getPosts()).filter((p) => p.is_active);
    const shifts = generateShifts(posts, '2025-03-10T06:00:00', '2025-03-11T06:00:00', true);
    const a = solveShiftAssignmentGreedy(shifts, soldiers, {}, []).map((x) => ({ ...x, start: x.start.toISOString(), end: x.end.toISOString() }));
    await service.saveAssignments('2025-03-10T06:00:00', '2025-03-11T06:00:00', a);
    await service.saveAssignments('2025-03-12T06:00:00', '2025-03-13T06:00:00', a.map((x) => ({ ...x, start: x.start.replace('03-10', '03-12').replace('03-11', '03-13'), end: x.end.replace('03-10', '03-12').replace('03-11', '03-13') })));
    // rule violations are marked with notes and text formatting: those requests must be valid too
    const clash = (role) => ({ soldier_name: 'Daniel', post_name: 'Gate', role_id: role, start: '2025-03-14T06:00:00', end: '2025-03-14T14:00:00' });
    await service.saveAssignments('2025-03-14T06:00:00', '2025-03-15T06:00:00', [clash(0), clash(1)]);
    expect((await service.checkSchedule()).violations.length).toBeGreaterThan(0);
    await service.applyAllFormatting(); // everything at once: all request types, twice
    await service.applyAllFormatting();
    await service.openDayView('2025-03-14'); // the Day View tab: formulas, dropdown, hidden rows, colours
    await service.saveAssignments('2025-03-10T06:00:00', '2025-03-15T06:00:00', []); // clear everything
    await service.applyFormatting();
    await service.applyFormatting(); // second run also deletes + re-adds the app's own rules
    await service.getHealth();

    const problems = [];
    let batches = 0;
    for (const [method, url, body] of fake.calls) {
      if (/:batchUpdate$/.test(url)) {
        batches++;
        problems.push(...validate(body, { $ref: 'BatchUpdateSpreadsheetRequest' }, 'batchUpdate'));
      } else if (/:append|\/values\/[^:]+$/.test(url) && body) {
        problems.push(...validate(body, { $ref: 'ValueRange' }, `${method} values`));
      }
      const q = new URL(url, 'https://x').searchParams;
      if (q.get('valueInputOption')) expect(['RAW', 'USER_ENTERED']).toContain(q.get('valueInputOption'));
      if (q.get('insertDataOption')) expect(['OVERWRITE', 'INSERT_ROWS']).toContain(q.get('insertDataOption'));
      if (q.get('fields')) problems.push(...validateMask(q.get('fields'), 'Spreadsheet').map((p) => `fields=${q.get('fields')} ${p}`));
    }
    expect(batches).toBeGreaterThan(3);
    expect(problems).toEqual([]);
  }, 60000);

  it('the validator itself rejects bad requests (guards against a vacuous pass)', () => {
    expect(validate({ requests: [{ repeatCell: { range: { sheetId: 1 }, cell: {}, fields: 'x', bogus: 1 } }] }, { $ref: 'BatchUpdateSpreadsheetRequest' })).not.toEqual([]);
    expect(validate({ requests: [{ updateSheetProperties: { properties: { gridProperties: { rowCount: 'ten' } }, fields: 'x' } }] }, { $ref: 'BatchUpdateSpreadsheetRequest' })).not.toEqual([]);
    expect(validateMask('sheets(properties(title,nope))', 'Spreadsheet')).not.toEqual([]);
    expect(validateMask('sheets(properties(title,sheetId,gridProperties),merges,conditionalFormats)', 'Spreadsheet')).toEqual([]);
  });
});
