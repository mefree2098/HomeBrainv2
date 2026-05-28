import api from './api';

export type DirectRadioProtocol = 'zigbee' | 'zwave';
export type DirectRadioLogProtocol = DirectRadioProtocol | 'system';
export type ZWaveSecurityMode = 'insecure' | 'default' | 's2' | 's0';

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
  nodes?: DirectRadioZWaveNode[];
};

export type DirectRadioZWaveNode = {
  id: number | null;
  name: string;
  isControllerNode: boolean;
  ready: boolean;
  status: number | string | null;
  interviewStage: string | null;
  isListening: boolean | null;
  isFrequentListening: boolean | null;
  manufacturerId: number | string | null;
  productType: number | string | null;
  productId: number | string | null;
  manufacturer: string | null;
  productLabel: string | null;
  features: string[];
  incomplete: boolean;
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
  pairings?: {
    zigbee?: DirectRadioPairingSession | null;
    zwave?: DirectRadioPairingSession | null;
  };
  migrations: unknown[];
};

export type DirectRadioPairingSession = {
  id: string;
  protocol: DirectRadioProtocol;
  mode: string;
  status: 'opening' | 'active' | 'awaiting_dsk' | 'completed' | 'failed' | 'expired' | 'stopped' | string;
  zwaveSecurityMode?: ZWaveSecurityMode | string | null;
  startedAt?: string | null;
  expiresAt?: string | null;
  secondsRemaining?: number;
  pendingDsk?: string | null;
  detectedIdentity?: Record<string, unknown> | null;
  directDeviceId?: string | null;
  directDeviceName?: string | null;
  message?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  expiredAt?: string | null;
  events?: Array<Record<string, unknown>>;
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

export type DirectRadioMigrationVerification = {
  migrationId: string;
  deviceId: string | null;
  protocol: DirectRadioProtocol;
  phase: string | null;
  stepId?: string | null;
  status: 'verified' | 'pending' | 'failed' | string;
  verified: boolean;
  canAdvance: boolean;
  message: string;
  guidance: string[];
  evidence?: Record<string, unknown>;
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
  zwaveSecurityMode?: ZWaveSecurityMode;
  migrationId?: string | null;
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
  dskPin?: string;
  zwaveSecurityMode?: ZWaveSecurityMode;
}) => {
  try {
    const response = await api.post('/api/direct-radios/pairing/start', payload);
    return response.data;
  } catch (error) {
    console.error('Error starting direct radio pairing:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const submitZWaveDskPin = async (pin: string) => {
  try {
    const response = await api.post('/api/direct-radios/pairing/zwave/dsk-pin', { pin });
    return response.data as {
      success: boolean;
      result?: {
        accepted?: boolean;
        pendingRequest?: boolean;
        pairing?: DirectRadioPairingSession | null;
      };
      status?: DirectRadioStatus;
    };
  } catch (error) {
    console.error('Error submitting Z-Wave DSK PIN:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const refreshZWaveNodeInfo = async (
  nodeId: number | string,
  options: {
    waitForWakeup?: boolean;
    resetSecurityClasses?: boolean;
    pingFirst?: boolean;
  } = {}
) => {
  try {
    const response = await api.post(`/api/direct-radios/zwave/nodes/${encodeURIComponent(String(nodeId))}/refresh-info`, options);
    return response.data as {
      success: boolean;
      result?: {
        node?: DirectRadioZWaveNode | null;
        before?: DirectRadioZWaveNode | null;
        ping?: boolean | null;
        pingError?: string | null;
        message?: string | null;
      };
      status?: DirectRadioStatus;
    };
  } catch (error) {
    console.error('Error refreshing Z-Wave node info:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const removeFailedZWaveNode = async (
  nodeId: number | string,
  options: { confirm: boolean; force?: boolean }
) => {
  try {
    const response = await api.post(`/api/direct-radios/zwave/nodes/${encodeURIComponent(String(nodeId))}/remove-failed`, options);
    return response.data as {
      success: boolean;
      result?: {
        nodeId?: number;
        failed?: boolean | null;
        force?: boolean;
        deletedDeviceCount?: number;
        message?: string | null;
      };
      status?: DirectRadioStatus;
    };
  } catch (error) {
    console.error('Error removing failed Z-Wave node:', error);
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

export const startZWaveExclusion = async (
  durationSeconds?: number,
  options: { deviceId?: string; migrationId?: string | null } = {}
) => {
  try {
    const response = await api.post('/api/direct-radios/exclusion/start', {
      protocol: 'zwave',
      durationSeconds,
      deviceId: options.deviceId,
      migrationId: options.migrationId
    });
    return response.data;
  } catch (error) {
    console.error('Error starting Z-Wave exclusion:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const verifyDirectRadioMigrationStep = async (payload: {
  migrationId?: string | null;
  deviceId: string;
  protocol: DirectRadioProtocol;
  phase: string;
  stepId: string;
}) => {
  try {
    const response = await api.post('/api/direct-radios/migrations/verify-step', payload);
    return response.data as {
      success: boolean;
      verification: DirectRadioMigrationVerification;
      migration?: unknown;
      status?: DirectRadioStatus;
    };
  } catch (error) {
    console.error('Error verifying direct radio migration step:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const finalizeDirectRadioMigration = async (payload: {
  deviceId: string;
  migrationId?: string | null;
  reason?: string;
}) => {
  try {
    const response = await api.post('/api/direct-radios/migrations/finalize', payload);
    return response.data as {
      success: boolean;
      device?: unknown;
      finalization?: {
        deviceId: string;
        protocol: DirectRadioProtocol;
        finalizedAt: string;
        validation?: Record<string, unknown>;
      };
      status?: DirectRadioStatus;
    };
  } catch (error) {
    console.error('Error finalizing direct radio migration:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};
