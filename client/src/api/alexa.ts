import api from './api';

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed';

export type AlexaExposureEntityType = 'device' | 'device_group' | 'scene' | 'workflow';

export type AlexaExposureSummary = {
  _id?: string;
  entityType: AlexaExposureEntityType;
  entityId: string;
  enabled: boolean;
  projectionType?: string;
  friendlyName?: string;
  aliases?: string[];
  roomHint?: string;
  validationWarnings?: string[];
  validationErrors?: string[];
  endpointId?: string;
  entity?: Record<string, any> | null;
};

export type AlexaBulkDeviceExposureResult = {
  source: string;
  sourceLabel: string;
  enabled: boolean;
  matchedCount: number;
  createdCount: number;
  changedCount: number;
  unchangedCount: number;
  failedCount: number;
  validationErrorCount: number;
  validationWarningCount: number;
  failures?: Array<{
    entityId?: string;
    name?: string;
    error?: string;
  }>;
  exposures?: AlexaExposureSummary[];
};

export type AlexaBrokerServiceStatus = {
  isInstalled: boolean;
  serviceStatus: string;
  serviceRunning: boolean;
  servicePid: number | null;
  servicePort: number;
  bindHost: string;
  serviceOwner?: string | null;
  publicBaseUrl?: string;
  localBaseUrl?: string;
  displayName?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthClientSecretConfigured?: boolean;
  eventClientId?: string;
  eventClientSecret?: string;
  eventClientSecretConfigured?: boolean;
  alexaCommandProvider?: 'disabled' | 'homebrain' | 'asp';
  alexaCommandDefaultType?: 'announce' | 'speak' | 'ssml';
  alexaCommandLocale?: string;
  alexaCommandAmazonPage?: string;
  alexaCommandServiceHost?: string;
  alexaCommandSessionCookie?: string;
  alexaCommandSessionData?: string;
  alexaCommandSessionConfigured?: boolean;
  alexaCommandSessionCookieMasked?: string;
  alexaCommandSessionDataMasked?: string;
  alexaCommandTargets?: Array<{
    key?: string;
    alexaDeviceId?: string;
    displayName?: string;
    room?: string;
    enabled?: boolean;
  }>;
  alexaCommandTimeoutMs?: number;
  allowedClientIds?: string[];
  allowedRedirectUris?: string[];
  storeFile?: string;
  authCodeTtlMs?: number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  lwaTokenUrl?: string;
  eventGatewayUrl?: string;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  allowManualRegistration?: boolean;
  autoStart?: boolean;
  manualStopRequested?: boolean;
  resumeAfterHostRestart?: boolean;
  autoRecoveryMode?: 'keep_running' | 'resume_after_restart' | 'paused_manual_stop' | 'disabled';
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastError?: {
    message?: string;
    timestamp?: string;
  } | null;
  statusReason?: {
    level?: 'info' | 'success' | 'warning' | 'error';
    source?: string;
    message?: string;
    timestamp?: string | null;
  } | null;
  reverseProxy?: {
    routeId?: string | null;
    routeExists?: boolean;
    expectedHostname?: string | null;
    hostname?: string | null;
    enabled?: boolean;
    tlsMode?: string;
    validationStatus?: string;
    lastApplyStatus?: string;
    upstreamHost?: string;
    upstreamPort?: number;
    healthCheckPath?: string;
    matchesConfig?: boolean;
  };
  logs?: string[];
  lifecycleEvents?: Array<{
    type?: string;
    status?: 'info' | 'success' | 'warning' | 'error';
    message?: string;
    details?: Record<string, any>;
    occurredAt?: string;
  }>;
  health?: Record<string, any> | null;
  healthAvailable?: boolean;
  healthMessage?: string;
};

export type AlexaDeviceSummary = {
  id: string;
  deviceId?: string;
  name: string;
  room?: string;
  type?: string;
  brokerAccountId?: string;
  locale?: string;
  online?: boolean | null;
  capabilities?: string[];
  provider?: string;
};

export type AlexaDevicesResponse = {
  success: boolean;
  available?: boolean;
  reason?: string;
  devices?: AlexaDeviceSummary[];
  count?: number;
  updatedAt?: string | null;
};

export type AlexaSessionCaptureSummary = {
  captureId: string;
  status: 'pending' | 'captured' | 'activated' | 'failed' | 'expired';
  message?: string;
  startedAt?: string;
  expiresAt?: string;
  completedAt?: string | null;
  activatedAt?: string | null;
  failedAt?: string | null;
  amazonPage?: string;
  serviceHost?: string;
  cookieNames?: string[];
  warnings?: string[];
};

export type AlexaSessionCaptureStartResponse = {
  success: boolean;
  captureId: string;
  token: string;
  status: string;
  message?: string;
  startedAt?: string;
  expiresAt?: string;
  amazonPage?: string;
  serviceHost?: string;
  loginUrl: string;
  receiverUrl: string;
  statusUrl: string;
  capturePageUrl: string;
  helperExtensionUrl?: string;
};

export const getAlexaSummary = async () => {
  try {
    const response = await api.get('/api/alexa');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const getAlexaExposures = async () => {
  try {
    const response = await api.get('/api/alexa/exposures');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const updateAlexaExposure = async (
  entityType: AlexaExposureEntityType,
  entityId: string,
  payload: {
    enabled?: boolean;
    friendlyName?: string;
    aliases?: string[];
    roomHint?: string;
    projectionType?: string;
  }
) => {
  try {
    const response = await api.put(`/api/alexa/exposures/${entityType}/${entityId}`, payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const bulkUpdateAlexaDeviceExposuresBySource = async (
  source: string,
  payload: { enabled?: boolean } = { enabled: true }
) => {
  try {
    const response = await api.post(
      `/api/alexa/exposures/devices/by-source/${encodeURIComponent(source)}`,
      payload
    );
    return response.data as {
      success: boolean;
      message?: string;
      result?: AlexaBulkDeviceExposureResult;
    };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const generateAlexaLinkCode = async (payload: { mode?: 'private' | 'public'; ttlMinutes?: number } = {}) => {
  try {
    const response = await api.post('/api/alexa/link-codes', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const pairAlexaBroker = async (payload: {
  brokerBaseUrl: string;
  linkCode: string;
  mode?: 'private' | 'public';
  brokerClientId?: string;
}) => {
  try {
    const response = await api.post('/api/alexa/pair-broker', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const syncAlexaDiscovery = async (payload: { reason?: string } = {}) => {
  try {
    const response = await api.post('/api/alexa/discovery-sync', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const flushAlexaBrokerEvents = async (payload: { limit?: number } = {}) => {
  try {
    const response = await api.post('/api/alexa/events/flush', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const syncAlexaHouseholdDiscovery = async (brokerAccountId: string) => {
  try {
    const response = await api.post(`/api/alexa/accounts/${encodeURIComponent(brokerAccountId)}/discovery-sync`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const revokeAlexaHousehold = async (brokerAccountId: string, payload: { reason?: string } = {}) => {
  try {
    const response = await api.post(`/api/alexa/accounts/${encodeURIComponent(brokerAccountId)}/revoke`, payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const updateAlexaVoiceUser = async (voiceUserId: string, payload: {
  label?: string;
  status?: 'unmapped' | 'mapped' | 'disabled';
  responseMode?: 'inherit' | 'text' | 'ssml' | 'audio';
  userProfileId?: string | null;
}) => {
  try {
    const response = await api.put(`/api/alexa/voice-users/${encodeURIComponent(voiceUserId)}`, payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const deleteAlexaVoiceUser = async (voiceUserId: string) => {
  try {
    const response = await api.delete(`/api/alexa/voice-users/${encodeURIComponent(voiceUserId)}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const getAlexaDevices = async (params: { brokerAccountId?: string } = {}) => {
  try {
    const response = await api.get('/api/alexa/devices', { params });
    return response.data as AlexaDevicesResponse;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const speakAlexaDevice = async (
  alexaDeviceId: string,
  payload: { message: string; brokerAccountId?: string; locale?: string; deviceName?: string; type?: 'announce' | 'speak' | 'ssml' }
) => {
  try {
    const response = await api.post(`/api/alexa/devices/${encodeURIComponent(alexaDeviceId)}/speak`, payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const startAlexaSessionCapture = async (payload: { amazonPage?: string; serviceHost?: string } = {}) => {
  try {
    const response = await api.post('/api/alexa/session-capture/start', payload);
    return response.data as AlexaSessionCaptureStartResponse;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const getAlexaSessionCaptureStatus = async (captureId: string) => {
  try {
    const response = await api.get(`/api/alexa/session-capture/${encodeURIComponent(captureId)}/status`);
    return response.data as { success: boolean; capture: AlexaSessionCaptureSummary };
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const getAlexaSessionHelperExtensionUrl = () => '/api/alexa/session-capture/helper-extension.zip';

export const getAlexaBrokerServiceStatus = async () => {
  try {
    const response = await api.get('/api/alexa/service/status');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const updateAlexaBrokerServiceConfig = async (payload: Record<string, any>) => {
  try {
    const response = await api.put('/api/alexa/service/config', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const installAlexaBrokerService = async () => {
  try {
    const response = await api.post('/api/alexa/service/install');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const deployAlexaBrokerService = async (payload: { installDependencies?: boolean } = {}) => {
  try {
    const response = await api.post('/api/alexa/service/deploy', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const startAlexaBrokerService = async () => {
  try {
    const response = await api.post('/api/alexa/service/start');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const stopAlexaBrokerService = async () => {
  try {
    const response = await api.post('/api/alexa/service/stop');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};

export const restartAlexaBrokerService = async () => {
  try {
    const response = await api.post('/api/alexa/service/restart');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getApiErrorMessage(error));
  }
};
