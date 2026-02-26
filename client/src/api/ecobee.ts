import api from './api';

export const getEcobeeStatus = async () => {
  try {
    const response = await api.get('/api/ecobee/status');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const configureEcobeeOAuth = async (config: {
  clientId: string;
  redirectUri?: string;
  scope?: string[];
}) => {
  try {
    const response = await api.post('/api/ecobee/configure', config);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const getEcobeeAuthUrl = async () => {
  try {
    const response = await api.get('/api/ecobee/auth/url');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const testEcobeeConnection = async () => {
  try {
    const response = await api.post('/api/ecobee/test');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const disconnectEcobee = async () => {
  try {
    const response = await api.post('/api/ecobee/disconnect');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const getEcobeeDevices = async (options: { refresh?: boolean } = {}) => {
  try {
    const response = await api.get('/api/ecobee/devices', {
      params: options.refresh ? { refresh: '1' } : undefined
    });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};
