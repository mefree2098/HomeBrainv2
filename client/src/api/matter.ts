import api from './api';

export type MatterTransport = 'ip' | 'wifi' | 'ethernet' | 'thread' | 'ble';

export type MatterCommissioningPayload = {
  setupCode?: string;
  qrCode?: string;
  manualCode?: string;
  passcode?: number;
  discriminator?: number;
  transport?: MatterTransport;
  knownAddress?: string;
  room?: string;
  name?: string;
  wifiSsid?: string;
  wifiCredentials?: string;
  threadNetworkName?: string;
  threadOperationalDataset?: string;
};

export type MatterThreadFirmwareFlashPayload = {
  confirmFlash: string;
  firmwareName?: string;
  firmwareBase64?: string;
};

const apiErrorMessage = (error: any, fallback: string) => (
  error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback
);

export const getMatterStatus = async () => {
  try {
    const response = await api.get('/api/matter/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching Matter status:', error);
    throw new Error(apiErrorMessage(error, 'Failed to load Matter status'));
  }
};

export const getThreadStatus = async () => {
  try {
    const response = await api.get('/api/matter/thread/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching Thread status:', error);
    throw new Error(apiErrorMessage(error, 'Failed to load Thread status'));
  }
};

export const getMatterThreadFirmwareFlashStatus = async () => {
  try {
    const response = await api.get('/api/matter/thread/firmware-flash/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching Thread firmware flash status:', error);
    throw new Error(apiErrorMessage(error, 'Failed to load Thread firmware flash status'));
  }
};

export const getMatterCommissioningSessions = async () => {
  try {
    const response = await api.get('/api/matter/commissioning-sessions');
    return response.data;
  } catch (error) {
    console.error('Error fetching Matter commissioning sessions:', error);
    throw new Error(apiErrorMessage(error, 'Failed to load Matter commissioning sessions'));
  }
};

export const startMatterCommissioning = async (payload: MatterCommissioningPayload) => {
  try {
    const response = await api.post('/api/matter/commissioning/start', payload);
    return response.data;
  } catch (error) {
    console.error('Error starting Matter commissioning:', error);
    throw new Error(apiErrorMessage(error, 'Failed to start Matter commissioning'));
  }
};

export const updateMatterConfig = async (payload: Record<string, unknown>) => {
  try {
    const response = await api.put('/api/matter/config', payload);
    return response.data;
  } catch (error) {
    console.error('Error updating Matter config:', error);
    throw new Error(apiErrorMessage(error, 'Failed to update Matter configuration'));
  }
};

export const startMatterThreadFirmwareFlash = async (payload: MatterThreadFirmwareFlashPayload) => {
  try {
    const response = await api.post('/api/matter/thread/firmware-flash/start', payload);
    return response.data;
  } catch (error) {
    console.error('Error starting Thread firmware flash:', error);
    throw new Error(apiErrorMessage(error, 'Failed to start Thread firmware flash'));
  }
};
