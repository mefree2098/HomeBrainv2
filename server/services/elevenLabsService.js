const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const Settings = require('../models/Settings');
const settingsService = require('./settingsService');
const { sendRequestToCodex } = require('./codexCliService');
const {
  isAllowedLocalHostname,
  parseHttpUrl,
  trimTrailingSlashes
} = require('../utils/networkSafety');

const DEFAULT_MODEL_ID = 'eleven_v3';
const MAX_TEXT_LENGTH = 5000;
const CACHE_VERSION = 1;
const TAGGER_PROMPT_VERSION = 'elevenlabs-v3-dialogue-tagger-2026-04-24';
const DEFAULT_CACHE_ROOT = path.join(__dirname, '..', 'data', 'elevenlabs-cache');
const DEFAULT_TTS_TIMEOUT_MS = 30000;
const DEFAULT_TAGGER_TIMEOUT_MS = 45000;
const DEFAULT_MAX_RETRIES = 3;

const TAGGER_DEVELOPER_INSTRUCTIONS = `You are an ElevenLabs v3 dialogue tagger.

Your job is to add minimal, high-value inline audio tags in square brackets to improve emotional delivery before the text is sent to ElevenLabs v3.

Rules:
1. Preserve the spoken words unless explicitly instructed otherwise.
2. Only add tags that describe audible delivery or audible events.
3. Place tags immediately before the words or moment they should affect.
4. Use as few tags as possible.
5. Prefer one precise tag over several weak tags.
6. Use punctuation and ellipses to support pacing.
7. Do not use SSML break tags.
8. Do not add accents, sound effects, or novelty tags unless the text clearly calls for them.
9. If a line does not benefit from tagging, leave it unchanged.
10. Return only JSON matching the requested schema.`;

const TAGGER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    taggedText: { type: 'string' },
    changed: { type: 'boolean' },
    rationale: { type: 'string' }
  },
  required: ['taggedText'],
  additionalProperties: false
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function optionIsExplicitFalse(value) {
  return value === false || value === 'false' || value === '0' || value === 0;
}

function optionIsExplicitTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function removeMarkdownFence(value) {
  const text = trimString(value);
  const fenceMatch = text.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

function parseCodexTaggedText(response) {
  const text = removeMarkdownFence(response);
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text);
    return trimString(parsed?.taggedText);
  } catch (_error) {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        return trimString(parsed?.taggedText);
      } catch (_nestedError) {
        // Fall through to plain text handling.
      }
    }
  }

  return text;
}

function stripInlineAudioTags(value) {
  return String(value || '').replace(/\[[^\]\n]{1,120}\]\s*/g, '');
}

function spokenTextFingerprint(value) {
  return stripInlineAudioTags(value)
    .normalize('NFKD')
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function containsInlineAudioTag(value) {
  return /(^|\s)\[[^\]\n]{2,120}\]/.test(String(value || ''));
}

function hasSsml(value) {
  return /<\/?speak\b/i.test(value) || /<break\b/i.test(value);
}

function normalizeElevenLabsBaseUrl(value) {
  const parsed = parseHttpUrl(value, 'ElevenLabs base URL');
  if (parsed.protocol !== 'https:' && !isAllowedLocalHostname(parsed.hostname)) {
    throw new Error('ElevenLabs base URL must use https unless it targets a local test service');
  }
  parsed.search = '';
  parsed.hash = '';
  return trimTrailingSlashes(parsed.toString());
}

class ElevenLabsService {
  constructor() {
    this.baseUrl = normalizeElevenLabsBaseUrl(
      process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1'
    );
    this.cacheRoot = process.env.HOMEBRAIN_ELEVENLABS_CACHE_DIR || DEFAULT_CACHE_ROOT;
    this.cacheInFlight = new Map();
    console.log('ElevenLabs Service initialized - API key will be retrieved from settings');
  }

  /**
   * Get the API key from settings (prioritizes database over environment variables)
   * @returns {Promise<string|null>} The ElevenLabs API key
   * @private
   */
  async _getApiKey(options = {}) {
    const explicitApiKey = typeof options === 'string'
      ? trimString(options)
      : trimString(options.apiKey);
    if (explicitApiKey) {
      return explicitApiKey;
    }

    try {
      const apiKey = await settingsService.getElevenLabsApiKey();
      return apiKey;
    } catch (error) {
      console.error('Error retrieving ElevenLabs API key from settings:', error.message);
      return null;
    }
  }

  async hasConfiguredApiKey() {
    return Boolean(await this._getApiKey());
  }

  getCacheRoot() {
    return this.cacheRoot;
  }

  _isCacheEnabled(options = {}) {
    if (
      optionIsExplicitFalse(options.cache) ||
      optionIsExplicitTrue(options.disableCache) ||
      process.env.HOMEBRAIN_ELEVENLABS_CACHE_DISABLED === '1'
    ) {
      return false;
    }
    return true;
  }

  _normalizeOptions(options = {}) {
    const modelId = trimString(options.model_id || options.modelId) || DEFAULT_MODEL_ID;
    const emotionTagging = this._shouldApplyEmotionTagging(modelId, options);
    const expressiveDefaults = modelId === DEFAULT_MODEL_ID && emotionTagging;

    return {
      modelId,
      emotionTagging,
      outputFormat: trimString(options.output_format || options.outputFormat),
      apiKey: trimString(options.apiKey),
      codexModel: trimString(options.codexModel),
      codexEffort: trimString(options.codexEffort) || 'low',
      taggerTimeoutMs: Math.max(
        10000,
        Number(options.taggerTimeoutMs || process.env.HOMEBRAIN_ELEVENLABS_TAGGER_TIMEOUT_MS || DEFAULT_TAGGER_TIMEOUT_MS)
      ),
      voiceSettings: {
        stability: clamp01(options.stability, expressiveDefaults ? 0.45 : 0.5),
        similarity_boost: clamp01(options.similarity_boost, 0.75),
        style: clamp01(options.style, expressiveDefaults ? 0.35 : 0.0),
        use_speaker_boost: options.use_speaker_boost !== undefined ? !!options.use_speaker_boost : true
      }
    };
  }

  _shouldApplyEmotionTagging(modelId, options = {}) {
    if (
      optionIsExplicitFalse(options.emotionTagging) ||
      optionIsExplicitFalse(options.applyEmotionTags) ||
      optionIsExplicitTrue(options.skipEmotionTagging)
    ) {
      return false;
    }
    if (optionIsExplicitTrue(options.emotionTagging) || optionIsExplicitTrue(options.applyEmotionTags)) {
      return true;
    }
    return modelId === DEFAULT_MODEL_ID;
  }

  _buildCacheDescriptor(text, voiceId, normalizedOptions) {
    return {
      cacheVersion: CACHE_VERSION,
      provider: 'elevenlabs',
      voiceId,
      text,
      model_id: normalizedOptions.modelId,
      voice_settings: normalizedOptions.voiceSettings,
      output_format: normalizedOptions.outputFormat || null,
      emotionTagging: normalizedOptions.emotionTagging,
      taggerPromptVersion: normalizedOptions.emotionTagging ? TAGGER_PROMPT_VERSION : null
    };
  }

  _buildCacheKey(descriptor) {
    return sha256(stableJson(descriptor));
  }

  _getCachePaths(cacheKey) {
    return {
      audioPath: path.join(this.cacheRoot, `${cacheKey}.mp3`),
      metadataPath: path.join(this.cacheRoot, `${cacheKey}.json`)
    };
  }

  async _readCachedAudio(cacheKey) {
    const { audioPath, metadataPath } = this._getCachePaths(cacheKey);
    try {
      const audioBuffer = await fsp.readFile(audioPath);
      if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        return null;
      }

      const metadata = await fsp.readFile(metadataPath, 'utf8')
        .then((raw) => JSON.parse(raw))
        .catch(() => null);

      return { audioBuffer, metadata };
    } catch (_error) {
      return null;
    }
  }

  async _writeCachedAudio(cacheKey, audioBuffer, metadata) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return;
    }

    await fsp.mkdir(this.cacheRoot, { recursive: true });
    const { audioPath, metadataPath } = this._getCachePaths(cacheKey);
    const tmpAudioPath = `${audioPath}.${process.pid}.${Date.now()}.tmp`;
    const tmpMetadataPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;

    await fsp.writeFile(tmpAudioPath, audioBuffer);
    await fsp.rename(tmpAudioPath, audioPath);
    await fsp.writeFile(tmpMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpMetadataPath, metadataPath);
  }

  async getCacheStatus() {
    const files = await fsp.readdir(this.cacheRoot).catch(() => []);
    const audioFiles = files.filter((file) => file.endsWith('.mp3'));
    return {
      enabled: this._isCacheEnabled(),
      root: this.cacheRoot,
      audioFiles: audioFiles.length,
      metadataFiles: files.filter((file) => file.endsWith('.json')).length
    };
  }

  /**
   * Get all available voices from ElevenLabs
   * @returns {Promise<Array>} Array of voice objects
   */
  async getVoices(options = {}) {
    try {
      console.log('Fetching voices from ElevenLabs API');

      const apiKey = await this._getApiKey(options);

      if (!apiKey) {
        if (options.requireConfigured === true) {
          throw new Error('ElevenLabs API key not configured');
        }
        console.log('ElevenLabs API key not configured, returning mock data');
        return this._getMockVoices();
      }

      console.log('ElevenLabs API key retrieved from settings, making API call');

      const response = await axios.get(`${this.baseUrl}/voices`, {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      console.log(`Retrieved ${response.data.voices.length} voices from ElevenLabs`);

      return response.data.voices.map(voice => ({
        id: voice.voice_id,
        name: voice.name,
        preview_url: voice.preview_url,
        category: voice.category,
        labels: voice.labels,
        description: voice.description
      }));

    } catch (error) {
      console.error('Error fetching voices from ElevenLabs:', error.response?.data || error.message);
      console.error('Full error:', error);
      if (options.requireConfigured === true) {
        throw error;
      }

      // Fallback to mock data if API fails
      console.log('Falling back to mock voice data');
      return this._getMockVoices();
    }
  }

  /**
   * Get voice details by voice ID
   * @param {string} voiceId - The ElevenLabs voice ID
   * @returns {Promise<Object>} Voice details object
   */
  async getVoiceById(voiceId) {
    try {
      console.log(`Fetching voice details for ID: ${voiceId}`);

      const apiKey = await this._getApiKey();

      if (!apiKey) {
        console.log('ElevenLabs API key not configured, returning mock data');
        const mockVoices = this._getMockVoices();
        return mockVoices.find(voice => voice.id === voiceId) || null;
      }

      const response = await axios.get(`${this.baseUrl}/voices/${encodeURIComponent(voiceId)}`, {
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      console.log(`Retrieved voice details for: ${response.data.name}`);

      return {
        id: response.data.voice_id,
        name: response.data.name,
        preview_url: response.data.preview_url,
        category: response.data.category,
        labels: response.data.labels,
        description: response.data.description,
        settings: response.data.settings
      };

    } catch (error) {
      console.error('%s', `Error fetching voice ${voiceId} from ElevenLabs:`, error.response?.data || error.message);
      console.error('Full error:', error);

      // Fallback to mock data if API fails
      const mockVoices = this._getMockVoices();
      return mockVoices.find(voice => voice.id === voiceId) || null;
    }
  }

  async prepareTextForSpeech(text, options = {}) {
    const normalizedText = trimString(text);
    const normalizedOptions = options.voiceSettings ? options : this._normalizeOptions(options);

    if (!normalizedOptions.emotionTagging) {
      return {
        text: normalizedText,
        tagger: {
          status: 'disabled',
          promptVersion: null
        }
      };
    }

    if (containsInlineAudioTag(normalizedText)) {
      return {
        text: normalizedText,
        tagger: {
          status: 'provided',
          promptVersion: TAGGER_PROMPT_VERSION
        }
      };
    }

    return this._tagTextWithCodex(normalizedText, normalizedOptions);
  }

  async _tagTextWithCodex(text, normalizedOptions) {
    const message = [
      'Transform this HomeBrain assistant line into ElevenLabs v3-ready tagged dialogue.',
      'Preserve the spoken words. Add only minimal audible emotion or delivery tags if they help.',
      '',
      'Original text:',
      text
    ].join('\n');

    try {
      const settings = await Settings.getSettings();
      const response = await sendRequestToCodex(message, settings, {
        codexModel: normalizedOptions.codexModel || settings?.codexModel,
        codexEffort: normalizedOptions.codexEffort || 'low',
        timeoutMs: normalizedOptions.taggerTimeoutMs || DEFAULT_TAGGER_TIMEOUT_MS,
        developerInstructions: TAGGER_DEVELOPER_INSTRUCTIONS,
        codexOutputSchema: TAGGER_OUTPUT_SCHEMA
      });

      const taggedText = this._sanitizeTaggedText(parseCodexTaggedText(response.response), text);
      return {
        text: taggedText,
        tagger: {
          status: taggedText === text ? 'codex-unchanged' : 'codex',
          provider: response.provider,
          model: response.model,
          promptVersion: TAGGER_PROMPT_VERSION,
          changed: taggedText !== text,
          tokenUsage: response.tokenUsage || null
        }
      };
    } catch (error) {
      console.warn(`ElevenLabs emotion tagging via Codex failed; using untagged text: ${error.message}`);
      return {
        text,
        tagger: {
          status: 'fallback',
          promptVersion: TAGGER_PROMPT_VERSION,
          error: error.message
        }
      };
    }
  }

  _sanitizeTaggedText(candidate, originalText) {
    const taggedText = trimString(candidate);
    if (!taggedText || hasSsml(taggedText) || taggedText.length > MAX_TEXT_LENGTH) {
      return originalText;
    }

    const originalFingerprint = spokenTextFingerprint(originalText);
    const taggedFingerprint = spokenTextFingerprint(taggedText);
    if (originalFingerprint && taggedFingerprint && originalFingerprint !== taggedFingerprint) {
      console.warn('ElevenLabs emotion tagger changed spoken words; using original text instead.');
      return originalText;
    }

    return taggedText;
  }

  /**
   * Generate speech from text using ElevenLabs TTS.
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - ElevenLabs voice ID
   * @param {Object} options - TTS options
   * @returns {Promise<Buffer>} Audio buffer
   */
  async textToSpeech(text, voiceId, options = {}) {
    const result = await this.textToSpeechDetailed(text, voiceId, options);
    return result.audioBuffer;
  }

  async textToSpeechDetailed(text, voiceId, options = {}) {
    if (!text || typeof text !== 'string') {
      throw new Error('Text is required and must be a string');
    }

    if (!voiceId || typeof voiceId !== 'string') {
      throw new Error('Voice ID is required and must be a string');
    }

    const normalizedText = trimString(text);
    const normalizedVoiceId = trimString(voiceId);

    if (normalizedText.length === 0) {
      throw new Error('Text cannot be empty');
    }

    if (normalizedText.length > MAX_TEXT_LENGTH) {
      throw new Error(`Text is too long. Maximum ${MAX_TEXT_LENGTH} characters allowed.`);
    }

    const normalizedOptions = this._normalizeOptions(options);
    const cacheEnabled = this._isCacheEnabled(options);
    const cacheDescriptor = this._buildCacheDescriptor(normalizedText, normalizedVoiceId, normalizedOptions);
    const cacheKey = this._buildCacheKey(cacheDescriptor);

    if (cacheEnabled) {
      const cached = await this._readCachedAudio(cacheKey);
      if (cached?.audioBuffer) {
        return {
          audioBuffer: cached.audioBuffer,
          cacheHit: true,
          cacheKey,
          metadata: cached.metadata || cacheDescriptor,
          modelId: cached.metadata?.model_id || normalizedOptions.modelId,
          tagger: cached.metadata?.tagger || { status: 'cached' }
        };
      }

      const existingGeneration = this.cacheInFlight.get(cacheKey);
      if (existingGeneration) {
        const result = await existingGeneration;
        return {
          ...result,
          cacheHit: true,
          metadata: {
            ...(result.metadata || {}),
            cacheCoalesced: true
          }
        };
      }
    }

    const generate = async () => {
      const fresh = await this._generateFreshAudio({
        text: normalizedText,
        voiceId: normalizedVoiceId,
        normalizedOptions,
        cacheDescriptor,
        cacheKey
      });

      if (cacheEnabled) {
        await this._writeCachedAudio(cacheKey, fresh.audioBuffer, fresh.metadata)
          .catch((error) => {
            console.warn(`ElevenLabs cache write failed for ${cacheKey}: ${error.message}`);
          });
      }

      return fresh;
    };

    if (!cacheEnabled) {
      return generate();
    }

    const generation = generate()
      .finally(() => {
        this.cacheInFlight.delete(cacheKey);
      });
    this.cacheInFlight.set(cacheKey, generation);
    return generation;
  }

  async _generateFreshAudio({ text, voiceId, normalizedOptions, cacheDescriptor, cacheKey }) {
    console.log(`Generating ElevenLabs speech for voice ${voiceId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    const apiKey = await this._getApiKey(normalizedOptions);
    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const prepared = await this.prepareTextForSpeech(text, normalizedOptions);
    const requestBody = {
      text: prepared.text,
      model_id: normalizedOptions.modelId,
      voice_settings: normalizedOptions.voiceSettings
    };

    const audioBuffer = await this._postTextToSpeech(apiKey, voiceId, requestBody, normalizedOptions);
    const metadata = {
      ...cacheDescriptor,
      cacheKey,
      originalText: text,
      generatedText: prepared.text,
      tagger: prepared.tagger,
      generatedAt: new Date().toISOString(),
      bytes: audioBuffer.length
    };

    return {
      audioBuffer,
      cacheHit: false,
      cacheKey,
      metadata,
      modelId: normalizedOptions.modelId,
      tagger: prepared.tagger
    };
  }

  async _postTextToSpeech(apiKey, voiceId, requestBody, normalizedOptions) {
    let lastError;
    const maxRetries = DEFAULT_MAX_RETRIES;
    const outputFormat = normalizedOptions.outputFormat;
    const url = `${this.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}${outputFormat ? `?output_format=${encodeURIComponent(outputFormat)}` : ''}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Attempt ${attempt}/${maxRetries} - Making request to ElevenLabs TTS API`);

        const response = await axios.post(
          url,
          requestBody,
          {
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg'
            },
            responseType: 'arraybuffer',
            timeout: Number(process.env.HOMEBRAIN_ELEVENLABS_TTS_TIMEOUT_MS || DEFAULT_TTS_TIMEOUT_MS)
          }
        );

        const audioBuffer = Buffer.from(response.data);
        console.log(`Generated ${audioBuffer.length} bytes of audio data on attempt ${attempt}`);
        return audioBuffer;

      } catch (retryError) {
        lastError = retryError;
        console.log('%s', `Attempt ${attempt} failed:`, retryError.code || retryError.message);

        if (retryError.response?.status === 401 || retryError.response?.status === 403) {
          console.log('Authentication error - not retrying');
          break;
        }

        if (retryError.response?.status >= 400 && retryError.response?.status < 500 && retryError.response?.status !== 429) {
          console.log('Client error - not retrying');
          break;
        }

        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.log(`Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    console.error('All retry attempts failed');
    throw lastError;
  }

  /**
   * Validate if a voice ID exists in ElevenLabs
   * @param {string} voiceId - ElevenLabs voice ID
   * @returns {Promise<boolean>} True if voice exists
   */
  async validateVoiceId(voiceId) {
    try {
      console.log(`Validating voice ID: ${voiceId}`);

      const apiKey = await this._getApiKey();

      if (!apiKey) {
        // When API key is not available, validate against mock data
        const mockVoices = this._getMockVoices();
        return mockVoices.some(voice => voice.id === voiceId);
      }

      const voice = await this.getVoiceById(voiceId);
      const isValid = voice !== null;

      console.log(`Voice ID ${voiceId} is ${isValid ? 'valid' : 'invalid'}`);
      return isValid;

    } catch (error) {
      console.error('%s', `Error validating voice ID ${voiceId}:`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Get mock voice data for when ElevenLabs API is not available
   * @returns {Array} Array of mock voice objects
   * @private
   */
  _getMockVoices() {
    return [
      {
        id: 'elevenlabs-voice-1',
        name: 'Sarah - Friendly Female',
        preview_url: '',
        category: 'generated',
        labels: { gender: 'female', age: 'young', accent: 'american' },
        description: 'A friendly, warm female voice perfect for home assistance'
      },
      {
        id: 'elevenlabs-voice-2',
        name: 'James - Professional Male',
        preview_url: '',
        category: 'generated',
        labels: { gender: 'male', age: 'middle_aged', accent: 'british' },
        description: 'A professional, clear male voice ideal for formal interactions'
      },
      {
        id: 'elevenlabs-voice-3',
        name: 'Alex - Neutral Voice',
        preview_url: '',
        category: 'generated',
        labels: { gender: 'neutral', age: 'young', accent: 'american' },
        description: 'A neutral, versatile voice suitable for all users'
      },
      {
        id: 'elevenlabs-voice-4',
        name: 'Emma - Warm Female',
        preview_url: '',
        category: 'generated',
        labels: { gender: 'female', age: 'middle_aged', accent: 'american' },
        description: 'A warm, caring female voice with a comforting tone'
      },
      {
        id: 'elevenlabs-voice-5',
        name: 'David - Deep Male',
        preview_url: '',
        category: 'generated',
        labels: { gender: 'male', age: 'mature', accent: 'american' },
        description: 'A deep, authoritative male voice with commanding presence'
      }
    ];
  }
}

module.exports = new ElevenLabsService();
