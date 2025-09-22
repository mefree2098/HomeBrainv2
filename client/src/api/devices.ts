import api from './api';

// Description: Get all smart home devices
// Endpoint: GET /api/devices
// Request: {}
// Response: { success: boolean, data: { devices: Array<Device> } }
export const getDevices = async (filters?: { room?: string; type?: string; status?: boolean; isOnline?: boolean }) => {
  try {
    if (filters && Object.keys(filters).length > 0) {
      console.log('Fetching devices from API with filters:', filters);
    } else {
      console.log('Fetching all devices from API');
    }
    
    const params = new URLSearchParams();
    if (filters?.room) params.append('room', filters.room);
    if (filters?.type) params.append('type', filters.type);
    if (filters?.status !== undefined) params.append('status', filters.status.toString());
    if (filters?.isOnline !== undefined) params.append('isOnline', filters.isOnline.toString());
    
    const queryString = params.toString();
    const url = queryString ? `/api/devices?${queryString}` : '/api/devices';
    
    const response = await api.get(url);
    console.log('Successfully fetched devices from API');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching devices:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Control a device
// Endpoint: POST /api/devices/control
// Request: { deviceId: string, action: string, value?: number }
// Response: { success: boolean, data: { device: Device } }
export const controlDevice = async (data: { deviceId: string; action: string; value?: number }) => {
  try {
    console.log('Controlling device:', data);
    const response = await api.post('/api/devices/control', data);
    console.log('Successfully controlled device');
    return response.data;
  } catch (error) {
    console.error('Error controlling device:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Get devices grouped by room
// Endpoint: GET /api/devices/by-room
// Request: {}
// Response: { success: boolean, data: { rooms: Array<{ name: string, devices: Array<Device> }> } }
export const getDevicesByRoom = async () => {
  try {
    console.log('Fetching devices by room from API');
    const response = await api.get('/api/devices/by-room');
    console.log('Successfully fetched devices by room from API');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching devices by room:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Get a specific device by ID
// Endpoint: GET /api/devices/:id
// Request: {}
// Response: { success: boolean, data: { device: Device } }
export const getDeviceById = async (deviceId: string) => {
  try {
    console.log('Fetching device by ID from API:', deviceId);
    const response = await api.get(`/api/devices/${deviceId}`);
    console.log('Successfully fetched device by ID from API');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching device by ID:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Create a new device
// Endpoint: POST /api/devices
// Request: { name: string, type: string, room: string, ... }
// Response: { success: boolean, data: { device: Device } }
export const createDevice = async (deviceData: any) => {
  try {
    console.log('Creating device via API:', deviceData);
    const response = await api.post('/api/devices', deviceData);
    console.log('Successfully created device via API');
    return response.data.data;
  } catch (error) {
    console.error('Error creating device:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Update a device
// Endpoint: PUT /api/devices/:id
// Request: { name?: string, type?: string, room?: string, ... }
// Response: { success: boolean, data: { device: Device } }
export const updateDevice = async (deviceId: string, updateData: any) => {
  try {
    console.log('Updating device via API:', deviceId, updateData);
    const response = await api.put(`/api/devices/${deviceId}`, updateData);
    console.log('Successfully updated device via API');
    return response.data.data;
  } catch (error) {
    console.error('Error updating device:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Delete a device
// Endpoint: DELETE /api/devices/:id
// Request: {}
// Response: { success: boolean, data: { device: Device } }
export const deleteDevice = async (deviceId: string) => {
  try {
    console.log('Deleting device via API:', deviceId);
    const response = await api.delete(`/api/devices/${deviceId}`);
    console.log('Successfully deleted device via API');
    return response.data.data;
  } catch (error) {
    console.error('Error deleting device:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Get device statistics
// Endpoint: GET /api/devices/stats
// Request: {}
// Response: { success: boolean, data: { stats: DeviceStats } }
export const getDeviceStats = async () => {
  try {
    console.log('Fetching device statistics from API');
    const response = await api.get('/api/devices/stats');
    console.log('Successfully fetched device statistics from API');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching device statistics:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}