import axios from 'axios';

const API_BASE_URL = 'http://localhost:8001';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const getSoldiers = () => apiClient.get('/soldiers');
export const createSoldier = (data) => apiClient.post('/soldiers', data);
export const updateSoldier = (id, data) => apiClient.put(`/soldiers/${id}`, data);
export const deleteSoldier = (id) => apiClient.delete(`/soldiers/${id}`);

export const getPosts = () => apiClient.get('/posts');
export const createPost = (data) => apiClient.post('/posts', data);
export const updatePost = (name, data) => apiClient.put(`/posts/${name}`, data);
export const deletePost = (name) => apiClient.delete(`/posts/${name}`);

export const getSkills = () => apiClient.get("/skills");

export const getSchedule = (startDate, endDate) => 
  apiClient.get('/schedule', { params: { start_date: startDate, end_date: endDate } });

export const getShiftsWithAssignments = (startDate, endDate) =>
  apiClient.get('/schedule/shifts', { params: { start_date: startDate, end_date: endDate } });

export const getCandidates = (postName, start, end, roleId) =>
  apiClient.get('/schedule/candidates', { params: { post_name: postName, start, end, role_id: roleId } });

export const getUnavailabilities = () => apiClient.get('/unavailabilities');
export const createUnavailability = (data) => apiClient.post('/unavailabilities', data);
export const updateUnavailability = (id, data) => apiClient.put(`/unavailabilities/${id}`, data);
export const deleteUnavailability = (id) => apiClient.delete(`/unavailabilities/${id}`);
export const checkManpower = (startDate, endDate) => 
  apiClient.get('/unavailabilities/check-manpower', { params: { start_date: startDate, end_date: endDate } });

export const draftSchedule = (startDate, endDate) => 
  apiClient.post('/schedule/draft', { start_date: startDate, end_date: endDate });
export const saveSchedule = (startDate, endDate, assignments) => 
  apiClient.post('/schedule/save', { start_date: startDate, end_date: endDate, assignments });

// CSV API
export const exportSoldiers = () => apiClient.get('/soldiers/export', { responseType: 'blob' });
export const importSoldiers = (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/soldiers/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
    });
};

export const exportPosts = () => apiClient.get('/posts/export', { responseType: 'blob' });
export const importPosts = (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/posts/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
    });
};

export default apiClient;
