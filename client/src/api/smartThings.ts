import api from './api';

// Description: Get SmartThings integration status
// Endpoint: GET /api/smartthings/status
// Request: {}
// Response: { success: boolean, integration: Object }
export const getSmartThingsStatus = async () => {
  try {
    const response = await api.get('/api/smartthings/status');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Configure SmartThings OAuth settings
// Endpoint: POST /api/smartthings/configure
// Request: { clientId: string, clientSecret: string, redirectUri?: string }
// Response: { success: boolean, message: string }
export const configureSmartThingsOAuth = async (config: {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}) => {
  try {
    const response = await api.post('/api/smartthings/configure', config);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get OAuth authorization URL
// Endpoint: GET /api/smartthings/auth/url
// Request: {}
// Response: { success: boolean, authUrl: string }
export const getSmartThingsAuthUrl = async () => {
  try {
    const response = await api.get('/api/smartthings/auth/url');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Test SmartThings connection
// Endpoint: POST /api/smartthings/test
// Request: {}
// Response: { success: boolean, message: string, deviceCount?: number }
export const testSmartThingsConnection = async () => {
  try {
    const response = await api.post('/api/smartthings/test');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Disconnect SmartThings integration
// Endpoint: POST /api/smartthings/disconnect
// Request: {}
// Response: { success: boolean, message: string }
export const disconnectSmartThings = async () => {
  try {
    const response = await api.post('/api/smartthings/disconnect');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get all SmartThings devices
// Endpoint: GET /api/smartthings/devices
// Request: {}
// Response: { success: boolean, devices: Array }
export const getSmartThingsDevices = async () => {
  try {
    const response = await api.get('/api/smartthings/devices');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get specific SmartThings device
// Endpoint: GET /api/smartthings/devices/:deviceId
// Request: {}
// Response: { success: boolean, device: Object }
export const getSmartThingsDevice = async (deviceId: string) => {
  try {
    const response = await api.get(`/api/smartthings/devices/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get SmartThings device status
// Endpoint: GET /api/smartthings/devices/:deviceId/status
// Request: {}
// Response: { success: boolean, status: Object }
export const getSmartThingsDeviceStatus = async (deviceId: string) => {
  try {
    const response = await api.get(`/api/smartthings/devices/${deviceId}/status`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Send command to SmartThings device
// Endpoint: POST /api/smartthings/devices/:deviceId/commands
// Request: { commands: Array }
// Response: { success: boolean, result: Object }
export const sendSmartThingsDeviceCommand = async (
  deviceId: string,
  commands: Array<{
    component: string;
    capability: string;
    command: string;
    arguments?: any[];
  }>
) => {
  try {
    const response = await api.post(`/api/smartthings/devices/${deviceId}/commands`, {
      commands
    });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Turn SmartThings device on
// Endpoint: POST /api/smartthings/devices/:deviceId/on
// Request: {}
// Response: { success: boolean, result: Object }
export const turnSmartThingsDeviceOn = async (deviceId: string) => {
  try {
    const response = await api.post(`/api/smartthings/devices/${deviceId}/on`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Turn SmartThings device off
// Endpoint: POST /api/smartthings/devices/:deviceId/off
// Request: {}
// Response: { success: boolean, result: Object }
export const turnSmartThingsDeviceOff = async (deviceId: string) => {
  try {
    const response = await api.post(`/api/smartthings/devices/${deviceId}/off`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Set SmartThings device level
// Endpoint: POST /api/smartthings/devices/:deviceId/level
// Request: { level: number }
// Response: { success: boolean, result: Object }
export const setSmartThingsDeviceLevel = async (deviceId: string, level: number) => {
  try {
    const response = await api.post(`/api/smartthings/devices/${deviceId}/level`, { level });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get all SmartThings scenes
// Endpoint: GET /api/smartthings/scenes
// Request: {}
// Response: { success: boolean, scenes: Array }
export const getSmartThingsScenes = async () => {
  try {
    const response = await api.get('/api/smartthings/scenes');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Execute SmartThings scene
// Endpoint: POST /api/smartthings/scenes/:sceneId/execute
// Request: {}
// Response: { success: boolean, result: Object }
export const executeSmartThingsScene = async (sceneId: string) => {
  try {
    const response = await api.post(`/api/smartthings/scenes/${sceneId}/execute`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Configure STHM virtual switches
// Endpoint: POST /api/smartthings/sthm/configure
// Request: { armAwayDeviceId?: string, armStayDeviceId?: string, disarmDeviceId?: string }
// Response: { success: boolean, message: string }
export const configureSmartThingsSthm = async (config: {
  armAwayDeviceId?: string;
  armStayDeviceId?: string;
  disarmDeviceId?: string;
}) => {
  try {
    const response = await api.post('/api/smartthings/sthm/configure', config);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Arm STHM (Stay mode)
// Endpoint: POST /api/smartthings/sthm/arm-stay
// Request: {}
// Response: { success: boolean, result: Object }
export const armSmartThingsSthmStay = async () => {
  try {
    const response = await api.post('/api/smartthings/sthm/arm-stay');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Arm STHM (Away mode)
// Endpoint: POST /api/smartthings/sthm/arm-away
// Request: {}
// Response: { success: boolean, result: Object }
export const armSmartThingsSthmAway = async () => {
  try {
    const response = await api.post('/api/smartthings/sthm/arm-away');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Disarm STHM
// Endpoint: POST /api/smartthings/sthm/disarm
// Request: {}
// Response: { success: boolean, result: Object }
export const disarmSmartThingsSthm = async () => {
  try {
    const response = await api.post('/api/smartthings/sthm/disarm');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};