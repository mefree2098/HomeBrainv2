import api from './api';

// Description: Get all scenes
// Endpoint: GET /api/scenes
// Request: {}
// Response: { scenes: Array<{ _id: string, name: string, description: string, devices: Array<any>, active: boolean }> }
export const getScenes = () => {
  console.log('Fetching scenes from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        scenes: [
          { 
            _id: '1', 
            name: 'Movie Night', 
            description: 'Dim lights and set cozy atmosphere',
            devices: ['1', '2', '3'],
            active: false
          },
          { 
            _id: '2', 
            name: 'Good Morning', 
            description: 'Turn on lights and adjust temperature',
            devices: ['1', '2', '5'],
            active: false
          },
          { 
            _id: '3', 
            name: 'Good Night', 
            description: 'Turn off all lights and lock doors',
            devices: ['1', '2', '3', '4', '8'],
            active: false
          },
          { 
            _id: '4', 
            name: 'Away Mode', 
            description: 'Security mode when leaving home',
            devices: ['4', '8', '6'],
            active: false
          },
          { 
            _id: '5', 
            name: 'Romantic Dinner', 
            description: 'Soft lighting for special occasions',
            devices: ['1', '2'],
            active: false
          }
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/scenes');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Activate a scene
// Endpoint: POST /api/scenes/activate
// Request: { sceneId: string }
// Response: { success: boolean, message: string }
export const activateScene = (data: { sceneId: string }) => {
  console.log('Activating scene:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ success: true, message: 'Scene activated successfully' });
    }, 800);
  });
  // try {
  //   return await api.post('/api/scenes/activate', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Create a new scene
// Endpoint: POST /api/scenes
// Request: { name: string, description: string, devices: Array<string> }
// Response: { success: boolean, scene: object }
export const createScene = (data: { name: string; description: string; devices: Array<string> }) => {
  console.log('Creating scene:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ 
        success: true, 
        scene: { 
          _id: Date.now().toString(), 
          ...data, 
          active: false 
        } 
      });
    }, 600);
  });
  // try {
  //   return await api.post('/api/scenes', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}