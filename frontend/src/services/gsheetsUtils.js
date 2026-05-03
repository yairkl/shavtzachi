import { 
  addHours, 
  format, 
  parse, 
  startOfHour, 
  parseISO,
  isEqual,
  addSeconds,
  isBefore,
  isAfter,
  addDays
} from 'date-fns';

/**
 * Port of build_schedule_requests
 */
export function buildScheduleRequests(sheetIdRaw, assignments, startDate, endDate, timeGranularityHours = 1) {
  const sheetId = parseInt(sheetIdRaw);
  if (!assignments.length && !startDate) return [];

  // 1. Standardize range to full hours (Literal port)
  const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
  const end = typeof endDate === 'string' ? parseISO(endDate) : endDate;
  
  let current_time = startOfHour(start);
  let limit_time = startOfHour(end);
  if (isBefore(limit_time, end)) {
    limit_time = addHours(limit_time, timeGranularityHours);
  }

  const time_steps = [];
  let temp_time = current_time;
  while (isBefore(temp_time, limit_time)) {
    time_steps.push(temp_time);
    temp_time = addHours(temp_time, timeGranularityHours);
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

    const end_t = addHours(t, timeGranularityHours);
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
  const div_colors = [
    { red: 227 / 255, green: 242 / 255, blue: 253 / 255 },  // Blue 50
    { red: 232 / 255, green: 245 / 255, blue: 233 / 255 },  // Green 50
    { red: 255 / 255, green: 243 / 255, blue: 224 / 255 },  // Orange 50
    { red: 243 / 255, green: 229 / 255, blue: 245 / 255 },  // Purple 50
    { red: 241 / 255, green: 248 / 255, blue: 233 / 255 },  // Light Green 50
  ];

  assignments.forEach(a => {
    const p_name = a.post_name;
    const r_id = Number(a.role_id);
    const raw_start = typeof a.start === 'string' ? parseISO(a.start) : a.start;
    const raw_end = typeof a.end === 'string' ? parseISO(a.end) : a.end;

    const s_dt = startOfHour(raw_start);
    let e_dt = startOfHour(raw_end);
    if (isAfter(raw_end, e_dt)) {
      e_dt = addHours(e_dt, timeGranularityHours);
    }

    let start_row;
    if (!time_to_row[s_dt.toISOString()]) {
      if (isBefore(s_dt, time_steps[0]) && isAfter(e_dt, time_steps[0])) {
        start_row = 2;
      } else {
        return;
      }
    } else {
      start_row = time_to_row[s_dt.toISOString()];
    }

    let end_row;
    if (time_to_row[e_dt.toISOString()]) {
      end_row = time_to_row[e_dt.toISOString()];
    } else {
      end_row = time_steps.length + 2;
    }

    const col = post_to_cols[p_name]?.find(pc => pc.role_id === r_id)?.col;
    if (col !== undefined) {
      for (let r = start_row; r < end_row; r++) {
        // No explicit bg color — division coloring is handled via conditional formatting rules
        set_cell(r, col, get_cell(a.soldier_name, false, null));
      }
      if (end_row > start_row + 1) {
        merges.push({ sheetId, startRowIndex: start_row, endRowIndex: end_row, startColumnIndex: col, endColumnIndex: col + 1 });
      }
    }
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

  return requests;
}

/**
 * Builds conditional formatting rules to color cells based on soldier division.
 * References the 'Soldiers' sheet to determine division membership.
 */
export function buildDivisionColoringRules(sheetId) {
  const div_colors = [
    { red: 227 / 255, green: 242 / 255, blue: 253 / 255 },  // Blue 50
    { red: 232 / 255, green: 245 / 255, blue: 233 / 255 },  // Green 50
    { red: 255 / 255, green: 243 / 255, blue: 224 / 255 },  // Orange 50
    { red: 243 / 255, green: 229 / 255, blue: 245 / 255 },  // Purple 50
    { red: 241 / 255, green: 248 / 255, blue: 233 / 255 },  // Light Green 50
  ];

  const requests = [];

  // Add a rule for each color/division index
  div_colors.forEach((color, i) => {
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{
            sheetId: sheetId,
            startRowIndex: 2,
            endRowIndex: 1000,
            startColumnIndex: 2,
            endColumnIndex: 100
          }],
          booleanRule: {
            condition: {
              type: 'CUSTOM_FORMULA',
              values: [{
                // Formula: lookup the soldier in the 'Soldiers' sheet and check if their division matches the color index
                // C3 is the top-left cell of the range (startRowIndex: 2, startColumnIndex: 2)
                userEnteredValue: `=AND(LEN(C3)>0, IFERROR(VLOOKUP(C3, INDIRECT("'Soldiers'!$A$2:$B$1000"), 2, FALSE), -1) = ${i + 1})`
              }]
            },
            format: {
              backgroundColor: color
            }
          }
        },
        index: i
      }
    });
  });

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
  while (c < gridRows[0].length) {
    const pName = val(0, c);
    if (pName) {
      let roleId = 0;
      colToPost[c] = { name: pName, role_id: roleId };
      let lookahead = c + 1;
      while (lookahead < gridRows[0].length && val(0, lookahead) === "" && val(1, lookahead) !== "") {
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
  let lastDStr = null;
  for (let r = 2; r < gridRows.length; r++) {
    let dStr = val(r, 0) || lastDStr;
    let tStr = val(r, 1);
    if (dStr && tStr) {
      lastDStr = dStr;
      if (tStr.includes(" - ")) tStr = tStr.split(" - ")[0];
      try {
        let dt;
        const cleanRef = new Date(2024, 0, 1, 0, 0, 0, 0);
        if (dStr.includes("/")) {
          dt = parse(`${dStr} ${tStr}`, "dd/MM/yyyy HH:mm", cleanRef);
        } else {
          dt = parse(`${dStr} ${tStr}`, "yyyy-MM-dd HH:mm", cleanRef);
        }
        rowToDt[r] = dt;
      } catch (e) {}
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
            endDt = addHours(rowToDt[lastR], (endRow - lastR) * timeGranularityHours);
          }
          currR = endRow;
        } else {
          currR = r + 1;
          endDt = addHours(rowToDt[r], timeGranularityHours);
        }

        assignments.push({
          post_name: postInfo.name,
          start: startDt,
          end: endDt,
          role_id: postInfo.role_id,
          soldier_name: soldierName
        });
        r = currR;
      } else {
        r++;
      }
    }
  }

  return assignments;
}
