import api from './api';

export interface InsteonIsyImportPayload {
  deviceIds?: string[] | string;
  addresses?: string[];
  devices?: Array<{ address?: string; id?: string; deviceId?: string; insteonAddress?: string; name?: string; displayName?: string } | string>;
  rawDeviceList?: string;
  rawList?: string;
  text?: string;
  isyDeviceList?: string;
  group?: number;
  linkGroup?: number;
  linkMode?: 'remote' | 'manual';
  perDeviceTimeoutMs?: number;
  timeoutMs?: number;
  pauseBetweenMs?: number;
  pauseBetweenLinksMs?: number;
  retries?: number;
  linkRetries?: number;
  skipLinking?: boolean;
  importOnly?: boolean;
  checkExistingLinks?: boolean;
}

export interface InsteonIsyConnectionPayload {
  connection?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    useHttps?: boolean;
    ignoreTlsErrors?: boolean;
  };
  isyHost?: string;
  isyPort?: number;
  isyUsername?: string;
  isyPassword?: string;
  isyUseHttps?: boolean;
  isyIgnoreTlsErrors?: boolean;
}

export interface InsteonIsyTopologyPayload {
  scenes?: Array<{
    name?: string;
    scene?: string;
    group?: number;
    sceneGroup?: number;
    controller?: string | { address?: string; id?: string; deviceId?: string; insteonAddress?: string };
    controllerId?: string;
    source?: string;
    responders?: Array<string | {
      id?: string;
      address?: string;
      deviceId?: string;
      insteonAddress?: string;
      name?: string;
      displayName?: string;
      level?: number;
      ramp?: number;
      data?: Array<string | number>;
    }>;
    members?: Array<string | Record<string, unknown>>;
    devices?: Array<string | Record<string, unknown>>;
    remove?: boolean;
  }>;
  linkRecords?: Array<{
    controller?: string;
    controllerId?: string;
    source?: string;
    responder?: string | Record<string, unknown>;
    target?: string | Record<string, unknown>;
    device?: string | Record<string, unknown>;
    deviceId?: string;
    group?: number;
    sceneGroup?: number;
    scene?: string;
    sceneName?: string;
    remove?: boolean;
  }>;
  topology?: { scenes?: Array<Record<string, unknown>> };
  dryRun?: boolean;
  pauseBetweenScenesMs?: number;
  pauseBetweenMs?: number;
  sceneTimeoutMs?: number;
  timeoutMs?: number;
  continueOnError?: boolean;
  upsertDevices?: boolean;
}

export interface InsteonIsySyncPayload extends InsteonIsyConnectionPayload {
  dryRun?: boolean;
  importDevices?: boolean;
  importTopology?: boolean;
  importPrograms?: boolean;
  enableProgramWorkflows?: boolean;
  continueOnError?: boolean;
  linkMode?: 'remote' | 'manual';
  group?: number;
  retries?: number;
  perDeviceTimeoutMs?: number;
  pauseBetweenMs?: number;
  checkExistingLinks?: boolean;
  skipLinking?: boolean;
  sceneTimeoutMs?: number;
  pauseBetweenScenesMs?: number;
}

export interface InsteonIsySyncRunLogEntry {
  timestamp?: string;
  message?: string;
  stage?: string | null;
  level?: 'info' | 'warn' | 'error';
  progress?: number | null;
}

export interface InsteonIsySyncRunSnapshot {
  id: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  request?: {
    dryRun?: boolean;
    importDevices?: boolean;
    importTopology?: boolean;
    importPrograms?: boolean;
    enableProgramWorkflows?: boolean;
    continueOnError?: boolean;
    linkMode?: 'remote' | 'manual';
  };
  logs?: InsteonIsySyncRunLogEntry[];
  result?: any;
  error?: string | null;
}

export interface InsteonLinkedDeviceStatusEntry {
  address?: string | null;
  displayAddress?: string;
  name?: string;
  databaseDeviceId?: string | null;
  group?: number | null;
  controller?: boolean;
  reachable?: boolean;
  isOnline?: boolean;
  status?: boolean | null;
  level?: number | null;
  brightness?: number | null;
  respondedVia?: 'level' | 'ping' | 'info' | 'none';
  error?: string | null;
  deviceInfo?: {
    firmwareVersion?: string | number | null;
    deviceCategory?: number | null;
    subcategory?: number | null;
  } | null;
}

export interface InsteonLinkedDeviceStatusResponse {
  success: boolean;
  message?: string;
  scannedAt?: string;
  plmInfo?: Record<string, unknown>;
  summary?: {
    linkedDevices?: number;
    reachable?: number;
    unreachable?: number;
    statusKnown?: number;
    statusUnknown?: number;
  };
  warnings?: string[];
  devices?: InsteonLinkedDeviceStatusEntry[];
}

export interface InsteonLinkedStatusQueryPayload {
  levelTimeoutMs?: number;
  pingTimeoutMs?: number;
  infoTimeoutMs?: number;
  pauseBetweenMs?: number;
}

export interface InsteonLinkedStatusRunSnapshot {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  request?: InsteonLinkedStatusQueryPayload;
  cancelRequested?: boolean;
  logs?: InsteonIsySyncRunLogEntry[];
  result?: InsteonLinkedDeviceStatusResponse | null;
  error?: string | null;
}

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

// Description: List local serial ports available for USB PLM setup
// Endpoint: GET /api/insteon/serial-ports
// Request: {}
// Response: { success: boolean, count: number, ports: Array<object> }
export const getInsteonSerialPorts = async () => {
  try {
    const response = await api.get('/api/insteon/serial-ports');
    return response.data;
  } catch (error) {
    console.error('Get Insteon serial ports error:', error);
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

// Description: Query all PLM-linked devices and return live reachability/status details
// Endpoint: GET /api/insteon/devices/linked/status
// Request: {}
// Response: InsteonLinkedDeviceStatusResponse
export const queryLinkedInsteonDeviceStatus = async (
  params?: InsteonLinkedStatusQueryPayload
): Promise<InsteonLinkedDeviceStatusResponse> => {
  try {
    const response = await api.get('/api/insteon/devices/linked/status', {
      params: params || {}
    });
    return response.data;
  } catch (error) {
    console.error('Query linked Insteon device status error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Start asynchronous linked-device status query and return a run id for live polling
// Endpoint: POST /api/insteon/devices/linked/status/start
// Request: InsteonLinkedStatusQueryPayload
// Response: { success: boolean, runId: string, run: InsteonLinkedStatusRunSnapshot }
export const startInsteonLinkedStatusRun = async (payload: InsteonLinkedStatusQueryPayload = {}) => {
  try {
    const response = await api.post('/api/insteon/devices/linked/status/start', payload || {});
    return response.data as { success: boolean; runId: string; run: InsteonLinkedStatusRunSnapshot };
  } catch (error) {
    console.error('Start linked status run error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Fetch asynchronous linked-device status query run status/logs/result
// Endpoint: GET /api/insteon/devices/linked/status/runs/:runId
// Request: {}
// Response: { success: boolean, run: InsteonLinkedStatusRunSnapshot }
export const getInsteonLinkedStatusRun = async (runId: string) => {
  try {
    const response = await api.get(`/api/insteon/devices/linked/status/runs/${encodeURIComponent(runId)}`);
    return response.data as { success: boolean; run: InsteonLinkedStatusRunSnapshot };
  } catch (error) {
    console.error('Get linked status run error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Request cancellation for an asynchronous linked-device status query run
// Endpoint: POST /api/insteon/devices/linked/status/runs/:runId/cancel
// Request: {}
// Response: { success: boolean, message: string, run: InsteonLinkedStatusRunSnapshot }
export const cancelInsteonLinkedStatusRun = async (runId: string) => {
  try {
    const response = await api.post(`/api/insteon/devices/linked/status/runs/${encodeURIComponent(runId)}/cancel`);
    return response.data as { success: boolean; message?: string; run: InsteonLinkedStatusRunSnapshot };
  } catch (error) {
    console.error('Cancel linked status run error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Import all devices from PLM to database
// Endpoint: POST /api/insteon/devices/import
// Request: {} OR InsteonIsyImportPayload
// Response: { success: boolean, message: string, imported: number, skipped: number, errors: number, devices: Array<object> }
export const importInsteonDevices = async (payload?: InsteonIsyImportPayload) => {
  try {
    const response = await api.post('/api/insteon/devices/import', payload || {});
    return response.data;
  } catch (error) {
    console.error('Import Insteon devices error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Import ISY device IDs and link to the currently connected PLM
// Endpoint: POST /api/insteon/devices/import/isy
// Request: InsteonIsyImportPayload
// Response: { success: boolean, message: string, accepted: number, linked: number, alreadyLinked: number, imported: number, updated: number, failed: number, devices: Array<object> }
export const importInsteonDevicesFromISY = async (payload: InsteonIsyImportPayload) => {
  try {
    const response = await api.post('/api/insteon/devices/import/isy', payload || {});
    return response.data;
  } catch (error) {
    console.error('Import ISY Insteon devices error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Recreate ISY scene/link topology on the connected PLM
// Endpoint: POST /api/insteon/devices/import/isy/topology
// Request: InsteonIsyTopologyPayload
// Response: { success: boolean, dryRun: boolean, sceneCount: number, plannedLinkOperations: number, appliedScenes: number, failedScenes: number, imported: number, updated: number, scenes: Array<object> }
export const syncInsteonISYTopology = async (payload: InsteonIsyTopologyPayload) => {
  try {
    const response = await api.post('/api/insteon/devices/import/isy/topology', payload || {});
    return response.data;
  } catch (error) {
    console.error('Sync ISY Insteon topology error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Test direct ISY REST API connectivity
// Endpoint: POST /api/insteon/isy/test
// Request: InsteonIsyConnectionPayload
export const testInsteonISYConnection = async (payload: InsteonIsyConnectionPayload = {}) => {
  try {
    const response = await api.post('/api/insteon/isy/test', payload || {});
    return response.data;
  } catch (error) {
    console.error('Test ISY connection error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Extract ISY device/group/program metadata
// Endpoint: POST /api/insteon/isy/extract
// Request: InsteonIsyConnectionPayload
export const extractInsteonISYData = async (payload: InsteonIsyConnectionPayload = {}) => {
  try {
    const response = await api.post('/api/insteon/isy/extract', payload || {});
    return response.data;
  } catch (error) {
    console.error('Extract ISY data error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Run end-to-end ISY extraction + import/sync workflow
// Endpoint: POST /api/insteon/isy/sync
// Request: InsteonIsySyncPayload
export const syncInsteonFromISY = async (payload: InsteonIsySyncPayload = {}) => {
  try {
    const response = await api.post('/api/insteon/isy/sync', payload || {});
    return response.data;
  } catch (error) {
    console.error('Sync from ISY error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Start asynchronous ISY sync run and return a run id for live polling
// Endpoint: POST /api/insteon/isy/sync/start
// Request: InsteonIsySyncPayload
// Response: { success: boolean, runId: string, run: InsteonIsySyncRunSnapshot }
export const startInsteonIsySyncRun = async (payload: InsteonIsySyncPayload = {}) => {
  try {
    const response = await api.post('/api/insteon/isy/sync/start', payload || {});
    return response.data as { success: boolean; runId: string; run: InsteonIsySyncRunSnapshot };
  } catch (error) {
    console.error('Start ISY sync run error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Fetch asynchronous ISY sync run status/logs/result
// Endpoint: GET /api/insteon/isy/sync/runs/:runId
// Request: {}
// Response: { success: boolean, run: InsteonIsySyncRunSnapshot }
export const getInsteonIsySyncRun = async (runId: string) => {
  try {
    const response = await api.get(`/api/insteon/isy/sync/runs/${encodeURIComponent(runId)}`);
    return response.data as { success: boolean; run: InsteonIsySyncRunSnapshot };
  } catch (error) {
    console.error('Get ISY sync run error:', error);
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
