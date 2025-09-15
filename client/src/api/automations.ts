import api from './api';

// Description: Get all automations
// Endpoint: GET /api/automations
// Request: {}
// Response: { automations: Array<{ _id: string, name: string, description: string, trigger: object, actions: Array<object>, enabled: boolean, lastRun?: string, category: string, priority: number }> }
export const getAutomations = async () => {
  console.log('Fetching automations from API')
  try {
    const response = await api.get('/api/automations');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Create automation from natural language
// Endpoint: POST /api/automations/create-from-text
// Request: { text: string }
// Response: { success: boolean, automation: object, message: string }
export const createAutomationFromText = async (data: { text: string }) => {
  console.log('Creating automation from text:', data)
  try {
    const response = await api.post('/api/automations/create-from-text', data);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Toggle automation enabled status  
// Endpoint: PUT /api/automations/:id/toggle
// Request: { enabled: boolean }
// Response: { success: boolean, message: string, automation: object }
export const toggleAutomation = async (data: { automationId: string; enabled: boolean }) => {
  console.log('Toggling automation:', data)
  try {
    const response = await api.put(`/api/automations/${data.automationId}/toggle`, { enabled: data.enabled });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get single automation by ID
// Endpoint: GET /api/automations/:id
// Request: {}
// Response: { success: boolean, automation: object }
export const getAutomationById = async (id: string) => {
  console.log('Fetching automation by ID:', id)
  try {
    const response = await api.get(`/api/automations/${id}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Create new automation
// Endpoint: POST /api/automations
// Request: { name: string, description?: string, trigger: object, actions: Array<object>, enabled?: boolean, priority?: number, category?: string, conditions?: Array<object>, cooldown?: number }
// Response: { success: boolean, message: string, automation: object }
export const createAutomation = async (data: {
  name: string;
  description?: string;
  trigger: object;
  actions: Array<object>;
  enabled?: boolean;
  priority?: number;
  category?: string;
  conditions?: Array<object>;
  cooldown?: number;
}) => {
  console.log('Creating automation:', data)
  try {
    const response = await api.post('/api/automations', data);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Update existing automation
// Endpoint: PUT /api/automations/:id
// Request: { name?: string, description?: string, trigger?: object, actions?: Array<object>, enabled?: boolean, priority?: number, category?: string, conditions?: Array<object>, cooldown?: number }
// Response: { success: boolean, message: string, automation: object }
export const updateAutomation = async (id: string, data: {
  name?: string;
  description?: string;
  trigger?: object;
  actions?: Array<object>;
  enabled?: boolean;
  priority?: number;
  category?: string;
  conditions?: Array<object>;
  cooldown?: number;
}) => {
  console.log('Updating automation:', id, data)
  try {
    const response = await api.put(`/api/automations/${id}`, data);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Delete automation
// Endpoint: DELETE /api/automations/:id
// Request: {}
// Response: { success: boolean, message: string, deletedAutomation: object }
export const deleteAutomation = async (id: string) => {
  console.log('Deleting automation:', id)
  try {
    const response = await api.delete(`/api/automations/${id}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Execute automation manually
// Endpoint: POST /api/automations/:id/execute
// Request: {}
// Response: { success: boolean, message: string, automation: object, executedActions: number }
export const executeAutomation = async (id: string) => {
  console.log('Executing automation:', id)
  try {
    const response = await api.post(`/api/automations/${id}/execute`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get automation statistics
// Endpoint: GET /api/automations/stats
// Request: {}
// Response: { success: boolean, stats: object }
export const getAutomationStats = async () => {
  console.log('Fetching automation statistics')
  try {
    const response = await api.get('/api/automations/stats');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}