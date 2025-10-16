import api from './api';

export const getWhisperStatus = async () => {
  try {
    const response = await api.get('/api/whisper/status');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const installWhisperDependencies = async () => {
  try {
    const response = await api.post('/api/whisper/install');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const startWhisperService = async (model?: string) => {
  try {
    const response = await api.post('/api/whisper/service/start', model ? { model } : {});
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const stopWhisperService = async () => {
  try {
    const response = await api.post('/api/whisper/service/stop');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getInstalledWhisperModels = async () => {
  try {
    const response = await api.get('/api/whisper/models');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getAvailableWhisperModels = async () => {
  try {
    const response = await api.get('/api/whisper/models/available');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const downloadWhisperModel = async (modelName: string) => {
  try {
    const response = await api.post('/api/whisper/models/download', { modelName });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const activateWhisperModel = async (modelName: string) => {
  try {
    const response = await api.post('/api/whisper/models/activate', { modelName });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

export const getWhisperLogs = async () => {
  try {
    const response = await api.get('/api/whisper/logs');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};
