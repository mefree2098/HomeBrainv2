import api from './api';

// Description: Get voice system status
// Endpoint: GET /api/voice/status
// Request: {}
// Response: { listening: boolean, connected: boolean, activeDevices: number }
export const getVoiceStatus = () => {
  console.log('Fetching voice status from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        listening: true,
        connected: true,
        activeDevices: 5
      });
    }, 200);
  });
  // try {
  //   return await api.get('/api/voice/status');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Get all voice devices
// Endpoint: GET /api/voice/devices
// Request: {}
// Response: { devices: Array<{ _id: string, name: string, room: string, status: string, lastSeen: string, batteryLevel?: number }> }
export const getVoiceDevices = () => {
  console.log('Fetching voice devices from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        devices: [
          {
            _id: '1',
            name: 'Living Room Voice Hub',
            room: 'Living Room',
            status: 'online',
            lastSeen: '2024-01-15T10:30:00Z',
            batteryLevel: null
          },
          {
            _id: '2',
            name: 'Kitchen Assistant',
            room: 'Kitchen',
            status: 'online',
            lastSeen: '2024-01-15T10:29:00Z',
            batteryLevel: 85
          },
          {
            _id: '3',
            name: 'Bedroom Speaker',
            room: 'Bedroom',
            status: 'online',
            lastSeen: '2024-01-15T10:28:00Z',
            batteryLevel: 92
          },
          {
            _id: '4',
            name: 'Office Hub',
            room: 'Office',
            status: 'offline',
            lastSeen: '2024-01-15T08:15:00Z',
            batteryLevel: 15
          },
          {
            _id: '5',
            name: 'Garage Monitor',
            room: 'Garage',
            status: 'online',
            lastSeen: '2024-01-15T10:25:00Z',
            batteryLevel: null
          }
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/voice/devices');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Test voice device
// Endpoint: POST /api/voice/test
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
export const testVoiceDevice = (data: { deviceId: string }) => {
  console.log('Testing voice device:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ success: true, message: 'Voice device test completed' });
    }, 2000);
  });
  // try {
  //   return await api.post('/api/voice/test', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}