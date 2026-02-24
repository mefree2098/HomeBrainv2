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

// ===== REMOTE UPDATE ENDPOINTS =====

// Description: Get current remote device software version
// Endpoint: GET /api/remote-updates/version
// Request: {}
// Response: { success: boolean, version: string }
export const getRemoteDeviceVersion = async () => {
  console.log('Fetching remote device version');
  try {
    const response = await api.get('/api/remote-updates/version');
    return response.data;
  } catch (error) {
    console.error('Error fetching remote device version:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Check for updates for a specific device
// Endpoint: GET /api/remote-updates/check/:deviceId
// Request: {}
// Response: { success: boolean, updateAvailable: boolean, currentVersion: string, latestVersion: string, deviceName: string }
export const checkDeviceForUpdates = async (deviceId: string) => {
  console.log('Checking for updates for device:', deviceId);
  try {
    const response = await api.get(`/api/remote-updates/check/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error checking for updates:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Generate update package
// Endpoint: POST /api/remote-updates/generate-package
// Request: {}
// Response: { success: boolean, version: string, packageName: string, checksum: string }
export const generateUpdatePackage = async () => {
  console.log('Generating update package');
  try {
    const response = await api.post('/api/remote-updates/generate-package');
    return response.data;
  } catch (error) {
    console.error('Error generating update package:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get update package information
// Endpoint: GET /api/remote-updates/package-info
// Request: {}
// Response: { success: boolean, version?: string, packageName?: string, size?: number, checksum?: string, downloadUrl?: string }
export const getUpdatePackageInfo = async () => {
  console.log('Fetching update package information');
  try {
    const response = await api.get('/api/remote-updates/package-info');
    return response.data;
  } catch (error) {
    console.error('Error fetching update package info:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Initiate update for a specific device
// Endpoint: POST /api/remote-updates/initiate/:deviceId
// Request: {}
// Response: { success: boolean, device: string, version: string, message: string }
export const initiateDeviceUpdate = async (deviceId: string) => {
  console.log('Initiating update for device:', deviceId);
  try {
    const response = await api.post(`/api/remote-updates/initiate/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error initiating device update:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Initiate update for all devices
// Endpoint: POST /api/remote-updates/initiate-all
// Request: {}
// Response: { success: boolean, totalDevices: number, initiated: number, failed: number, results: Array }
export const initiateUpdateForAllDevices = async () => {
  console.log('Initiating update for all devices');
  try {
    const response = await api.post('/api/remote-updates/initiate-all');
    return response.data;
  } catch (error) {
    console.error('Error initiating update for all devices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const initiateUpdateForAllDevicesWithOptions = async (options?: {
  force?: boolean;
  onlyOutdated?: boolean;
}) => {
  console.log('Initiating update for all devices with options:', options);
  try {
    const response = await api.post('/api/remote-updates/initiate-all', options || {});
    return response.data;
  } catch (error) {
    console.error('Error initiating update for all devices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get update statistics
// Endpoint: GET /api/remote-updates/statistics
// Request: {}
// Response: { success: boolean, totalDevices: number, currentVersion: string, upToDate: number, outdated: number, updating: number, offline: number, byVersion: object }
export const getUpdateStatistics = async () => {
  console.log('Fetching update statistics');
  try {
    const response = await api.get('/api/remote-updates/statistics');
    return response.data;
  } catch (error) {
    console.error('Error fetching update statistics:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get list of devices needing update
// Endpoint: GET /api/remote-updates/devices-needing-update
// Request: {}
// Response: { success: boolean, devices: Array<{ id, name, room, currentVersion, latestVersion, status, lastSeen }> }
export const getDevicesNeedingUpdate = async () => {
  console.log('Fetching devices needing update');
  try {
    const response = await api.get('/api/remote-updates/devices-needing-update');
    return response.data;
  } catch (error) {
    console.error('Error fetching devices needing update:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const getRemoteFleetStatus = async () => {
  console.log('Fetching remote update fleet status');
  try {
    const response = await api.get('/api/remote-updates/fleet-status');
    return response.data;
  } catch (error) {
    console.error('Error fetching remote fleet status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};
