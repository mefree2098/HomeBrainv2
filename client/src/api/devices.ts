import api from './api';

// Description: Get all smart home devices
// Endpoint: GET /api/devices
// Request: {}
// Response: { devices: Array<{ _id: string, name: string, type: string, room: string, status: boolean, brightness?: number, temperature?: number }> }
export const getDevices = () => {
  console.log('Fetching devices from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        devices: [
          { _id: '1', name: 'Living Room Lights', type: 'light', room: 'Living Room', status: true, brightness: 75 },
          { _id: '2', name: 'Kitchen Lights', type: 'light', room: 'Kitchen', status: false, brightness: 0 },
          { _id: '3', name: 'Bedroom Lights', type: 'light', room: 'Bedroom', status: true, brightness: 50 },
          { _id: '4', name: 'Front Door Lock', type: 'lock', room: 'Entrance', status: true },
          { _id: '5', name: 'Thermostat', type: 'thermostat', room: 'Living Room', status: true, temperature: 72 },
          { _id: '6', name: 'Garage Door', type: 'garage', room: 'Garage', status: false },
          { _id: '7', name: 'Porch Light', type: 'light', room: 'Porch', status: false, brightness: 0 },
          { _id: '8', name: 'Back Door Lock', type: 'lock', room: 'Back Door', status: true },
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/devices');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Control a device
// Endpoint: POST /api/devices/control
// Request: { deviceId: string, action: string, value?: number }
// Response: { success: boolean, message: string }
export const controlDevice = (data: { deviceId: string; action: string; value?: number }) => {
  console.log('Controlling device:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ success: true, message: 'Device controlled successfully' });
    }, 300);
  });
  // try {
  //   return await api.post('/api/devices/control', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Get devices grouped by room
// Endpoint: GET /api/devices/by-room
// Request: {}
// Response: { rooms: Array<{ name: string, devices: Array<Device> }> }
export const getDevicesByRoom = () => {
  console.log('Fetching devices by room from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        rooms: [
          {
            name: 'Living Room',
            devices: [
              { _id: '1', name: 'Living Room Lights', type: 'light', status: true, brightness: 75 },
              { _id: '5', name: 'Thermostat', type: 'thermostat', status: true, temperature: 72 }
            ]
          },
          {
            name: 'Kitchen',
            devices: [
              { _id: '2', name: 'Kitchen Lights', type: 'light', status: false, brightness: 0 }
            ]
          },
          {
            name: 'Bedroom',
            devices: [
              { _id: '3', name: 'Bedroom Lights', type: 'light', status: true, brightness: 50 }
            ]
          },
          {
            name: 'Entrance',
            devices: [
              { _id: '4', name: 'Front Door Lock', type: 'lock', status: true }
            ]
          }
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/devices/by-room');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}