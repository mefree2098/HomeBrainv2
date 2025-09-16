import api from './api';

// Description: Get all available voices from ElevenLabs
// Endpoint: GET /api/elevenlabs/voices
// Request: {}
// Response: { success: boolean, voices: Array<{ id: string, name: string, preview_url: string, category: string, labels: object, description: string }>, count: number }
export const getElevenLabsVoices = async () => {
  console.log('Fetching ElevenLabs voices from API');
  try {
    const response = await api.get('/api/elevenlabs/voices');
    return response.data;
  } catch (error) {
    console.error('Error fetching ElevenLabs voices:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Get voice details by ID from ElevenLabs
// Endpoint: GET /api/elevenlabs/voices/:voiceId
// Request: {}
// Response: { success: boolean, voice: { id: string, name: string, preview_url: string, category: string, labels: object, description: string, settings: object } }
export const getElevenLabsVoiceById = async (voiceId: string) => {
  console.log('Fetching ElevenLabs voice by ID:', voiceId);
  try {
    const response = await api.get(`/api/elevenlabs/voices/${voiceId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching ElevenLabs voice by ID:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Validate if voice ID exists in ElevenLabs
// Endpoint: POST /api/elevenlabs/voices/:voiceId/validate
// Request: {}
// Response: { success: boolean, valid: boolean, voiceId: string }
export const validateElevenLabsVoiceId = async (voiceId: string) => {
  console.log('Validating ElevenLabs voice ID:', voiceId);
  try {
    const response = await api.post(`/api/elevenlabs/voices/${voiceId}/validate`);
    return response.data;
  } catch (error) {
    console.error('Error validating ElevenLabs voice ID:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Description: Convert text to speech using ElevenLabs TTS
// Endpoint: POST /api/elevenlabs/text-to-speech
// Request: { text: string, voiceId: string, options?: { stability?: number, similarity_boost?: number, style?: number, use_speaker_boost?: boolean, model_id?: string } }
// Response: Audio file (audio/mpeg) as blob
export const textToSpeechElevenLabs = async (data: {
  text: string;
  voiceId: string;
  options?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    model_id?: string;
  };
}) => {
  console.log('Converting text to speech with ElevenLabs:', data);
  try {
    const response = await api.post('/api/elevenlabs/text-to-speech', data, {
      responseType: 'blob',
      transformResponse: [] // Disable JSON parsing for blob responses
    });
    
    // Return the audio blob
    return new Blob([response.data], { type: 'audio/mpeg' });
  } catch (error) {
    console.error('Error converting text to speech:', error);
    
    // Handle blob response errors differently
    if (error?.response?.status === 503) {
      throw new Error('ElevenLabs service is not configured. Please set up your API key in settings.');
    } else if (error?.response?.status === 429) {
      throw new Error('Too many requests. Please wait a moment before trying again.');
    } else if (error?.response?.status === 400) {
      throw new Error('Invalid request. Please check your text and voice selection.');
    } else {
      throw new Error(error?.response?.statusText || error.message || 'Failed to generate speech');
    }
  }
}

// Description: Generate voice preview with ElevenLabs
// Endpoint: POST /api/elevenlabs/preview
// Request: { voiceId: string, text?: string }
// Response: Audio file (audio/mpeg) as blob
export const generateVoicePreview = async (data: { voiceId: string; text?: string }) => {
  console.log('Generating voice preview with ElevenLabs:', data);
  try {
    const response = await api.post('/api/elevenlabs/preview', data, {
      responseType: 'blob',
      transformResponse: [] // Disable JSON parsing for blob responses
    });
    
    // Check if response is actually a blob (successful audio response)
    if (response.data instanceof Blob && response.data.type.startsWith('audio/')) {
      return response.data;
    } else {
      // If we get here, the response might be an error message in blob format
      console.warn('Received non-audio blob response:', response.data);
      return new Blob([response.data], { type: 'audio/mpeg' });
    }
  } catch (error) {
    console.error('Error generating voice preview:', error);
    
    // Try to extract meaningful error message
    let errorMessage = 'Failed to generate voice preview';
    
    if (error?.response?.data) {
      try {
        // If error response is a blob, try to read it as text
        if (error.response.data instanceof Blob) {
          const errorText = await error.response.data.text();
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorMessage;
        } else if (typeof error.response.data === 'object') {
          errorMessage = error.response.data.message || error.response.data.error || errorMessage;
        } else if (typeof error.response.data === 'string') {
          errorMessage = error.response.data;
        }
      } catch (parseError) {
        console.warn('Could not parse error response:', parseError);
        // Fall through to status-based error handling
      }
    }
    
    // Handle specific HTTP status codes
    if (error?.response?.status === 503) {
      errorMessage = 'ElevenLabs service is not configured. Please set up your API key in settings.';
    } else if (error?.response?.status === 429) {
      errorMessage = 'Too many requests. Please wait a moment before trying again.';
    } else if (error?.response?.status === 400) {
      errorMessage = 'Invalid voice ID or request. Please try a different voice.';
    } else if (error?.response?.status === 500) {
      errorMessage = 'Server error occurred. Please try again in a moment.';
    } else if (error?.code === 'ECONNRESET' || error?.message?.includes('socket hang up')) {
      errorMessage = 'Network connection issue. Please try again.';
    }
    
    throw new Error(errorMessage);
  }
}

// Description: Get ElevenLabs integration status
// Endpoint: GET /api/elevenlabs/status
// Request: {}
// Response: { success: boolean, status: { configured: boolean, apiKeyValid: boolean, totalVoices: number, service: string, baseUrl: string } }
export const getElevenLabsStatus = async () => {
  console.log('Fetching ElevenLabs integration status');
  try {
    const response = await api.get('/api/elevenlabs/status');
    return response.data;
  } catch (error) {
    console.error('Error fetching ElevenLabs status:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
}

// Utility function to create audio URL from blob for playback
export const createAudioUrl = (audioBlob: Blob): string => {
  return URL.createObjectURL(audioBlob);
}

// Utility function to download audio file
export const downloadAudioFile = (audioBlob: Blob, filename: string = 'speech.mp3') => {
  const url = createAudioUrl(audioBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Utility function to play audio blob
export const playAudioBlob = (audioBlob: Blob): Promise<void> => {
  return new Promise((resolve, reject) => {
    const url = createAudioUrl(audioBlob);
    const audio = new Audio(url);
    
    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    
    audio.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    
    audio.play().catch(reject);
  });
}