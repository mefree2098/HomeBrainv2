import api from './api';

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed';

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

export const generateAlexaLinkCode = async (payload: { mode?: 'private' | 'public'; ttlMinutes?: number } = {}) => {
  try {
    const response = await api.post('/api/alexa/link-codes', payload);
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
