import api from './api';
import type { InsteonIsySyncRunLogEntry, InsteonStatusResponse } from './insteon';

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

export interface InsteonMaintenanceSyncRunSnapshot {
  id: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  request?: {
    skipExisting?: boolean;
  };
  cancelRequested?: boolean;
  logs?: InsteonIsySyncRunLogEntry[];
  result?: InsteonMaintenanceSyncResponse | null;
  error?: string | null;
}

export interface DisasterRecoveryRestoreJob {
  id: string;
  status: 'queued' | 'validating' | 'restoring' | 'completed' | 'failed';
  actor?: string | null;
  archiveName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  phase?: string | null;
  message?: string | null;
  manifest?: {
    version?: number | null;
    createdAt?: string | null;
    appVersion?: string | null;
  } | null;
}

export interface DisasterRecoveryBackupJob {
  id: string;
  status: 'queued' | 'creating' | 'uploading' | 'completed' | 'failed';
  actor?: string | null;
  source?: 'manual' | 'scheduled' | string | null;
  archiveName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  phase?: string | null;
  message?: string | null;
  remoteTarget?: string | null;
  retention?: {
    keepCount?: number;
    matched?: number;
    kept?: string[];
    deleted?: string[];
    displayPath?: string;
  } | null;
  manifest?: {
    version?: number | null;
    createdAt?: string | null;
    appVersion?: string | null;
  } | null;
}

export interface SmbDisasterRecoveryBackupPayload {
  shareUrl?: string;
  remoteDirectory?: string;
  username?: string;
  password?: string;
  domain?: string;
  confirmBackup?: string;
  useSavedSettings?: boolean;
  retentionCount?: number;
}

export interface SmbBackupConnectionTestPayload {
  shareUrl?: string;
  remoteDirectory?: string;
  username?: string;
  password?: string;
  domain?: string;
  useSavedSettings?: boolean;
}

export interface SmbBackupConnectionTestResponse {
  success: boolean;
  message?: string;
  sharePath?: string;
  remoteDirectory?: string;
  remoteTarget?: string;
  stdout?: string;
}

export interface SmbBackupScheduleStatusResponse {
  success: boolean;
  schedule?: {
    enabled?: boolean;
    time?: string;
    timeZone?: string;
    retentionCount?: number;
    shareUrlConfigured?: boolean;
    remoteDirectory?: string;
    usernameConfigured?: boolean;
    passwordConfigured?: boolean;
    domainConfigured?: boolean;
    nextRunAt?: string | null;
    lastTriggeredAt?: string | null;
    lastCompletedAt?: string | null;
    lastStatus?: string;
    lastError?: string;
  };
}

export interface DeviceRestartStatusResponse {
  success: boolean;
  schedule?: {
    enabled?: boolean;
    frequency?: 'daily' | 'weekly' | 'biweekly';
    dayOfWeek?: number;
    time?: string;
    timeZone?: string;
    nextRunAt?: string | null;
    lastTriggeredAt?: string | null;
  };
}

function parseDownloadFilename(value: string | null | undefined, fallback: string) {
  const match = String(value || '').match(/filename="?([^"]+)"?/i);
  return match?.[1] || fallback;
}

export const getDeviceRestartStatus = async () => {
  try {
    const response = await api.get('/api/maintenance/device-restart');
    return response.data as DeviceRestartStatusResponse;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const triggerDeviceReboot = async () => {
  try {
    const response = await api.post('/api/maintenance/device-restart/reboot');
    return response.data as {
      success: boolean;
      message?: string;
      command?: string;
      source?: string;
      requestedAt?: string;
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

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

export const startInsteonSyncRun = async (payload: { skipExisting?: boolean } = {}) => {
  try {
    const response = await api.post('/api/maintenance/sync/insteon/start', payload || {});
    return response.data as { success: boolean; runId: string; run: InsteonMaintenanceSyncRunSnapshot };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const getInsteonSyncRun = async (runId: string) => {
  try {
    const response = await api.get(`/api/maintenance/sync/insteon/runs/${encodeURIComponent(runId)}`);
    return response.data as { success: boolean; run: InsteonMaintenanceSyncRunSnapshot };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const cancelInsteonSyncRun = async (runId: string) => {
  try {
    const response = await api.post(`/api/maintenance/sync/insteon/runs/${encodeURIComponent(runId)}/cancel`);
    return response.data as { success: boolean; message?: string; run: InsteonMaintenanceSyncRunSnapshot };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
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

export const downloadDisasterRecoveryBackup = async () => {
  try {
    const response = await api.get('/api/maintenance/backup/full', {
      responseType: 'blob',
      transformResponse: [(data) => data]
    });

    return {
      blob: response.data as Blob,
      filename: parseDownloadFilename(
        typeof response.headers?.['content-disposition'] === 'string'
          ? response.headers['content-disposition']
          : null,
        'homebrain-backup.tar.gz'
      )
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const startSmbDisasterRecoveryBackup = async (payload: SmbDisasterRecoveryBackupPayload) => {
  try {
    const response = await api.post('/api/maintenance/backup/smb', payload);
    return response.data as {
      success: boolean;
      message?: string;
      job: DisasterRecoveryBackupJob;
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const testSmbDisasterRecoveryBackup = async (payload: SmbBackupConnectionTestPayload) => {
  try {
    const response = await api.post('/api/maintenance/backup/smb/test', payload);
    return response.data as SmbBackupConnectionTestResponse;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getSmbBackupScheduleStatus = async () => {
  try {
    const response = await api.get('/api/maintenance/backup/smb/schedule');
    return response.data as SmbBackupScheduleStatusResponse;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getLatestDisasterRecoveryBackupJob = async () => {
  try {
    const response = await api.get('/api/maintenance/backup/latest');
    return response.data as {
      success: boolean;
      job: DisasterRecoveryBackupJob | null;
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const uploadDisasterRecoveryBackup = async (file: File) => {
  try {
    const response = await api.request({
      url: '/api/maintenance/restore',
      method: 'POST',
      data: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-backup-filename': file.name
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    return response.data as {
      success: boolean;
      message?: string;
      job: DisasterRecoveryRestoreJob;
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getLatestDisasterRecoveryRestoreJob = async () => {
  try {
    const response = await api.get('/api/maintenance/restore/latest');
    return response.data as {
      success: boolean;
      job: DisasterRecoveryRestoreJob | null;
    };
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};
