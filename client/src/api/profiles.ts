import api from './api';

// Description: Get all user profiles
// Endpoint: GET /api/profiles
// Request: {}
// Response: { profiles: Array<{ _id: string, name: string, wakeWords: Array<string>, voiceId: string, systemPrompt: string, active: boolean }> }
export const getUserProfiles = () => {
  console.log('Fetching user profiles from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        profiles: [
          {
            _id: '1',
            name: 'Anna',
            wakeWords: ['Anna', 'Hey Anna'],
            voiceId: 'elevenlabs-voice-1',
            systemPrompt: 'You are Anna, a helpful and friendly home assistant.',
            active: true
          },
          {
            _id: '2',
            name: 'Henry',
            wakeWords: ['Henry', 'Hey Henry'],
            voiceId: 'elevenlabs-voice-2',
            systemPrompt: 'You are Henry, a professional and efficient home assistant.',
            active: true
          },
          {
            _id: '3',
            name: 'Guest',
            wakeWords: ['Home Brain', 'Computer'],
            voiceId: 'elevenlabs-voice-3',
            systemPrompt: 'You are a neutral home assistant for guests.',
            active: false
          }
        ]
      });
    }, 500);
  });
  // try {
  //   return await api.get('/api/profiles');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Create or update user profile
// Endpoint: POST /api/profiles
// Request: { name: string, wakeWords: Array<string>, voiceId: string, systemPrompt: string }
// Response: { success: boolean, profile: object }
export const saveUserProfile = (data: { name: string; wakeWords: Array<string>; voiceId: string; systemPrompt: string }) => {
  console.log('Saving user profile:', data)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        success: true,
        profile: {
          _id: Date.now().toString(),
          ...data,
          active: true
        }
      });
    }, 600);
  });
  // try {
  //   return await api.post('/api/profiles', data);
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}

// Description: Get available ElevenLabs voices
// Endpoint: GET /api/profiles/voices
// Request: {}
// Response: { voices: Array<{ id: string, name: string, preview_url: string }> }
export const getAvailableVoices = () => {
  console.log('Fetching available voices from API')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        voices: [
          { id: 'elevenlabs-voice-1', name: 'Sarah - Friendly Female', preview_url: '' },
          { id: 'elevenlabs-voice-2', name: 'James - Professional Male', preview_url: '' },
          { id: 'elevenlabs-voice-3', name: 'Alex - Neutral Voice', preview_url: '' },
          { id: 'elevenlabs-voice-4', name: 'Emma - Warm Female', preview_url: '' },
          { id: 'elevenlabs-voice-5', name: 'David - Deep Male', preview_url: '' }
        ]
      });
    }, 400);
  });
  // try {
  //   return await api.get('/api/profiles/voices');
  // } catch (error) {
  //   throw new Error(error?.response?.data?.message || error.message);
  // }
}