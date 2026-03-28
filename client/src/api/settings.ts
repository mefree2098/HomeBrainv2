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
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Update application settings
// Endpoint: PUT /api/settings
// Request: { location?: string, timezone?: string, wakeWordSensitivity?: number, voiceVolume?: number, microphoneSensitivity?: number, enableVoiceConfirmation?: boolean, enableNotifications?: boolean, insteonPort?: string, isyHost?: string, isyPort?: number, isyUsername?: string, isyPassword?: string, isyUseHttps?: boolean, isyIgnoreTlsErrors?: boolean, smartthingsToken?: string, smartthingsClientId?: string, smartthingsClientSecret?: string, smartthingsRedirectUri?: string, smartthingsUseOAuth?: boolean, harmonyHubAddresses?: string, elevenlabsApiKey?: string, enableSecurityMode?: boolean }
// Response: { success: boolean, message: string, settings: { location?: string, timezone?: string, wakeWordSensitivity?: number, voiceVolume?: number, microphoneSensitivity?: number, enableVoiceConfirmation?: boolean, enableNotifications?: boolean, insteonPort?: string, smartthingsToken?: string, smartthingsClientId?: string, smartthingsClientSecret?: string, smartthingsRedirectUri?: string, smartthingsUseOAuth?: boolean, elevenlabsApiKey?: string, enableSecurityMode?: boolean } }
export const updateSettings = async (settings: {
  location?: string;
  timezone?: string;
  wakeWordSensitivity?: number;
  voiceVolume?: number;
  microphoneSensitivity?: number;
  enableVoiceConfirmation?: boolean;
  enableNotifications?: boolean;
  insteonPort?: string;
  isyHost?: string;
  isyPort?: number;
  isyUsername?: string;
  isyPassword?: string;
  isyUseHttps?: boolean;
  isyIgnoreTlsErrors?: boolean;
  smartthingsToken?: string;
  smartthingsClientId?: string;
  smartthingsClientSecret?: string;
  smartthingsRedirectUri?: string;
  smartthingsUseOAuth?: boolean;
  harmonyHubAddresses?: string;
  elevenlabsApiKey?: string;
  enableSecurityMode?: boolean;
  llmProvider?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  codexPath?: string;
  codexHome?: string;
  codexHomeProfile?: string;
  codexAwsVolumeRoot?: string;
  codexModel?: string;
  localLlmEndpoint?: string;
  homebrainLocalLlmModel?: string;
  spamFilterLocalLlmModel?: string;
  voiceRegion?: string;
  autoDiscoveryEnabled?: boolean;
}) => {
  try {
    const response = await api.put('/api/settings', settings);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
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
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
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
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Test OpenAI API key connectivity
// Endpoint: POST /api/settings/test-openai
// Request: { apiKey: string, model?: string }
// Response: { success: boolean, message: string, models?: string[] }
export const testOpenAIApiKey = async (apiKey: string, model?: string) => {
  try {
    const response = await api.post('/api/settings/test-openai', { apiKey, model });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Test Anthropic API key connectivity
// Endpoint: POST /api/settings/test-anthropic
// Request: { apiKey: string, model?: string }
// Response: { success: boolean, message: string }
export const testAnthropicApiKey = async (apiKey: string, model?: string) => {
  try {
    const response = await api.post('/api/settings/test-anthropic', { apiKey, model });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Test local LLM endpoint connectivity
// Endpoint: POST /api/settings/test-local-llm
// Request: { endpoint: string, model?: string }
// Response: { success: boolean, message: string, models?: string[] }
export const testLocalLLM = async (endpoint: string, model?: string) => {
  try {
    const response = await api.post('/api/settings/test-local-llm', { endpoint, model });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

type CodexSettingsDraft = {
  codexPath?: string;
  codexHome?: string;
  codexHomeProfile?: string;
  codexAwsVolumeRoot?: string;
  codexModel?: string;
};

const buildCodexQuery = (draft: CodexSettingsDraft = {}, extra: Record<string, string | number | boolean | undefined> = {}) => {
  const params = new URLSearchParams();

  const entries = {
    codexPath: draft.codexPath,
    codexHome: draft.codexHome,
    codexHomeProfile: draft.codexHomeProfile,
    codexAwsVolumeRoot: draft.codexAwsVolumeRoot,
    codexModel: draft.codexModel,
    ...extra
  };

  Object.entries(entries).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return;
    }

    params.set(key, normalized);
  });

  const query = params.toString();
  return query ? `?${query}` : '';
};

export const getCodexModels = async (draft: CodexSettingsDraft = {}, options: { includeHidden?: boolean; startLogin?: boolean } = {}) => {
  try {
    const query = buildCodexQuery(draft, {
      includeHidden: options.includeHidden === true ? '1' : undefined,
      startLogin: options.startLogin === true ? '1' : undefined
    });
    const response = await api.get(`/api/settings/codex-models${query}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const getCodexAuthHealth = async (draft: CodexSettingsDraft = {}, options: { includeModelProbe?: boolean } = {}) => {
  try {
    const query = buildCodexQuery(draft, {
      includeModelProbe: options.includeModelProbe === true ? '1' : undefined
    });
    const response = await api.get(`/api/settings/codex-auth-health${query}`);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

export const completeCodexLogin = async (payload: { loginId: string; callbackUrl: string }) => {
  try {
    const response = await api.post('/api/settings/codex-login/complete', payload);
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Test SmartThings token connectivity
// Endpoint: POST /api/settings/test-smartthings
// Request: { token?: string, useOAuth?: boolean }
// Response: { success: boolean, message: string, deviceCount?: number }
export const testSmartThingsToken = async (token?: string, useOAuth?: boolean) => {
  try {
    const response = await api.post('/api/settings/test-smartthings', { token, useOAuth });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Get LLM priority list
// Endpoint: GET /api/settings/llm-priority
// Request: {}
// Response: { success: boolean, priorityList: Array<string> }
export const getLLMPriorityList = async () => {
  try {
    const response = await api.get('/api/settings/llm-priority');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Update LLM priority list
// Endpoint: PUT /api/settings/llm-priority
// Request: { priorityList: Array<string> }
// Response: { success: boolean, message: string, priorityList: Array<string> }
export const updateLLMPriorityList = async (priorityList: string[]) => {
  try {
    const response = await api.put('/api/settings/llm-priority', { priorityList });
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};
