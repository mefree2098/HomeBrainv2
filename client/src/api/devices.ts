import api from './api';

type DeviceFilters = {
  room?: string;
  type?: string;
  status?: boolean;
  isOnline?: boolean;
  source?: string;
}

export type DeviceRecord = {
  _id: string;
  id?: string;
  name: string;
  type: string;
  room: string;
  groups?: string[];
  status?: boolean;
  isOnline?: boolean;
  brightness?: number;
  temperature?: number;
  targetTemperature?: number;
  properties?: Record<string, unknown>;
};

export type DeviceGroupSummary = {
  _id: string;
  name: string;
  normalizedName: string;
  description: string;
  groupKind: 'direct' | 'master' | 'hybrid';
  containsNestedGroups: boolean;
  deviceCount: number;
  deviceIds: string[];
  deviceNames: string[];
  directDeviceCount: number;
  directDeviceIds: string[];
  directDeviceNames: string[];
  childGroupIds: string[];
  childGroups: Array<{
    _id: string;
    name: string;
    normalizedName: string;
    groupKind: 'direct' | 'master' | 'hybrid';
    deviceCount: number;
  }>;
  parentGroupIds: string[];
  parentGroupNames: string[];
  rooms: string[];
  types: string[];
  sources: string[];
  workflowUsageCount: number;
  automationUsageCount: number;
  workflowNames: string[];
  automationNames: string[];
  insteonPlmGroup?: number | null;
  insteonLastSyncedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type DeviceEnergySample = {
  recordedAt: string;
  source: string;
  power: {
    value: number;
    unit: string;
    timestamp: string;
  } | null;
  energy: {
    value: number;
    unit: string;
    timestamp: string;
  } | null;
}

// Description: Get all smart home devices
// Endpoint: GET /api/devices
// Request: {}
// Response: { success: boolean, data: { devices: Array<Device> } }
export const getDevices = async (filters?: DeviceFilters) => {
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
    if (filters?.source) params.append('source', filters.source);
    
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

export const getDeviceGroups = async () => {
  try {
    console.log('Fetching device groups from API');
    const response = await api.get('/api/device-groups');
    console.log('Successfully fetched device groups from API');
    return response.data.data as { groups: DeviceGroupSummary[] };
  } catch (error) {
    console.error('Error fetching device groups:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

export const getDeviceGroupById = async (groupId: string) => {
  try {
    console.log('Fetching device group from API:', groupId);
    const response = await api.get(`/api/device-groups/${groupId}`);
    console.log('Successfully fetched device group from API');
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error fetching device group:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

export const createDeviceGroup = async (payload: {
  name: string;
  description?: string;
  deviceIds?: string[];
  childGroupIds?: string[];
}) => {
  try {
    console.log('Creating device group via API:', payload);
    const response = await api.post('/api/device-groups', payload);
    console.log('Successfully created device group via API');
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error creating device group:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

export const updateDeviceGroup = async (
  groupId: string,
  payload: {
    name?: string;
    description?: string;
    deviceIds?: string[];
    childGroupIds?: string[];
  }
) => {
  try {
    console.log('Updating device group via API:', groupId, payload);
    const response = await api.put(`/api/device-groups/${groupId}`, payload);
    console.log('Successfully updated device group via API');
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error updating device group:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

export const setDeviceGroupDevices = async (groupId: string, deviceIds: string[]) => {
  try {
    console.log('Updating device group membership via API:', groupId, deviceIds);
    const response = await api.put(`/api/device-groups/${groupId}/devices`, { deviceIds });
    console.log('Successfully updated device group membership via API');
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error updating device group membership:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

export const setDeviceGroupMembership = async (
  groupId: string,
  payload: {
    deviceIds?: string[];
    childGroupIds?: string[];
  }
) => {
  try {
    console.log('Updating device group membership via API:', groupId, payload)
    const response = await api.put(`/api/device-groups/${groupId}/membership`, payload)
    console.log('Successfully updated device group membership via API')
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error updating device group membership:', error)
    throw new Error(error?.response?.data?.error || error.message)
  }
}

export const deleteDeviceGroup = async (groupId: string) => {
  try {
    console.log('Deleting device group via API:', groupId);
    const response = await api.delete(`/api/device-groups/${groupId}`);
    console.log('Successfully deleted device group via API');
    return response.data.data as { group: DeviceGroupSummary };
  } catch (error) {
    console.error('Error deleting device group:', error);
    throw new Error(error?.response?.data?.error || error.message);
  }
}

// Description: Control a device
// Endpoint: POST /api/devices/control
// Request: { deviceId: string, action: string, value?: number | string }
// Response: { success: boolean, data: { device: Device } }
export const controlDevice = async (data: { deviceId: string; action: string; value?: number | string }) => {
  try {
    console.log('Controlling device:', data);
    const response = await api.post('/api/devices/control', data);
    console.log('Successfully controlled device');
    return response.data?.data || {};
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

// Description: Get recent device energy history
// Endpoint: GET /api/devices/:id/energy-history
// Request: { hours?: number, limit?: number }
// Response: { success: boolean, data: { deviceId: string, hours: number, count: number, samples: Array<DeviceEnergySample> } }
export const getDeviceEnergyHistory = async (
  deviceId: string,
  options: { hours?: number; limit?: number } = {}
) => {
  try {
    console.log('Fetching device energy history from API:', deviceId, options);
    const params = new URLSearchParams();
    if (options.hours !== undefined) params.append('hours', String(options.hours));
    if (options.limit !== undefined) params.append('limit', String(options.limit));
    const queryString = params.toString();
    const url = queryString
      ? `/api/devices/${deviceId}/energy-history?${queryString}`
      : `/api/devices/${deviceId}/energy-history`;
    const response = await api.get(url);
    console.log('Successfully fetched device energy history from API');
    return response.data.data as {
      deviceId: string;
      hours: number;
      count: number;
      samples: DeviceEnergySample[];
    };
  } catch (error) {
    console.error('Error fetching device energy history:', error);
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
