import api from './api';

// Description: Get current system resource utilization
// Endpoint: GET /api/resources/utilization
// Request: {}
// Response: { cpu: object, memory: object, disk: object, gpu: object, temperature: object, uptime: object, systemInfo: object }
export const getResourceUtilization = async () => {
  try {
    const response = await api.get('/api/resources/utilization');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get historical resource data
// Endpoint: GET /api/resources/history
// Request: { limit?: number }
// Response: { history: Array<{ timestamp: Date, cpu: object, memory: object, disk: object, ... }> }
export const getResourceHistory = async (limit?: number) => {
  try {
    const response = await api.get('/api/resources/history', {
      params: { limit },
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get CPU usage
// Endpoint: GET /api/resources/cpu
// Request: {}
// Response: { usagePercent: number, cores: number, model: string, speed: number }
export const getCPUUsage = async () => {
  try {
    const response = await api.get('/api/resources/cpu');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get memory usage
// Endpoint: GET /api/resources/memory
// Request: {}
// Response: { total: number, used: number, free: number, usagePercent: number, totalGB: number, usedGB: number, freeGB: number }
export const getMemoryUsage = async () => {
  try {
    const response = await api.get('/api/resources/memory');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get disk usage
// Endpoint: GET /api/resources/disk
// Request: {}
// Response: { total: string, used: string, available: string, usagePercent: number, totalGB: number, usedGB: number, availableGB: number }
export const getDiskUsage = async () => {
  try {
    const response = await api.get('/api/resources/disk');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get GPU usage (Jetson devices)
// Endpoint: GET /api/resources/gpu
// Request: {}
// Response: { available: boolean, usagePercent: number, type: string }
export const getGPUUsage = async () => {
  try {
    const response = await api.get('/api/resources/gpu');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get system temperature
// Endpoint: GET /api/resources/temperature
// Request: {}
// Response: { available: boolean, zones: Array, average: number, maximum: number, unit: string }
export const getTemperature = async () => {
  try {
    const response = await api.get('/api/resources/temperature');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get system information
// Endpoint: GET /api/resources/system-info
// Request: {}
// Response: { platform: string, arch: string, hostname: string, release: string, type: string }
export const getSystemInfo = async () => {
  try {
    const response = await api.get('/api/resources/system-info');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get process information
// Endpoint: GET /api/resources/process
// Request: {}
// Response: { pid: number, uptime: number, memory: object, cpuUsage: object }
export const getProcessInfo = async () => {
  try {
    const response = await api.get('/api/resources/process');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Clear resource history
// Endpoint: DELETE /api/resources/history
// Request: {}
// Response: { success: boolean, message: string }
export const clearResourceHistory = async () => {
  try {
    const response = await api.delete('/api/resources/history');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};
