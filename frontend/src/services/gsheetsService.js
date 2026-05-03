import axios from 'axios';
import { parseGrid, buildScheduleRequests, buildDivisionColoringRules } from './gsheetsUtils';
import { parseISO, format, differenceInSeconds, addHours, isBefore, isAfter, isEqual } from 'date-fns';

class GSheetsService {
  constructor() {
    this.spreadsheetId = localStorage.getItem('gsheets_spreadsheet_id');
    this.accessToken = null;
    this.client = axios.create({
      baseURL: 'https://sheets.googleapis.com/v4/spreadsheets',
    });

    this.client.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
          console.warn("Access token expired or forbidden. Clearing token.");
          localStorage.removeItem('google_access_token');
          localStorage.removeItem('gsheets_access_token');
          window.location.reload(); 
        }
        return Promise.reject(error);
      }
    );

    this.cache = {
      data: null,
      metadata: null,
      lastFetch: 0
    };
    this.CACHE_TTL = 5000; // 5 seconds
  }

  getSpreadsheetId() {
    return this.spreadsheetId;
  }

  setSpreadsheetId(id) {
    this.spreadsheetId = id;
    if (id) {
      localStorage.setItem('gsheets_spreadsheet_id', id);
    } else {
      localStorage.removeItem('gsheets_spreadsheet_id');
    }
    this.clearCache();
  }

  async listSpreadsheets() {
    const resp = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        fields: 'files(id, name, modifiedTime)',
        orderBy: 'modifiedTime desc'
      },
      headers: {
        Authorization: `Bearer ${this.accessToken}`
      }
    });
    return resp.data.files || [];
  }

  async createSpreadsheet(title = "Shavtzachi Scheduler") {
    const resp = await this.client.post('/', {
      properties: { title },
      sheets: [
        { properties: { title: 'Soldiers' } },
        { properties: { title: 'Posts' } },
        { properties: { title: 'Unavailabilities' } },
        { properties: { title: 'Schedule', gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 } } }
      ]
    });
    
    const newId = resp.data.spreadsheetId;
    this.setSpreadsheetId(newId);

    // Initialize headers
    await this.batchUpdate([
      {
        updateCells: {
          range: { sheetId: resp.data.sheets.find(s => s.properties.title === 'Soldiers').properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
          rows: [{ values: [{ userEnteredValue: { stringValue: 'Name' } }, { userEnteredValue: { stringValue: 'Division' } }, { userEnteredValue: { stringValue: 'Skills' } }, { userEnteredValue: { stringValue: 'Excluded Posts' } }] }],
          fields: 'userEnteredValue'
        }
      },
      {
        updateCells: {
          range: { sheetId: resp.data.sheets.find(s => s.properties.title === 'Posts').properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 },
          rows: [{ values: [
            { userEnteredValue: { stringValue: 'Name' } }, { userEnteredValue: { stringValue: 'Shift Length' } }, { userEnteredValue: { stringValue: 'Start Time' } }, { userEnteredValue: { stringValue: 'End Time' } },
            { userEnteredValue: { stringValue: 'Cooldown' } }, { userEnteredValue: { stringValue: 'Intensity' } }, { userEnteredValue: { stringValue: 'Slots' } }, { userEnteredValue: { stringValue: 'Is Active' } },
            { userEnteredValue: { stringValue: 'Active From' } }, { userEnteredValue: { stringValue: 'Active Until' } }
          ] }],
          fields: 'userEnteredValue'
        }
      },
      {
        updateCells: {
          range: { sheetId: resp.data.sheets.find(s => s.properties.title === 'Unavailabilities').properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
          rows: [{ values: [{ userEnteredValue: { stringValue: 'Soldier' } }, { userEnteredValue: { stringValue: 'Start' } }, { userEnteredValue: { stringValue: 'End' } }, { userEnteredValue: { stringValue: 'Reason' } }] }],
          fields: 'userEnteredValue'
        }
      }
    ]);

    return newId;
  }

  clearCache() {
    this.cache.data = null;
    this.cache.metadata = null;
    this.cache.lastFetch = 0;
  }

  setAccessToken(token) {
    this.accessToken = token;
  }

  async fetchSheetValues(range) {
    if (!this.spreadsheetId) throw new Error("No Spreadsheet ID configured");
    const resp = await this.client.get(`/${this.spreadsheetId}/values/${range}`);
    return resp.data.values || [];
  }

  async batchGetValues(ranges) {
    if (!this.spreadsheetId) throw new Error("No Spreadsheet ID configured");
    const params = new URLSearchParams();
    ranges.forEach(r => params.append('ranges', r));
    const resp = await this.client.get(`/${this.spreadsheetId}/values:batchGet?${params.toString()}`);
    return resp.data.valueRanges || [];
  }

  async fetchAllData() {
    if (!this.spreadsheetId) throw new Error("No Spreadsheet ID configured");
    const now = Date.now();
    if (this.cache.data && (now - this.cache.lastFetch < this.CACHE_TTL)) {
      return this.cache;
    }

    const [metadataResp, valueRanges] = await Promise.all([
      this.client.get(`/${this.spreadsheetId}?fields=sheets(properties(title,sheetId),merges,conditionalFormats)`),
      this.batchGetValues([
        'Soldiers!A2:E',
        'Posts!A2:K',
        'Unavailabilities!A2:E',
        'Schedule!A:Z'
      ])
    ]);

    const data = {
      soldiers: valueRanges[0]?.values || [],
      posts: valueRanges[1]?.values || [],
      unavailabilities: valueRanges[2]?.values || [],
      schedule: valueRanges[3]?.values || []
    };

    this.cache = {
      data,
      metadata: metadataResp.data.sheets,
      lastFetch: now
    };
    return this.cache;
  }

  async appendValues(range, values) {
    await this.client.post(`/${this.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: [values]
    });
  }

  async updateValues(range, values) {
    await this.client.put(`/${this.spreadsheetId}/values/${range}?valueInputOption=RAW`, {
      values
    });
  }

  async clearValues(range) {
    await this.client.post(`/${this.spreadsheetId}/values/${range}:clear`);
  }

  async batchUpdate(requests) {
    try {
      await this.client.post(`/${this.spreadsheetId}:batchUpdate`, { requests });
    } catch (error) {
      if (error.response && error.response.data && error.response.data.error) {
        const detail = error.response.data.error.message;
        console.error("GSheets batchUpdate Error:", detail, error.response.data.error);
        alert(`Google Sheets Error: ${detail}`);
      }
      throw error;
    }
  }

  // --- Soldiers ---
  async getSoldiers() {
    const { data } = await this.fetchAllData();
    return data.soldiers.map((row, i) => ({
      id: i + 1,
      name: row[0],
      division: row[1] ? parseInt(row[1]) : null,
      skills: row[2] ? row[2].split(',').map(s => s.trim()) : [],
      excluded_posts: row[3] ? row[3].split(',').map(p => p.trim()) : []
    })).filter(s => s.name);
  }

  async createSoldier(data) {
    const values = [data.name, data.division || "", data.skills.join(','), data.excluded_posts.join(',')];
    await this.appendValues('Soldiers!A:D', values);
    this.clearCache();
  }

  async updateSoldier(id, data) {
    const rowIdx = id + 1;
    const values = [data.name, data.division || "", data.skills.join(','), data.excluded_posts.join(',')];
    await this.updateValues(`Soldiers!A${rowIdx}:D${rowIdx}`, [values]);
    this.clearCache();
  }

  async deleteSoldier(id) {
    const rowIdx = id + 1;
    await this.clearValues(`Soldiers!A${rowIdx}:D${rowIdx}`);
    this.clearCache();
  }

  // --- Posts ---
  async getPosts() {
    const { data } = await this.fetchAllData();
    return data.posts.map((row, i) => ({
      id: i + 1,
      name: row[0],
      shift_length_hours: parseFloat(row[1]) || 4,
      start_time: row[2] || "06:00",
      end_time: row[3] || "05:59",
      cooldown_hours: parseFloat(row[4]) || 0,
      intensity_weight: parseFloat(row[5]) || 1.0,
      slots: row[6] ? row[6].split(',').map((sk, j) => ({ role_index: j, skill: sk.trim() })) : [],
      is_active: row[7] === "1",
      active_from: row[8] || null,
      active_until: row[9] || null
    })).filter(p => p.name);
  }

  async createPost(data) {
    const values = [
      data.name, data.shift_length_hours, data.start_time, data.end_time,
      data.cooldown_hours, data.intensity_weight, 
      data.slots.map(s => typeof s === 'string' ? s : s.skill).join(','),
      data.is_active ? "1" : "0", data.active_from || "", data.active_until || ""
    ];
    await this.appendValues('Posts!A:J', values);
    this.clearCache();
  }

  async updatePost(name, data) {
    const posts = await this.getPosts();
    const post = posts.find(p => p.name === name);
    if (!post) return;
    const rowIdx = post.id + 1;
    const values = [
      data.name, data.shift_length_hours, data.start_time, data.end_time,
      data.cooldown_hours, data.intensity_weight, 
      data.slots.map(s => typeof s === 'string' ? s : s.skill).join(','),
      data.is_active ? "1" : "0", data.active_from || "", data.active_until || ""
    ];
    await this.updateValues(`Posts!A${rowIdx}:J${rowIdx}`, [values]);
    this.clearCache();
  }

  async deletePost(name) {
    const posts = await this.getPosts();
    const post = posts.find(p => p.name === name);
    if (!post) return;
    const rowIdx = post.id + 1;
    await this.clearValues(`Posts!A${rowIdx}:J${rowIdx}`);
    this.clearCache();
  }

  // --- Unavailabilities ---
  async getUnavailabilities() {
    const { data } = await this.fetchAllData();
    const values = data.unavailabilities;
    const soldiers = await this.getSoldiers();
    return values.map((row, i) => {
      const sName = row[0];
      const sol = soldiers.find(s => s.name === sName);
      return {
        id: i + 1,
        soldier_id: sol ? sol.id : 0,
        soldier_name: sName,
        start_datetime: row[1],
        end_datetime: row[2],
        reason: row[3] || ""
      };
    }).filter(u => u.soldier_name);
  }

  async createUnavailability(data) {
    const soldiers = await this.getSoldiers();
    const soldier = soldiers.find(s => s.id === data.soldier_id);
    if (!soldier) throw new Error("Soldier not found");
    const values = [soldier.name, data.start_datetime, data.end_datetime, data.reason || ""];
    await this.appendValues('Unavailabilities!A:D', values);
    this.clearCache();
  }

  async updateUnavailability(id, data) {
    const soldiers = await this.getSoldiers();
    const soldier = soldiers.find(s => s.id === data.soldier_id);
    if (!soldier) throw new Error("Soldier not found");
    const rowIdx = id + 1;
    const values = [soldier.name, data.start_datetime, data.end_datetime, data.reason || ""];
    await this.updateValues(`Unavailabilities!A${rowIdx}:D${rowIdx}`, [values]);
    this.clearCache();
  }

  async deleteUnavailability(id) {
    const rowIdx = id + 1;
    await this.clearValues(`Unavailabilities!A${rowIdx}:D${rowIdx}`);
    this.clearCache();
  }

  // --- Schedule ---
  async getAssignmentsInRange(startDate, endDate) {
    const { metadata, data } = await this.fetchAllData();
    const sheet = metadata.find(s => s.properties.title === "Schedule");
    if (!sheet) return [];

    const posts = await this.getPosts();
    const soldiers = await this.getSoldiers();
    
    const assignments = parseGrid(data.schedule, posts, sheet.merges || [], 4); 
    assignments.forEach(a => {
      const s = soldiers.find(sol => sol.name === a.soldier_name);
      if (s) a.soldier_id = s.id;
    });

    if (!startDate || !endDate) return assignments;

    const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
    const end = typeof endDate === 'string' ? parseISO(endDate) : endDate;

    return assignments.filter(a => {
        const aStart = typeof a.start === 'string' ? parseISO(a.start) : a.start;
        const aEnd   = typeof a.end   === 'string' ? parseISO(a.end)   : a.end;
        return aStart.getTime() < end.getTime() && aEnd.getTime() > start.getTime();
    });
  }

  async saveAssignments(startDate, endDate, assignments) {
    const soldiers = await this.getSoldiers();
    assignments.forEach(a => {
        if (a.soldier_id) {
            const s = soldiers.find(sold => sold.id === a.soldier_id || sold.name === a.soldier_id);
            if (s) {
                if (!a.soldier_name) a.soldier_name = s.name;
                if (a.division_id === undefined) a.division_id = s.division;
            } else {
                if (!a.soldier_name) a.soldier_name = a.soldier_id; // Fallback to ID if not found
            }
        }
    });

    const { metadata } = await this.fetchAllData();
    let sheet = metadata.find(s => s.properties.title === "Schedule");
    let sheetId;

    if (!sheet) {
        // Create the sheet if it doesn't exist
        const addSheetResp = await this.client.post(`/${this.spreadsheetId}:batchUpdate`, {
            requests: [{
                addSheet: {
                    properties: {
                        title: "Schedule",
                        gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 }
                    }
                }
            }]
        });
        sheetId = addSheetResp.data.replies[0].addSheet.properties.sheetId;
    } else {
        sheetId = sheet.properties.sheetId;
    }

    // IMPORTANT: Fetch existing assignments BEFORE clearing the sheet.
    // If we clear first, the sheet is empty and we lose all other days.
    const existing = await this.getAssignmentsInRange("1970-01-01", "2100-01-01");

    // Now safe to clear
    if (sheet) {
        await this.clearValues('Schedule!A:Z');
    }

    // Keep assignments from OTHER days, drop those overlapping the save window
    const saveStart = typeof startDate === 'string' ? parseISO(startDate) : new Date(startDate);
    const saveEnd = typeof endDate === 'string' ? parseISO(endDate) : new Date(endDate);

    const otherDays = existing.filter(a => {
        const aStart = typeof a.start === 'string' ? parseISO(a.start) : new Date(a.start);
        const aEnd   = typeof a.end   === 'string' ? parseISO(a.end)   : new Date(a.end);
        // Overlaps the save window → drop it (will be replaced by new assignments)
        const overlaps = aStart.getTime() < saveEnd.getTime() && aEnd.getTime() > saveStart.getTime();
        return !overlaps;
    });

    const combined = [...otherDays, ...assignments];
    
    // 3. Determine full range for the new grid
    if (combined.length === 0) return;
    
    // Sort to ensure we find the true min/max
    combined.sort((a, b) => {
        const da = typeof a.start === 'string' ? parseISO(a.start) : a.start;
        const db = typeof b.start === 'string' ? parseISO(b.start) : b.start;
        return da.getTime() - db.getTime();
    });

    let fullStart = combined[0].start;
    let fullEnd = combined[0].end;
    
    combined.forEach(a => {
        const aStart = typeof a.start === 'string' ? parseISO(a.start) : a.start;
        const aEnd = typeof a.end === 'string' ? parseISO(a.end) : a.end;
        const fStart = typeof fullStart === 'string' ? parseISO(fullStart) : fullStart;
        const fEnd = typeof fullEnd === 'string' ? parseISO(fullEnd) : fullEnd;
        
        if (isBefore(aStart, fStart)) fullStart = aStart;
        if (isAfter(aEnd, fEnd)) fullEnd = aEnd;
    });

    const requests = buildScheduleRequests(sheetId, combined, fullStart, fullEnd, 4);
    if (requests.length > 0) {
        // Clear existing conditional format rules first
        if (sheet && sheet.conditionalFormats) {
            sheet.conditionalFormats.forEach((_, i) => {
                // We always delete index 0 because indices shift after each deletion
                requests.push({ deleteConditionalFormatRule: { index: 0, sheetId } });
            });
        }

        // Add automatic division coloring rules
        const coloringRules = buildDivisionColoringRules(sheetId);
        requests.push(...coloringRules);
        
        await this.batchUpdate(requests);
    }
    this.clearCache();
  }

  async getHistoryScores(excludeFrom = null) {
    const assignments = await this.getAssignmentsInRange("2000-01-01", excludeFrom || new Date().toISOString());
    const scores = {};
    const posts = await this.getPosts();

    assignments.forEach(a => {
      const post = posts.find(p => p.name === a.post_name);
      const intensity = post ? post.intensity_weight : 1.0;
      const load = (differenceInSeconds(a.end, a.start) / 3600) * intensity;
      scores[a.soldier_id] = (scores[a.soldier_id] || 0) + load;
    });
    return scores;
  }
}

export const gsheetsService = new GSheetsService();
