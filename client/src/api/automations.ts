import api from './api';

// Description: Get all automations
// Endpoint: GET /api/automations
// Request: {}
// Response: { automations: Array<{ _id: string, name: string, description: string, trigger: string, actions: Array<any>, enabled: boolean, lastRun?: string }> }
export const getAutomations = () => {
  console.log('Fetching automations from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        automations: [
          {
            _id: '1',
            name: 'Morning Routine',
            description: 'Turn on lights and adjust temperature at 7 AM',
            trigger: 'time:07:00',
            actions: ['turn_on_lights', 'set_temperature'],
            enabled: true,
            lastRun: '2024-01-15T07:00:00Z'
          },
          {
            _id: '2',
            name: 'Evening Security',
            description: 'Lock doors and turn on porch light at sunset',
            trigger: 'sunset',
            actions: ['lock_doors', 'turn_on_porch_light'],
            enabled: true,
            lastRun: '2024-01-14T18:30:00Z'
          },
          {
            _id: '3',
            name: 'Motion Detection',
            description: 'Turn on hallway light when motion detected',
            trigger: 'motion:hallway',
            actions: ['turn_on_hallway_light'],
            enabled: true,
            lastRun: '2024-01-15T02:15:00Z'
          },
          {
            _id: '4',
            name: 'Energy Saver',
            description: 'Turn off all lights when no one is home',
            trigger: 'presence:away',
            actions: ['turn_off_all_lights'],
            enabled: false,
            lastRun: null
          }
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/automations');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Create automation from natural language
// Endpoint: POST /api/automations/create-from-text
// Request: { text: string }
// Response: { success: boolean, automation: object }
export const createAutomationFromText = (data: { text: string }) => {
  console.log('Creating automation from text:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        success: true,
        automation: {
          _id: Date.now().toString(),
          name: 'Custom Automation',
          description: data.text,
          trigger: 'custom',
          actions: ['custom_action'],
          enabled: true,
          lastRun: null
        }
      });
    }, 1000);
  });
  // try {
  //   return await api.post('/api/automations/create-from-text', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Toggle automation enabled status
// Endpoint: PUT /api/automations/toggle
// Request: { automationId: string, enabled: boolean }
// Response: { success: boolean, message: string }
export const toggleAutomation = (data: { automationId: string; enabled: boolean }) => {
  console.log('Toggling automation:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ success: true, message: 'Automation toggled successfully' });
    }, 300);
  });
  // try {
  //   return await api.put('/api/automations/toggle', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}