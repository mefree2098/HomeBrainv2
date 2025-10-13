import api from './api';

export interface PiperVoice {
  id: string;
  name: string;
  language: string;
  speaker?: string;
  quality?: string;
  sizeBytes?: number;
  installed: boolean;
  modelPath?: string | null;
  configPath?: string | null;
}

export interface PiperVoiceResponse {
  success: boolean;
  voices: PiperVoice[];
}

export const getPiperVoices = async (): Promise<PiperVoiceResponse> => {
  const response = await api.get('/api/wake-words/voices');
  return response.data;
};

export const downloadPiperVoice = async (voiceId: string) => {
  const response = await api.post(`/api/wake-words/voices/${voiceId}`);
  return response.data;
};

export const removePiperVoice = async (voiceId: string) => {
  const response = await api.delete(`/api/wake-words/voices/${voiceId}`);
  return response.data;
};
