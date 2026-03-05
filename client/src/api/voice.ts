import api from './api';
import JSONbig from 'json-bigint';

// Enhanced request cache to aggressively prevent duplicate API calls
const requestCache = new Map<string, { data: any; timestamp: number; promise?: Promise<any> }>();
const CACHE_DURATION = 10000; // 10 seconds cache (more aggressive)
const IN_FLIGHT_REQUESTS = new Map<string, Promise<any>>(); // Track in-flight requests globally
const BROWSER_STT_FETCH_TIMEOUT_MS = 18000;

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

export interface VoiceCommandResult {
  success: boolean;
  processedText: string;
  intent: {
    action: string;
    confidence: number;
    entities: {
      devices: Array<Record<string, unknown>>;
      scenes: Array<Record<string, unknown>>;
      actions: Array<Record<string, unknown>>;
    };
  };
  execution: {
    status: string;
    actions: Array<Record<string, unknown>>;
  };
  responseText: string;
  llm?: {
    provider?: string | null;
    model?: string | null;
    runtime?: {
      model?: string | null;
      sizeBytes?: number | null;
      sizeVramBytes?: number | null;
      gpuPercent?: number | null;
      processor?: string | null;
    } | null;
    prompt?: string;
    rawResponse?: string | null;
    processingTimeMs?: number;
    error?: string | null;
  };
  followUpQuestion: string | null;
  usedFallback: boolean;
  stt?: unknown;
}

export interface BrowserTranscriptionResult {
  provider: string;
  model: string;
  text: string;
  language?: string | null;
  confidence?: number | null;
  processingTimeMs?: number | null;
  device?: string | null;
  computeType?: string | null;
  beamSize?: number | null;
  duration?: number | null;
  segments?: Array<Record<string, unknown>>;
}

const coerceBrowserTranscriptionPayload = (parsed: any): BrowserTranscriptionResult | null => {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  // Preferred/current contract.
  if (parsed.stt && typeof parsed.stt === 'object') {
    const stt = parsed.stt;
    return {
      provider: String(stt.provider || 'unknown'),
      model: String(stt.model || 'unknown'),
      text: typeof stt.text === 'string' ? stt.text : '',
      language: stt.language ?? null,
      confidence: typeof stt.confidence === 'number' ? stt.confidence : null,
      processingTimeMs: typeof stt.processingTimeMs === 'number' ? stt.processingTimeMs : null,
      device: typeof stt.device === 'string' ? stt.device : null,
      computeType: typeof stt.computeType === 'string' ? stt.computeType : null,
      beamSize: typeof stt.beamSize === 'number' ? stt.beamSize : null,
      duration: typeof stt.duration === 'number' ? stt.duration : null,
      segments: Array.isArray(stt.segments) ? stt.segments : []
    };
  }

  // Legacy/alternate contracts.
  const candidate = parsed.transcription || parsed.result || parsed.data || parsed;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const candidateText = typeof candidate.text === 'string'
    ? candidate.text
    : (typeof candidate.transcript === 'string' ? candidate.transcript : '');
  if (!candidateText && typeof candidate.provider === 'undefined' && typeof candidate.model === 'undefined') {
    return null;
  }

  return {
    provider: String(candidate.provider || 'unknown'),
    model: String(candidate.model || 'unknown'),
    text: candidateText || '',
    language: candidate.language ?? null,
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null,
    processingTimeMs: typeof candidate.processingTimeMs === 'number' ? candidate.processingTimeMs : null,
    device: typeof candidate.device === 'string' ? candidate.device : null,
    computeType: typeof candidate.computeType === 'string' ? candidate.computeType : null,
    beamSize: typeof candidate.beamSize === 'number' ? candidate.beamSize : null,
    duration: typeof candidate.duration === 'number' ? candidate.duration : null,
    segments: Array.isArray(candidate.segments) ? candidate.segments : []
  };
};

// Description: Interpret a voice command through the full pipeline
// Endpoint: POST /api/voice/commands/interpret
// Request: { commandText: string, room?: string, wakeWord?: string, deviceId?: string }
// Response: VoiceCommandResult
export const interpretVoiceCommand = async (payload: {
  commandText: string;
  room?: string | null;
  wakeWord?: string | null;
  deviceId?: string | null;
  stt?: unknown;
}): Promise<VoiceCommandResult> => {
  console.log('Interpreting voice command:', payload);
  try {
    const response = await api.post('/api/voice/commands/interpret', payload);
    return response.data as VoiceCommandResult;
  } catch (error: any) {
    console.error('Error interpreting voice command:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Transcribe browser-recorded audio through server STT
// Endpoint: POST /api/voice/browser/transcribe
// Request: { audioBase64: string, mimeType?: string, language?: string }
// Response: { success: boolean, stt: BrowserTranscriptionResult }
export const transcribeBrowserAudio = async (payload: {
  audioBase64: string;
  mimeType?: string;
  language?: string;
  profile?: "realtime" | "default";
}): Promise<BrowserTranscriptionResult> => {
  const attempt = async (path: string) => {
    const token = localStorage.getItem('accessToken');
    const timeoutMs = payload?.profile === 'realtime'
      ? BROWSER_STT_FETCH_TIMEOUT_MS
      : BROWSER_STT_FETCH_TIMEOUT_MS + 6000;
    const controller = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    const timeout = setTimeout(() => {
      controller?.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      const aborted = error?.name === 'AbortError' || message.toLowerCase().includes('abort');
      if (aborted) {
        throw new Error(`Browser STT request timed out after ${timeoutMs}ms (${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let parsed: any = null;
    if (raw && raw.trim()) {
      try {
        parsed = JSONbig.parse(raw);
      } catch (_error) {
        parsed = null;
      }
    }

    if (!response.ok) {
      const serverMessage = parsed?.message || parsed?.error;
      const snippet = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
      throw new Error(serverMessage || `HTTP ${response.status} from ${path}: ${snippet || response.statusText}`);
    }

    const sttPayload = coerceBrowserTranscriptionPayload(parsed);
    if (!sttPayload) {
      const snippet = typeof raw === 'string' ? raw.trim().slice(0, 220) : '';
      throw new Error(`Missing STT payload from ${path}${snippet ? `: ${snippet}` : ''}`);
    }

    return sttPayload;
  };

  try {
    return await attempt('/api/voice/browser/transcribe');
  } catch (error: any) {
    const firstMessage = error?.message || 'Unknown browser transcription error';
    const shouldRetryWithSlash =
      firstMessage.includes('HTTP 404') ||
      firstMessage.toLowerCase().includes('page not found') ||
      firstMessage.toLowerCase().includes('timed out') ||
      firstMessage.toLowerCase().includes('networkerror') ||
      firstMessage.toLowerCase().includes('failed to fetch');

    if (shouldRetryWithSlash) {
      try {
        return await attempt('/api/voice/browser/transcribe/');
      } catch (retryError: any) {
        console.error('Error transcribing browser audio (retry failed):', retryError);
        throw new Error(retryError?.message || firstMessage);
      }
    }

    console.error('Error transcribing browser audio:', error);
    throw new Error(firstMessage);
  }
};

// Description: Fetch browser wake acknowledgment audio from server cache/TTS
// Endpoint: POST /api/voice/browser/acknowledgment
// Request: { wakeWord?: string }
// Response: audio/mpeg blob (or 204 when unavailable)
export const fetchBrowserWakeAcknowledgmentAudio = async (payload: {
  wakeWord?: string;
}): Promise<Blob | null> => {
  const token = localStorage.getItem('accessToken');
  const response = await fetch('/api/voice/browser/acknowledgment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload || {})
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let message = '';
    if (raw && raw.trim()) {
      try {
        const parsed = JSONbig.parse(raw);
        message = parsed?.message || parsed?.error || '';
      } catch (_error) {
        message = raw.trim().slice(0, 200);
      }
    }
    throw new Error(message || `HTTP ${response.status} from /api/voice/browser/acknowledgment`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    return null;
  }

  if (contentType.includes('audio/')) {
    return blob;
  }

  const raw = await blob.text().catch(() => '');
  throw new Error(raw || 'Unexpected non-audio acknowledgment payload');
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
export const pushConfigToDevice = async (deviceId: string) => {
  try {
    const response = await api.post(`/api/voice/devices/${deviceId}/push-config`, {});
    return response.data;
  } catch (error) {
    console.error('Error pushing config to device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

export const pingTtsToDevice = async (deviceId: string, text?: string) => {
  try {
    const response = await api.post(`/api/voice/devices/${deviceId}/ping-tts`, { text });
    return response.data;
  } catch (error) {
    console.error('Error sending TTS to device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Update voice device settings (volume, microphoneSensitivity, wake word VAD, etc.)
// Endpoint: PUT /api/voice/devices/:id/settings
// Request: { volume?: number, microphoneSensitivity?: number, wakeWordVad?: object }
// Response: { success: boolean, device: object }
export const updateVoiceDeviceSettings = async (deviceId: string, updates: Record<string, unknown>) => {
  try {
    const response = await api.put(`/api/voice/devices/${deviceId}/settings`, updates);
    return response.data;
  } catch (error) {
    console.error('Error updating voice device settings:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

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
