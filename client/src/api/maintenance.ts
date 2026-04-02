import api from './api';
import type { InsteonStatusResponse } from './insteon';

export interface InsteonMaintenanceSyncResponse {
  success?: boolean;
  message?: string;
  deviceCount?: number;
  linkedDeviceCount?: number;
  created?: number;
  updated?: number;
  failed?: number;
  warnings?: string[];
  errors?: Array<{
    address?: string | null;
    error?: string;
  }>;
  diagnostics?: string[];
  plmInfo?: {
    deviceId?: string;
    firmwareVersion?: string | number;
    deviceCategory?: string | number;
    subcategory?: string | number;
  };
  runtimeStatus?: InsteonStatusResponse | null;
}

// Description: Clear all fake/demo data from the system
// Endpoint: DELETE /api/maintenance/fake-data
// Request: {}
// Response: { success: boolean, message: string, results: { devices: number, scenes: number, automations: number, voiceDevices: number, userProfiles: number, voiceCommands: number, securityAlarms: number } }
export const clearAllFakeData = async () => {
  try {
    const response = await api.delete('/api/maintenance/fake-data');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Inject fake/demo data into the system
// Endpoint: POST /api/maintenance/fake-data
// Request: {}
// Response: { success: boolean, message: string, results: { devices: number, scenes: number, automations: number, voiceDevices: number, userProfiles: number } }
export const injectFakeData = async () => {
  try {
    const response = await api.post('/api/maintenance/fake-data');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Force re-sync all devices from SmartThings
// Endpoint: POST /api/maintenance/sync/smartthings
// Request: {}
// Response: { success: boolean, message: string, deviceCount: number, error?: string }
export const forceSmartThingsSync = async () => {
  try {
    const response = await api.post('/api/maintenance/sync/smartthings');
    return response.data;
  } catch (error) {
    console.error(error);
    // Handle both 400 (not configured) and 500 (other errors) responses
    const errorMessage = error?.response?.data?.message || error?.response?.data?.error || error.message;
    throw new Error(errorMessage);
  }
};

// Description: Force re-sync all devices from INSTEON
// Endpoint: POST /api/maintenance/sync/insteon
// Request: {}
// Response: { success: boolean, message: string, deviceCount: number }
export const forceInsteonSync = async () => {
  try {
    const response = await api.post('/api/maintenance/sync/insteon');
    return response.data as InsteonMaintenanceSyncResponse;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Force re-sync all devices from Harmony
// Endpoint: POST /api/maintenance/sync/harmony
// Request: {}
// Response: { success: boolean, message: string, hubsFound: number, created: number, updated: number, removed: number }
export const forceHarmonySync = async () => {
  try {
    const response = await api.post('/api/maintenance/sync/harmony');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error?.response?.data?.message || error.message);
  }
};

// Description: Clear all SmartThings devices from local database
// Endpoint: DELETE /api/maintenance/devices/smartthings
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
export const clearSmartThingsDevices = async () => {
  try {
    const response = await api.delete('/api/maintenance/devices/smartthings');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Clear all INSTEON devices from local database
// Endpoint: DELETE /api/maintenance/devices/insteon
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
export const clearInsteonDevices = async () => {
  try {
    const response = await api.delete('/api/maintenance/devices/insteon');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Clear all Harmony devices from local database
// Endpoint: DELETE /api/maintenance/devices/harmony
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
export const clearHarmonyDevices = async () => {
  try {
    const response = await api.delete('/api/maintenance/devices/harmony');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error?.response?.data?.message || error.message);
  }
};

// Description: Reset all settings to default values
// Endpoint: POST /api/maintenance/reset/settings
// Request: {}
// Response: { success: boolean, message: string }
export const resetSettingsToDefaults = async () => {
  try {
    const response = await api.post('/api/maintenance/reset/settings');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Clear SmartThings integration configuration
// Endpoint: DELETE /api/maintenance/integrations/smartthings
// Request: {}
// Response: { success: boolean, message: string }
export const clearSmartThingsIntegration = async () => {
  try {
    const response = await api.delete('/api/maintenance/integrations/smartthings');
    return response.data;
  } catch (error) {
    console.error(error);
    const errorMessage = error?.response?.data?.message || error?.response?.data?.error || error.message;
    throw new Error(errorMessage);
  }
};

// Description: Clear all voice command history
// Endpoint: DELETE /api/maintenance/voice-commands
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
export const clearVoiceCommandHistory = async () => {
  try {
    const response = await api.delete('/api/maintenance/voice-commands');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Perform system health check
// Endpoint: GET /api/maintenance/health
// Request: {}
// Response: { success: boolean, message: string, health: Object }
export const performHealthCheck = async () => {
  try {
    const response = await api.get('/api/maintenance/health');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Export system configuration
// Endpoint: GET /api/maintenance/export
// Request: {}
// Response: { success: boolean, message: string, config: Object }
export const exportConfiguration = async () => {
  try {
    const response = await api.get('/api/maintenance/export');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};
