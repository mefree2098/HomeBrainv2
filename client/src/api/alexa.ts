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
