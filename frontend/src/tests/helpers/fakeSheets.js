/**
 * In-memory stand-in for the Google Sheets REST API (just the parts the app uses).
 * It is deliberately strict: out-of-grid writes and unknown tabs fail like the real API.
 */
const apiError = (status, message) => Object.assign(new Error(message), {
  response: { status, data: { error: { message } } },
});

const colToIndex = (letters) => letters.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

function parseA1(a1) {
  // forms: A1:Z  A:D  A5:D5  5:5  A1
  const m = a1.match(/^([A-Za-z]*)(\d*)(?::([A-Za-z]*)(\d*))?$/);
  if (!m) throw apiError(400, `Unable to parse range: ${a1}`);
  const [, c1, r1, c2, r2] = m;
  const hasEnd = m[3] !== undefined;
  return {
    c1: c1 ? colToIndex(c1) : 0,
    r1: r1 ? parseInt(r1, 10) - 1 : 0,
    c2: hasEnd ? (c2 ? colToIndex(c2) : Infinity) : (c1 ? colToIndex(c1) : Infinity),
    r2: hasEnd ? (r2 ? parseInt(r2, 10) - 1 : Infinity) : (r1 ? parseInt(r1, 10) - 1 : Infinity),
  };
}

const trimRow = (row) => { const r = [...row]; while (r.length && (r[r.length - 1] === '' || r[r.length - 1] === undefined)) r.pop(); return r; };

export class FakeSheets {
  /** tabs: { Title: string[][] } */
  constructor(tabs = {}, { gridRows = 1000, gridCols = 26, locale = 'en_GB' } = {}) {
    this.locale = locale;
    this.nextSheetId = 100;
    this.defaults = { rowCount: gridRows, columnCount: gridCols };
    this.sheets = [];
    this.calls = [];
    this.failNextBatch = null;
    Object.entries(tabs).forEach(([title, values]) => this._addSheet(title, values));
  }

  _addSheet(title, values = [], grid = {}, sheetId) {
    const sheet = {
      properties: { title, sheetId: sheetId ?? this.nextSheetId++, gridProperties: { ...this.defaults, ...grid } },
      values: values.map((r) => [...r]),
      merges: [],
      conditionalFormats: [],
    };
    this.sheets.push(sheet);
    return sheet;
  }

  tab(title) { return this.sheets.find((s) => s.properties.title === title); }
  rows(title) { return (this.tab(title)?.values || []).map(trimRow); }

  _sheetFromRange(range) {
    const i = range.lastIndexOf('!');
    let title = range.slice(0, i);
    if (title.startsWith("'")) title = title.slice(1, -1).replace(/''/g, "'");
    const sheet = this.tab(title);
    if (!sheet) throw apiError(400, `Unable to parse range: ${range}`);
    return { sheet, a1: range.slice(i + 1) };
  }

  _readRange(range) {
    const { sheet, a1 } = this._sheetFromRange(range);
    const { c1, r1, c2, r2 } = parseA1(a1);
    const rows = [];
    for (let r = r1; r < Math.min(sheet.values.length, r2 + 1); r++) {
      const row = sheet.values[r] || [];
      rows.push(trimRow(row.slice(c1, c2 === Infinity ? undefined : c2 + 1)));
    }
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return { range, values: rows };
  }

  _write(sheet, r, c, value) {
    const gp = sheet.properties.gridProperties;
    if (r >= gp.rowCount || c >= gp.columnCount) {
      throw apiError(400, `Range exceeds grid limits. Max rows: ${gp.rowCount}, max columns: ${gp.columnCount}`);
    }
    while (sheet.values.length <= r) sheet.values.push([]);
    while (sheet.values[r].length <= c) sheet.values[r].push('');
    sheet.values[r][c] = value === undefined || value === null ? '' : String(value);
  }

  async get(url) {
    this.calls.push(['GET', url]);
    let m = url.match(/^\/[^/?]+\?fields=/);
    if (m) {
      return { data: { properties: { locale: this.locale }, sheets: this.sheets.map((s) => ({ properties: { ...s.properties, gridProperties: { ...s.properties.gridProperties } }, merges: [...s.merges], conditionalFormats: [...s.conditionalFormats] })) } };
    }
    m = url.match(/^\/[^/?]+\/values:batchGet\?(.*)$/);
    if (m) {
      const ranges = new URLSearchParams(m[1]).getAll('ranges');
      return { data: { valueRanges: ranges.map((r) => this._readRange(r)) } };
    }
    m = url.match(/^\/[^/?]+\/values\/(.+)$/);
    if (m) return { data: this._readRange(decodeURIComponent(m[1])) };
    throw apiError(404, `Unexpected GET ${url}`);
  }

  async put(url, body) {
    this.calls.push(['PUT', url, body]);
    const m = url.match(/^\/[^/?]+\/values\/(.+?)(\?.*)?$/);
    if (!m) throw apiError(404, `Unexpected PUT ${url}`);
    const { sheet, a1 } = this._sheetFromRange(m[1]);
    const { c1, r1 } = parseA1(a1);
    body.values.forEach((row, ri) => row.forEach((v, ci) => this._write(sheet, r1 + ri, c1 + ci, v)));
    return { data: {} };
  }

  async post(url, body) {
    this.calls.push(['POST', url, body]);
    let m = url.match(/^\/[^/?]+\/values\/(.+?):(append|clear)(\?.*)?$/);
    if (m) {
      const { sheet, a1 } = this._sheetFromRange(m[1]);
      if (m[2] === 'clear') {
        const { c1, r1, c2, r2 } = parseA1(a1);
        for (let r = r1; r <= Math.min(r2, sheet.values.length - 1); r++) {
          for (let c = c1; c <= Math.min(c2, (sheet.values[r] || []).length - 1); c++) sheet.values[r][c] = '';
        }
        return { data: {} };
      }
      const { c1 } = parseA1(a1);
      let last = -1;
      sheet.values.forEach((row, i) => { if (trimRow(row).length) last = i; });
      body.values.forEach((row, ri) => row.forEach((v, ci) => this._write(sheet, last + 1 + ri, c1 + ci, v)));
      return { data: {} };
    }
    m = url.match(/^\/[^/?]+:batchUpdate$/);
    if (m) return this._batch(body.requests);
    if (/^\/?$/.test(url)) {
      // spreadsheets.create
      this.sheets = [];
      (body.sheets || [{ properties: { title: 'Sheet1' } }]).forEach((sh) => this._addSheet(sh.properties.title, [], sh.properties.gridProperties || {}));
      return { data: { spreadsheetId: 'test-sheet', sheets: this.sheets.map((sh) => ({ properties: { ...sh.properties } })) } };
    }
    throw apiError(404, `Unexpected POST ${url}`);
  }

  async _batch(requests) {
    if (this.failNextBatch) { const e = this.failNextBatch; this.failNextBatch = null; throw e; }
    const snapshot = JSON.stringify(this.sheets);
    const replies = [];
    try {
      for (const req of requests) {
        const [kind, arg] = Object.entries(req)[0];
        const sid = arg?.range?.sheetId ?? arg?.rule?.ranges?.[0]?.sheetId ?? arg?.sheetId ?? arg?.properties?.sheetId;
        const sheet = this.sheets.find((s) => s.properties.sheetId === sid);
        switch (kind) {
          case 'addSheet': {
            if (this.tab(arg.properties.title)) throw apiError(400, `A sheet with the name "${arg.properties.title}" already exists.`);
            const s = this._addSheet(arg.properties.title, [], arg.properties.gridProperties || {}, arg.properties.sheetId);
            replies.push({ addSheet: { properties: JSON.parse(JSON.stringify(s.properties)) } });
            continue;
          }
          case 'deleteSheet': this.sheets = this.sheets.filter((x) => x.properties.sheetId !== arg.sheetId); break;
          case 'unmergeCells': sheet.merges = []; break;
          case 'repeatCell':
            // Only wipes content when asked to (fields include userEnteredValue); formatting-only calls keep the data.
            if ((arg.fields || '').split(',').some((f) => f.trim() === 'userEnteredValue')) sheet.values = [];
            else (sheet.formatting ||= []).push({ range: arg.range, fields: arg.fields, cell: arg.cell });
            if ((arg.fields || '').split(',').some((f) => f.trim() === 'note') && sheet.notes) {
              const { startRowIndex = 0, endRowIndex = Infinity, startColumnIndex = 0, endColumnIndex = Infinity } = arg.range;
              for (const key of Object.keys(sheet.notes)) {
                const [r, c] = key.split(',').map(Number);
                if (r >= startRowIndex && r < endRowIndex && c >= startColumnIndex && c < endColumnIndex) delete sheet.notes[key];
              }
            }
            break;
          case 'updateDimensionProperties': (sheet.dimensions ||= []).push(arg); break;
          case 'setDataValidation': (sheet.validations ||= []).push({ range: arg.range, rule: arg.rule }); break;
          case 'updateCells': {
            const { startRowIndex = 0, startColumnIndex = 0 } = arg.range;
            arg.rows.forEach((row, ri) => row.values.forEach((cell, ci) => {
              const v = cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.formulaValue;
              if (v !== undefined) this._write(sheet, startRowIndex + ri, startColumnIndex + ci, v);
              if (cell?.note !== undefined) (sheet.notes ||= {})[`${startRowIndex + ri},${startColumnIndex + ci}`] = cell.note;
            }));
            break;
          }
          case 'mergeCells': {
            sheet.merges.push({ ...arg.range });
            // like Google Sheets: only the top-left value of a merged range survives
            const { startRowIndex, endRowIndex, startColumnIndex, endColumnIndex } = arg.range;
            for (let r = startRowIndex; r < endRowIndex; r++) {
              for (let c = startColumnIndex; c < endColumnIndex; c++) {
                if ((r !== startRowIndex || c !== startColumnIndex) && sheet.values[r]?.[c] !== undefined) sheet.values[r][c] = '';
              }
            }
            break;
          }
          case 'updateSheetProperties':
            Object.assign(sheet.properties.gridProperties, arg.properties.gridProperties);
            break;
          case 'deleteConditionalFormatRule':
            if (arg.index >= sheet.conditionalFormats.length) throw apiError(400, `Invalid index ${arg.index}`);
            sheet.conditionalFormats.splice(arg.index, 1);
            break;
          case 'addConditionalFormatRule': sheet.conditionalFormats.splice(arg.index ?? 0, 0, arg.rule); break;
          default: throw apiError(400, `Unsupported request ${kind}`);
        }
        replies.push({});
      }
    } catch (e) {
      this.sheets = JSON.parse(snapshot); // batchUpdate is atomic
      throw e;
    }
    return { data: { replies } };
  }
}

/** Create a service instance wired to a fake spreadsheet. */
export async function makeService(tabs, opts) {
  const { GSheetsService } = await import('../../services/gsheetsService.js');
  const fake = new FakeSheets(tabs, opts);
  const service = new GSheetsService();
  service.client = fake;
  service.spreadsheetId = 'test-sheet';
  service.CACHE_TTL = 0;
  return { service, fake };
}
