const axios = require('axios');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Settings = require('../models/Settings');
const OllamaConfig = require('../models/OllamaConfig');
const { sendRequestToCodex } = require('./codexCliService');
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
const DEFAULT_OLLAMA_FORMAT = 'json';
const DEFAULT_OPENAI_MODEL = 'gpt-5.2-codex';
const OPENAI_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_LOCAL_TIMEOUT_MS = 30000;
const DEFAULT_PROVIDER_PRIORITY = ['local', 'codex', 'openai', 'anthropic'];
const DEFAULT_LOCAL_KEEP_ALIVE = '-1';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildOpenAIErrorMessage(error) {
  const primaryMessage = error?.message || '';
  const apiMessage = error?.response?.data?.error?.message || '';
  const code = error?.code || '';
  return `${primaryMessage} ${apiMessage} ${code}`.trim().toLowerCase();
}

function isJsonModeUnsupportedError(errorMessage) {
  if (!errorMessage) {
    return false;
  }

  return errorMessage.includes('response_format') ||
    errorMessage.includes('json mode') ||
    errorMessage.includes('json_object') ||
    (errorMessage.includes('text.format') && errorMessage.includes('json')) ||
    (errorMessage.includes('unsupported_parameter') && errorMessage.includes('json'));
}

function isNewerOpenAIChatModel(normalizedModel) {
  return normalizedModel.includes('gpt-4') ||
    normalizedModel.includes('gpt-5') ||
    normalizedModel.includes('o1') ||
    normalizedModel.includes('o3') ||
    normalizedModel.includes('o4');
}

function extractOpenAIResponseText(response) {
  if (!response) {
    throw new Error('OpenAI response payload is empty');
  }

  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (Array.isArray(response.output_text)) {
    const text = response.output_text
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part?.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  if (Array.isArray(response.output)) {
    const text = response.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error('OpenAI response missing text output');
}

function extractOpenAIChatCompletionText(response) {
  const message = response?.choices?.[0]?.message;
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
}

async function requestOpenAIResponses(openaiClient, model, message, enforceJsonMode) {
  const payload = {
    model,
    instructions: JSON_ONLY_SYSTEM_PROMPT,
    input: message,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS
  };

  if (enforceJsonMode) {
    payload.text = { format: { type: 'json_object' } };
  }

  const response = await openaiClient.responses.create(payload);
  return extractOpenAIResponseText(response);
}

async function requestOpenAIChatCompletions(openaiClient, model, message, enforceJsonMode) {
  const normalizedModel = model.toLowerCase();
  const tokenParam = isNewerOpenAIChatModel(normalizedModel)
    ? { max_completion_tokens: OPENAI_MAX_OUTPUT_TOKENS }
    : { max_tokens: OPENAI_MAX_OUTPUT_TOKENS };

  const payload = {
    model,
    messages: [
      { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
      { role: 'user', content: message }
    ],
    ...tokenParam
  };

  if (enforceJsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await openaiClient.chat.completions.create(payload);
  return extractOpenAIChatCompletionText(response);
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

function buildLocalModelCandidates(preferredModel, { strict = false } = {}) {
  const candidates = normalizeModelVariants(preferredModel);

  if (strict) {
    return candidates;
  }

  const defaults = ['llama3.1:8b', 'llama3:8b', 'llama2:7b', 'llama2'];

  defaults.forEach((model) => {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  });

  return candidates;
}

function normalizeConfiguredModelName(modelName) {
  if (typeof modelName !== 'string') {
    return null;
  }

  const trimmed = modelName.trim();
  return trimmed || null;
}

function resolveHomeBrainLocalModel(settings) {
  return normalizeConfiguredModelName(settings?.homebrainLocalLlmModel) ||
    normalizeConfiguredModelName(settings?.localLlmModel) ||
    null;
}

function resolveRequestedLocalModel(settings, requestConfig = {}, fallbackModel = null) {
  return normalizeConfiguredModelName(requestConfig?.localModelOverride) ||
    normalizeConfiguredModelName(fallbackModel) ||
    resolveHomeBrainLocalModel(settings);
}

function extractOllamaErrorMessage(error) {
  return (
    error?.response?.data?.error ||
    error?.response?.data?.message ||
    error?.message ||
    ''
  ).toString();
}

function isSchemaFormatCompatibilityError(error) {
  const message = extractOllamaErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('format') &&
    (
      message.includes('invalid') ||
      message.includes('unsupported') ||
      message.includes('schema') ||
      message.includes('cannot unmarshal') ||
      message.includes('json: cannot')
    )
  );
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
    options.num_ctx = contextLength || 1536;

    const predictSetting = sanitizeNumeric(configuration.maxPredictTokens, { min: 128, max: 2048, fallback: null });
    options.num_predict = predictSetting || 256;

    const temperatureValue = typeof configuration.temperature === 'number'
      ? sanitizeNumeric(configuration.temperature, { min: 0, max: 2, fallback: 0.1 })
      : 0.1;
    options.temperature = temperatureValue;

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
      num_ctx: 1536,
      num_predict: 256,
      temperature: 0.1,
      low_vram: true
    };
  }
}

function normalizeModelNameForComparison(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return '';
  }

  const trimmed = modelName.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  if (!trimmed.includes(':')) {
    return `${trimmed}:latest`;
  }

  return trimmed;
}

function mergeLocalOllamaRequestOptions(baseOptions, overrides = {}) {
  const merged = {
    ...baseOptions,
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };

  Object.keys(merged).forEach((key) => {
    if (merged[key] === null || merged[key] === undefined) {
      delete merged[key];
    }
  });

  return merged;
}

function resolveLocalOllamaKeepAlive(requestConfig = {}) {
  if (requestConfig && Object.prototype.hasOwnProperty.call(requestConfig, 'ollamaKeepAlive')) {
    const value = requestConfig.ollamaKeepAlive;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const configured = typeof process.env.HOMEBRAIN_OLLAMA_KEEP_ALIVE === 'string'
    ? process.env.HOMEBRAIN_OLLAMA_KEEP_ALIVE.trim()
    : '';

  return configured || DEFAULT_LOCAL_KEEP_ALIVE;
}

async function getLocalModelRuntimeInfo(baseUrl, requestedModel) {
  try {
    const response = await axios.get(`${baseUrl}/api/ps`, { timeout: 1500 });
    const models = Array.isArray(response.data?.models) ? response.data.models : [];
    if (!models.length) {
      return null;
    }

    const normalizedRequested = normalizeModelNameForComparison(requestedModel);
    const matched = models.find((entry) => {
      const name = normalizeModelNameForComparison(entry?.name || entry?.model || '');
      if (!name) {
        return false;
      }
      return name === normalizedRequested || name.startsWith(`${normalizedRequested.split(':')[0]}:`);
    }) || models[0];

    const sizeBytes = Number(matched?.size);
    const sizeVramBytes = Number(matched?.size_vram);
    const hasSize = Number.isFinite(sizeBytes) && sizeBytes > 0;
    const hasVram = Number.isFinite(sizeVramBytes) && sizeVramBytes > 0;
    const gpuPercent = hasSize && hasVram
      ? Math.max(0, Math.min(100, Math.round((sizeVramBytes / sizeBytes) * 100)))
      : 0;

    return {
      model: matched?.name || matched?.model || requestedModel || null,
      sizeBytes: hasSize ? sizeBytes : null,
      sizeVramBytes: hasVram ? sizeVramBytes : 0,
      gpuPercent,
      processor: hasVram ? `${gpuPercent}% GPU` : 'CPU'
    };
  } catch (error) {
    return null;
  }
}

async function sendRequestToOpenAI(model, message, apiKey = null) {
  // Use provided API key or fall back to environment variable
  const openaiClient = apiKey ? new OpenAI({ apiKey }) : openai;

  if (!openaiClient) {
    throw new Error('OpenAI API key not configured');
  }

  // Use the model as configured, defaulting to a modern Responses-compatible model.
  const validModel = (typeof model === 'string' && model.trim())
    ? model.trim()
    : DEFAULT_OPENAI_MODEL;
  console.log(`Using OpenAI model: ${validModel}`);

  let enforceJsonMode = true;
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_RETRIES) {
    let retryImmediately = false;

    try {
      const responseText = await requestOpenAIResponses(openaiClient, validModel, message, enforceJsonMode);
      console.log(`OpenAI response received successfully from model: ${validModel} (Responses API)`);
      return responseText;
    } catch (responsesError) {
      lastError = responsesError;
      const errorMessage = buildOpenAIErrorMessage(responsesError);
      const attemptNumber = attempt + 1;
      console.error(`Error sending request to OpenAI Responses API (attempt ${attemptNumber}):`, responsesError.message);
      if (responsesError.response) {
        console.error('OpenAI Responses API Error Response:', JSON.stringify(responsesError.response.data, null, 2));
      }
      if (responsesError.stack) console.error('Stack:', responsesError.stack);

      if (enforceJsonMode && isJsonModeUnsupportedError(errorMessage)) {
        console.warn('OpenAI model does not support enforced JSON format via Responses API. Retrying without enforced JSON mode.');
        enforceJsonMode = false;
        retryImmediately = true;
      } else {
        try {
          const responseText = await requestOpenAIChatCompletions(openaiClient, validModel, message, enforceJsonMode);
          console.log(`OpenAI response received successfully from model: ${validModel} (Chat Completions fallback)`);
          return responseText;
        } catch (chatError) {
          lastError = chatError;
          const chatErrorMessage = buildOpenAIErrorMessage(chatError);
          console.error(`Error sending request to OpenAI Chat Completions fallback (attempt ${attemptNumber}):`, chatError.message);
          if (chatError.response) {
            console.error('OpenAI Chat Completions Error Response:', JSON.stringify(chatError.response.data, null, 2));
          }
          if (chatError.stack) console.error('Stack:', chatError.stack);

          if (enforceJsonMode && isJsonModeUnsupportedError(chatErrorMessage)) {
            console.warn('OpenAI model does not support enforced JSON format via Chat Completions. Retrying without enforced JSON mode.');
            enforceJsonMode = false;
            retryImmediately = true;
          }
        }
      }
    }

    if (retryImmediately) {
      continue;
    }

    attempt += 1;
    if (attempt >= MAX_RETRIES) {
      break;
    }

    await sleep(RETRY_DELAY);
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('OpenAI request failed after retries');
}

async function testOpenAIModelCompatibility(model, apiKey, message = 'Return JSON: {"status":"ok"}') {
  const response = await sendRequestToOpenAI(model, message, apiKey);
  return {
    success: true,
    model: (typeof model === 'string' && model.trim()) ? model.trim() : DEFAULT_OPENAI_MODEL,
    sample: response
  };
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

async function sendRequestToLocalLLM(endpoint, model, message, requestConfig = {}) {
  if (!endpoint || endpoint.trim() === '') {
    throw new Error('Local LLM endpoint not configured');
  }

  const baseRequestOptions = await buildLocalOllamaOptions();
  const requestOptions = mergeLocalOllamaRequestOptions(baseRequestOptions, requestConfig.ollamaOptions);
  const requestFormat = requestConfig.ollamaFormat || DEFAULT_OLLAMA_FORMAT;
  const requestKeepAlive = resolveLocalOllamaKeepAlive(requestConfig);
  const requestTimeoutMs = sanitizeNumeric(requestConfig.timeoutMs, {
    min: 3000,
    max: 60000,
    fallback: DEFAULT_LOCAL_TIMEOUT_MS
  });
  const returnMetadata = requestConfig.returnMetadata === true;

  let testUrl = endpoint.trim();
  if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
    testUrl = 'http://' + testUrl;
  }

  const installedModels = await getOllamaInstalledModels(testUrl);
  const requestedModel = normalizeConfiguredModelName(model);
  const strictModel = requestConfig.strictModel === true && Boolean(requestedModel);
  const preferActiveModel = requestConfig.preferActiveModel === true ||
    (!requestedModel && requestConfig.preferActiveModel !== false);
  const candidateModels = buildLocalModelCandidates(requestedModel, { strict: strictModel });

  const activeModel = preferActiveModel ? await getActiveOllamaModel() : null;
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

  if (!strictModel) {
    installedModels.forEach((installedModel) => {
      normalizeModelVariants(installedModel).forEach((variant) => {
        if (!candidateModels.includes(variant)) {
          candidateModels.push(variant);
        }
      });
    });
  }

  if (candidateModels.length === 0) {
    throw new Error('No local LLM models available. Install a model with "ollama pull <model>" and choose the shared Ollama model on the Ollama page.');
  }

  if (strictModel && installedModels.length > 0) {
    const normalizedInstalled = new Set(installedModels.map((item) => normalizeModelNameForComparison(item)));
    const configuredInstalled = candidateModels.some((item) => normalizedInstalled.has(normalizeModelNameForComparison(item)));

    if (!configuredInstalled) {
      throw new Error(`Configured local LLM model "${requestedModel}" is not installed in Ollama.`);
    }
  }

  if (!installedModels.length) {
    console.warn('LLM Service: No Ollama models installed. Install one (e.g., "ollama pull llama3.1:8b") to enable the local provider.');
  }

  let lastError = null;

  for (const candidateModel of candidateModels) {
    console.log(`LLM Service: Attempting local provider with model "${candidateModel}" at ${testUrl}`);

    try {
      let responseText = null;

      try {
        responseText = await attemptLocalModelRequest(
          testUrl,
          candidateModel,
          message,
          requestOptions,
          requestTimeoutMs,
          requestFormat,
          requestKeepAlive
        );
      } catch (formatError) {
        if (
          requestFormat &&
          typeof requestFormat === 'object' &&
          isSchemaFormatCompatibilityError(formatError)
        ) {
          console.warn(`LLM Service: Schema format rejected by Ollama for "${candidateModel}", retrying with plain JSON mode.`);
          responseText = await attemptLocalModelRequest(
            testUrl,
            candidateModel,
            message,
            requestOptions,
            requestTimeoutMs,
            DEFAULT_OLLAMA_FORMAT,
            requestKeepAlive
          );
        } else {
          throw formatError;
        }
      }

      if (responseText !== undefined && responseText !== null) {
        if (!returnMetadata) {
          return responseText;
        }

        const runtime = await getLocalModelRuntimeInfo(testUrl, candidateModel);
        return {
          response: responseText,
          resolvedModel: candidateModel,
          runtime
        };
      }
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const errorMessage = extractOllamaErrorMessage(error);

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

async function attemptLocalModelRequest(
  baseUrl,
  modelName,
  message,
  requestOptions,
  requestTimeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
  requestFormat = DEFAULT_OLLAMA_FORMAT,
  requestKeepAlive = DEFAULT_LOCAL_KEEP_ALIVE
) {
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
    format: requestFormat,
    messages: chatMessages,
    options: sanitizedOptions,
    stream: false,
    keep_alive: requestKeepAlive
  };

  try {
    console.log(`LLM Service: Sending request to ${baseUrl}/api/chat`);
    const chatResponse = await axios.post(`${baseUrl}/api/chat`, chatPayload, {
      timeout: requestTimeoutMs,
      headers
    });

    const chatMessage = chatResponse.data?.message;
    if (chatMessage?.content) {
      const content = chatMessage.content;
      if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
      }
      if (typeof content === 'string') {
        return content.trim();
      }
      return JSON.stringify(content);
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
      format: requestFormat,
      options: sanitizedOptions,
      stream: false,
      keep_alive: requestKeepAlive
    }, {
      timeout: requestTimeoutMs,
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
    case 'codex': {
      const settings = await Settings.getSettings();
      const result = await sendRequestToCodex(message, settings, {
        codexModel: model,
        developerInstructions: JSON_ONLY_SYSTEM_PROMPT
      });
      return result.response;
    }
    case 'local':
      // Get settings to retrieve local LLM endpoint
      const settings = await Settings.getSettings();
      const localModel = normalizeConfiguredModelName(model) || resolveHomeBrainLocalModel(settings);
      return sendRequestToLocalLLM(settings.localLlmEndpoint, localModel, message, {
        strictModel: Boolean(localModel),
        preferActiveModel: false
      });
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
async function sendLLMRequestWithFallback(message, priorityList = null, requestConfig = {}) {
  console.log('LLM Service: Sending request with fallback mechanism');

  // Get settings to retrieve priority list and API keys
  const settings = await Settings.getSettings();
  const priorities = priorityList || settings.llmPriorityList || DEFAULT_PROVIDER_PRIORITY;

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
          model = resolveRequestedLocalModel(settings, requestConfig, settings.localLlmModel);

          if (!endpoint) {
            console.log(`LLM Service: Local LLM endpoint not configured, skipping`);
            errors.push({ provider, error: 'Local LLM endpoint not configured' });
            continue;
          }

          const response = await sendRequestToLocalLLM(endpoint, model, message, {
            ...requestConfig,
            strictModel: requestConfig.strictModel === true || Boolean(model),
            preferActiveModel: requestConfig.preferActiveModel === true
          });
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

        case 'codex':
          model = settings.codexModel;

          const codexResponse = await sendRequestToCodex(message, settings, {
            ...requestConfig,
            codexModel: requestConfig.codexModel || model,
            developerInstructions: JSON_ONLY_SYSTEM_PROMPT
          });
          console.log(`LLM Service: Successfully received response from ${provider}`);
          return codexResponse.response;

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

async function sendLLMRequestWithFallbackDetailed(message, priorityList = null, requestConfig = {}) {
  console.log('LLM Service: Sending request with fallback mechanism (detailed response)');

  const settings = await Settings.getSettings();
  const priorities = priorityList || settings.llmPriorityList || DEFAULT_PROVIDER_PRIORITY;
  const errors = [];

  for (const provider of priorities) {
    try {
      let model;
      let apiKey;
      let endpoint;

      switch (provider.toLowerCase()) {
        case 'local':
          endpoint = settings.localLlmEndpoint;
          model = resolveRequestedLocalModel(settings, requestConfig, settings.localLlmModel);

          if (!endpoint) {
            errors.push({ provider, error: 'Local LLM endpoint not configured' });
            continue;
          }

          const localResult = await sendRequestToLocalLLM(endpoint, model, message, {
            ...requestConfig,
            strictModel: requestConfig.strictModel === true || Boolean(model),
            preferActiveModel: requestConfig.preferActiveModel === true,
            returnMetadata: true
          });

          return {
            response: localResult?.response ?? localResult,
            provider: 'local',
            model: localResult?.resolvedModel || model,
            runtime: localResult?.runtime || null
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

        case 'codex':
          model = settings.codexModel;

          return await sendRequestToCodex(message, settings, {
            ...requestConfig,
            codexModel: requestConfig.codexModel || model,
            developerInstructions: JSON_ONLY_SYSTEM_PROMPT
          });

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
  sendRequestToOpenAI,
  testOpenAIModelCompatibility,
  sendLLMRequest,
  sendLLMRequestWithFallback,
  sendLLMRequestWithFallbackDetailed
};
