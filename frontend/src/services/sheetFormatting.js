/**
 * Makes the data tabs pleasant and safe to edit by hand in Google Sheets:
 * styled + frozen header, column widths, header notes, dropdowns and input validation,
 * ISO date / 24h time formats (so values always read back unambiguously), and red/amber
 * highlighting of cells the app would not understand.
 *
 * Everything is derived from the actual header positions, so re-ordered columns work.
 * Applying it twice gives the same result (our own highlight rules are replaced, never duplicated).
 */
import { colLetter } from '../lib/sheetModel';

const HEADER_BG = { red: 63 / 255, green: 81 / 255, blue: 181 / 255 };
export const RED = { red: 0.96, green: 0.78, blue: 0.78 };
export const AMBER = { red: 1, green: 0.92, blue: 0.7 };

const near = (a = {}, b) => ['red', 'green', 'blue'].every((k) => Math.abs((a[k] ?? 0) - b[k]) < 0.005);
/** True for a conditional-format rule created by this app (identified by its fill colour). */
export const isOurRule = (rule) => {
  const bg = rule?.booleanRule?.format?.backgroundColor;
  return !!bg && (near(bg, RED) || near(bg, AMBER));
};

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

/**
 * Per tab, per field: how it should look and behave.
 * `c(field)` gives that field's column letter; `r` is the first data row (2).
 */
const specs = (c, ctx) => ({
  Soldiers: {
    name: {
      width: 170,
      note: 'Required. One row per person. Names must be unique - schedules refer to people by name.',
      validation: { custom: `=COUNTIF($${c('name')}$2:$${c('name')},${c('name')}2)<=1`, message: 'Names must be unique.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('name')}2)>0,COUNTIF($${c('name')}$2:$${c('name')},${c('name')}2)>1)` }],
    },
    division: {
      width: 90,
      note: 'Optional whole number (1, 2, 3...). Used to colour people on the schedule.',
      format: { type: 'NUMBER', pattern: '0' },
      validation: { type: 'NUMBER_GREATER_THAN_EQ', values: ['1'], message: 'A whole number, 1 or more.' },
    },
    skills: { width: 230, wrap: true, note: 'Comma-separated, e.g. guard, medic. Must match the skills used in Posts > Slots.' },
    excluded_posts: { width: 210, wrap: true, note: 'Optional. Comma-separated post names this person must never be assigned to.' },
    rowHighlight: { color: AMBER, anchor: 'name', formula: (L) => `=AND(LEN($${L}2)=0,COUNTA($A2:$Z2)>0)` },
  },
  Posts: {
    name: {
      width: 150,
      note: 'Required. Unique name of the post.',
      validation: { custom: `=COUNTIF($${c('name')}$2:$${c('name')},${c('name')}2)<=1`, message: 'Post names must be unique.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('name')}2)>0,COUNTIF($${c('name')}$2:$${c('name')},${c('name')}2)>1)` }],
    },
    shift_length_hours: {
      width: 110,
      note: 'Length of one shift in hours, e.g. 8 or 4.5.',
      validation: { type: 'NUMBER_BETWEEN', values: ['0.25', '168'], message: 'Hours between 0.25 and 168.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('shift_length_hours')}2)>0,NOT(IFERROR(VALUE(${c('shift_length_hours')}2)>0,FALSE)))` }],
    },
    start_time: {
      width: 100,
      note: 'Time of day the post opens, e.g. 06:00.',
      format: { type: 'TIME', pattern: 'hh:mm' },
      validation: { custom: `=OR(ISNUMBER(${c('start_time')}2),NOT(ISERROR(TIMEVALUE(${c('start_time')}2))))`, message: 'Enter a time like 06:00.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('start_time')}2)>0,NOT(ISNUMBER(${c('start_time')}2)),ISERROR(TIMEVALUE(${c('start_time')}2)))` }],
    },
    end_time: {
      width: 100,
      note: 'Time of day the post closes. Same as Start (or earlier) means it runs past midnight / around the clock.',
      format: { type: 'TIME', pattern: 'hh:mm' },
      validation: { custom: `=OR(ISNUMBER(${c('end_time')}2),NOT(ISERROR(TIMEVALUE(${c('end_time')}2))))`, message: 'Enter a time like 18:00.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('end_time')}2)>0,NOT(ISNUMBER(${c('end_time')}2)),ISERROR(TIMEVALUE(${c('end_time')}2)))` }],
    },
    cooldown_hours: { width: 90, note: 'Minimum rest in hours between two shifts for the same person.', validation: { type: 'NUMBER_GREATER_THAN_EQ', values: ['0'], message: '0 or more hours.' } },
    intensity_weight: { width: 90, note: 'How demanding the post is (1 = normal, 2 = twice as heavy). Used for fair workload.', validation: { type: 'NUMBER_GREATER', values: ['0'], message: 'A number above 0.' } },
    slots: {
      width: 230,
      wrap: true,
      note: 'One required skill per person needed on each shift, comma-separated. Repeat a skill for more people: guard, guard, medic.',
      highlight: [{ color: AMBER, formula: `=AND(LEN($${c('name')}2)>0,LEN(${c('slots')}2)=0)` }],
    },
    is_active: {
      width: 90,
      note: 'TRUE = scheduled, FALSE = skipped. Blank counts as TRUE.',
      validation: { type: 'ONE_OF_LIST', values: ['TRUE', 'FALSE'], dropdown: true, message: 'TRUE or FALSE.' },
    },
    active_from: {
      width: 140,
      note: 'Optional. The post only exists from this date/time (yyyy-mm-dd hh:mm).',
      format: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' },
      validation: { type: 'DATE_IS_VALID', message: 'Enter a valid date.' },
    },
    active_until: {
      width: 140,
      note: 'Optional. The post stops after this date/time. A date without a time includes that whole day.',
      format: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' },
      validation: { type: 'DATE_IS_VALID', message: 'Enter a valid date.' },
    },
  },
  Unavailabilities: {
    soldier: {
      width: 170,
      note: 'Pick a person from the Soldiers sheet.',
      validation: ctx.soldierNameRange ? { type: 'ONE_OF_RANGE', values: [`=${ctx.soldierNameRange}`], dropdown: true, message: 'Pick someone from the Soldiers sheet.' } : null,
      highlight: ctx.soldierNameRange ? [{ color: AMBER, formula: `=AND(LEN(${c('soldier')}2)>0,COUNTIF(INDIRECT("${ctx.soldierNameRange.replace(/"/g, '""')}"),${c('soldier')}2)=0)` }] : [],
    },
    start: {
      width: 150,
      note: 'When the absence starts (yyyy-mm-dd hh:mm).',
      format: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' },
      validation: { type: 'DATE_IS_VALID', message: 'Enter a valid date and time.' },
      highlight: [{ color: RED, formula: `=AND(LEN(${c('start')}2)>0,ISERROR(VALUE(${c('start')}2)))` }],
    },
    end: {
      width: 150,
      note: 'When the absence ends (yyyy-mm-dd hh:mm). A date without a time includes that whole day.',
      format: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' },
      validation: { type: 'DATE_IS_VALID', message: 'Enter a valid date and time.' },
      highlight: [
        { color: RED, formula: `=AND(LEN(${c('end')}2)>0,ISERROR(VALUE(${c('end')}2)))` },
        { color: RED, formula: `=AND(LEN(${c('end')}2)>0,LEN(${c('start')}2)>0,IFERROR(VALUE(${c('end')}2)<=VALUE(${c('start')}2),FALSE))` },
      ],
    },
    reason: { width: 210, note: 'Optional free text.' },
  },
});

/**
 * @param sheets  [{ tab, sheetId, title, columns: {field: colIndex}, rowCount, conditionalFormats }] (all existing data tabs)
 * @param only    optional list of tabs to format (the others are still used for cross-references)
 * @returns batchUpdate requests
 */
export function buildFormattingRequests(sheets, only = null) {
  const requests = [];
  const soldiers = sheets.find((s) => s.tab === 'Soldiers');
  const soldierNameRange = soldiers && soldiers.columns.name !== undefined
    ? `${q(soldiers.title)}!$${colLetter(soldiers.columns.name)}$2:$${colLetter(soldiers.columns.name)}`
    : null;

  for (const sh of sheets) {
    if (only && !only.includes(sh.tab)) continue;
    const cols = sh.columns;
    const c = (field) => colLetter(cols[field] ?? 0);
    const tabSpec = specs(c, { soldierNameRange })[sh.tab];
    const sheetId = sh.sheetId;
    const lastRow = Math.max(sh.rowCount || 1000, 2);
    const mapped = Object.entries(cols).filter(([, i]) => i !== undefined);
    const width = Math.max(...mapped.map(([, i]) => i)) + 1;

    // Header: bold white on indigo, frozen.
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
        cell: { userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
      },
    });
    requests.push({
      updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' },
    });

    // Our own previous highlight rules are replaced (deleted highest index first so indexes stay valid).
    (sh.conditionalFormats || []).map((rule, i) => (isOurRule(rule) ? i : -1)).filter((i) => i >= 0).reverse()
      .forEach((index) => requests.push({ deleteConditionalFormatRule: { sheetId, index } }));

    for (const [field, idx] of mapped) {
      const f = tabSpec[field];
      if (!f) continue;
      const colRange = { sheetId, startColumnIndex: idx, endColumnIndex: idx + 1 };
      const dataRange = { ...colRange, startRowIndex: 1, endRowIndex: lastRow };

      if (f.width) {
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
            properties: { pixelSize: f.width },
            fields: 'pixelSize',
          },
        });
      }
      if (f.note) {
        requests.push({
          updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: idx, endColumnIndex: idx + 1 }, rows: [{ values: [{ note: f.note }] }], fields: 'note' },
        });
      }
      if (f.format || f.wrap) {
        const fmt = {};
        const fields = [];
        if (f.format) { fmt.numberFormat = f.format; fields.push('userEnteredFormat.numberFormat'); }
        if (f.wrap) { fmt.wrapStrategy = 'WRAP'; fields.push('userEnteredFormat.wrapStrategy'); }
        requests.push({ repeatCell: { range: dataRange, cell: { userEnteredFormat: fmt }, fields: fields.join(',') } });
      }
      const v = f.validation;
      if (v) {
        const condition = v.custom
          ? { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: v.custom }] }
          : { type: v.type, values: (v.values || []).map((x) => ({ userEnteredValue: x })) };
        requests.push({
          setDataValidation: { range: dataRange, rule: { condition, inputMessage: v.message, strict: false, showCustomUi: !!v.dropdown } },
        });
      }
      (f.highlight || []).forEach((h) => {
        requests.push({
          addConditionalFormatRule: {
            rule: { ranges: [dataRange], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: h.formula }] }, format: { backgroundColor: h.color } } },
            index: 0,
          },
        });
      });
    }

    if (tabSpec.rowHighlight && cols[tabSpec.rowHighlight.anchor] !== undefined) {
      const L = colLetter(cols[tabSpec.rowHighlight.anchor]);
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: width }],
            booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: tabSpec.rowHighlight.formula(L) }] }, format: { backgroundColor: tabSpec.rowHighlight.color } },
          },
          index: 0,
        },
      });
    }
  }
  return requests;
}
