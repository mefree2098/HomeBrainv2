import api from './api';

// Enhanced request cache to aggressively prevent duplicate API calls
const requestCache = new Map<string, { data: any; timestamp: number; promise?: Promise<any> }>();
const CACHE_DURATION = 10000; // 10 seconds cache (more aggressive)
const IN_FLIGHT_REQUESTS = new Map<string, Promise<any>>(); // Track in-flight requests globally

// Debug mode controlled by environment variable
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_API_DEBUG === 'true';

// Debug function to monitor cache usage (only in debug mode)
const logCacheStats = () => {
  if (DEBUG_MODE) {
    console.log('Voice API Cache Stats:', {
      cached: requestCache.size,
      inFlight: IN_FLIGHT_REQUESTS.size,
      keys: Array.from(requestCache.keys()),
      flightKeys: Array.from(IN_FLIGHT_REQUESTS.keys())
    });
  }
};

// Description: Get voice system status
// Endpoint: GET /api/voice/status
// Request: {}
// Response: { listening: boolean, connected: boolean, activeDevices: number, totalDevices: number, deviceStats: object }
export const getVoiceStatus = async () => {
  const cacheKey = 'voice-status';
  const now = Date.now();
  
  // Check if we have a recent cached response
  const cached = requestCache.get(cacheKey);
  if (cached && cached.data && (now - cached.timestamp) < CACHE_DURATION) {
    if (DEBUG_MODE) console.log('Using cached voice status (10s cache)');
    return cached.data;
  }

  // Check for global in-flight request
  if (IN_FLIGHT_REQUESTS.has(cacheKey)) {
    if (DEBUG_MODE) console.log('Waiting for global in-flight voice status request');
    return await IN_FLIGHT_REQUESTS.get(cacheKey);
  }

  if (DEBUG_MODE) console.log('Fetching voice status from API');
  logCacheStats();
  
  // Create and track the promise globally
  const requestPromise = (async () => {
    try {
      const response = await api.get('/api/voice/status');
      const data = response.data;
      
      // Update cache with successful response
      requestCache.set(cacheKey, {
        data,
        timestamp: now
      });
      
      return data;
    } catch (error) {
      // Remove failed request from cache
      requestCache.delete(cacheKey);
      console.error('Error fetching voice status:', error);
      throw new Error(error?.response?.data?.message || error.message);
    } finally {
      // Always clean up in-flight tracking
      IN_FLIGHT_REQUESTS.delete(cacheKey);
    }
  })();
  
  // Track this request globally
  IN_FLIGHT_REQUESTS.set(cacheKey, requestPromise);
  
  return await requestPromise;
}

// Description: Get all voice devices
// Endpoint: GET /api/voice/devices
// Request: {}
// Response: { success: boolean, devices: Array<{ _id: string, name: string, room: string, deviceType: string, status: string, lastSeen: string, batteryLevel?: number, powerSource: string, connectionType: string, ipAddress?: string, volume: number, microphoneSensitivity: number, firmwareVersion?: string, uptime: number }>, count: number }
export const getVoiceDevices = async () => {
  const cacheKey = 'voice-devices';
  const now = Date.now();
  
  // Check if we have a recent cached response
  const cached = requestCache.get(cacheKey);
  if (cached && cached.data && (now - cached.timestamp) < CACHE_DURATION) {
    if (DEBUG_MODE) console.log('Using cached voice devices (10s cache)');
    return cached.data;
  }

  // Check for global in-flight request
  if (IN_FLIGHT_REQUESTS.has(cacheKey)) {
    if (DEBUG_MODE) console.log('Waiting for global in-flight voice devices request');
    return await IN_FLIGHT_REQUESTS.get(cacheKey);
  }

  if (DEBUG_MODE) console.log('Fetching voice devices from API');
  logCacheStats();
  
  // Create and track the promise globally
  const requestPromise = (async () => {
    try {
      const response = await api.get('/api/voice/devices');
      const data = response.data;
      
      // Update cache with successful response
      requestCache.set(cacheKey, {
        data,
        timestamp: now
      });
      
      return data;
    } catch (error) {
      // Remove failed request from cache
      requestCache.delete(cacheKey);
      console.error('Error fetching voice devices:', error);
      throw new Error(error?.response?.data?.message || error.message);
    } finally {
      // Always clean up in-flight tracking
      IN_FLIGHT_REQUESTS.delete(cacheKey);
    }
  })();
  
  // Track this request globally
  IN_FLIGHT_REQUESTS.set(cacheKey, requestPromise);
  
  return await requestPromise;
}

// Description: Test voice device
// Endpoint: POST /api/voice/test
// Request: { deviceId: string }
// Response: { success: boolean, message: string, deviceName: string, room: string, testResults: object }
export const testVoiceDevice = async (data: { deviceId: string }) => {
  console.log('Testing voice device:', data)
  try {
    const response = await api.post('/api/voice/test', data);
    return response.data;
  } catch (error) {
    console.error('Error testing voice device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get voice device by ID
// Endpoint: GET /api/voice/devices/:id
// Request: {}
// Response: { success: boolean, device: object }
export const getVoiceDeviceById = async (deviceId: string) => {
  console.log('Fetching voice device by ID:', deviceId)
  try {
    const response = await api.get(`/api/voice/devices/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching voice device by ID:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Update voice device status
// Endpoint: PUT /api/voice/devices/:id/status
// Request: { status: string }
// Response: { success: boolean, message: string, device: object }
export const updateVoiceDeviceStatus = async (deviceId: string, status: string) => {
  console.log('Updating voice device status:', deviceId, status)
  try {
    const response = await api.put(`/api/voice/devices/${deviceId}/status`, { status });
    return response.data;
  } catch (error) {
    console.error('Error updating voice device status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get voice devices by room
// Endpoint: GET /api/voice/devices/room/:room
// Request: {}
// Response: { success: boolean, devices: Array<object>, room: string, count: number }
export const getVoiceDevicesByRoom = async (room: string) => {
  console.log('Fetching voice devices by room:', room)
  try {
    const response = await api.get(`/api/voice/devices/room/${encodeURIComponent(room)}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching voice devices by room:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get voice devices by status
// Endpoint: GET /api/voice/devices/status/:status
// Request: {}
// Response: { success: boolean, devices: Array<object>, status: string, count: number }
export const getVoiceDevicesByStatus = async (status: string) => {
  console.log('Fetching voice devices by status:', status)
  try {
    const response = await api.get(`/api/voice/devices/status/${status}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching voice devices by status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}