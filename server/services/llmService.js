const axios = require('axios');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Settings = require('../models/Settings');
const dotenv = require('dotenv');

dotenv.config();

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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      // Check if this is a newer model that requires max_completion_tokens
      // GPT-4, GPT-5, and O1 series use max_completion_tokens
      // GPT-3.5 and older use max_tokens
      const isNewerModel = validModel.includes('gpt-4') ||
                           validModel.includes('gpt-5') ||
                           validModel.includes('o1');
      const tokenParam = isNewerModel ? { max_completion_tokens: 1024 } : { max_tokens: 1024 };

      const response = await openaiClient.chat.completions.create({
        model: validModel,
        messages: [{ role: 'user', content: message }],
        ...tokenParam,
      });

      console.log(`OpenAI response received successfully from model: ${validModel}`);
      return response.choices[0].message.content;
    } catch (error) {
      console.error(`Error sending request to OpenAI (attempt ${i + 1}):`, error.message);
      if (error.response) {
        console.error('OpenAI API Error Response:', JSON.stringify(error.response.data, null, 2));
      }
      if (error.stack) console.error('Stack:', error.stack);
      if (i === MAX_RETRIES - 1) throw error;
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

  let testUrl = endpoint.trim();
  if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
    testUrl = 'http://' + testUrl;
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      console.log(`Sending request to local LLM at ${testUrl} with model: ${model}`);

      // Try OpenAI-compatible endpoint format first
      const response = await axios.post(`${testUrl}/v1/chat/completions`, {
        model: model || 'default',
        messages: [{ role: 'user', content: message }],
        max_tokens: 1024,
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`Received response from local LLM`);

      // Handle OpenAI-compatible response format
      if (response.data.choices && response.data.choices[0]) {
        return response.data.choices[0].message.content;
      }

      // Handle alternative response formats
      if (response.data.response) {
        return response.data.response;
      }

      throw new Error('Unexpected response format from local LLM');

    } catch (error) {
      console.error(`Error sending request to local LLM (attempt ${i + 1}):`, error.message);

      // If first attempt failed, try alternative endpoint format
      if (i === 0 && (error.code === 'ECONNREFUSED' || error.response?.status === 404)) {
        try {
          console.log(`Trying alternative endpoint format: ${testUrl}/api/generate`);
          const altResponse = await axios.post(`${testUrl}/api/generate`, {
            model: model || 'default',
            prompt: message,
            stream: false
          }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
          });

          if (altResponse.data.response) {
            return altResponse.data.response;
          }
        } catch (altError) {
          console.error(`Alternative endpoint also failed:`, altError.message);
        }
      }

      if (i === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_DELAY);
    }
  }
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

module.exports = {
  sendLLMRequest,
  sendLLMRequestWithFallback
};
