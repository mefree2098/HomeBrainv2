import api from './api';

// Description: Get security alarm system information
// Endpoint: GET /api/security-alarm
// Request: {}
// Response: { success: boolean, alarm: { _id: string, name: string, alarmState: string, zones: Array, lastArmed: string, lastDisarmed: string, armedBy: string, disarmedBy: string, isOnline: boolean } }
export const getSecurityAlarm = async () => {
  try {
    const response = await api.get('/api/security-alarm');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Get security alarm status
// Endpoint: GET /api/security-alarm/status
// Request: {}
// Response: { success: boolean, status: { alarmState: string, isArmed: boolean, isTriggered: boolean, lastArmed: string, lastDisarmed: string, zoneCount: number, activeZones: number, isOnline: boolean } }
export const getSecurityStatus = async () => {
  try {
    const response = await api.get('/api/security-alarm/status');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Arm the security system
// Endpoint: POST /api/security-alarm/arm
// Request: { mode: 'stay' | 'away' }
// Response: { success: boolean, message: string, alarm: { _id: string, alarmState: string } }
export const armSecuritySystem = async (mode: 'stay' | 'away') => {
  try {
    const response = await api.post('/api/security-alarm/arm', { mode });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Disarm the security system
// Endpoint: POST /api/security-alarm/disarm
// Request: {}
// Response: { success: boolean, message: string, alarm: { _id: string, alarmState: string } }
export const disarmSecuritySystem = async () => {
  try {
    const response = await api.post('/api/security-alarm/disarm');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Add a security zone
// Endpoint: POST /api/security-alarm/zones
// Request: { name: string, deviceId: string, deviceType: string, enabled?: boolean, bypassable?: boolean }
// Response: { success: boolean, message: string, alarm: { _id: string, zones: Array } }
export const addSecurityZone = async (zoneData: {
  name: string;
  deviceId: string;
  deviceType: string;
  enabled?: boolean;
  bypassable?: boolean;
}) => {
  try {
    const response = await api.post('/api/security-alarm/zones', zoneData);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Remove a security zone
// Endpoint: DELETE /api/security-alarm/zones/:deviceId
// Request: {}
// Response: { success: boolean, message: string, alarm: { _id: string, zones: Array } }
export const removeSecurityZone = async (deviceId: string) => {
  try {
    const response = await api.delete(`/api/security-alarm/zones/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Bypass or unbypass a security zone
// Endpoint: PUT /api/security-alarm/zones/:deviceId/bypass
// Request: { bypass: boolean }
// Response: { success: boolean, message: string, alarm: { _id: string, zones: Array } }
export const bypassSecurityZone = async (deviceId: string, bypass: boolean) => {
  try {
    const response = await api.put(`/api/security-alarm/zones/${deviceId}/bypass`, { bypass });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Sync alarm status with SmartThings
// Endpoint: POST /api/security-alarm/sync
// Request: {}
// Response: { success: boolean, message: string, alarm: { _id: string, alarmState: string, isOnline: boolean } }
export const syncSecurityWithSmartThings = async () => {
  try {
    const response = await api.post('/api/security-alarm/sync');
    return response.data;
  } catch (error) {
    console.error(error);
    // Handle specific SmartThings configuration errors
    if (error?.response?.status === 400 && error?.response?.data?.message === 'SmartThings token not configured') {
      throw new Error('SmartThings token not configured');
    }
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Configure SmartThings integration
// Endpoint: PUT /api/security-alarm/configure
// Request: { smartthingsDeviceId: string }
// Response: { success: boolean, message: string, alarm: { _id: string, smartthingsDeviceId: string } }
export const configureSmartThingsIntegration = async (smartthingsDeviceId: string) => {
  try {
    const response = await api.put('/api/security-alarm/configure', { smartthingsDeviceId });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};