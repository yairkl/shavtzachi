import {
  addMinutes,
  differenceInMinutes,
  format,
  startOfHour,
  parseISO,
  isBefore,
} from 'date-fns';
import { parseDateTime, parseTime, timeToMinutes } from '../lib/sheetModel';

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const MAX_ROWS = 5000;

/**
 * Pick a grid step (in minutes) on which every assignment start/end lands exactly.
 * Posts can start at any time (06:00, 06:20...) with any shift length, so a fixed step would
 * silently drop shifts that do not line up with it.
 */
export function chooseStepMinutes(assignments, origin) {
  let g = 0;
  for (const a of assignments) {
    const s = typeof a.start === 'string' ? parseISO(a.start) : a.start;
    const e = typeof a.end === 'string' ? parseISO(a.end) : a.end;
    for (const t of [s, e]) {
      const off = Math.abs(differenceInMinutes(t, origin));
      g = gcd(g, off);
    }
  }
  if (g === 0) return 60;
  // Prefer whole hours / sensible divisions of a day when possible.
  return Math.min(Math.max(g, 1), 24 * 60);
}

/**
 * Port of build_schedule_requests.
 * timeGranularityHours: fixed row height in hours, or omit/null to choose one that fits all shifts.
 * The returned array has a `stats` property: { written, skipped }.
 */
export function buildScheduleRequests(sheetIdRaw, assignments, startDate, endDate, timeGranularityHours = null) {
  const sheetId = parseInt(sheetIdRaw);
  if (!assignments.length && !startDate) return [];

  // 1. Standardize range
  const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
  const end = typeof endDate === 'string' ? parseISO(endDate) : endDate;

  let current_time = startOfHour(start);
  const stepMinutes = timeGranularityHours ? Math.round(timeGranularityHours * 60) : chooseStepMinutes(assignments, current_time);

  const time_steps = [];
  let temp_time = current_time;
  while (isBefore(temp_time, end)) {
    time_steps.push(temp_time);
    temp_time = addMinutes(temp_time, stepMinutes);
    if (time_steps.length > MAX_ROWS) {
      throw new Error('The schedule covers too long a period (or its shift times are too irregular) to be written to one sheet. Save a shorter period.');
    }
  }

  const time_to_row = {};
  time_steps.forEach((t, i) => {
    time_to_row[t.toISOString()] = i + 2; // Data starts at row 2
  });

  // 2. Map Columns
  const unique_posts = [...new Set(assignments.map(a => a.post_name))].sort();
  const roles_per_post = {};
  assignments.forEach(a => {
    if (!roles_per_post[a.post_name]) roles_per_post[a.post_name] = new Set();
    roles_per_post[a.post_name].add(a.role_id);
  });

  const post_to_cols = {};
  const post_col_ranges = {};
  let current_col = 2; // Col A=Date, B=Time

  unique_posts.forEach(p_name => {
    const num_roles = roles_per_post[p_name] ? Math.max(...Array.from(roles_per_post[p_name])) + 1 : 1;
    const start_c = current_col;
    post_to_cols[p_name] = [];
    for (let r = 0; r < num_roles; r++) {
      post_to_cols[p_name].push({ role_id: r, col: current_col });
      current_col++;
    }
    post_col_ranges[p_name] = { start: start_c, end: current_col };
  });

  // 3. Build Grid Data
  const row_data = [];
  const merges = [];

  const get_cell = (val, is_header = false, bg_color = null) => {
    const cell = { userEnteredValue: { stringValue: val?.toString() || "" } };
    const format = {
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      borders: {
        top: { style: 'SOLID' }, bottom: { style: 'SOLID' },
        left: { style: 'SOLID' }, right: { style: 'SOLID' }
      }
    };
    if (is_header) {
      format.backgroundColor = { red: 63 / 255, green: 81 / 255, blue: 181 / 255 };
      format.textFormat = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };
    }
    if (bg_color) {
      format.backgroundColor = bg_color;
    }
    cell.userEnteredFormat = format;
    return cell;
  };

  const set_cell = (r, c, cell_dict) => {
    while (row_data.length <= r) row_data.push([]);
    while (row_data[r].length <= c) row_data[r].push({ userEnteredValue: { stringValue: "" } });
    row_data[r][c] = cell_dict;
  };

  // --- Headers ---
  set_cell(0, 0, get_cell("Date", true));
  set_cell(0, 1, get_cell("Time", true));
  set_cell(1, 0, get_cell("", true));
  set_cell(1, 1, get_cell("", true));
  merges.push({ sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 });
  merges.push({ sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 });

  Object.entries(post_col_ranges).forEach(([p_name, range]) => {
    set_cell(0, range.start, get_cell(p_name, true));
    if (range.end - range.start > 1) {
      for (let c = range.start + 1; c < range.end; c++) set_cell(0, c, get_cell("", true));
      merges.push({ sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: range.start, endColumnIndex: range.end });
      // Role subheaders
      post_to_cols[p_name].forEach(pCol => {
        const role_name = assignments.find(a => a.post_name === p_name && a.role_id === pCol.role_id)?.role_name;
        set_cell(1, pCol.col, get_cell(role_name || `Role ${pCol.role_id + 1}`, true));
      });
    } else {
      merges.push({ sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: range.start, endColumnIndex: range.end });
    }
  });

  // --- Y-Axis (Date & Time) ---
  let last_date = null;
  let date_start_row = 2;
  time_steps.forEach((t, i) => {
    const r = i + 2;
    const curr_date = format(t, 'dd/MM/yyyy');
    set_cell(r, 0, get_cell(curr_date));

    const end_t = addMinutes(t, stepMinutes);
    const time_range_str = `${format(t, 'HH:mm')} - ${format(end_t, 'HH:mm')}`;
    set_cell(r, 1, get_cell(time_range_str));

    if (last_date !== null && curr_date !== last_date) {
      if (r > date_start_row + 1) {
        merges.push({ sheetId, startRowIndex: date_start_row, endRowIndex: r, startColumnIndex: 0, endColumnIndex: 1 });
      }
      date_start_row = r;
    }
    last_date = curr_date;
  });

  if (time_steps.length + 2 > date_start_row + 1) {
    merges.push({ sheetId, startRowIndex: date_start_row, endRowIndex: time_steps.length + 2, startColumnIndex: 0, endColumnIndex: 1 });
  }

  // --- Data ---
  let written = 0;
  let skipped = 0;
  const placements = [];
  assignments.forEach(a => {
    const p_name = a.post_name;
    const r_id = Number(a.role_id);
    const raw_start = typeof a.start === 'string' ? parseISO(a.start) : a.start;
    const raw_end = typeof a.end === 'string' ? parseISO(a.end) : a.end;

    // Row range covering [raw_start, raw_end): snap outwards to the grid (exact when the step was auto-chosen).
    const gridEnd = time_steps.length ? addMinutes(time_steps[time_steps.length - 1], stepMinutes) : null;
    if (!gridEnd || raw_start.getTime() >= gridEnd.getTime()) { skipped++; return; }
    let startIdx = -1;
    for (let i = 0; i < time_steps.length; i++) {
      if (time_steps[i].getTime() <= raw_start.getTime()) startIdx = i; else break;
    }
    if (startIdx === -1) {
      // Starts before the grid: only keep it if it overlaps the grid at all.
      if (time_steps.length && raw_end.getTime() > time_steps[0].getTime()) startIdx = 0;
      else { skipped++; return; }
    }
    let endIdx = time_steps.length;
    for (let i = startIdx + 1; i < time_steps.length; i++) {
      if (time_steps[i].getTime() >= raw_end.getTime()) { endIdx = i; break; }
    }
    const start_row = startIdx + 2;
    const end_row = endIdx + 2;

    const col = post_to_cols[p_name]?.find(pc => pc.role_id === r_id)?.col;
    if (col === undefined) { skipped++; return; }
    for (let r = start_row; r < end_row; r++) {
      // No explicit bg color — division coloring is handled via conditional formatting rules
      set_cell(r, col, get_cell(a.soldier_name, false, null));
    }
    if (end_row > start_row + 1) {
      merges.push({ sheetId, startRowIndex: start_row, endRowIndex: end_row, startColumnIndex: col, endColumnIndex: col + 1 });
    }
    placements.push({ assignment: a, row: start_row, col });
    written++;
  });

  const requests = [];
  requests.push({ unmergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 200 } } });

  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
      rows: row_data.map(r => ({ values: r })),
      fields: 'userEnteredValue,userEnteredFormat'
    }
  });

  const unique_merges = [];
  const seen_merges = new Set();
  merges.forEach(m => {
    const key = `${m.startRowIndex}-${m.endRowIndex}-${m.startColumnIndex}-${m.endColumnIndex}`;
    if (!seen_merges.has(key)) {
      seen_merges.add(key);
      unique_merges.push(m);
    }
  });

  unique_merges.forEach(m => {
    if (m.endRowIndex > m.startRowIndex || m.endColumnIndex > m.startColumnIndex) {
      requests.push({ mergeCells: { range: m, mergeType: 'MERGE_ALL' } });
    }
  });

  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 }
      },
      fields: 'gridProperties(frozenRowCount,frozenColumnCount)'
    }
  });

  requests.stats = { written, skipped };
  requests.placements = placements; // where each assignment's cell ended up (0-based row/col)
  return requests;
}

export const DIVISION_COLORS = [
  { red: 227 / 255, green: 242 / 255, blue: 253 / 255 },  // Blue
  { red: 232 / 255, green: 245 / 255, blue: 233 / 255 },  // Green
  { red: 255 / 255, green: 243 / 255, blue: 224 / 255 },  // Orange
  { red: 243 / 255, green: 229 / 255, blue: 245 / 255 },  // Purple
  { red: 241 / 255, green: 248 / 255, blue: 233 / 255 },  // Light green
  { red: 224 / 255, green: 247 / 255, blue: 250 / 255 },  // Cyan
  { red: 255 / 255, green: 249 / 255, blue: 196 / 255 },  // Yellow
  { red: 252 / 255, green: 228 / 255, blue: 236 / 255 },  // Pink
  { red: 239 / 255, green: 235 / 255, blue: 233 / 255 },  // Brown
  { red: 236 / 255, green: 239 / 255, blue: 241 / 255 },  // Grey
];

const a1col = (i) => { let n = i + 1; let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/**
 * Conditional formatting for the Schedule tab:
 *  - a fill colour per division (looked up from the Soldiers tab by name; division n uses colour ((n-1) mod 10)+1)
 *  - a red fill, with top priority, when the same person appears twice in one time row (a double booking you just typed)
 * The Soldiers tab and its Name/Division columns are located by header, so reordered columns still work.
 * `soldiers` = { title, nameCol, divisionCol } (0-based column indexes); without both columns only the double-booking rule is added.
 */
export function buildDivisionColoringRules(sheetId, soldiers = { title: 'Soldiers', nameCol: 0, divisionCol: 1 }, grid = { rowCount: 1000, columnCount: 100 }) {
  const requests = [];
  const range = { sheetId, startRowIndex: 2, endRowIndex: Math.max(grid.rowCount || 1000, 3), startColumnIndex: 2, endColumnIndex: Math.max(grid.columnCount || 100, 3) };
  const lastCol = a1col(range.endColumnIndex - 1);

  if (soldiers && soldiers.nameCol !== undefined && soldiers.divisionCol !== undefined) {
    const q = String(soldiers.title).replace(/'/g, "''");
    const rng = (c) => `INDIRECT("'${q}'!$${a1col(c)}$2:$${a1col(c)}")`;
    const division = `IFERROR(VALUE(INDEX(${rng(soldiers.divisionCol)},MATCH(C3,${rng(soldiers.nameCol)},0))),0)`;
    DIVISION_COLORS.forEach((color, i) => {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [range],
            booleanRule: {
              condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND(LEN(C3)>0,${division}>0,MOD(${division}-1,${DIVISION_COLORS.length})+1=${i + 1})` }] },
              format: { backgroundColor: color },
            },
          },
          index: i,
        },
      });
    });
  }

  // Highest priority: the same name twice in one row.
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND(LEN(C3)>0,COUNTIF($C3:$${lastCol}3,C3)>1)` }] },
          format: { backgroundColor: { red: 0.96, green: 0.78, blue: 0.78 }, textFormat: { bold: true } },
        },
      },
      index: 0,
    },
  });
  return requests;
}

/**
 * Mark cells whose assignment breaks a rule: bold dark-red text plus a note explaining why.
 * (Text colour and notes are used because conditional fills, e.g. division colours, would hide a static fill.)
 * Always starts by clearing earlier marks in the data area. marks = [{ row, col, notes: [string] }]
 */
export function buildViolationMarkRequests(sheetId, marks, grid = { rowCount: 1000, columnCount: 100 }) {
  const requests = [{
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: Math.max(grid.rowCount || 1000, 3), startColumnIndex: 2, endColumnIndex: Math.max(grid.columnCount || 100, 3) },
      cell: { userEnteredFormat: { textFormat: { bold: false, foregroundColor: {} } }, note: '' },
      fields: 'note,userEnteredFormat.textFormat',
    },
  }];
  for (const m of marks) {
    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: m.row, endRowIndex: m.row + 1, startColumnIndex: m.col, endColumnIndex: m.col + 1 },
        rows: [{ values: [{ note: `Problem${m.notes.length > 1 ? 's' : ''}:\n- ${m.notes.join('\n- ')}`, userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 0.72, green: 0.05, blue: 0.05 } } } }] }],
        fields: 'note,userEnteredFormat.textFormat',
      },
    });
  }
  return requests;
}

/**
 * Port of parse_grid
 */
export function parseGrid(gridRows, activePosts, merges = [], timeGranularityHours = 1) {
  if (!gridRows || gridRows.length < 3) return [];

  const mergeMap = {};
  merges.forEach(m => {
    mergeMap[`${m.startRowIndex}-${m.startColumnIndex}`] = m.endRowIndex;
  });

  const val = (r, c) => gridRows[r]?.[c]?.toString().trim() || "";

  const colToPost = {};
  let c = 2;
  // Google trims trailing blank cells per row, so the header row can be shorter than the data.
  const width = Math.max(0, ...gridRows.map((row) => (row ? row.length : 0)));
  while (c < width) {
    const pName = val(0, c);
    if (pName) {
      let roleId = 0;
      colToPost[c] = { name: pName, role_id: roleId };
      let lookahead = c + 1;
      while (lookahead < width && val(0, lookahead) === "" && val(1, lookahead) !== "") {
        roleId++;
        colToPost[lookahead] = { name: pName, role_id: roleId };
        lookahead++;
      }
      c = lookahead;
    } else {
      c++;
    }
  }

  const rowToDt = {};
  const rowStep = {}; // minutes per row, from the Time column label
  const stepOf = (r) => (rowStep[r] ?? timeGranularityHours * 60);
  let lastDStr = null;
  for (let r = 2; r < gridRows.length; r++) {
    let dStr = val(r, 0) || lastDStr;
    let tStr = val(r, 1);
    if (dStr && tStr) {
      lastDStr = dStr;
      let endLabel = null;
      if (tStr.includes(" - ")) { [tStr, endLabel] = tStr.split(" - "); }
      // Tolerates "6:00", "06:00", d/M/yyyy and yyyy-MM-dd, written by hand or by this app.
      const label = tStr.trim();
      const parsed = parseDateTime(`${dStr} ${label}`);
      if (parsed && !parsed.dateOnly) {
        rowToDt[r] = parsed.date;
        // The row's own "HH:mm - HH:mm" label tells how long the row is, whatever step the sheet was written with.
        if (endLabel) {
          const sm = timeToMinutes(parseTime(label));
          const em = timeToMinutes(parseTime(endLabel));
          if (sm !== null && em !== null) rowStep[r] = ((em - sm) + 24 * 60) % (24 * 60) || 24 * 60;
        }
      }
    }
  }

  const assignments = [];
  for (const [col, postInfo] of Object.entries(colToPost)) {
    const cIdx = parseInt(col);
    let r = 2;
    while (r < gridRows.length) {
      const soldierName = val(r, cIdx);
      if (soldierName && rowToDt[r]) {
        const startDt = rowToDt[r];
        let endDt;
        let currR;

        if (mergeMap[`${r}-${cIdx}`]) {
          const endRow = mergeMap[`${r}-${cIdx}`];
          if (rowToDt[endRow]) {
            endDt = rowToDt[endRow];
          } else {
            const lastR = Math.max(...Object.keys(rowToDt).map(Number));
            endDt = addMinutes(rowToDt[lastR], (endRow - lastR) * stepOf(lastR));
          }
          currR = endRow;
        } else {
          currR = r + 1;
          endDt = addMinutes(rowToDt[r], stepOf(r));
        }

        assignments.push({
          post_name: postInfo.name,
          start: startDt,
          end: endDt,
          role_id: postInfo.role_id,
          soldier_name: soldierName,
          row: r, // 0-based sheet position of the (top-left) cell, so problems can be marked in the sheet
          col: cIdx
        });
        r = currR;
      } else {
        r++;
      }
    }
  }

  return assignments;
}
