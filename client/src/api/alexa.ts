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
  resumeAfterHostRestart?: boolean;
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastError?: {
    message?: string;
    timestamp?: string;
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
  health?: Record<string, any> | null;
  healthAvailable?: boolean;
  healthMessage?: string;
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
