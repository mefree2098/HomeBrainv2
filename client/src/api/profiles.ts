import api from './api';

// Description: Get all user profiles
// Endpoint: GET /api/profiles
// Request: {}
// Response: { success: boolean, profiles: Array<{ _id: string, name: string, wakeWords: Array<string>, voiceId: string, systemPrompt: string, active: boolean }> }
export const getUserProfiles = async () => {
  console.log('Fetching user profiles from API');
  try {
    const response = await api.get('/api/profiles');
    return response.data;
  } catch (error) {
    console.error('Error fetching user profiles:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Create new user profile
// Endpoint: POST /api/profiles
// Request: { name: string, wakeWords: Array<string>, voiceId: string, systemPrompt: string, [other optional fields] }
// Response: { success: boolean, message: string, profile: object }
export const createUserProfile = async (data: { 
  name: string; 
  wakeWords: Array<string>; 
  voiceId: string; 
  systemPrompt: string; 
  voiceName?: string;
  personality?: string;
  responseStyle?: string;
  preferredLanguage?: string;
  timezone?: string;
  speechRate?: number;
  speechPitch?: number;
  permissions?: Array<string>;
  avatar?: string;
  birthDate?: Date;
  contextMemory?: boolean;
  learningMode?: boolean;
  privacyMode?: boolean;
}) => {
  console.log('Creating user profile:', data);
  try {
    const response = await api.post('/api/profiles', data);
    return response.data;
  } catch (error) {
    console.error('Error creating user profile:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Update user profile
// Endpoint: PUT /api/profiles/:id
// Request: { [any profile fields to update] }
// Response: { success: boolean, message: string, profile: object }
export const updateUserProfile = async (profileId: string, data: any) => {
  console.log('Updating user profile:', profileId, data);
  try {
    const response = await api.put(`/api/profiles/${profileId}`, data);
    return response.data;
  } catch (error) {
    console.error('Error updating user profile:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Legacy function for backward compatibility
export const saveUserProfile = createUserProfile;

// Description: Get available ElevenLabs voices
// Endpoint: GET /api/profiles/voices
// Request: {}
// Response: { success: boolean, voices: Array<{ id: string, name: string, preview_url: string }> }
export const getAvailableVoices = async () => {
  console.log('Fetching available voices from API');
  try {
    const response = await api.get('/api/profiles/voices');
    return response.data;
  } catch (error) {
    console.error('Error fetching available voices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get user profile by ID
// Endpoint: GET /api/profiles/:id
// Request: {}
// Response: { success: boolean, profile: object }
export const getUserProfileById = async (profileId: string) => {
  console.log('Fetching user profile by ID:', profileId);
  try {
    const response = await api.get(`/api/profiles/${profileId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching user profile by ID:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Delete user profile
// Endpoint: DELETE /api/profiles/:id
// Request: {}
// Response: { success: boolean, message: string }
export const deleteUserProfile = async (profileId: string) => {
  console.log('Deleting user profile:', profileId);
  try {
    const response = await api.delete(`/api/profiles/${profileId}`);
    return response.data;
  } catch (error) {
    console.error('Error deleting user profile:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Toggle profile active status
// Endpoint: PATCH /api/profiles/:id/toggle
// Request: {}
// Response: { success: boolean, message: string, profile: object }
export const toggleProfileStatus = async (profileId: string) => {
  console.log('Toggling profile status:', profileId);
  try {
    const response = await api.patch(`/api/profiles/${profileId}/toggle`);
    return response.data;
  } catch (error) {
    console.error('Error toggling profile status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Update profile usage tracking
// Endpoint: PATCH /api/profiles/:id/usage
// Request: {}
// Response: { success: boolean, message: string, profile: object }
export const updateProfileUsage = async (profileId: string) => {
  console.log('Updating profile usage:', profileId);
  try {
    const response = await api.patch(`/api/profiles/${profileId}/usage`);
    return response.data;
  } catch (error) {
    console.error('Error updating profile usage:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Add device to profile favorites
// Endpoint: POST /api/profiles/:id/favorites/devices
// Request: { deviceId: string }
// Response: { success: boolean, message: string, profile: object }
export const addFavoriteDevice = async (profileId: string, deviceId: string) => {
  console.log('Adding favorite device:', profileId, deviceId);
  try {
    const response = await api.post(`/api/profiles/${profileId}/favorites/devices`, { deviceId });
    return response.data;
  } catch (error) {
    console.error('Error adding favorite device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Remove device from profile favorites
// Endpoint: DELETE /api/profiles/:id/favorites/devices/:deviceId
// Request: {}
// Response: { success: boolean, message: string, profile: object }
export const removeFavoriteDevice = async (profileId: string, deviceId: string) => {
  console.log('Removing favorite device:', profileId, deviceId);
  try {
    const response = await api.delete(`/api/profiles/${profileId}/favorites/devices/${deviceId}`);
    return response.data;
  } catch (error) {
    console.error('Error removing favorite device:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get voice details by ID
// Endpoint: GET /api/profiles/voices/:voiceId
// Request: {}
// Response: { success: boolean, voice: object }
export const getVoiceById = async (voiceId: string) => {
  console.log('Fetching voice details by ID:', voiceId);
  try {
    const response = await api.get(`/api/profiles/voices/${voiceId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching voice details:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get profiles by wake word
// Endpoint: GET /api/profiles/wake-word/:wakeWord
// Request: {}
// Response: { success: boolean, profiles: Array<object> }
export const getProfilesByWakeWord = async (wakeWord: string) => {
  console.log('Fetching profiles by wake word:', wakeWord);
  try {
    const response = await api.get(`/api/profiles/wake-word/${wakeWord}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching profiles by wake word:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}