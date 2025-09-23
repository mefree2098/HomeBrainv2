import api from './api';

// Description: Toggle auto-discovery service on/off
// Endpoint: POST /api/discovery/toggle
// Request: { enabled: boolean }
// Response: { success: boolean, enabled: boolean, message: string }
export const toggleAutoDiscovery = async (enabled: boolean) => {
  console.log('Toggling auto-discovery:', enabled);
  try {
    const response = await api.post('/api/discovery/toggle', { enabled });
    return response.data;
  } catch (error) {
    console.error('Error toggling auto-discovery:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get auto-discovery service status
// Endpoint: GET /api/discovery/status
// Request: {}
// Response: { success: boolean, stats: object }
export const getDiscoveryStatus = async () => {
  console.log('Fetching auto-discovery status');
  try {
    const response = await api.get('/api/discovery/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching discovery status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Get pending devices awaiting approval
// Endpoint: GET /api/discovery/pending
// Request: {}
// Response: { success: boolean, devices: Array<object>, count: number }
export const getPendingDevices = async () => {
  console.log('Fetching pending devices');
  try {
    const response = await api.get('/api/discovery/pending');
    return response.data;
  } catch (error) {
    console.error('Error fetching pending devices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Approve a pending device
// Endpoint: POST /api/discovery/approve/:deviceId
// Request: { name: string, room: string, deviceType?: string }
// Response: { success: boolean, device: object, message: string }
export const approvePendingDevice = async (
  deviceId: string,
  data: {
    name: string;
    room: string;
    deviceType?: string;
  }
) => {
  console.log('Approving pending device:', deviceId, data);
  try {
    const response = await api.post(`/api/discovery/approve/${deviceId}`, data);
    return response.data;
  } catch (error) {
    console.error('Error approving pending device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Reject a pending device
// Endpoint: POST /api/discovery/reject/:deviceId
// Request: {}
// Response: { success: boolean, message: string }
export const rejectPendingDevice = async (deviceId: string) => {
  console.log('Rejecting pending device:', deviceId);
  try {
    const response = await api.post(`/api/discovery/reject/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error rejecting pending device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Clear all pending devices
// Endpoint: POST /api/discovery/clear-pending
// Request: {}
// Response: { success: boolean, cleared: number, message: string }
export const clearAllPendingDevices = async () => {
  console.log('Clearing all pending devices');
  try {
    const response = await api.post('/api/discovery/clear-pending');
    return response.data;
  } catch (error) {
    console.error('Error clearing pending devices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};