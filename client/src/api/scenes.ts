import api from './api';

export type SceneDeviceAction = {
  deviceId: string | { _id: string; name?: string };
  action: string;
  value?: any;
};

export type SceneGroupAction = {
  groupId: string | { _id: string; name?: string; normalizedName?: string };
  action: string;
  value?: any;
};

export type SceneRecord = {
  _id: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  color?: string;
  active?: boolean;
  deviceActions?: SceneDeviceAction[];
  groupActions?: SceneGroupAction[];
};

// Description: Get all scenes
// Endpoint: GET /api/scenes
// Request: {}
// Response: { scenes: Array<{ _id: string, name: string, description: string, devices: Array<any>, active: boolean }> }
export const getScenes = async () => {
  console.log('Fetching scenes from API')
  try {
    const response = await api.get('/api/scenes');
    return response.data;
  } catch (error) {
    console.error('Error fetching scenes:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Activate a scene
// Endpoint: POST /api/scenes/activate
// Request: { sceneId: string }
// Response: { success: boolean, message: string }
export const activateScene = async (data: { sceneId: string }) => {
  console.log('Activating scene:', data)
  try {
    const response = await api.post('/api/scenes/activate', data);
    return response.data;
  } catch (error) {
    console.error('Error activating scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Create a new scene
// Endpoint: POST /api/scenes
// Request: { name: string, description: string, devices: Array<string>, deviceActions?: Array<object>, groupActions?: Array<object> }
// Response: { success: boolean, scene: object }
export const createScene = async (data: {
  name: string;
  description: string;
  devices: Array<string>;
  deviceActions?: SceneDeviceAction[];
  groupActions?: SceneGroupAction[];
}) => {
  console.log('Creating scene:', data)
  try {
    const response = await api.post('/api/scenes', data);
    return response.data;
  } catch (error) {
    console.error('Error creating scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Create scene from natural language
// Endpoint: POST /api/scenes/natural-language
// Request: { description: string }
// Response: { success: boolean, scene: object, message: string }
export const createSceneFromNaturalLanguage = async (data: { description: string }) => {
  console.log('Creating scene from natural language:', data)
  try {
    const response = await api.post('/api/scenes/natural-language', data);
    return response.data;
  } catch (error) {
    console.error('Error creating scene from natural language:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Update existing scene
// Endpoint: PUT /api/scenes/:id
// Request: { name?: string, description?: string, deviceActions?: Array<object>, groupActions?: Array<object>, category?: string, icon?: string, color?: string }
// Response: { success: boolean, message: string, scene: object }
export const updateScene = async (id: string, data: {
  name?: string;
  description?: string;
  deviceActions?: SceneDeviceAction[];
  groupActions?: SceneGroupAction[];
  category?: string;
  icon?: string;
  color?: string;
}) => {
  console.log('Updating scene:', id, data)
  try {
    const response = await api.put(`/api/scenes/${id}`, data);
    return response.data;
  } catch (error) {
    console.error('Error updating scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Delete scene
// Endpoint: DELETE /api/scenes/:id
// Request: {}
// Response: { success: boolean, message: string, deletedScene: object }
export const deleteScene = async (id: string) => {
  console.log('Deleting scene:', id)
  try {
    const response = await api.delete(`/api/scenes/${id}`);
    return response.data;
  } catch (error) {
    console.error('Error deleting scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Get single scene by ID
// Endpoint: GET /api/scenes/:id
// Request: {}
// Response: { success: boolean, scene: object }
export const getSceneById = async (id: string) => {
  console.log('Fetching scene by ID:', id)
  try {
    const response = await api.get(`/api/scenes/${id}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}
