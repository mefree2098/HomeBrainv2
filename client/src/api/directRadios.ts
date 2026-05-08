import api from './api';

export type DirectRadioProtocol = 'zigbee' | 'zwave';
export type DirectRadioLogProtocol = DirectRadioProtocol | 'system';

export type DirectRadioSerialPort = {
  path?: string;
  rawPath?: string | null;
  stablePath?: string | null;
  realPath?: string | null;
  manufacturer?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  friendlyName?: string | null;
  descriptor?: string | null;
  scores?: {
    zigbee?: number | null;
    zwave?: number | null;
  };
  likelyZigbee?: boolean;
  likelyZWave?: boolean;
  preferredProtocol?: DirectRadioProtocol | null;
};

export type DirectRadioControllerStatus = {
  expectedHardware: string;
  source: string;
  detectedPort: string | null;
  detectedPortDetails?: DirectRadioSerialPort | null;
  configuredPort: string | null;
  started: boolean;
  error: string | null;
  diagnostics?: string[];
  permitJoinUntil?: string | null;
  inclusionUntil?: string | null;
  exclusionUntil?: string | null;
  pendingDsk?: string | null;
  lastStartResult?: unknown;
  pairedDeviceCount?: number;
  pairedNodeCount?: number;
};

export type DirectRadioStatus = {
  enabled: boolean;
  dataDir: string;
  serialPorts: DirectRadioSerialPort[];
  diagnostics?: string[];
  controllers: {
    zigbee: DirectRadioControllerStatus;
    zwave: DirectRadioControllerStatus;
  };
  migrations: unknown[];
};

export type DirectRadioLogEntry = {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  protocol: DirectRadioLogProtocol;
  stage?: string | null;
  operation?: string | null;
  target?: string | null;
  message: string;
  details?: Record<string, unknown>;
};

export type DirectRadioMigrationPlan = {
  deviceId: string | null;
  smartThingsDeviceId: string | null;
  name: string;
  room: string | null;
  currentSource: string;
  recommendedProtocol: DirectRadioProtocol | 'unknown';
  inferredProtocol: DirectRadioProtocol | 'unknown';
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
  guidedSteps?: DirectRadioMigrationGuidedStep[];
  instructionProfile?: {
    key: string;
    label: string;
    confidence: 'low' | 'medium' | 'high' | string;
    reference?: string | null;
  } | null;
  warnings: string[];
  targetSource: string | null;
};

export type DirectRadioMigrationGuidedStep = {
  id: string;
  title: string;
  phase: string;
  protocol: DirectRadioProtocol | 'unknown';
  action: 'start_zwave_exclusion' | 'start_direct_migration' | 'user_confirm' | string;
  automatic: boolean;
  durationSeconds?: number | null;
  instructions: string[];
  confirmLabel: string;
};

export const getDirectRadioStatus = async () => {
  try {
    const response = await api.get('/api/direct-radios/status');
    return response.data as { success: boolean; status: DirectRadioStatus };
  } catch (error) {
    console.error('Error fetching direct radio status:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const getDirectRadioSerialPorts = async () => {
  try {
    const response = await api.get('/api/direct-radios/serial-ports');
    return response.data as { success: boolean; serialPorts: DirectRadioSerialPort[] };
  } catch (error) {
    console.error('Error fetching direct radio serial ports:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const getDirectRadioEngineLogs = async (limit = 200) => {
  try {
    const response = await api.get('/api/direct-radios/logs/latest', {
      params: { limit }
    });
    return response.data as { success: boolean; logs: DirectRadioLogEntry[]; count: number };
  } catch (error) {
    console.error('Error fetching direct radio logs:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const clearDirectRadioEngineLogs = async () => {
  try {
    const response = await api.post('/api/direct-radios/logs/clear');
    return response.data as { success: boolean; cleared: number };
  } catch (error) {
    console.error('Error clearing direct radio logs:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const openDirectRadioEngineLogStream = (
  options: { limit?: number } = {},
  handlers: {
    onLog: (entry: DirectRadioLogEntry) => void;
    onReady?: () => void;
    onError?: (error: Event) => void;
  }
) => {
  const params = new URLSearchParams();
  if (typeof options.limit === 'number' && options.limit > 0) {
    params.set('limit', String(options.limit));
  }

  const url = params.toString()
    ? `/api/direct-radios/logs/stream?${params.toString()}`
    : '/api/direct-radios/logs/stream';
  const stream = new EventSource(url, { withCredentials: true });

  stream.addEventListener('log', (raw) => {
    const message = raw as MessageEvent<string>;
    try {
      handlers.onLog(JSON.parse(message.data) as DirectRadioLogEntry);
    } catch (error) {
      console.error('Failed to parse direct radio log stream payload:', error);
    }
  });

  stream.addEventListener('ready', () => {
    handlers.onReady?.();
  });

  stream.onerror = (error) => {
    handlers.onError?.(error);
  };

  return () => {
    stream.close();
  };
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
  protocol: DirectRadioProtocol;
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
  protocol: DirectRadioProtocol;
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

export const stopDirectRadioPairing = async (protocol: DirectRadioProtocol | 'all' = 'all') => {
  try {
    const response = await api.post('/api/direct-radios/pairing/stop', { protocol });
    return response.data as { success: boolean; status: DirectRadioStatus };
  } catch (error) {
    console.error('Error stopping direct radio pairing:', error);
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
