import axios from 'axios';
import { gsheetsService } from './gsheetsService';
import { generateShifts, solveShiftAssignmentGreedy, evaluateSoldierFitness } from '../lib/schedulerCore';
import { parseISO, format, addDays, subDays } from 'date-fns';

// Toggle between 'api' and 'gsheets'
const BACKEND_TYPE = 'gsheets'; 

const API_BASE_URL = '/api';
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Helper to wrap gsheets calls
const wrapGSheets = (promise) => promise;

export const getSoldiers = async () => {
  if (BACKEND_TYPE === 'gsheets') {
    const [soldiers, scores] = await Promise.all([
      gsheetsService.getSoldiers(),
      gsheetsService.getHistoryScores()
    ]);
    const merged = soldiers.map(s => ({
      ...s,
      history_score: scores[s.id] || 0.0
    }));
    return { data: merged };
  }
  return apiClient.get('/soldiers');
};

export const createSoldier = (data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.createSoldier(data).then(() => ({ data: { status: 'success' } }));
  return apiClient.post('/soldiers', data);
};

export const updateSoldier = (id, data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.updateSoldier(id, data).then(() => ({ data: { status: 'success' } }));
  return apiClient.put(`/soldiers/${id}`, data);
};

export const deleteSoldier = (id) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.deleteSoldier(id).then(() => ({ data: { status: 'success' } }));
  return apiClient.delete(`/soldiers/${id}`);
};

export const getPosts = () => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.getPosts().then(data => ({ data }));
  return apiClient.get('/posts');
};

export const createPost = (data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.createPost(data).then(() => ({ data: { status: 'success' } }));
  return apiClient.post('/posts', data);
};

export const updatePost = (name, data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.updatePost(name, data).then(() => ({ data: { status: 'success' } }));
  return apiClient.put(`/posts/${name}`, data);
};

export const deletePost = (name) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.deletePost(name).then(() => ({ data: { status: 'success' } }));
  return apiClient.delete(`/posts/${name}`);
};

export const getSkills = () => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.getSoldiers().then(soldiers => {
    const skills = new Set();
    soldiers.forEach(s => s.skills.forEach(sk => skills.add(sk)));
    return { data: Array.from(skills) };
  });
  return apiClient.get("/skills");
};

export const getShiftsWithAssignments = async (startDate, endDate) => {
  if (BACKEND_TYPE === 'gsheets') {
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
  }
  return apiClient.get('/schedule/shifts', { params: { start_date: startDate, end_date: endDate } });
};

export const getCandidates = async (postName, start, end, roleId, draftAssignments = []) => {
  if (BACKEND_TYPE === 'gsheets') {
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
  }
  return apiClient.post('/schedule/candidates', { post_name: postName, start, end, role_id: roleId, draft_assignments: draftAssignments });
};

export const getUnavailabilities = (startDate, endDate) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.getUnavailabilities().then(data => ({ data }));
  return apiClient.get('/unavailabilities', { params: { start_date: startDate, end_date: endDate } });
};

export const createUnavailability = (data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.createUnavailability(data).then(() => ({ data: { status: 'success' } }));
  return apiClient.post('/unavailabilities', data);
};

export const updateUnavailability = (id, data) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.updateUnavailability(id, data).then(() => ({ data: { status: 'success' } }));
  return apiClient.put(`/unavailabilities/${id}`, data);
};

export const deleteUnavailability = (id) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.deleteUnavailability(id).then(() => ({ data: { status: 'success' } }));
  return apiClient.delete(`/unavailabilities/${id}`);
};

export const draftSchedule = async (startDate, endDate, algorithm = "greedy") => {
  if (BACKEND_TYPE === 'gsheets') {
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
  }
  return apiClient.post('/schedule/draft', { start_date: startDate, end_date: endDate, algorithm });
};

export const saveSchedule = (startDate, endDate, assignments) => {
  if (BACKEND_TYPE === 'gsheets') return gsheetsService.saveAssignments(startDate, endDate, assignments).then(() => ({ data: { status: 'success' } }));
  return apiClient.post('/schedule/save', { start_date: startDate, end_date: endDate, assignments });
};

export const exportSchedule = async (startDate, endDate) => {
  if (BACKEND_TYPE === 'gsheets') {
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
  }
  return apiClient.get('/schedule/export', { params: { start_date: startDate, end_date: endDate }, responseType: 'blob' });
};

// CSV API
export const exportSoldiers = async () => {
    if (BACKEND_TYPE === 'gsheets') {
        const soldiers = await gsheetsService.getSoldiers();
        exportSoldiersToCSV(soldiers);
        return;
    }
    return apiClient.get('/soldiers/export', { responseType: 'blob' });
};

export const importSoldiers = (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/soldiers/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
    });
};

export const exportPosts = async () => {
    if (BACKEND_TYPE === 'gsheets') {
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
    }
    return apiClient.get('/posts/export', { responseType: 'blob' });
};

export const importPosts = (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/posts/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
    });
};

export const checkManpower = async (startDate, endDate) => {
    if (BACKEND_TYPE === 'gsheets') {
        const soldiers = await gsheetsService.getSoldiers();
        const unavailabilities = await gsheetsService.getUnavailabilities();
        soldiers.forEach(s => {
            s.unavailabilities = unavailabilities.filter(u => u.soldier_name === s.name);
        });
        const posts = await gsheetsService.getPosts();
        
        const { checkManpower: coreCheckManpower } = await import('../lib/schedulerCore');
        const report = coreCheckManpower(startDate, endDate, soldiers, posts);
        return { data: report };
    }
    return apiClient.get('/unavailabilities/check-manpower', { params: { start_date: startDate, end_date: endDate } });
};

export const getAuthStatus = () => {
    if (BACKEND_TYPE === 'gsheets') {
        const token = localStorage.getItem('google_access_token');
        if (token) {
            gsheetsService.setAccessToken(token);
            return Promise.resolve({ data: { authenticated: true, backend: 'gsheets' } });
        }
        return Promise.resolve({ data: { authenticated: false, backend: 'gsheets', reason: 'no_token' } });
    }
    return apiClient.get('/auth/status');
};

export default apiClient;
