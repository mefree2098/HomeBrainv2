import api from './api';

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
// Request: { name: string, description: string, devices: Array<string> }
// Response: { success: boolean, scene: object }
export const createScene = async (data: { name: string; description: string; devices: Array<string> }) => {
  console.log('Creating scene:', data)
  try {
    const response = await api.post('/api/scenes', data);
    return response.data;
  } catch (error) {
    console.error('Error creating scene:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}