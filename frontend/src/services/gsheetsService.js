import axios from 'axios';
import { requestToken, notifyExpired } from './auth';
import { notify } from '../lib/notify';
import { buildFormattingRequests, isOurRule } from './sheetFormatting';
import { parseGrid, buildScheduleRequests, buildDivisionColoringRules } from './gsheetsUtils';
import { TABS, COLUMN_SPECS, buildModel, mapColumns, composeRow, colLetter, normalizeKey, toSheetDateTime } from '../lib/sheetModel';
import { parseISO, differenceInSeconds, isBefore, isAfter } from 'date-fns';

const quoteTab = (title) => `'${String(title).replace(/'/g, "''")}'`;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export class GSheetsService {
  constructor() {
    this.spreadsheetId = store.get('gsheets_spreadsheet_id');
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
      async (error) => {
        const status = error.response?.status;
        const config = error.config;
        if (status === 401 && config && !config._retried) {
          // Access token expired: refresh silently and retry the request once.
          config._retried = true;
          try {
            const token = await requestToken({ interactive: false });
            this.accessToken = token;
            config.headers.Authorization = `Bearer ${token}`;
            return this.client(config);
          } catch {
            notifyExpired();
          }
        } else if (status === 401) {
          notifyExpired();
        } else if (status === 403) {
          const msg = error.response?.data?.error?.message;
          notify.error(`Google denied access${msg ? `: ${msg}` : ''}. Check that you have edit permission on this spreadsheet.`);
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
      store.set('gsheets_spreadsheet_id', id);
    } else {
      store.del('gsheets_spreadsheet_id');
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

    // Make the new sheet pleasant to edit by hand. A failure here must not undo the creation.
    try {
      await this.applyFormatting();
    } catch (e) {
      console.warn('Could not format the new spreadsheet', e);
    }
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

  /** The real title of a tab (matched case-insensitively), or null if the spreadsheet has no such tab. */
  _resolveTabs(sheets) {
    const tabs = {};
    for (const name of TABS) {
      const found = sheets.find((sh) => normalizeKey(sh.properties?.title) === normalizeKey(name));
      tabs[name] = found ? found.properties.title : null;
    }
    return tabs;
  }

  async fetchAllData() {
    if (!this.spreadsheetId) throw new Error("No Spreadsheet ID configured");
    const now = Date.now();
    if (this.cache.data && (now - this.cache.lastFetch < this.CACHE_TTL)) {
      return this.cache;
    }

    // Look at which tabs exist first, so a missing tab never breaks the whole read.
    const metadataResp = await this.client.get(
      `/${this.spreadsheetId}?fields=properties(locale),sheets(properties(title,sheetId,gridProperties),merges,conditionalFormats)`
    );
    const sheets = metadataResp.data.sheets || [];
    const tabs = this._resolveTabs(sheets);

    const names = TABS.filter((n) => tabs[n]);
    const valueRanges = names.length
      ? await this.batchGetValues(names.map((n) => `${quoteTab(tabs[n])}!A1:${n === 'Schedule' ? 'ZZ' : 'Z'}`))
      : [];
    const raw = { Soldiers: null, Posts: null, Unavailabilities: null, Schedule: null };
    names.forEach((n, i) => { raw[n] = valueRanges[i]?.values || []; });

    const model = buildModel(raw, { locale: metadataResp.data.properties?.locale });

    this.cache = {
      // Kept for callers that read the data rows directly (header row removed).
      data: {
        soldiers: (raw.Soldiers || []).slice(1),
        posts: (raw.Posts || []).slice(1),
        unavailabilities: (raw.Unavailabilities || []).slice(1),
        schedule: raw.Schedule || [],
      },
      raw,
      model,
      tabs,
      metadata: sheets,
      lastFetch: now,
      assignments: null,
    };
    return this.cache;
  }

  /** Problems found in the spreadsheet (missing tabs/columns, invalid values...). */
  async getHealth() {
    const cache = await this.fetchAllData();
    const issues = [...cache.model.issues];
    this._scheduleAssignments(cache, issues);
    const unformatted = ['Soldiers', 'Posts', 'Unavailabilities'].filter((t) => {
      const meta = cache.tabs[t] && cache.metadata.find((m) => m.properties.title === cache.tabs[t]);
      return meta && !(meta.conditionalFormats || []).some(isOurRule);
    });
    if (unformatted.length) {
      issues.push({ level: 'info', sheet: unformatted.join(', '), row: null, message: 'These tabs are not set up for editing by hand yet (dropdowns, validation and highlighting of problem cells). Use "Format sheets for editing".' });
    }
    return {
      issues,
      counts: {
        soldiers: cache.model.soldiers.length,
        posts: cache.model.posts.length,
        unavailabilities: cache.model.unavailabilities.length,
        assignments: cache.assignments.length,
      },
      missingTabs: cache.model.missingTabs,
    };
  }

  /**
   * A text report for troubleshooting: what the app found in the spreadsheet and how it read it.
   * Contains tab headers, column mapping, counts, problems, and the (non-personal) Posts rows.
   * Names of people are not included.
   */
  async getDiagnosticReport() {
    this.clearCache();
    const cache = await this.fetchAllData();
    const health = await this.getHealth();
    const lines = [];
    lines.push(`Shavtzachi diagnostic report - ${new Date().toISOString()}`);
    lines.push(`Spreadsheet locale: ${cache.metadata ? 'see sheet settings' : '?'}  |  tabs: ${cache.metadata.map((m) => m.properties.title).join(', ')}`);
    lines.push(`Counts: ${JSON.stringify(health.counts)}`);
    for (const tab of ['Soldiers', 'Posts', 'Unavailabilities']) {
      const raw = cache.raw[tab];
      lines.push('', `## ${tab}${raw ? '' : ' (MISSING)'}`);
      if (!raw) continue;
      lines.push(`header: ${JSON.stringify(raw[0] || [])}`);
      lines.push(`columns understood: ${JSON.stringify(cache.model.columns[tab])}`);
      lines.push(`data rows: ${Math.max(raw.length - 1, 0)}`);
      if (tab === 'Posts') raw.slice(1, 6).forEach((r, i) => lines.push(`row ${i + 2}: ${JSON.stringify(r)}`));
    }
    lines.push('', '## Posts as read');
    cache.model.posts.slice(0, 8).forEach((p) => lines.push(JSON.stringify({ name: p.name, len: p.shift_length_hours, start: p.start_time, end: p.end_time, active: p.is_active, slots: p.slots.map((s) => s.skill), from: p.active_from, until: p.active_until })));
    lines.push('', `## Skills held by soldiers: ${JSON.stringify([...new Set(cache.model.soldiers.flatMap((s) => s.skills))])}`);
    const sch = cache.raw.Schedule;
    lines.push('', `## Schedule tab: ${sch ? `${sch.length} rows` : 'absent'}`);
    if (sch) lines.push(`header rows: ${JSON.stringify(sch.slice(0, 2))}`);
    lines.push('', '## Problems found');
    health.issues.forEach((i) => lines.push(`- [${i.level}] ${i.sheet || ''}${i.row ? ` row ${i.row}` : ''}: ${i.message}`));
    if (!health.issues.length) lines.push('(none)');
    return lines.join('\n');
  }

  /**
   * Create any missing tabs and missing header columns. Never moves or overwrites existing data.
   * Returns a list of changes it made.
   */
  async ensureSchema({ force = false } = {}) {
    if (!force && this._schemaOkFor === this.spreadsheetId) return [];
    this.clearCache();
    const { raw, tabs } = await this.fetchAllData();
    const changes = [];

    const toCreate = ['Soldiers', 'Posts', 'Unavailabilities'].filter((n) => !tabs[n]);
    if (toCreate.length) {
      await this.batchUpdate(toCreate.map((title) => ({ addSheet: { properties: { title } } })));
      toCreate.forEach((t) => changes.push(`Created the "${t}" tab`));
    }

    for (const name of ['Soldiers', 'Posts', 'Unavailabilities']) {
      const title = tabs[name] || name;
      const specs = COLUMN_SPECS[name];
      const header = raw[name] ? (raw[name][0] || []) : [];
      if (!header.some((h) => String(h ?? '').trim())) {
        await this.updateValues(`${quoteTab(title)}!A1`, [specs.map((sp) => sp.header)]);
        changes.push(`Added the header row to "${name}"`);
        continue;
      }
      const { map, positional } = mapColumns(name, header);
      if (positional) continue; // headers unknown: columns are read by position, leave them alone
      let next = header.length;
      const missing = specs.filter((sp) => map[sp.field] === undefined);
      for (const sp of missing) {
        await this.updateValues(`${quoteTab(title)}!${colLetter(next)}1`, [[sp.header]]);
        changes.push(`Added the "${sp.header}" column to "${name}"`);
        next += 1;
      }
    }

    this.clearCache();
    this._schemaOkFor = this.spreadsheetId;
    if (toCreate.length) {
      const formatted = await this.applyFormatting({ tabs: toCreate });
      if (formatted) changes.push(`Formatted ${toCreate.join(', ')} for easy editing`);
    }
    return changes;
  }

  /**
   * Style the data tabs for direct editing: header, widths, notes, dropdowns, validation, date/time formats and
   * highlighting of cells the app cannot read. Safe to run repeatedly; it never changes cell contents.
   * Returns the number of tabs formatted.
   */
  async applyFormatting({ tabs: only } = {}) {
    this.clearCache();
    const { tabs, metadata, model } = await this.fetchAllData();
    const sheets = [];
    for (const tab of ['Soldiers', 'Posts', 'Unavailabilities']) {
      const meta = tabs[tab] && metadata.find((m) => m.properties.title === tabs[tab]);
      if (!meta) continue;
      sheets.push({
        tab,
        title: tabs[tab],
        sheetId: meta.properties.sheetId,
        columns: model.columns[tab],
        rowCount: meta.properties.gridProperties?.rowCount,
        conditionalFormats: meta.conditionalFormats || [],
      });
    }
    const targets = sheets.filter((s) => !only || only.includes(s.tab));
    const requests = buildFormattingRequests(sheets, only);
    if (!requests.length) return 0;
    await this.batchUpdate(requests);
    this.clearCache();
    return targets.length;
  }

  async _tabInfo(tab) {
    const cache = await this.fetchAllData();
    const title = cache.tabs[tab];
    if (!title) throw new Error(`The "${tab}" tab does not exist in the spreadsheet.`);
    return { title, map: cache.model.columns[tab], raw: cache.raw[tab] || [] };
  }

  async _appendRow(tab, fields) {
    await this.ensureSchema();
    const { title, map } = await this._tabInfo(tab);
    const row = composeRow(map, fields);
    await this.appendValues(`${quoteTab(title)}!A:${colLetter(Math.max(row.length - 1, 0))}`, row);
    this.clearCache();
  }

  /** Append many rows with a single request (used by file import). */
  async _appendRows(tab, fieldsList) {
    if (!fieldsList.length) return;
    await this.ensureSchema();
    const { title, map } = await this._tabInfo(tab);
    const rows = fieldsList.map((f) => composeRow(map, f));
    const width = Math.max(...rows.map((r) => r.length), 1);
    rows.forEach((r) => { while (r.length < width) r.push(''); });
    await this.appendRows(`${quoteTab(title)}!A:${colLetter(width - 1)}`, rows);
    this.clearCache();
  }

  async appendSoldiers(list) {
    await this._appendRows('Soldiers', list.map((d) => this._soldierFields(d)));
  }

  async appendPosts(list) {
    await this._appendRows('Posts', list.map((d) => this._postFields(d)));
  }

  async _updateRow(tab, id, fields) {
    await this.ensureSchema();
    const { title, map, raw } = await this._tabInfo(tab);
    const rowNumber = id + 1;
    const base = raw[id] || [];
    const row = composeRow(map, fields, base);
    await this.updateValues(`${quoteTab(title)}!A${rowNumber}:${colLetter(Math.max(row.length - 1, 0))}${rowNumber}`, [row]);
    this.clearCache();
  }

  async _clearRow(tab, id) {
    const { title } = await this._tabInfo(tab);
    const rowNumber = id + 1;
    await this.clearValues(`${quoteTab(title)}!${rowNumber}:${rowNumber}`);
    this.clearCache();
  }

  async appendValues(range, values) {
    await this.appendRows(range, [values]);
  }

  async appendRows(range, rows) {
    await this.client.post(`/${this.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: rows
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
        notify.error(`Google Sheets error: ${detail}`);
      }
      throw error;
    }
  }

  // --- Soldiers ---
  async getSoldiers() {
    const { model } = await this.fetchAllData();
    return model.soldiers.map((s) => ({ ...s, skills: [...s.skills], excluded_posts: [...s.excluded_posts] }));
  }

  _soldierFields(data) {
    return {
      name: String(data.name ?? '').trim(),
      division: data.division ?? '',
      skills: (data.skills || []).join(', '),
      excluded_posts: (data.excluded_posts || []).join(', '),
    };
  }

  async createSoldier(data) {
    const name = String(data.name ?? '').trim();
    if (!name) throw new Error('A soldier needs a name.');
    const existing = await this.getSoldiers();
    if (existing.some((s) => normalizeKey(s.name) === normalizeKey(name))) {
      throw new Error(`A soldier named "${name}" already exists.`);
    }
    await this._appendRow('Soldiers', this._soldierFields(data));
  }

  async updateSoldier(id, data) {
    const name = String(data.name ?? '').trim();
    if (!name) throw new Error('A soldier needs a name.');
    const existing = await this.getSoldiers();
    if (existing.some((s) => s.id !== id && normalizeKey(s.name) === normalizeKey(name))) {
      throw new Error(`A soldier named "${name}" already exists.`);
    }
    await this._updateRow('Soldiers', id, this._soldierFields(data));
  }

  async deleteSoldier(id) {
    await this._clearRow('Soldiers', id);
  }

  // --- Posts ---
  async getPosts() {
    const { model } = await this.fetchAllData();
    return model.posts.map((p) => ({ ...p, slots: p.slots.map((s) => ({ ...s })) }));
  }

  _postFields(data) {
    return {
      name: String(data.name ?? '').trim(),
      shift_length_hours: data.shift_length_hours,
      start_time: data.start_time,
      end_time: data.end_time,
      cooldown_hours: data.cooldown_hours,
      intensity_weight: data.intensity_weight,
      slots: (data.slots || []).map((s) => (typeof s === 'string' ? s : s.skill)).join(', '),
      is_active: data.is_active === false ? 'FALSE' : 'TRUE',
      active_from: toSheetDateTime(data.active_from),
      active_until: toSheetDateTime(data.active_until),
    };
  }

  async createPost(data) {
    const name = String(data.name ?? '').trim();
    if (!name) throw new Error('A post needs a name.');
    const existing = await this.getPosts();
    if (existing.some((p) => normalizeKey(p.name) === normalizeKey(name))) {
      throw new Error(`A post named "${name}" already exists.`);
    }
    await this._appendRow('Posts', this._postFields(data));
  }

  async updatePost(name, data) {
    const posts = await this.getPosts();
    const post = posts.find((p) => normalizeKey(p.name) === normalizeKey(name));
    if (!post) throw new Error(`Post "${name}" was not found. It may have been removed from the spreadsheet.`);
    await this._updateRow('Posts', post.id, this._postFields(data));
  }

  async deletePost(name) {
    const posts = await this.getPosts();
    const post = posts.find((p) => normalizeKey(p.name) === normalizeKey(name));
    if (!post) throw new Error(`Post "${name}" was not found. It may have been removed from the spreadsheet.`);
    await this._clearRow('Posts', post.id);
  }

  // --- Unavailabilities ---
  async getUnavailabilities() {
    const { model } = await this.fetchAllData();
    return model.unavailabilities.map((u) => ({ ...u }));
  }

  async _unavailabilityFields(data) {
    const soldiers = await this.getSoldiers();
    const soldier = soldiers.find((s) => s.id === data.soldier_id);
    if (!soldier) throw new Error('Soldier not found. Pick a soldier from the list.');
    if (!data.start_datetime || !data.end_datetime) throw new Error('Start and end are required.');
    return { soldier: soldier.name, start: toSheetDateTime(data.start_datetime), end: toSheetDateTime(data.end_datetime), reason: data.reason || '' };
  }

  async createUnavailability(data) {
    await this._appendRow('Unavailabilities', await this._unavailabilityFields(data));
  }

  async updateUnavailability(id, data) {
    await this._updateRow('Unavailabilities', id, await this._unavailabilityFields(data));
  }

  async deleteUnavailability(id) {
    await this._clearRow('Unavailabilities', id);
  }

  // --- Schedule ---
  /** Parse the Schedule tab once per fetch; unreadable or odd cells become issues, never exceptions. */
  _scheduleAssignments(cache, issues = []) {
    if (cache.assignments) return cache.assignments;
    const out = [];
    const tab = cache.tabs.Schedule;
    const sheet = tab ? cache.metadata.find((m) => m.properties.title === tab) : null;
    if (sheet && cache.raw.Schedule) {
      let parsed = [];
      try {
        parsed = parseGrid(cache.raw.Schedule, cache.model.posts, sheet.merges || [], 4);
      } catch (e) {
        console.error('Schedule parse error', e);
        issues.push({ level: 'error', sheet: 'Schedule', row: null, message: `The Schedule tab could not be read (${e.message}). Existing assignments are ignored until it is fixed or cleared.` });
      }
      const byName = new Map(cache.model.soldiers.map((s) => [normalizeKey(s.name), s]));
      const postNames = new Set(cache.model.posts.map((p) => normalizeKey(p.name)));
      const unknownSoldiers = new Set();
      const unknownPosts = new Set();
      for (const a of parsed) {
        if (!(a.start instanceof Date) || Number.isNaN(a.start.getTime()) || !(a.end instanceof Date) || Number.isNaN(a.end.getTime()) || !(a.end > a.start)) continue;
        const s = byName.get(normalizeKey(a.soldier_name));
        if (s) { a.soldier_id = s.id; a.soldier_name = s.name; } else unknownSoldiers.add(a.soldier_name);
        if (!postNames.has(normalizeKey(a.post_name))) unknownPosts.add(a.post_name);
        out.push(a);
      }
      if (unknownSoldiers.size) issues.push({ level: 'warning', sheet: 'Schedule', row: null, message: `The schedule mentions people who are not in the Soldiers sheet: ${[...unknownSoldiers].slice(0, 5).join(', ')}${unknownSoldiers.size > 5 ? '...' : ''}. They count as busy but have no history.` });
      if (unknownPosts.size) issues.push({ level: 'warning', sheet: 'Schedule', row: null, message: `The schedule has columns for posts that are not in the Posts sheet: ${[...unknownPosts].slice(0, 5).join(', ')}${unknownPosts.size > 5 ? '...' : ''}.` });
    }
    cache.assignments = out;
    return out;
  }

  async getAssignmentsInRange(startDate, endDate) {
    const cache = await this.fetchAllData();
    const assignments = this._scheduleAssignments(cache);

    if (!startDate || !endDate) return assignments;

    const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
    const end = typeof endDate === 'string' ? parseISO(endDate) : endDate;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

    return assignments.filter((a) => a.start.getTime() < end.getTime() && a.end.getTime() > start.getTime());
  }

  async saveAssignments(startDate, endDate, assignments) {
    await this.ensureSchema();
    // Always work from fresh data: this function rewrites the whole Schedule tab.
    this.clearCache();
    const soldiers = await this.getSoldiers();
    const soldierById = new Map(soldiers.map((s) => [s.id, s]));
    const soldierByName = new Map(soldiers.map((s) => [normalizeKey(s.name), s]));

    const prepared = [];
    for (const a of assignments) {
      const s = soldierById.get(a.soldier_id) || soldierByName.get(normalizeKey(a.soldier_name ?? a.soldier_id));
      const name = a.soldier_name || s?.name || (a.soldier_id != null ? String(a.soldier_id) : '');
      if (!name) continue; // nothing to write for an empty slot
      prepared.push({ ...a, soldier_name: name, division_id: a.division_id ?? s?.division ?? null });
    }

    const { metadata, tabs } = await this.fetchAllData();
    const title = tabs.Schedule;
    const sheet = title ? metadata.find((m) => m.properties.title === title) : null;
    let sheetId;
    let grid = { rowCount: 1000, columnCount: 26 };

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
      const props = addSheetResp.data.replies[0].addSheet.properties;
      sheetId = props.sheetId;
      if (props.gridProperties) grid = { rowCount: props.gridProperties.rowCount ?? 1000, columnCount: props.gridProperties.columnCount ?? 26 };
    } else {
      sheetId = sheet.properties.sheetId;
      const gp = sheet.properties.gridProperties;
      if (gp) grid = { rowCount: gp.rowCount ?? 1000, columnCount: gp.columnCount ?? 26 };
    }

    // Existing assignments are read BEFORE anything is changed.
    const existing = await this.getAssignmentsInRange("1970-01-01", "2100-01-01");

    // Keep assignments from OTHER days, drop those overlapping the save window
    const toDate = (v) => (typeof v === 'string' ? parseISO(v) : new Date(v));
    const saveStart = toDate(startDate);
    const saveEnd = toDate(endDate);
    if (Number.isNaN(saveStart.getTime()) || Number.isNaN(saveEnd.getTime())) {
      throw new Error('Invalid date range for saving the schedule.');
    }

    const otherDays = existing.filter((a) => {
      const aStart = toDate(a.start);
      const aEnd = toDate(a.end);
      return !(aStart.getTime() < saveEnd.getTime() && aEnd.getTime() > saveStart.getTime());
    });

    const combined = [...otherDays, ...prepared].filter((a) => {
      const st = toDate(a.start); const en = toDate(a.end);
      return !Number.isNaN(st.getTime()) && !Number.isNaN(en.getTime()) && en > st;
    });

    // Clearing and rewriting happen in ONE batchUpdate, which Google applies atomically:
    // if anything fails, the existing schedule is left untouched.
    const clearAll = [
      { unmergeCells: { range: { sheetId } } },
      { repeatCell: { range: { sheetId }, cell: {}, fields: 'userEnteredValue,userEnteredFormat' } },
    ];
    if (sheet && sheet.conditionalFormats) {
      sheet.conditionalFormats.forEach(() => {
        // Always delete index 0 because indices shift after each deletion
        clearAll.push({ deleteConditionalFormatRule: { index: 0, sheetId } });
      });
    }

    if (combined.length === 0) {
      if (sheet) await this.batchUpdate(clearAll);
      this.clearCache();
      return;
    }

    combined.sort((a, b) => toDate(a.start).getTime() - toDate(b.start).getTime());
    let fullStart = toDate(combined[0].start);
    let fullEnd = toDate(combined[0].end);
    combined.forEach((a) => {
      const aStart = toDate(a.start);
      const aEnd = toDate(a.end);
      if (isBefore(aStart, fullStart)) fullStart = aStart;
      if (isAfter(aEnd, fullEnd)) fullEnd = aEnd;
    });

    const built = buildScheduleRequests(sheetId, combined, fullStart, fullEnd);
    if (built.length === 0) return;
    // Never write a schedule that silently lost assignments.
    if (built.stats && built.stats.skipped > 0) {
      throw new Error(`${built.stats.skipped} assignment(s) could not be placed in the Schedule grid, so nothing was saved. Check that the post names and times are valid.`);
    }

    // Make sure the grid is large enough for what we are about to write.
    const cells = built.find((r) => r.updateCells)?.updateCells;
    const needRows = cells ? cells.rows.length + 1 : 0;
    const needCols = cells ? Math.max(0, ...cells.rows.map((r) => r.values.length)) + 1 : 0;
    const resize = [];
    if (needRows > grid.rowCount || needCols > grid.columnCount) {
      resize.push({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { rowCount: Math.max(needRows, grid.rowCount), columnCount: Math.max(needCols, grid.columnCount) } },
          fields: 'gridProperties(rowCount,columnCount)',
        },
      });
    }

    // buildScheduleRequests starts with its own unmerge; ours already did that.
    const rest = built.filter((r) => !r.unmergeCells);
    await this.batchUpdate([...resize, ...clearAll, ...rest, ...buildDivisionColoringRules(sheetId)]);
    this.clearCache();
  }

  async getHistoryScores(excludeFrom = null) {
    const assignments = await this.getAssignmentsInRange("2000-01-01", excludeFrom || new Date().toISOString());
    const scores = {};
    const posts = await this.getPosts();

    assignments.forEach(a => {
      const post = posts.find(p => normalizeKey(p.name) === normalizeKey(a.post_name));
      const intensity = post ? post.intensity_weight : 1.0;
      const load = (differenceInSeconds(a.end, a.start) / 3600) * intensity;
      if (a.soldier_id == null) return;
      scores[a.soldier_id] = (scores[a.soldier_id] || 0) + load;
    });
    return scores;
  }
}

export const gsheetsService = new GSheetsService();
