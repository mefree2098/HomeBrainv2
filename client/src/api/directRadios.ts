import api from './api';

export type DirectRadioMigrationPlan = {
  deviceId: string | null;
  smartThingsDeviceId: string | null;
  name: string;
  room: string | null;
  currentSource: string;
  recommendedProtocol: 'zigbee' | 'zwave' | 'unknown';
  inferredProtocol: 'zigbee' | 'zwave' | 'unknown';
  supported: boolean;
  cloudOrVirtualOnly: boolean;
  features: string[];
  featureSupport: Array<{
    key: string;
    label: string;
    supported: boolean;
    support: 'native' | 'best_effort';
  }>;
  manualSteps: string[];
  warnings: string[];
  targetSource: string | null;
};

export const getDirectRadioStatus = async () => {
  try {
    const response = await api.get('/api/direct-radios/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching direct radio status:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const getDirectRadioMigrationPlan = async (deviceId: string, protocol?: string) => {
  try {
    const params = protocol ? `?protocol=${encodeURIComponent(protocol)}` : '';
    const response = await api.get(`/api/direct-radios/migration-plan/${deviceId}${params}`);
    return response.data as { success: boolean; plan: DirectRadioMigrationPlan };
  } catch (error) {
    console.error('Error fetching direct radio migration plan:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const startDirectRadioMigration = async (payload: {
  deviceId: string;
  protocol: 'zigbee' | 'zwave';
  durationSeconds?: number;
  dskPin?: string;
}) => {
  try {
    const response = await api.post('/api/direct-radios/migrations', payload);
    return response.data;
  } catch (error) {
    console.error('Error starting direct radio migration:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const startDirectRadioPairing = async (payload: {
  protocol: 'zigbee' | 'zwave';
  durationSeconds?: number;
}) => {
  try {
    const response = await api.post('/api/direct-radios/pairing/start', payload);
    return response.data;
  } catch (error) {
    console.error('Error starting direct radio pairing:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const startZWaveExclusion = async (durationSeconds?: number) => {
  try {
    const response = await api.post('/api/direct-radios/exclusion/start', {
      protocol: 'zwave',
      durationSeconds
    });
    return response.data;
  } catch (error) {
    console.error('Error starting Z-Wave exclusion:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};
