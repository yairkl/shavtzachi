import * as XLSX from 'xlsx';
import { gsheetsService } from './gsheetsService';
import { ensureToken } from './auth';
import { parseSoldierTable, parsePostTable, normalizeKey } from '../lib/sheetModel';
import { exportToExcel, exportSoldiersToCSV, scheduleRows } from './exportService';
import { generateShifts, solveShiftAssignmentGreedy, evaluateSoldierFitness, checkManpower as coreCheckManpower } from '../lib/schedulerCore';
import { parseISO, format, addDays } from 'date-fns';


export const getSoldiers = async () => {
  const [soldiers, scores] = await Promise.all([
    gsheetsService.getSoldiers(),
    gsheetsService.getHistoryScores()
  ]);
  const merged = soldiers.map(s => ({
    ...s,
    history_score: scores[s.id] || 0.0
  }));
  return { data: merged };
};

export const createSoldier = (data) => {
  return gsheetsService.createSoldier(data).then(() => ({ data: { status: 'success' } }));
};

export const updateSoldier = (id, data) => {
  return gsheetsService.updateSoldier(id, data).then(() => ({ data: { status: 'success' } }));
};

export const deleteSoldier = (id) => {
  return gsheetsService.deleteSoldier(id).then(() => ({ data: { status: 'success' } }));
};

export const getPosts = () => {
  return gsheetsService.getPosts().then(data => ({ data }));
};

export const createPost = (data) => {
  return gsheetsService.createPost(data).then(() => ({ data: { status: 'success' } }));
};

export const updatePost = (name, data) => {
  return gsheetsService.updatePost(name, data).then(() => ({ data: { status: 'success' } }));
};

export const deletePost = (name) => {
  return gsheetsService.deletePost(name).then(() => ({ data: { status: 'success' } }));
};

export const getSkills = () => {
  return gsheetsService.getSoldiers().then(soldiers => {
    const skills = new Set();
    soldiers.forEach(s => s.skills.forEach(sk => skills.add(sk)));
    return { data: Array.from(skills) };
  });
};

export const getShiftsWithAssignments = async (startDate, endDate) => {
  const posts = await gsheetsService.getPosts();
  const activePosts = posts.filter(p => p.is_active);
  const shifts = generateShifts(activePosts, startDate, endDate, true);
  const assignments = await gsheetsService.getAssignmentsInRange(startDate, endDate);

  const toKey = (d) => {
    const dt = typeof d === 'string' ? parseISO(d) : d;
    return format(dt, 'yyyyMMddHHmm');
  };

  const assignmentLookup = {};
  assignments.forEach(a => {
    const key = `${normalizeKey(a.post_name)}-${toKey(a.start)}-${a.role_id}`;
    assignmentLookup[key] = a;
  });

  const result = [];
  shifts.forEach(shift => {
    shift.post.slots.forEach(slot => {
      const key = `${normalizeKey(shift.post_name)}-${toKey(shift.start)}-${slot.role_index}`;
      const a = assignmentLookup[key];
      result.push({
        post_name: shift.post_name,
        start: shift.start.toISOString(),
        end: shift.end.toISOString(),
        role_id: slot.role_index,
        skill: slot.skill,
        soldier_id: a ? a.soldier_id : null,
        soldier_name: a ? a.soldier_name : null,
      });
    });
  });
  return { data: result };
};

export const getCandidates = async (postName, start, end, roleId, draftAssignments = []) => {
  const posts = await gsheetsService.getPosts();
  const post = posts.find(p => p.name === postName);
  const soldiers = await gsheetsService.getSoldiers();
  const unavailabilities = await gsheetsService.getUnavailabilities();
  
  // Attach unavailabilities to soldiers
  soldiers.forEach(s => {
      s.unavailabilities = unavailabilities.filter(u => u.soldier_name === s.name);
  });

  const historyScores = await gsheetsService.getHistoryScores(start);
  const existingAssignments = await gsheetsService.getAssignmentsInRange(
      format(addDays(parseISO(start), -7), 'yyyy-MM-dd'),
      format(addDays(parseISO(end), 7), 'yyyy-MM-dd')
  );

  const results = soldiers.map(s => {
    const { score, conflicts, lastShift, nextShift } = evaluateSoldierFitness(
      s, start, end, post, roleId, historyScores, existingAssignments, draftAssignments
    );
    return {
      id: s.id,
      name: s.name,
      fitness_score: score,
      conflicts,
      last_shift: lastShift ? { ...lastShift, end: lastShift.end.toISOString() } : null,
      next_shift: nextShift ? { start: nextShift.start.toISOString(), post_name: nextShift.post_name } : null
    };
  });

  results.sort((a, b) => b.fitness_score - a.fitness_score);
  return { data: results };
};

export const getUnavailabilities = () => {
  return gsheetsService.getUnavailabilities().then(data => ({ data }));
};

export const createUnavailability = (data) => {
  return gsheetsService.createUnavailability(data).then(() => ({ data: { status: 'success' } }));
};

export const updateUnavailability = (id, data) => {
  return gsheetsService.updateUnavailability(id, data).then(() => ({ data: { status: 'success' } }));
};

export const deleteUnavailability = (id) => {
  return gsheetsService.deleteUnavailability(id).then(() => ({ data: { status: 'success' } }));
};

export const draftSchedule = async (startDate, endDate) => {
  const soldiers = await gsheetsService.getSoldiers();
  const unavailabilities = await gsheetsService.getUnavailabilities();
  soldiers.forEach(s => {
      s.unavailabilities = unavailabilities.filter(u => u.soldier_name === s.name);
  });

  const posts = await gsheetsService.getPosts();
  const activePosts = posts.filter(p => p.is_active);
  
  const shifts = generateShifts(activePosts, startDate, endDate, true);
  const historyScores = await gsheetsService.getHistoryScores(startDate);
  
  const lookbackDate = format(addDays(parseISO(startDate), -7), 'yyyy-MM-dd');
  const existingAssignments = await gsheetsService.getAssignmentsInRange(lookbackDate, endDate);

  const assignments = solveShiftAssignmentGreedy(shifts, soldiers, historyScores, existingAssignments);

  return { data: assignments.map(a => ({
    soldier_id: a.soldier_id,
    soldier_name: a.soldier_name,
    post_name: a.post_name,
    start: a.start.toISOString(),
    end: a.end.toISOString(),
    role_id: a.role_id
  })) };
};

export const saveSchedule = (startDate, endDate, assignments) => {
  return gsheetsService.saveAssignments(startDate, endDate, assignments).then((res) => ({ data: { status: 'success', violations: res?.violations || [], liveChecks: res?.liveChecks || null } }));
};

export const exportSchedule = async (startDate, endDate) => {
  const [assignments, posts] = await Promise.all([
    gsheetsService.getAssignmentsInRange(startDate, endDate),
    gsheetsService.getPosts(),
  ]);
  if (!assignments.length) throw new Error('There is nothing to export: no saved assignments in this period. Save the schedule first.');
  exportToExcel(scheduleRows(assignments, posts), `schedule_${String(startDate).slice(0, 10)}`, 'Schedule');
};

// CSV API
export const exportSoldiers = async () => {
      const soldiers = await gsheetsService.getSoldiers();
      exportSoldiersToCSV(soldiers);
      return;
};

/** Read a CSV/XLSX file into a 2D array of strings (header row first). */
const readTable = async (file, preferredSheet) => {
  let wb;
  if (/\.csv$|\.txt$/i.test(file.name || '') || file.type === 'text/csv') {
    let text = await file.text();
    text = text.replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': (first.match(/,/g) || []).length, ';': (first.match(/;/g) || []).length, '\t': (first.match(/\t/g) || []).length };
    const FS = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    wb = XLSX.read(text, { type: 'string', FS, raw: true });
  } else {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  }
  if (!wb.SheetNames.length) throw new Error('The file has no sheets.');
  const name = wb.SheetNames.find(n => n.trim().toLowerCase() === preferredSheet.toLowerCase()) || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
};

export const importSoldiers = async (file) => {
  const table = await readTable(file, 'Soldiers');
  const { soldiers, issues } = parseSoldierTable(table);
  const existing = new Set((await gsheetsService.getSoldiers()).map(s => normalizeKey(s.name)));
  const fresh = [];
  for (const s of soldiers) {
    if (existing.has(normalizeKey(s.name))) {
      issues.push({ level: 'info', sheet: 'Import', row: null, message: `"${s.name}" already exists; skipped.` });
      continue;
    }
    fresh.push(s);
  }
  await gsheetsService.appendSoldiers(fresh);
  return { data: { imported: fresh.length, skipped: soldiers.length - fresh.length, issues } };
};

export const exportPosts = async () => {
      const posts = await gsheetsService.getPosts();
      const data = posts.map(p => ({
          Name: p.name,
          'Shift Length': p.shift_length_hours,
          'Start Time': p.start_time,
          'End Time': p.end_time,
          Cooldown: p.cooldown_hours,
          Intensity: p.intensity_weight,
          Slots: p.slots.map(s => s.skill).join(',')
      }));
      exportToExcel(data, "posts", "Posts");
      return;
};

export const importPosts = async (file) => {
  const table = await readTable(file, 'Posts');
  const { posts, issues } = parsePostTable(table);
  const existing = new Set((await gsheetsService.getPosts()).map(p => normalizeKey(p.name)));
  const fresh = [];
  for (const p of posts) {
    if (existing.has(normalizeKey(p.name))) {
      issues.push({ level: 'info', sheet: 'Import', row: null, message: `"${p.name}" already exists; skipped.` });
      continue;
    }
    fresh.push(p);
  }
  await gsheetsService.appendPosts(fresh);
  return { data: { imported: fresh.length, skipped: posts.length - fresh.length, issues } };
};

export const checkManpower = async (startDate, endDate) => {
      const soldiers = await gsheetsService.getSoldiers();
      const unavailabilities = await gsheetsService.getUnavailabilities();
      soldiers.forEach(s => {
          s.unavailabilities = unavailabilities.filter(u => u.soldier_name === s.name);
      });
      const posts = await gsheetsService.getPosts();
      
      const report = coreCheckManpower(startDate, endDate, soldiers, posts);
      return { data: report };
};

export const getAuthStatus = async () => {
  const token = await ensureToken();
  if (token) {
    gsheetsService.setAccessToken(token);
    return { data: { authenticated: true, backend: 'gsheets' } };
  }
  return { data: { authenticated: false, backend: 'gsheets', reason: 'no_token' } };
};
