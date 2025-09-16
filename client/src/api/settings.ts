import api from './api';

// Description: Get application settings
// Endpoint: GET /api/settings
// Request: {}
// Response: { success: boolean, settings: { location?: string, timezone?: string, wakeWordSensitivity?: number, voiceVolume?: number, microphoneSensitivity?: number, enableVoiceConfirmation?: boolean, enableNotifications?: boolean, insteonPort?: string, smartthingsToken?: string, elevenlabsApiKey?: string, enableSecurityMode?: boolean } }
export const getSettings = async () => {
  try {
    const response = await api.get('/api/settings');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Update application settings
// Endpoint: PUT /api/settings
// Request: { location?: string, timezone?: string, wakeWordSensitivity?: number, voiceVolume?: number, microphoneSensitivity?: number, enableVoiceConfirmation?: boolean, enableNotifications?: boolean, insteonPort?: string, smartthingsToken?: string, elevenlabsApiKey?: string, enableSecurityMode?: boolean }
// Response: { success: boolean, message: string, settings: { location?: string, timezone?: string, wakeWordSensitivity?: number, voiceVolume?: number, microphoneSensitivity?: number, enableVoiceConfirmation?: boolean, enableNotifications?: boolean, insteonPort?: string, smartthingsToken?: string, elevenlabsApiKey?: string, enableSecurityMode?: boolean } }
export const updateSettings = async (settings: {
  location?: string;
  timezone?: string;
  wakeWordSensitivity?: number;
  voiceVolume?: number;
  microphoneSensitivity?: number;
  enableVoiceConfirmation?: boolean;
  enableNotifications?: boolean;
  insteonPort?: string;
  smartthingsToken?: string;
  elevenlabsApiKey?: string;
  enableSecurityMode?: boolean;
}) => {
  try {
    const response = await api.put('/api/settings', settings);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get specific setting value
// Endpoint: GET /api/settings/:key
// Request: {}
// Response: { success: boolean, key: string, value: any }
export const getSetting = async (key: string) => {
  try {
    const response = await api.get(`/api/settings/${key}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Test ElevenLabs API key connectivity
// Endpoint: POST /api/settings/test-elevenlabs
// Request: { apiKey: string }
// Response: { success: boolean, message: string, voiceCount?: number }
export const testElevenLabsApiKey = async (apiKey: string) => {
  try {
    const response = await api.post('/api/settings/test-elevenlabs', { apiKey });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};