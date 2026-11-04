/**
 * Tolerant parsing of the user's spreadsheet.
 *
 * The spreadsheet can be edited by hand, imported from elsewhere, re-ordered or partially
 * filled in, so nothing here assumes the data is valid. Every problem is reported as an
 * "issue" ({ level, sheet, row, message }) instead of throwing, and rows that cannot be
 * used are skipped with an explanation.
 */
import { format, isValid, parse, parseISO } from 'date-fns';

export const TABS = ['Soldiers', 'Posts', 'Unavailabilities', 'Schedule'];

// Default column order (also used as the fallback when headers are not recognised).
export const COLUMN_SPECS = {
  Soldiers: [
    { field: 'name', header: 'Name', required: true, aliases: ['name', 'soldier', 'soldier name', 'person', 'שם'] },
    { field: 'division', header: 'Division', aliases: ['division', 'div', 'unit', 'platoon', 'team', 'מחלקה', 'פלגה'] },
    { field: 'skills', header: 'Skills', aliases: ['skills', 'skill', 'roles', 'role', 'qualifications', 'כישורים', 'תפקידים'] },
    { field: 'excluded_posts', header: 'Excluded Posts', aliases: ['excluded posts', 'excluded', 'exclusions', 'exclude', 'excluded post', 'עמדות מוחרגות'] },
  ],
  Posts: [
    { field: 'name', header: 'Name', required: true, aliases: ['name', 'post', 'post name', 'position', 'station', 'עמדה'] },
    { field: 'shift_length_hours', header: 'Shift Length', aliases: ['shift length', 'shift length hours', 'shift hours', 'length', 'duration', 'shift duration', 'אורך משמרת'] },
    { field: 'start_time', header: 'Start Time', aliases: ['start time', 'start', 'opens', 'from time', 'שעת התחלה'] },
    { field: 'end_time', header: 'End Time', aliases: ['end time', 'end', 'closes', 'to time', 'שעת סיום'] },
    { field: 'cooldown_hours', header: 'Cooldown', aliases: ['cooldown', 'cooldown hours', 'rest', 'rest hours', 'מנוחה'] },
    { field: 'intensity_weight', header: 'Intensity', aliases: ['intensity', 'intensity weight', 'weight', 'עצימות'] },
    { field: 'slots', header: 'Slots', aliases: ['slots', 'required skills', 'required slots', 'roles', 'skills', 'תפקידים'] },
    { field: 'is_active', header: 'Is Active', aliases: ['is active', 'active', 'enabled', 'פעיל'] },
    { field: 'active_from', header: 'Active From', aliases: ['active from', 'valid from', 'starts on'] },
    { field: 'active_until', header: 'Active Until', aliases: ['active until', 'active to', 'valid until', 'valid to', 'until', 'ends on'] },
  ],
  Unavailabilities: [
    { field: 'soldier', header: 'Soldier', required: true, aliases: ['soldier', 'name', 'soldier name', 'person', 'שם'] },
    { field: 'start', header: 'Start', required: true, aliases: ['start', 'from', 'start datetime', 'start date', 'begin', 'מתאריך'] },
    { field: 'end', header: 'End', required: true, aliases: ['end', 'to', 'until', 'end datetime', 'end date', 'עד תאריך'] },
    { field: 'reason', header: 'Reason', aliases: ['reason', 'note', 'notes', 'comment', 'סיבה'] },
  ],
};

// ---------------------------------------------------------------------------
// Scalar parsers
// ---------------------------------------------------------------------------

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

// "Shift Length (hours)" -> "shift length"; "start_time" -> "start time"
export const normalizeHeader = (h) => clean(h).toLowerCase()
  .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
  .replace(/[_\-.:*]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizeKey = (s) => clean(s).toLowerCase().replace(/\s+/g, ' ');

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'on', 'x', 'v', '✓', '✔', '☑', 'כן', 'פעיל', 'active', 'enabled']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', 'off', '☐', 'לא', 'לא פעיל', 'inactive', 'disabled', 'off']);

/** Returns { value, recognized }. Blank means "not specified" -> defaultValue. */
export function parseBool(raw, defaultValue = true) {
  if (typeof raw === 'boolean') return { value: raw, recognized: true };
  if (typeof raw === 'number') return { value: raw !== 0, recognized: true };
  const s = clean(raw).toLowerCase();
  if (s === '') return { value: defaultValue, recognized: true, blank: true };
  if (TRUE_WORDS.has(s)) return { value: true, recognized: true };
  if (FALSE_WORDS.has(s)) return { value: false, recognized: true };
  return { value: defaultValue, recognized: false };
}

/** Returns { value, recognized, blank }. Accepts "4", "4.5", "4,5", "4h", "4 hours". */
export function parseNumber(raw, defaultValue) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, recognized: true };
  const s = clean(raw);
  if (s === '') return { value: defaultValue, recognized: true, blank: true };
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return { value: defaultValue, recognized: false };
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) ? { value: n, recognized: true } : { value: defaultValue, recognized: false };
}

/**
 * Normalise a time of day to "HH:MM". Accepts "6:00", "06:00:00", "6:00 AM", "6pm", "0600",
 * "6", a Sheets time serial fraction (0.25) or a full date-time string. Returns null if invalid.
 */
export function parseTime(raw) {
  if (typeof raw === 'number') {
    if (raw >= 0 && raw < 1) {
      const mins = Math.round(raw * 24 * 60) % (24 * 60);
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    }
    if (Number.isInteger(raw) && raw >= 0 && raw <= 24) return `${String(raw % 24).padStart(2, '0')}:00`;
    return null;
  }
  let s = clean(raw);
  if (!s) return null;
  // A full date-time ("2025-01-01 06:00") -> keep only the time part.
  const dt = s.match(/^\S*\d[-/.]\d\S*[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m?\.?)?)$/i);
  if (dt) s = dt[1];

  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m?\.?$/i);
  let h; let min;
  if (m) {
    h = parseInt(m[1], 10);
    min = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase() === 'p';
    h = (h % 12) + (pm ? 12 : 0);
  } else if ((m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/))) {
    h = parseInt(m[1], 10);
    min = parseInt(m[2], 10);
  } else if ((m = s.match(/^(\d{1,2})(\d{2})$/)) ) {
    h = parseInt(m[1], 10);
    min = parseInt(m[2], 10);
  } else if ((m = s.match(/^(\d{1,2})$/))) {
    h = parseInt(m[1], 10);
    min = 0;
  } else {
    return null;
  }
  if (min < 0 || min > 59 || h < 0 || h > 24 || (h === 24 && min !== 0)) return null;
  return `${String(h % 24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const timeToMinutes = (t) => {
  const m = typeof t === 'string' && t.match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
};

// Locales where a written date such as 3/4/2025 means March 4th (everywhere else it is 3 April).
const MONTH_FIRST_LOCALES = new Set(['en_US', 'en_PH', 'fil_PH', 'en_CA']);
export const isMonthFirstLocale = (locale) => MONTH_FIRST_LOCALES.has(String(locale || '').replace('-', '_'));

const DATE_TIME_FORMATS = [
  "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm',
  'd/M/yyyy HH:mm:ss', 'd/M/yyyy H:mm', 'd/M/yy H:mm',
  'd.M.yyyy HH:mm:ss', 'd.M.yyyy H:mm', 'd.M.yy H:mm',
  'd-M-yyyy H:mm',
  'd/M/yyyy h:mm a', 'yyyy-MM-dd h:mm a',
];
const DATE_ONLY_FORMATS = ['yyyy-MM-dd', 'd/M/yyyy', 'd/M/yy', 'd.M.yyyy', 'd.M.yy', 'd-M-yyyy', 'yyyy/MM/dd', 'd MMM yyyy', 'MMM d, yyyy'];

// Swap day and month in a day-first format for month-first locales.
const monthFirstFormat = (f) => f.replace(/^d([/.-])M/, 'M$1d');

/**
 * Parse a date or date-time written in the sheet. Day-first ("31/12/2025") is preferred, matching
 * the Schedule sheet this app writes, unless the spreadsheet's locale is month-first (monthFirst: true).
 * Returns { date, dateOnly } or null if unparseable.
 */
export function parseDateTime(raw, { monthFirst = false } = {}) {
  if (raw instanceof Date) return isValid(raw) ? { date: raw, dateOnly: false } : null;
  if (typeof raw === 'number') {
    // Google Sheets / Excel serial date (days since 1899-12-30).
    if (raw > 20000 && raw < 80000) {
      const ms = Math.round((raw - 25569) * 86400 * 1000);
      const d = new Date(ms);
      const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
      return isValid(local) ? { date: local, dateOnly: Number.isInteger(raw) } : null;
    }
    return null;
  }
  const s = clean(raw).replace(/\s+/g, ' ');
  if (!s) return null;
  const ref = new Date(2000, 0, 1, 0, 0, 0, 0);

  const fmt = (f) => (monthFirst ? monthFirstFormat(f) : f);
  for (const f of DATE_TIME_FORMATS) {
    const d = parse(s, fmt(f), ref);
    if (isValid(d)) return { date: d, dateOnly: false };
  }
  for (const f of DATE_ONLY_FORMATS) {
    const d = parse(s, fmt(f), ref);
    if (isValid(d)) return { date: d, dateOnly: true };
  }
  const iso = parseISO(s);
  if (isValid(iso)) return { date: iso, dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(s) };
  return null;
}

export const toLocalIso = (d) => format(d, "yyyy-MM-dd'T'HH:mm:ss");

/** Split a "a, b; c" cell into items. dedupe=false keeps repeats (a post can need two "guard" slots). */
export function parseList(raw, { dedupe = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const part of clean(raw).split(/[,;،\n|]+/)) {
    const t = part.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const k = t.toLowerCase();
    if (dedupe && seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Work out which column holds which field using the header row.
 * Returns { map: {field: colIndex}, positional, recognized, issues[] }.
 */
export function mapColumns(tab, headerRow = []) {
  const specs = COLUMN_SPECS[tab];
  const headers = (headerRow || []).map(normalizeHeader);
  const map = {};
  const used = new Set();

  for (const spec of specs) {
    const idx = headers.findIndex((h, i) => !used.has(i) && h && spec.aliases.includes(h));
    if (idx >= 0) { map[spec.field] = idx; used.add(idx); }
  }

  // Second pass for headers that only contain an alias ("Shift length in hours", "Required skills list").
  for (const spec of specs) {
    if (map[spec.field] !== undefined) continue;
    const idx = headers.findIndex((h, i) => !used.has(i) && h && spec.aliases.some((a) => a.length >= 4 && (h.startsWith(`${a} `) || h.endsWith(` ${a}`) || h.includes(` ${a} `))));
    if (idx >= 0) { map[spec.field] = idx; used.add(idx); }
  }

  const recognized = Object.keys(map).length;
  const issues = [];
  let positional = false;

  if (recognized === 0) {
    // Nothing recognisable: assume the documented column order.
    positional = true;
    specs.forEach((spec, i) => { map[spec.field] = i; });
    if (headers.some(Boolean)) {
      issues.push({ level: 'warning', sheet: tab, row: 1, message: `Header row was not recognised, so columns are assumed to be in this order: ${specs.map(s => s.header).join(', ')}.` });
    } else {
      issues.push({ level: 'warning', sheet: tab, row: 1, message: `Header row is empty; assuming columns: ${specs.map(s => s.header).join(', ')}.` });
    }
  } else {
    // Required first column fallback: if the "name" column was not recognised use column A when free.
    const first = specs[0];
    if (first.required && map[first.field] === undefined && !used.has(0)) {
      map[first.field] = 0;
      used.add(0);
      issues.push({ level: 'warning', sheet: tab, row: 1, message: `No "${first.header}" column header found; using column A.` });
    }
    for (const spec of specs) {
      if (map[spec.field] === undefined) {
        issues.push({
          level: spec.required ? 'error' : 'warning',
          sheet: tab,
          row: 1,
          message: spec.required
            ? `Missing required column "${spec.header}". This sheet cannot be used until it is added.`
            : `Missing column "${spec.header}"; a default value will be used.`,
        });
      }
    }
  }
  return { map, positional, recognized, issues };
}

const cell = (row, map, field) => (map[field] === undefined ? undefined : row[map[field]]);
const isBlankRow = (row) => !row || row.every((c) => clean(c) === '');

// ---------------------------------------------------------------------------
// Sheet -> model
// ---------------------------------------------------------------------------

const issue = (issues, level, sheet, row, message) => issues.push({ level, sheet, row, message });

function parseSoldiers(values, issues) {
  const { map, issues: colIssues } = mapColumns('Soldiers', values[0]);
  issues.push(...colIssues);
  if (map.name === undefined) return { soldiers: [], map };

  const soldiers = [];
  const seen = new Map();
  values.slice(1).forEach((row, i) => {
    const sheetRow = i + 2;
    if (isBlankRow(row)) return;
    const name = clean(cell(row, map, 'name')).replace(/\s+/g, ' ');
    if (!name) {
      issue(issues, 'warning', 'Soldiers', sheetRow, 'Row has data but no name; it was skipped.');
      return;
    }
    const key = normalizeKey(name);
    if (seen.has(key)) {
      issue(issues, 'error', 'Soldiers', sheetRow, `Duplicate name "${name}" (also on row ${seen.get(key)}). Schedules refer to people by name, so this row was ignored.`);
      return;
    }
    seen.set(key, sheetRow);

    let division = null;
    const rawDiv = clean(cell(row, map, 'division'));
    if (rawDiv) {
      const n = parseInt(rawDiv.replace(/[^\d-]/g, ''), 10);
      if (Number.isFinite(n)) division = n;
      else issue(issues, 'warning', 'Soldiers', sheetRow, `Division "${rawDiv}" is not a number; it was ignored.`);
    }

    soldiers.push({
      id: i + 1, // stable row-based id: sheet row = id + 1
      name,
      division,
      skills: parseList(cell(row, map, 'skills')),
      excluded_posts: parseList(cell(row, map, 'excluded_posts')),
    });
  });
  return { soldiers, map };
}

function parsePosts(values, issues, dateOpts = {}) {
  const { map, issues: colIssues } = mapColumns('Posts', values[0]);
  issues.push(...colIssues);
  if (map.name === undefined) return { posts: [], map };

  const posts = [];
  const seen = new Map();
  values.slice(1).forEach((row, i) => {
    const sheetRow = i + 2;
    if (isBlankRow(row)) return;
    const name = clean(cell(row, map, 'name')).replace(/\s+/g, ' ');
    if (!name) {
      issue(issues, 'warning', 'Posts', sheetRow, 'Row has data but no name; it was skipped.');
      return;
    }
    const key = normalizeKey(name);
    if (seen.has(key)) {
      issue(issues, 'error', 'Posts', sheetRow, `Duplicate post "${name}" (also on row ${seen.get(key)}); this row was ignored.`);
      return;
    }
    seen.set(key, sheetRow);

    const len = parseNumber(cell(row, map, 'shift_length_hours'), 4);
    let shiftLength = len.value;
    if (!len.recognized) {
      issue(issues, 'warning', 'Posts', sheetRow, `Shift length "${clean(cell(row, map, 'shift_length_hours'))}" for "${name}" is not a number; using 4 hours.`);
      shiftLength = 4;
    } else if (len.blank) {
      issue(issues, 'warning', 'Posts', sheetRow, `Shift length is empty for "${name}"; using 4 hours.`);
    } else if (!(shiftLength > 0) || shiftLength > 24 * 7) {
      issue(issues, 'warning', 'Posts', sheetRow, `Shift length ${shiftLength} for "${name}" is out of range; using 4 hours.`);
      shiftLength = 4;
    }

    const rawStart = cell(row, map, 'start_time');
    const rawEnd = cell(row, map, 'end_time');
    let start = parseTime(rawStart);
    if (!start) {
      if (clean(rawStart)) issue(issues, 'warning', 'Posts', sheetRow, `Start time "${clean(rawStart)}" for "${name}" is not a valid time; using 00:00.`);
      start = '00:00';
    }
    let end = parseTime(rawEnd);
    if (!end) {
      if (clean(rawEnd)) issue(issues, 'warning', 'Posts', sheetRow, `End time "${clean(rawEnd)}" for "${name}" is not a valid time; the post is treated as active around the clock.`);
      end = start;
    }

    const cool = parseNumber(cell(row, map, 'cooldown_hours'), 0);
    let cooldown = cool.value;
    if (!cool.recognized || cooldown < 0) {
      issue(issues, 'warning', 'Posts', sheetRow, `Cooldown "${clean(cell(row, map, 'cooldown_hours'))}" for "${name}" is invalid; using 0.`);
      cooldown = 0;
    }

    const inten = parseNumber(cell(row, map, 'intensity_weight'), 1);
    let intensity = inten.value;
    if (!inten.recognized || !(intensity > 0)) {
      issue(issues, 'warning', 'Posts', sheetRow, `Intensity "${clean(cell(row, map, 'intensity_weight'))}" for "${name}" is invalid; using 1.`);
      intensity = 1;
    }

    const skills = parseList(cell(row, map, 'slots'), { dedupe: false });
    if (skills.length === 0) {
      issue(issues, 'warning', 'Posts', sheetRow, `"${name}" has no required skills in Slots, so nobody can be scheduled on it.`);
    }

    const active = parseBool(cell(row, map, 'is_active'), true);
    if (!active.recognized) {
      issue(issues, 'warning', 'Posts', sheetRow, `Is Active value "${clean(cell(row, map, 'is_active'))}" for "${name}" was not understood; treating the post as active. Use TRUE/FALSE, 1/0 or Yes/No.`);
    }

    const readDate = (field, endOfDay) => {
      const raw = cell(row, map, field);
      if (!clean(raw)) return null;
      const p = parseDateTime(raw, dateOpts);
      if (!p) {
        issue(issues, 'warning', 'Posts', sheetRow, `${field === 'active_from' ? 'Active From' : 'Active Until'} "${clean(raw)}" for "${name}" is not a valid date; it was ignored.`);
        return null;
      }
      let d = p.date;
      if (p.dateOnly && endOfDay) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0);
      return toLocalIso(d);
    };
    const activeFrom = readDate('active_from', false);
    const activeUntil = readDate('active_until', true);
    if (activeFrom && activeUntil && activeFrom >= activeUntil) {
      issue(issues, 'warning', 'Posts', sheetRow, `"${name}" is only active from ${activeFrom} until ${activeUntil}, which is an empty period.`);
    }

    posts.push({
      id: i + 1,
      name,
      shift_length_hours: shiftLength,
      start_time: start,
      end_time: end,
      cooldown_hours: cooldown,
      intensity_weight: intensity,
      slots: skills.map((skill, j) => ({ role_index: j, skill })),
      is_active: active.value,
      active_from: activeFrom,
      active_until: activeUntil,
    });
  });
  return { posts, map };
}

function parseUnavailabilities(values, soldiers, issues, dateOpts = {}) {
  const { map, issues: colIssues } = mapColumns('Unavailabilities', values[0]);
  issues.push(...colIssues);
  if (map.soldier === undefined || map.start === undefined || map.end === undefined) return { unavailabilities: [], map };

  const byName = new Map(soldiers.map((s) => [normalizeKey(s.name), s]));
  const out = [];
  values.slice(1).forEach((row, i) => {
    const sheetRow = i + 2;
    if (isBlankRow(row)) return;
    const rawName = clean(cell(row, map, 'soldier'));
    if (!rawName) {
      issue(issues, 'warning', 'Unavailabilities', sheetRow, 'Row has no soldier name; it was skipped.');
      return;
    }
    const sol = byName.get(normalizeKey(rawName));
    if (!sol) issue(issues, 'warning', 'Unavailabilities', sheetRow, `"${rawName}" is not in the Soldiers sheet, so this unavailability has no effect.`);

    const s = parseDateTime(cell(row, map, 'start'), dateOpts);
    const e = parseDateTime(cell(row, map, 'end'), dateOpts);
    if (!s || !e) {
      issue(issues, 'warning', 'Unavailabilities', sheetRow, `Could not read the ${!s ? 'start' : 'end'} date "${clean(cell(row, map, !s ? 'start' : 'end'))}" for ${rawName}; the row was skipped. Use e.g. 31/12/2025 14:00 or 2025-12-31 14:00.`);
      return;
    }
    let start = s.date;
    let end = e.date;
    // A date-only end means "through that whole day".
    if (e.dateOnly) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, 0, 0, 0);
    if (end <= start) {
      issue(issues, 'warning', 'Unavailabilities', sheetRow, `End is not after start for ${rawName}; the row was skipped.`);
      return;
    }
    out.push({
      id: i + 1,
      soldier_id: sol ? sol.id : 0,
      soldier_name: sol ? sol.name : rawName,
      start_datetime: toLocalIso(start),
      end_datetime: toLocalIso(end),
      reason: clean(cell(row, map, 'reason')),
    });
  });
  return { unavailabilities: out, map };
}

/**
 * Make skill and post names consistent regardless of capitalisation, so "guard" in the Soldiers
 * sheet matches "Guard" in Posts. Post requirements are the reference spelling.
 */
function canonicalize(soldiers, posts, issues) {
  const canonSkill = new Map();
  posts.forEach((p) => p.slots.forEach((s) => { if (!canonSkill.has(normalizeKey(s.skill))) canonSkill.set(normalizeKey(s.skill), s.skill); }));
  soldiers.forEach((s) => s.skills.forEach((sk) => { if (!canonSkill.has(normalizeKey(sk))) canonSkill.set(normalizeKey(sk), sk); }));
  const canonPost = new Map(posts.map((p) => [normalizeKey(p.name), p.name]));
  posts.forEach((p) => p.slots.forEach((slot) => { slot.skill = canonSkill.get(normalizeKey(slot.skill)) || slot.skill; }));

  soldiers.forEach((s) => {
    s.skills = [...new Set(s.skills.map((sk) => canonSkill.get(normalizeKey(sk)) || sk))];
    s.excluded_posts = s.excluded_posts
      .map((p) => {
        const c = canonPost.get(normalizeKey(p));
        if (!c) issue(issues, 'warning', 'Soldiers', s.id + 1, `${s.name} is excluded from "${p}", which is not a post in the Posts sheet.`);
        return c || p;
      });
  });

  // Required skills nobody has.
  const have = new Set(soldiers.flatMap((s) => s.skills.map(normalizeKey)));
  const reported = new Set();
  posts.forEach((p) => p.slots.forEach((s) => {
    const k = normalizeKey(s.skill);
    if (!have.has(k) && !reported.has(`${p.name}|${k}`)) {
      reported.add(`${p.name}|${k}`);
      issue(issues, 'warning', 'Posts', p.id + 1, `Post "${p.name}" requires skill "${s.skill}" but no soldier has it, so that slot cannot be filled.`);
    }
  }));
}

/**
 * Build the in-memory model from raw sheet values.
 * raw = { Soldiers, Posts, Unavailabilities: any[][] | null (null = tab missing), Schedule }
 */
export function buildModel(raw, { locale } = {}) {
  const issues = [];
  const dateOpts = { monthFirst: isMonthFirstLocale(locale) };
  const missing = [];
  for (const tab of ['Soldiers', 'Posts', 'Unavailabilities']) {
    if (raw[tab] === null || raw[tab] === undefined) {
      missing.push(tab);
      const required = tab !== 'Unavailabilities';
      issue(issues, required ? 'error' : 'warning', tab, null, `The "${tab}" tab was not found in the spreadsheet. ${required ? 'Create it (use "Repair sheet structure") to continue.' : 'No unavailabilities will be applied.'}`);
    }
  }

  const sRaw = raw.Soldiers || [];
  const pRaw = raw.Posts || [];
  const uRaw = raw.Unavailabilities || [];

  const soldiersRes = raw.Soldiers ? parseSoldiers(sRaw, issues) : { soldiers: [], map: {} };
  const postsRes = raw.Posts ? parsePosts(pRaw, issues, dateOpts) : { posts: [], map: {} };
  const unavRes = raw.Unavailabilities ? parseUnavailabilities(uRaw, soldiersRes.soldiers, issues, dateOpts) : { unavailabilities: [], map: {} };

  canonicalize(soldiersRes.soldiers, postsRes.posts, issues);

  if (raw.Soldiers && soldiersRes.soldiers.length === 0 && !issues.some((i) => i.sheet === 'Soldiers' && i.level === 'error')) {
    issue(issues, 'warning', 'Soldiers', null, 'No soldiers found. Add rows below the header.');
  }
  if (raw.Posts && postsRes.posts.length === 0 && !issues.some((i) => i.sheet === 'Posts' && i.level === 'error')) {
    issue(issues, 'warning', 'Posts', null, 'No posts found. Add rows below the header.');
  }

  return {
    soldiers: soldiersRes.soldiers,
    posts: postsRes.posts,
    unavailabilities: unavRes.unavailabilities,
    columns: { Soldiers: soldiersRes.map, Posts: postsRes.map, Unavailabilities: unavRes.map },
    missingTabs: missing,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

export const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Place `fields` into a copy of `baseRow` according to the column map (keeps unknown columns). */
export function composeRow(map, fields, baseRow = []) {
  const row = [...baseRow];
  for (const [field, value] of Object.entries(fields)) {
    const idx = map[field];
    if (idx === undefined) continue;
    while (row.length <= idx) row.push('');
    row[idx] = value === undefined || value === null ? '' : value;
  }
  return row;
}

export function summarizeIssues(issues) {
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  return { errors, warnings, total: issues.length };
}

/** Parse a standalone table (e.g. an imported file) with the same rules as the live sheets. */
export function parseSoldierTable(values) {
  const issues = [];
  const { soldiers } = parseSoldiers(values && values.length ? values : [[]], issues);
  return { soldiers, issues };
}

export function parsePostTable(values) {
  const issues = [];
  const { posts } = parsePosts(values && values.length ? values : [[]], issues);
  return { posts, issues };
}

/** Dates are written to the sheet as "yyyy-MM-dd HH:mm": unambiguous in any locale and readable by sheet formulas. */
export function toSheetDateTime(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const p = parseDateTime(value);
  return p ? format(p.date, 'yyyy-MM-dd HH:mm') : String(value);
}
