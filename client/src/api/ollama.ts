import api from './api';

// Description: Get Ollama status and configuration
// Endpoint: GET /api/ollama/status
// Request: {}
// Response: { isInstalled: boolean, version: string, serviceRunning: boolean, installedModels: Array, activeModel: string, ... }
export const getOllamaStatus = async () => {
  try {
    const response = await api.get('/api/ollama/status');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Retrieve recent Ollama service logs
// Endpoint: GET /api/ollama/logs
// Request: { lines?: number }
// Response: { success: boolean, source: string|null, sourceType: string|null, lines: string[], lineCount: number, truncated: boolean, message?: string }
export const getOllamaLogs = async (lines?: number) => {
  try {
    const response = await api.get('/api/ollama/logs', {
      params: typeof lines === 'number' ? { lines } : undefined,
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(
      error?.response?.data?.error ||
        error?.response?.data?.message ||
        error.message
    );
  }
};

// Description: Install Ollama
// Endpoint: POST /api/ollama/install
// Request: { sudoPassword?: string }
// Response: { success: boolean, version: string }
export const installOllama = async (sudoPassword?: string) => {
  try {
    const payload = sudoPassword ? { sudoPassword } : {};
    const response = await api.post('/api/ollama/install', payload);
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Start Ollama service
// Endpoint: POST /api/ollama/service/start
// Request: {}
// Response: { success: boolean, message: string }
export const startOllamaService = async () => {
  try {
    const response = await api.post('/api/ollama/service/start');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Stop Ollama service
// Endpoint: POST /api/ollama/service/stop
// Request: {}
// Response: { success: boolean, message: string }
export const stopOllamaService = async () => {
  try {
    const response = await api.post('/api/ollama/service/stop');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Check for Ollama updates
// Endpoint: GET /api/ollama/updates/check
// Request: {}
// Response: { updateAvailable: boolean, currentVersion: string, latestVersion: string }
export const checkOllamaUpdates = async () => {
  try {
    const response = await api.get('/api/ollama/updates/check');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Update Ollama to latest version
// Endpoint: POST /api/ollama/update
// Request: { sudoPassword?: string }
// Response: { success: boolean, version: string }
export const updateOllama = async (sudoPassword?: string) => {
  try {
    const payload = sudoPassword ? { sudoPassword } : {};
    const response = await api.post('/api/ollama/update', payload);
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: List installed models
// Endpoint: GET /api/ollama/models
// Request: {}
// Response: { models: Array<{ name: string, size: number, modifiedAt: Date, ... }> }
export const getInstalledModels = async () => {
  try {
    const response = await api.get('/api/ollama/models');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get available models for download
// Endpoint: GET /api/ollama/models/available
// Request: { q?: string, c?: string[], o?: "popular"|"newest", maxPages?: number }
// Response: { models: Array<{ name: string, description: string, size: string, parameterSize: string, capabilities?: string[], nanoFit?: boolean }> }
export const getAvailableModels = async (params?: {
  q?: string;
  c?: string[];
  o?: 'popular' | 'newest';
  maxPages?: number;
}) => {
  try {
    const response = await api.get('/api/ollama/models/available', {
      params,
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Pull/download a model
// Endpoint: POST /api/ollama/models/pull
// Request: { modelName: string }
// Response: { success: boolean, message: string }
export const pullModel = async (modelName: string) => {
  try {
    const response = await api.post('/api/ollama/models/pull', { modelName });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Get active model pull/download status
// Endpoint: GET /api/ollama/models/pull/status
// Request: {}
// Response: { active: boolean, modelName: string|null, status: string, message: string, percent?: number|null }
export const getModelPullStatus = async () => {
  try {
    const response = await api.get('/api/ollama/models/pull/status');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Delete a model
// Endpoint: DELETE /api/ollama/models/:name
// Request: {}
// Response: { success: boolean, message: string }
export const deleteModel = async (modelName: string) => {
  try {
    const response = await api.delete(`/api/ollama/models/${modelName}`);
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Set active model
// Endpoint: POST /api/ollama/models/activate
// Request: { modelName: string }
// Response: { success: boolean, activeModel: string }
export const activateModel = async (modelName: string) => {
  try {
    const response = await api.post('/api/ollama/models/activate', { modelName });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Update the single shared local model used by HomeBrain and spam filtering
// Endpoint: POST /api/ollama/models/roles
// Request: { modelName: string }
// Response: { success: boolean, modelName: string, activeModel: string, homebrainLocalLlmModel: string, spamFilterLocalLlmModel: string }
export const updateModelRoles = async (modelName: string) => {
  try {
    const response = await api.post('/api/ollama/models/roles', {
      modelName,
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Send chat message to model
// Endpoint: POST /api/ollama/chat
// Request: { modelName?: string, message: string, conversationHistory?: Array<{ role: string, content: string }> }
// Response: { message: string, model: string, done: boolean, totalDuration: number, ... }
export const sendChatMessage = async (
  message: string,
  modelName?: string,
  conversationHistory?: Array<{ role: string; content: string }>
) => {
  try {
    const response = await api.post('/api/ollama/chat', {
      message,
      modelName,
      conversationHistory,
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Generate text completion
// Endpoint: POST /api/ollama/generate
// Request: { modelName?: string, prompt: string }
// Response: { response: string, model: string, done: boolean, totalDuration: number }
export const generateText = async (prompt: string, modelName?: string) => {
  try {
    const response = await api.post('/api/ollama/generate', {
      prompt,
      modelName,
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message);
  }
};

// Description: Get chat history
// Endpoint: GET /api/ollama/chat/history
// Request: { limit?: number }
// Response: { history: Array<{ role: string, content: string, timestamp: Date, model: string }> }
export const getChatHistory = async (limit?: number) => {
  try {
    const response = await api.get('/api/ollama/chat/history', {
      params: { limit },
    });
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};

// Description: Clear chat history
// Endpoint: DELETE /api/ollama/chat/history
// Request: {}
// Response: { success: boolean, message: string }
export const clearChatHistory = async () => {
  try {
    const response = await api.delete('/api/ollama/chat/history');
    return response.data;
  } catch (error: any) {
    console.error(error);
    throw new Error(error?.response?.data?.error || error.message);
  }
};
