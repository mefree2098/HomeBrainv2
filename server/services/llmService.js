const axios = require('axios');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Settings = require('../models/Settings');
const OllamaConfig = require('../models/OllamaConfig');
const dotenv = require('dotenv');

dotenv.config();

const ollamaModelCache = new Map();

// Initialize OpenAI only if API key is available
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Initialize Anthropic only if API key is available
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const OLLAMA_MODEL_CACHE_TTL = 30_000;
const JSON_ONLY_SYSTEM_PROMPT = 'You are the HomeBrain automation intelligence. Always respond with a single JSON object and no commentary.';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeModelVariants(modelName) {
  const variants = [];
  if (!modelName || typeof modelName !== 'string') {
    return variants;
  }

  const trimmed = modelName.trim();
  if (!trimmed) {
    return variants;
  }

  const lower = trimmed.toLowerCase();
  const addVariant = (value) => {
    if (value && !variants.includes(value)) {
      variants.push(value);
    }
  };

  addVariant(trimmed);

  let colonVariantAdded = trimmed.includes(':');

  if (lower.includes('-')) {
    const colonVariant = trimmed.replace(/-/g, ':');
    addVariant(colonVariant);
    colonVariantAdded = colonVariantAdded || colonVariant.includes(':');

    const dashMatch = lower.match(/^(.+?)-(\d+[a-z0-9]*)$/i);
    if (dashMatch) {
      addVariant(`${dashMatch[1]}:${dashMatch[2]}`);
      colonVariantAdded = true;
    }
  }

  if (!colonVariantAdded && !trimmed.includes(':')) {
    addVariant(`${trimmed}:latest`);
  }

  return variants;
}

function buildLocalModelCandidates(preferredModel) {
  const candidates = normalizeModelVariants(preferredModel);
  const defaults = ['llama3.1:8b', 'llama3:8b', 'llama2:7b', 'llama2'];

  defaults.forEach((model) => {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  });

  return candidates;
}

async function getOllamaInstalledModels(baseUrl) {
  try {
    const cacheEntry = ollamaModelCache.get(baseUrl);
    const now = Date.now();

    if (cacheEntry && now - cacheEntry.timestamp < OLLAMA_MODEL_CACHE_TTL) {
      return cacheEntry.models;
    }

    const response = await axios.get(`${baseUrl}/api/tags`, { timeout: 5000 });
    const models = Array.isArray(response.data?.models)
      ? response.data.models
          .map((model) => model?.name)
          .filter((name) => typeof name === 'string' && name.trim().length > 0)
      : [];

    ollamaModelCache.set(baseUrl, { timestamp: now, models });
    return models;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error('Local LLM is not running (connection refused)');
    }

    if (error.response?.status === 404) {
      return [];
    }

    console.warn(`LLM Service: Unable to fetch Ollama models from ${baseUrl}: ${error.message}`);
    return [];
  }
}

async function getActiveOllamaModel() {
  try {
    const config = await OllamaConfig.getConfig();
    if (config && typeof config.activeModel === 'string' && config.activeModel.trim().length > 0) {
      return config.activeModel.trim();
    }
  } catch (error) {
    console.warn(`LLM Service: Could not load active Ollama model from config: ${error.message}`);
  }
  return null;
}

function sanitizeNumeric(value, { min = 0, max = Number.POSITIVE_INFINITY, fallback = null }) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric < min) {
    return min;
  }
  if (numeric > max) {
    return max;
  }
  return numeric;
}

async function buildLocalOllamaOptions() {
  try {
    const config = await OllamaConfig.getConfig();
    const configuration = config?.configuration || {};
    const options = {};

    const contextLength = sanitizeNumeric(configuration.contextLength, { min: 256, max: 4096, fallback: null });
    options.num_ctx = contextLength || 1024;

    const predictSetting = sanitizeNumeric(configuration.maxPredictTokens, { min: 128, max: 2048, fallback: null });
    options.num_predict = predictSetting || 256;

    if (typeof configuration.temperature === 'number') {
      options.temperature = sanitizeNumeric(configuration.temperature, { min: 0, max: 2, fallback: 0.2 });
    } else {
      options.temperature = 0.2;
    }

    if (typeof configuration.gpuLayers === 'number' && configuration.gpuLayers >= 0) {
      options.gpu_layers = configuration.gpuLayers;
    }

    if (configuration.lowVram === true || process.env.OLLAMA_LOW_VRAM === 'true') {
      options.low_vram = true;
    }

    if (process.env.OLLAMA_NUM_GPU) {
      const numGpu = sanitizeNumeric(process.env.OLLAMA_NUM_GPU, { min: 0, max: 64, fallback: null });
      if (numGpu !== null) {
        options.num_gpu = numGpu;
      }
    }

    return options;
  } catch (error) {
    console.warn('LLM Service: Unable to load Ollama configuration for request options:', error.message);
    return {
      num_ctx: 1024,
      num_predict: 256,
      temperature: 0.2,
      low_vram: true
    };
  }
}

async function sendRequestToOpenAI(model, message, apiKey = null) {
  // Use provided API key or fall back to environment variable
  const openaiClient = apiKey ? new OpenAI({ apiKey }) : openai;

  if (!openaiClient) {
    throw new Error('OpenAI API key not configured');
  }

  // Use the model as configured, defaulting to gpt-3.5-turbo if not provided
  const validModel = model || 'gpt-3.5-turbo';
  console.log(`Using OpenAI model: ${validModel}`);

  const normalizedModel = validModel.toLowerCase();
  let enforceJsonMode = !normalizedModel.includes('gpt-3.5');
  const systemInstruction = JSON_ONLY_SYSTEM_PROMPT;
  const baseMessages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: message }
  ];

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      // GPT-4, GPT-5, and O1 series use max_completion_tokens
      const isNewerModel = normalizedModel.includes('gpt-4') ||
                           normalizedModel.includes('gpt-5') ||
                           normalizedModel.includes('o1');
      const tokenParam = isNewerModel ? { max_completion_tokens: 1024 } : { max_tokens: 1024 };

      const payload = {
        model: validModel,
        messages: baseMessages,
        ...tokenParam
      };

      if (enforceJsonMode) {
        payload.response_format = { type: 'json_object' };
      }

      const response = await openaiClient.chat.completions.create(payload);
      console.log(`OpenAI response received successfully from model: ${validModel}`);
      const message = response.choices?.[0]?.message;
      if (!message) {
        throw new Error('OpenAI response missing message content');
      }

      const { content } = message;
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('');
        return text.trim();
      }

      if (typeof content === 'string') {
        return content.trim();
      }

      return JSON.stringify(content);
    } catch (error) {
      const attemptNumber = attempt + 1;
      console.error(`Error sending request to OpenAI (attempt ${attemptNumber}):`, error.message);
      if (error.response) {
        console.error('OpenAI API Error Response:', JSON.stringify(error.response.data, null, 2));
      }
      if (error.stack) console.error('Stack:', error.stack);

      const errorMessage = `${error.message || ''} ${error.response?.data?.error?.message || ''}`.toLowerCase();
      if (enforceJsonMode && (errorMessage.includes('response_format') || errorMessage.includes('json mode'))) {
        console.warn('OpenAI model does not support JSON response_format. Retrying without enforced JSON mode.');
        enforceJsonMode = false;
        continue;
      }

      attempt += 1;
      if (attempt >= MAX_RETRIES) {
        throw error;
      }
      await sleep(RETRY_DELAY);
    }
  }
}

async function sendRequestToAnthropic(model, message, apiKey = null) {
  // Use provided API key or fall back to environment variable
  const anthropicClient = apiKey ? new Anthropic({ apiKey }) : anthropic;

  if (!anthropicClient) {
    throw new Error('Anthropic API key not configured');
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      console.log(`Sending request to Anthropic with model: ${model}`);
      const response = await anthropicClient.messages.create({
        model: model,
        messages: [{ role: 'user', content: message }],
        max_tokens: 1024,
      });
      console.log(`Received response from Anthropic`);
      return response.content[0].text;
    } catch (error) {
      console.error(`Error sending request to Anthropic (attempt ${i + 1}):`, error.message);
      if (i === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_DELAY);
    }
  }
}

async function sendRequestToLocalLLM(endpoint, model, message) {
  if (!endpoint || endpoint.trim() === '') {
    throw new Error('Local LLM endpoint not configured');
  }

  const requestOptions = await buildLocalOllamaOptions();

  let testUrl = endpoint.trim();
  if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
    testUrl = 'http://' + testUrl;
  }

  const installedModels = await getOllamaInstalledModels(testUrl);
  const candidateModels = buildLocalModelCandidates(model);

  const activeModel = await getActiveOllamaModel();
  if (activeModel) {
    const activeVariants = normalizeModelVariants(activeModel);
    activeVariants.reverse().forEach((variant) => {
      if (!candidateModels.includes(variant)) {
        candidateModels.unshift(variant);
      } else {
        const index = candidateModels.indexOf(variant);
        if (index > 0) {
          candidateModels.splice(index, 1);
          candidateModels.unshift(variant);
        }
      }
    });
  }

  installedModels.forEach((installedModel) => {
    normalizeModelVariants(installedModel).forEach((variant) => {
      if (!candidateModels.includes(variant)) {
        candidateModels.push(variant);
      }
    });
  });

  if (candidateModels.length === 0) {
    throw new Error('No local LLM models available. Install a model with "ollama pull <model>" or configure Settings.localLlmModel.');
  }

  if (!installedModels.length) {
    console.warn('LLM Service: No Ollama models installed. Install one (e.g., "ollama pull llama3.1:8b") to enable the local provider.');
  }

  let lastError = null;

  for (const candidateModel of candidateModels) {
    console.log(`LLM Service: Attempting local provider with model "${candidateModel}" at ${testUrl}`);

    try {
      const responseText = await attemptLocalModelRequest(testUrl, candidateModel, message, requestOptions);
      if (responseText !== undefined && responseText !== null) {
        return responseText;
      }
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const errorMessage = error.response?.data?.error || error.message;

      if (status === 404 || (errorMessage && errorMessage.toLowerCase().includes('not found'))) {
        console.warn(`LLM Service: Local model "${candidateModel}" not available (${errorMessage}). Trying next candidate.`);
        continue;
      }

      console.error(`Error sending request to local LLM with model "${candidateModel}":`, errorMessage);
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Local LLM request failed: no models responded successfully.');
}

async function attemptLocalModelRequest(baseUrl, modelName, message, requestOptions) {
  const headers = { 'Content-Type': 'application/json' };
  let lastError = null;

  const baseModel = modelName || 'default';
  const systemInstruction = JSON_ONLY_SYSTEM_PROMPT;
  const chatMessages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: message }
  ];
  const promptWithInstruction = `${systemInstruction}\n\n${message}`;

  const sanitizedOptions = { ...requestOptions };

  const chatPayload = {
    model: baseModel,
    messages: chatMessages,
    options: sanitizedOptions,
    stream: false
  };

  try {
    console.log(`LLM Service: Sending request to ${baseUrl}/api/chat`);
    const chatResponse = await axios.post(`${baseUrl}/api/chat`, chatPayload, {
      timeout: 30000,
      headers
    });

    const chatMessage = chatResponse.data?.message;
    if (chatMessage?.content) {
      if (Array.isArray(chatMessage.content)) {
        return chatMessage.content.map((part) => part.text || '').join('').trim();
      }
      return String(chatMessage.content);
    }

    if (typeof chatMessage === 'string') {
      return chatMessage;
    }
  } catch (error) {
    lastError = error;
  }

  try {
    console.log(`LLM Service: Sending request to ${baseUrl}/api/generate`);
    const generateResponse = await axios.post(`${baseUrl}/api/generate`, {
      model: baseModel,
      prompt: promptWithInstruction,
      options: sanitizedOptions,
      stream: false
    }, {
      timeout: 30000,
      headers
    });

    if (typeof generateResponse.data?.response === 'string') {
      return generateResponse.data.response;
    }

    if (typeof generateResponse.data?.output === 'string') {
      return generateResponse.data.output;
    }
  } catch (error) {
    lastError = error;
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Local LLM request did not return a response.');
}

async function sendLLMRequest(provider, model, message) {
  switch (provider.toLowerCase()) {
    case 'openai':
      return sendRequestToOpenAI(model, message);
    case 'anthropic':
      return sendRequestToAnthropic(model, message);
    case 'local':
      // Get settings to retrieve local LLM endpoint
      const settings = await Settings.getSettings();
      return sendRequestToLocalLLM(settings.localLlmEndpoint, settings.localLlmModel || model, message);
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

/**
 * Send LLM request with automatic fallback based on priority list
 * @param {string} message - The message to send to the LLM
 * @param {Array<string>} priorityList - Optional custom priority list. If not provided, uses settings
 * @returns {Promise<string>} - The LLM response
 */
async function sendLLMRequestWithFallback(message, priorityList = null) {
  console.log('LLM Service: Sending request with fallback mechanism');

  // Get settings to retrieve priority list and API keys
  const settings = await Settings.getSettings();
  const priorities = priorityList || settings.llmPriorityList || ['local', 'openai', 'anthropic'];

  console.log(`LLM Service: Priority list: ${priorities.join(' -> ')}`);

  const errors = [];

  // Try each provider in priority order
  for (const provider of priorities) {
    try {
      console.log(`LLM Service: Attempting to use provider: ${provider}`);

      let model, apiKey, endpoint;

      // Get provider-specific configuration
      switch (provider.toLowerCase()) {
        case 'local':
          endpoint = settings.localLlmEndpoint;
          model = settings.localLlmModel;

          if (!endpoint) {
            console.log(`LLM Service: Local LLM endpoint not configured, skipping`);
            errors.push({ provider, error: 'Local LLM endpoint not configured' });
            continue;
          }

          const response = await sendRequestToLocalLLM(endpoint, model, message);
          console.log(`LLM Service: Successfully received response from ${provider}`);
          return response;

        case 'openai':
          apiKey = settings.openaiApiKey;
          model = settings.openaiModel;

          if (!apiKey) {
            console.log(`LLM Service: OpenAI API key not configured, skipping`);
            errors.push({ provider, error: 'OpenAI API key not configured' });
            continue;
          }

          const openaiResponse = await sendRequestToOpenAI(model, message, apiKey);
          console.log(`LLM Service: Successfully received response from ${provider}`);
          return openaiResponse;

        case 'anthropic':
          apiKey = settings.anthropicApiKey;
          model = settings.anthropicModel;

          if (!apiKey) {
            console.log(`LLM Service: Anthropic API key not configured, skipping`);
            errors.push({ provider, error: 'Anthropic API key not configured' });
            continue;
          }

          const anthropicResponse = await sendRequestToAnthropic(model, message, apiKey);
          console.log(`LLM Service: Successfully received response from ${provider}`);
          return anthropicResponse;

        default:
          console.log(`LLM Service: Unknown provider ${provider}, skipping`);
          errors.push({ provider, error: `Unknown provider: ${provider}` });
          continue;
      }

    } catch (error) {
      console.error(`LLM Service: Error with provider ${provider}:`, error.message);
      errors.push({ provider, error: error.message });
      // Continue to next provider in priority list
    }
  }

  // If we reach here, all providers failed
  console.error('LLM Service: All LLM providers failed');
  const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
  throw new Error(`All LLM providers failed. Errors: ${errorSummary}`);
}

async function sendLLMRequestWithFallbackDetailed(message, priorityList = null) {
  console.log('LLM Service: Sending request with fallback mechanism (detailed response)');

  const settings = await Settings.getSettings();
  const priorities = priorityList || settings.llmPriorityList || ['local', 'openai', 'anthropic'];
  const errors = [];

  for (const provider of priorities) {
    try {
      let model;
      let apiKey;
      let endpoint;

      switch (provider.toLowerCase()) {
        case 'local':
          endpoint = settings.localLlmEndpoint;
          model = settings.localLlmModel;

          if (!endpoint) {
            errors.push({ provider, error: 'Local LLM endpoint not configured' });
            continue;
          }

          return {
            response: await sendRequestToLocalLLM(endpoint, model, message),
            provider: 'local',
            model
          };

        case 'openai':
          apiKey = settings.openaiApiKey;
          model = settings.openaiModel;

          if (!apiKey) {
            errors.push({ provider, error: 'OpenAI API key not configured' });
            continue;
          }

          return {
            response: await sendRequestToOpenAI(model, message, apiKey),
            provider: 'openai',
            model
          };

        case 'anthropic':
          apiKey = settings.anthropicApiKey;
          model = settings.anthropicModel;

          if (!apiKey) {
            errors.push({ provider, error: 'Anthropic API key not configured' });
            continue;
          }

          return {
            response: await sendRequestToAnthropic(model, message, apiKey),
            provider: 'anthropic',
            model
          };

        default:
          errors.push({ provider, error: `Unknown provider: ${provider}` });
          continue;
      }
    } catch (error) {
      console.error(`LLM Service: Error with provider ${provider}:`, error.message);
      errors.push({ provider, error: error.message });
    }
  }

  const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
  throw new Error(`All LLM providers failed. Errors: ${errorSummary}`);
}

module.exports = {
  sendLLMRequest,
  sendLLMRequestWithFallback,
  sendLLMRequestWithFallbackDetailed
};
