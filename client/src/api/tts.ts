import api from './api';

export type TtsVoice = {
  id: string;
  name: string;
  provider: string;
  previewUrl?: string;
  raw?: unknown;
};

export const getTtsVoices = async (params: {
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  voiceId?: string;
  model?: string;
  format?: string;
  timeoutMs?: number;
}) => {
  try {
    const response = await api.post('/api/tts/voices/query', params);
    return response.data as { success: boolean; provider: string; voices: TtsVoice[]; count: number; endpoint?: string };
  } catch (error) {
    console.error('Error fetching TTS voices:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const testTtsProvider = async (data: {
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  voiceId?: string;
  model?: string;
  format?: string;
  timeoutMs?: number;
  text?: string;
}) => {
  try {
    const response = await api.post('/api/tts/test', data);
    return response.data;
  } catch (error) {
    console.error('Error testing TTS provider:', error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const generateTtsPreview = async (data: {
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  voiceId?: string;
  model?: string;
  format?: string;
  timeoutMs?: number;
  text?: string;
}) => {
  try {
    const response = await api.post('/api/tts/preview', data, {
      responseType: 'blob',
      transformResponse: []
    });
    return new Blob([response.data], { type: response.headers?.['content-type'] || 'audio/mpeg' });
  } catch (error) {
    console.error('Error generating TTS preview:', error);
    if (error?.response?.data instanceof Blob) {
      const text = await error.response.data.text();
      try {
        const parsed = JSON.parse(text);
        throw new Error(parsed.message || parsed.error || 'Failed to generate TTS preview');
      } catch (_parseError) {
        throw new Error(text || 'Failed to generate TTS preview');
      }
    }
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};
