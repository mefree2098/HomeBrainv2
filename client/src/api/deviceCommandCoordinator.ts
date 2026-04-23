import api from './api';

export type DeviceCommandSourcePolicy = {
  id: string;
  label: string;
  priority: number;
  ttlSeconds: number;
  enabled: boolean;
};

export type DeviceCommandCoordinatorPolicy = {
  enabled: boolean;
  samePriorityMode: 'last_wins' | 'block';
  workflowPriorityWeight: number;
  sources: Record<string, DeviceCommandSourcePolicy>;
};

export type DeviceCommandClaim = {
  _id?: string;
  deviceId: string;
  device?: {
    _id: string;
    name: string;
    room?: string;
    type?: string;
  };
  commandId: string;
  source: string;
  priority: number;
  ttlSeconds: number;
  reason?: string;
  actor?: string;
  action?: string;
  value?: unknown;
  issuedAt: string;
  expiresAt: string;
  metadata?: Record<string, unknown>;
};

export type DeviceCommandDecision = {
  id: string;
  decision: string;
  details?: Record<string, unknown>;
  createdAt: string;
};

export type DeviceCommandSourceDefinition = {
  id: string;
  label: string;
  priority: number;
  ttlSeconds: number;
};

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed';

export const getDeviceCommandCoordinatorPolicy = async () => {
  try {
    const response = await api.get('/api/device-command-coordinator/policy');
    return response.data as {
      success: boolean;
      policy: DeviceCommandCoordinatorPolicy;
      sourceDefinitions: DeviceCommandSourceDefinition[];
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const updateDeviceCommandCoordinatorPolicy = async (policy: DeviceCommandCoordinatorPolicy) => {
  try {
    const response = await api.put('/api/device-command-coordinator/policy', { policy });
    return response.data as {
      success: boolean;
      message: string;
      policy: DeviceCommandCoordinatorPolicy;
      sourceDefinitions: DeviceCommandSourceDefinition[];
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const getDeviceCommandCoordinatorClaims = async () => {
  try {
    const response = await api.get('/api/device-command-coordinator/claims');
    return response.data as {
      success: boolean;
      claims: DeviceCommandClaim[];
      decisions: DeviceCommandDecision[];
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const clearDeviceCommandCoordinatorClaim = async (deviceId: string) => {
  try {
    const response = await api.delete(`/api/device-command-coordinator/claims/${encodeURIComponent(deviceId)}`);
    return response.data as {
      success: boolean;
      message: string;
      cleared: DeviceCommandClaim | null;
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const clearAllDeviceCommandCoordinatorClaims = async () => {
  try {
    const response = await api.delete('/api/device-command-coordinator/claims');
    return response.data as {
      success: boolean;
      message: string;
      cleared: DeviceCommandClaim[];
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};
