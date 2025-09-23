import api from './api';

// Description: Register a new remote device
// Endpoint: POST /api/remote-devices/register
// Request: { name: string, room: string, deviceType?: string, macAddress?: string }
// Response: { success: boolean, device: object, registrationCode: string, message: string }
export const registerRemoteDevice = async (data: {
  name: string;
  room: string;
  deviceType?: string;
  macAddress?: string;
}) => {
  console.log('Registering remote device:', data);
  try {
    const response = await api.post('/api/remote-devices/register', data);
    return response.data;
  } catch (error) {
    console.error('Error registering remote device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Activate device with registration code
// Endpoint: POST /api/remote-devices/activate
// Request: { registrationCode: string, ipAddress?: string, firmwareVersion?: string }
// Response: { success: boolean, device: object, hubUrl: string, message: string }
export const activateRemoteDevice = async (data: {
  registrationCode: string;
  ipAddress?: string;
  firmwareVersion?: string;
}) => {
  console.log('Activating remote device:', data);
  try {
    const response = await api.post('/api/remote-devices/activate', data);
    return response.data;
  } catch (error) {
    console.error('Error activating remote device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get device configuration by device ID
// Endpoint: GET /api/remote-devices/:deviceId/config
// Request: {}
// Response: { success: boolean, device: object, config: object }
export const getRemoteDeviceConfig = async (deviceId: string) => {
  console.log('Fetching remote device config:', deviceId);
  try {
    const response = await api.get(`/api/remote-devices/${deviceId}/config`);
    return response.data;
  } catch (error) {
    console.error('Error fetching remote device config:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Update device heartbeat and status
// Endpoint: POST /api/remote-devices/:deviceId/heartbeat
// Request: { status?: string, batteryLevel?: number, uptime?: number, lastInteraction?: string }
// Response: { success: boolean, message: string }
export const updateRemoteDeviceHeartbeat = async (
  deviceId: string,
  data: {
    status?: string;
    batteryLevel?: number;
    uptime?: number;
    lastInteraction?: string;
  }
) => {
  console.log('Updating remote device heartbeat:', deviceId, data);
  try {
    const response = await api.post(`/api/remote-devices/${deviceId}/heartbeat`, data);
    return response.data;
  } catch (error) {
    console.error('Error updating remote device heartbeat:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get setup instructions for remote devices
// Endpoint: GET /api/remote-devices/setup-instructions
// Request: {}
// Response: { success: boolean, instructions: object }
export const getRemoteDeviceSetupInstructions = async () => {
  console.log('Fetching remote device setup instructions');
  try {
    const response = await api.get('/api/remote-devices/setup-instructions');
    return response.data;
  } catch (error) {
    console.error('Error fetching setup instructions:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Delete/unregister a remote device
// Endpoint: DELETE /api/remote-devices/:deviceId
// Request: {}
// Response: { success: boolean, message: string }
export const deleteRemoteDevice = async (deviceId: string) => {
  console.log('Deleting remote device:', deviceId);
  try {
    const response = await api.delete(`/api/remote-devices/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error deleting remote device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};