import * as XLSX from 'xlsx';
import { gsheetsService } from './gsheetsService';
import { ensureToken } from './auth';
import { exportToExcel, exportSoldiersToCSV } from './exportService';
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
    const key = `${a.post_name}-${toKey(a.start)}-${a.role_id}`;
    assignmentLookup[key] = a;
  });

  const result = [];
  shifts.forEach(shift => {
    shift.post.slots.forEach(slot => {
      const key = `${shift.post_name}-${toKey(shift.start)}-${slot.role_index}`;
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

export const getUnavailabilities = (startDate, endDate) => {
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

export const draftSchedule = async (startDate, endDate, algorithm = "greedy") => {
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
  return gsheetsService.saveAssignments(startDate, endDate, assignments).then(() => ({ data: { status: 'success' } }));
};

export const exportSchedule = async (startDate, endDate) => {
  const assignments = await gsheetsService.getAssignmentsInRange(startDate, endDate);
  const data = assignments.map(a => ({
      Soldier: a.soldier_name,
      Post: a.post_name,
      Start: format(parseISO(a.start), 'yyyy-MM-dd HH:mm'),
      End: format(parseISO(a.end), 'yyyy-MM-dd HH:mm'),
      Role: a.role_id
  }));
  exportToExcel(data, `schedule_${startDate}`);
  return;
};

// CSV API
export const exportSoldiers = async () => {
      const soldiers = await gsheetsService.getSoldiers();
      exportSoldiersToCSV(soldiers);
      return;
};

const readRows = async (file) => {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
};
const splitList = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k];
  return '';
};

export const importSoldiers = async (file) => {
  const rows = await readRows(file);
  const existing = new Set((await gsheetsService.getSoldiers()).map(s => s.name));
  let imported = 0;
  for (const row of rows) {
    const name = String(pick(row, 'Name', 'name')).trim();
    if (!name || existing.has(name)) continue;
    await gsheetsService.createSoldier({
      name,
      division: parseInt(pick(row, 'Division', 'division')) || null,
      skills: splitList(pick(row, 'Skills', 'skills')),
      excluded_posts: splitList(pick(row, 'Excluded Posts', 'excluded_posts')),
    });
    existing.add(name);
    imported++;
  }
  return { data: { imported } };
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
      exportToExcel(data, "posts");
      return;
};

export const importPosts = async (file) => {
  const rows = await readRows(file);
  const existing = new Set((await gsheetsService.getPosts()).map(p => p.name));
  let imported = 0;
  for (const row of rows) {
    const name = String(pick(row, 'Name', 'name')).trim();
    if (!name || existing.has(name)) continue;
    await gsheetsService.createPost({
      name,
      shift_length_hours: Number(pick(row, 'Shift Length', 'shift_length_hours')) || 8,
      start_time: String(pick(row, 'Start Time', 'start_time') || '00:00'),
      end_time: String(pick(row, 'End Time', 'end_time') || '00:00'),
      cooldown_hours: Number(pick(row, 'Cooldown', 'cooldown_hours')) || 0,
      intensity_weight: Number(pick(row, 'Intensity', 'intensity_weight')) || 1,
      slots: splitList(pick(row, 'Slots', 'slots')),
      is_active: true,
    });
    existing.add(name);
    imported++;
  }
  return { data: { imported } };
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
