import api from './api';

// Description: Test Insteon PLM connection
// Endpoint: GET /api/insteon/test
// Request: {}
// Response: { success: boolean, message: string, connected: boolean, plmInfo?: object }
export const testInsteonConnection = async () => {
  try {
    const response = await api.get('/api/insteon/test');
    return response.data;
  } catch (error) {
    console.error('Insteon connection test error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get Insteon PLM information
// Endpoint: GET /api/insteon/info
// Request: {}
// Response: { success: boolean, plmInfo: object }
export const getInsteonPLMInfo = async () => {
  try {
    const response = await api.get('/api/insteon/info');
    return response.data;
  } catch (error) {
    console.error('Get Insteon PLM info error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get PLM connection status
// Endpoint: GET /api/insteon/status
// Request: {}
// Response: { connected: boolean, deviceCount: number, connectionAttempts: number }
export const getInsteonStatus = async () => {
  try {
    const response = await api.get('/api/insteon/status');
    return response.data;
  } catch (error) {
    console.error('Get Insteon status error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Connect to Insteon PLM
// Endpoint: POST /api/insteon/connect
// Request: {}
// Response: { success: boolean, message: string, port: string }
export const connectToInsteonPLM = async () => {
  try {
    const response = await api.post('/api/insteon/connect');
    return response.data;
  } catch (error) {
    console.error('Connect to Insteon PLM error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Disconnect from Insteon PLM
// Endpoint: POST /api/insteon/disconnect
// Request: {}
// Response: { success: boolean, message: string }
export const disconnectFromInsteonPLM = async () => {
  try {
    const response = await api.post('/api/insteon/disconnect');
    return response.data;
  } catch (error) {
    console.error('Disconnect from Insteon PLM error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get all devices linked to PLM
// Endpoint: GET /api/insteon/devices/linked
// Request: {}
// Response: { success: boolean, devices: Array<object> }
export const getLinkedInsteonDevices = async () => {
  try {
    const response = await api.get('/api/insteon/devices/linked');
    return response.data;
  } catch (error) {
    console.error('Get linked Insteon devices error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Import all devices from PLM to database
// Endpoint: POST /api/insteon/devices/import
// Request: {}
// Response: { success: boolean, message: string, imported: number, skipped: number, errors: number, devices: Array<object> }
export const importInsteonDevices = async () => {
  try {
    const response = await api.post('/api/insteon/devices/import');
    return response.data;
  } catch (error) {
    console.error('Import Insteon devices error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Scan all Insteon devices and update their status
// Endpoint: POST /api/insteon/devices/scan
// Request: {}
// Response: { success: boolean, message: string, results: object }
export const scanInsteonDevices = async () => {
  try {
    const response = await api.post('/api/insteon/devices/scan');
    return response.data;
  } catch (error) {
    console.error('Scan Insteon devices error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get specific device status from PLM
// Endpoint: GET /api/insteon/devices/:deviceId/status
// Request: { deviceId: string }
// Response: { success: boolean, status: boolean, brightness: number, level: number, isOnline: boolean }
export const getInsteonDeviceStatus = async (deviceId: string) => {
  try {
    const response = await api.get(`/api/insteon/devices/${deviceId}/status`);
    return response.data;
  } catch (error) {
    console.error('Get Insteon device status error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Turn Insteon device on
// Endpoint: POST /api/insteon/devices/:deviceId/on
// Request: { deviceId: string, brightness?: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
export const turnInsteonDeviceOn = async (deviceId: string, brightness?: number) => {
  try {
    const response = await api.post(`/api/insteon/devices/${deviceId}/on`, { brightness });
    return response.data;
  } catch (error) {
    console.error('Turn Insteon device on error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Turn Insteon device off
// Endpoint: POST /api/insteon/devices/:deviceId/off
// Request: { deviceId: string }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
export const turnInsteonDeviceOff = async (deviceId: string) => {
  try {
    const response = await api.post(`/api/insteon/devices/${deviceId}/off`);
    return response.data;
  } catch (error) {
    console.error('Turn Insteon device off error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Set Insteon device brightness
// Endpoint: POST /api/insteon/devices/:deviceId/brightness
// Request: { deviceId: string, brightness: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
export const setInsteonDeviceBrightness = async (deviceId: string, brightness: number) => {
  try {
    const response = await api.post(`/api/insteon/devices/${deviceId}/brightness`, { brightness });
    return response.data;
  } catch (error) {
    console.error('Set Insteon device brightness error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Link new device to PLM
// Endpoint: POST /api/insteon/devices/link
// Request: { timeout?: number }
// Response: { success: boolean, message: string, address?: string, group?: number, type?: string }
export const linkInsteonDevice = async (timeout?: number) => {
  try {
    const response = await api.post('/api/insteon/devices/link', { timeout });
    return response.data;
  } catch (error) {
    console.error('Link Insteon device error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Unlink device from PLM and remove from database
// Endpoint: DELETE /api/insteon/devices/:deviceId/unlink
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
export const unlinkInsteonDevice = async (deviceId: string) => {
  try {
    const response = await api.delete(`/api/insteon/devices/${deviceId}/unlink`);
    return response.data;
  } catch (error) {
    console.error('Unlink Insteon device error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Delete device from database only (keep in PLM)
// Endpoint: DELETE /api/insteon/devices/:deviceId
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
export const deleteInsteonDevice = async (deviceId: string) => {
  try {
    const response = await api.delete(`/api/insteon/devices/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Delete Insteon device error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};
