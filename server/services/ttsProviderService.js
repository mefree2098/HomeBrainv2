const Settings = require('../models/Settings');
const elevenLabsService = require('./elevenLabsService');
const {
  parseLocalHttpUrl,
  trimLeadingSlashes,
  trimTrailingSlashes
} = require('../utils/networkSafety');

const DEFAULT_TEST_TEXT = 'HomeBrain local voice generation test.';
const DEFAULT_TTS_TIMEOUT_MS = 30000;
const DEFAULT_S2_MODEL = 's2-pro';
const DEFAULT_S2_FORMAT = 'mp3';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseLocalHttpProviderUrl(endpoint, label) {
  return parseLocalHttpUrl(endpoint, label);
}

function providerPathname(url) {
  const pathname = trimTrailingSlashes(url.pathname || '/');
  return pathname || '/';
}

function pathEndsWith(url, suffix) {
  const pathname = providerPathname(url).toLowerCase();
  const normalizedSuffix = `/${trimLeadingSlashes(suffix).toLowerCase()}`;
  return pathname === normalizedSuffix || pathname.endsWith(normalizedSuffix);
}

function renderProviderUrl(url) {
  return trimTrailingSlashes(url.toString());
}

function ensureHttpUrl(value, label) {
  return renderProviderUrl(parseLocalHttpProviderUrl(value, label));
}

function appendPath(baseUrl, path) {
  const url = new URL(baseUrl);
  const basePath = providerPathname(url);
  url.pathname = `${basePath === '/' ? '' : basePath}/${trimLeadingSlashes(path)}`;
  return renderProviderUrl(url);
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TTS_TIMEOUT_MS;
  }
  if (parsed <= 1000) {
    return 1000;
  }
  if (parsed <= 5000) {
    return 5000;
  }
  if (parsed <= 10000) {
    return 10000;
  }
  if (parsed <= 30000) {
    return 30000;
  }
  if (parsed <= 60000) {
    return 60000;
  }
  return 120000;
}

function getAuthHeaders(apiKey) {
  const normalizedApiKey = trimString(apiKey);
  if (!normalizedApiKey) {
    return {};
  }
  return {
    Authorization: `Bearer ${normalizedApiKey}`,
    'X-API-Key': normalizedApiKey
  };
}

function normalizeContentType(contentType = '', format = DEFAULT_S2_FORMAT) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('audio/')) {
    return contentType;
  }
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/L16';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

function normalizeVoiceList(payload) {
  if (!payload) {
    return [];
  }

  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.voices)
      ? payload.voices
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.results)
          ? payload.results
          : [];

  return candidates
    .map((voice) => {
      if (typeof voice === 'string') {
        return { id: voice, name: voice, provider: 's2_pro' };
      }
      const id = trimString(voice?.id || voice?.voice_id || voice?.voiceId || voice?.name);
      if (!id) {
        return null;
      }
      return {
        id,
        name: trimString(voice?.name || voice?.display_name || voice?.label || id),
        provider: 's2_pro',
        previewUrl: trimString(voice?.preview_url || voice?.previewUrl || voice?.sample_url),
        raw: voice
      };
    })
    .filter(Boolean);
}

class TtsProviderService {
  hasS2Overrides(overrides = {}) {
    return [
      'endpoint',
      'apiKey',
      'voiceId',
      'model',
      'format',
      'timeoutMs'
    ].some((key) => overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '');
  }

  async getSettingsForS2(overrides = {}) {
    if (overrides.settings) {
      return overrides.settings;
    }
    if (this.hasS2Overrides(overrides)) {
      return {};
    }
    return Settings.getSettings();
  }

  resolveS2Config(settings = {}, overrides = {}) {
    return {
      endpoint:
        trimString(overrides.endpoint) ||
        trimString(process.env.S2_PRO_ENDPOINT) ||
        trimString(process.env.HOMEBRAIN_S2_PRO_ENDPOINT) ||
        trimString(settings.s2ProEndpoint),
      apiKey:
        trimString(overrides.apiKey) ||
        trimString(process.env.S2_PRO_API_KEY) ||
        trimString(process.env.HOMEBRAIN_S2_PRO_API_KEY) ||
        trimString(settings.s2ProApiKey),
      voiceId:
        trimString(overrides.voiceId) ||
        trimString(settings.s2ProDefaultVoiceId) ||
        'default',
      model:
        trimString(overrides.model) ||
        trimString(settings.s2ProModel) ||
        DEFAULT_S2_MODEL,
      format:
        trimString(overrides.format || settings.s2ProOutputFormat || DEFAULT_S2_FORMAT).toLowerCase(),
      timeoutMs: clampTimeout(overrides.timeoutMs || settings.s2ProTimeoutMs)
    };
  }

  resolveProviderOrder(settings = {}, overrideProvider = null) {
    if (overrideProvider) {
      return [overrideProvider];
    }

    const configured = Array.isArray(settings.ttsProviderPriorityList)
      ? settings.ttsProviderPriorityList
      : [];
    const priority = configured
      .map((provider) => trimString(provider).toLowerCase())
      .filter((provider, index, arr) => ['s2_pro', 'elevenlabs'].includes(provider) && arr.indexOf(provider) === index);

    const fallbackPriority = priority.length ? priority : ['elevenlabs', 's2_pro'];
    const selectedProvider = trimString(settings.ttsProvider).toLowerCase();
    if (['s2_pro', 'elevenlabs'].includes(selectedProvider)) {
      return [selectedProvider, ...fallbackPriority.filter((provider) => provider !== selectedProvider)];
    }

    return fallbackPriority;
  }

  buildS2VoiceUrls(endpoint) {
    const baseUrl = ensureHttpUrl(endpoint, 'S2 Pro endpoint');
    const url = new URL(baseUrl);
    if (pathEndsWith(url, 'voices') || pathEndsWith(url, 'v1/voices')) {
      return [baseUrl];
    }
    return [appendPath(baseUrl, '/voices'), appendPath(baseUrl, '/v1/voices')];
  }

  buildS2SpeechUrls(endpoint) {
    const baseUrl = ensureHttpUrl(endpoint, 'S2 Pro endpoint');
    const url = new URL(baseUrl);
    if (pathEndsWith(url, 'v1/audio/speech') || pathEndsWith(url, 'tts') || pathEndsWith(url, 'text-to-speech')) {
      return [baseUrl];
    }
    return [
      appendPath(baseUrl, '/v1/audio/speech'),
      appendPath(baseUrl, '/tts'),
      appendPath(baseUrl, '/text-to-speech')
    ];
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TTS_TIMEOUT_MS) {
    const controller = new AbortController();
    const safeTimeoutMs = clampTimeout(timeoutMs);
    // lgtm[js/resource-exhaustion] Timeout is selected from a bounded set before scheduling.
    const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
    try {
      // codeql[js/request-forgery] Admin-configured S2 Pro URLs are restricted to local/private hosts before fetch.
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listS2Voices(overrides = {}) {
    const settings = await this.getSettingsForS2(overrides);
    const config = this.resolveS2Config(settings, overrides);
    const urls = this.buildS2VoiceUrls(config.endpoint);
    const headers = getAuthHeaders(config.apiKey);
    let lastError = null;

    for (const url of urls) {
      try {
        const response = await this.fetchWithTimeout(url, { headers }, config.timeoutMs);
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
          ? await response.json()
          : await response.text();

        if (!response.ok) {
          const detail = typeof payload === 'string' ? payload : (payload?.message || payload?.error || JSON.stringify(payload));
          throw new Error(`S2 Pro voices returned HTTP ${response.status}: ${detail}`);
        }

        return {
          success: true,
          provider: 's2_pro',
          endpoint: url,
          voices: normalizeVoiceList(payload)
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('S2 Pro voice list request failed');
  }

  buildS2RequestBodies({ text, voiceId, model, format }) {
    return [
      {
        input: text,
        voice: voiceId || 'default',
        model,
        response_format: format || DEFAULT_S2_FORMAT
      },
      {
        text,
        voice: voiceId || 'default',
        voiceId: voiceId || 'default',
        model,
        format: format || DEFAULT_S2_FORMAT
      }
    ];
  }

  async parseSpeechResponse(response, format) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const audioBase64 =
        payload.audio_base64 ||
        payload.audioBase64 ||
        payload.audio ||
        payload.data?.audio_base64 ||
        payload.data?.audio;
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        throw new Error('S2 Pro JSON response did not include base64 audio');
      }
      return {
        audioBuffer: Buffer.from(audioBase64, 'base64'),
        contentType: normalizeContentType(payload.content_type || payload.contentType, format),
        metadata: payload
      };
    }

    return {
      audioBuffer: Buffer.from(await response.arrayBuffer()),
      contentType: normalizeContentType(contentType, format),
      metadata: {}
    };
  }

  async textToSpeechWithS2Pro(text, voiceId, overrides = {}) {
    const settings = await this.getSettingsForS2(overrides);
    const config = this.resolveS2Config(settings, { ...overrides, voiceId });
    const urls = this.buildS2SpeechUrls(config.endpoint);
    const headers = {
      ...getAuthHeaders(config.apiKey),
      'Content-Type': 'application/json',
      Accept: 'audio/*,application/json'
    };
    const bodies = this.buildS2RequestBodies({
      text,
      voiceId: config.voiceId,
      model: config.model,
      format: config.format
    });
    let lastError = null;

    for (const url of urls) {
      for (const body of bodies) {
        try {
          const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          }, config.timeoutMs);

          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`S2 Pro returned HTTP ${response.status}: ${detail || response.statusText}`);
          }

          const parsed = await this.parseSpeechResponse(response, config.format);
          return {
            provider: 's2_pro',
            audioBuffer: parsed.audioBuffer,
            contentType: parsed.contentType,
            cacheHit: false,
            modelId: config.model,
            voiceId: config.voiceId,
            endpoint: url,
            metadata: {
              provider: 's2_pro',
              endpoint: url,
              format: config.format,
              ...(parsed.metadata || {})
            },
            tagger: { status: 'not_applicable', provider: 's2_pro' }
          };
        } catch (error) {
          lastError = error;
        }
      }
    }

    throw lastError || new Error('S2 Pro speech generation failed');
  }

  async textToSpeechDetailed(text, voiceId, options = {}) {
    const normalizedText = trimString(text);
    if (!normalizedText) {
      throw new Error('Text is required for text-to-speech');
    }

    const settings = options.settings || await Settings.getSettings();
    const providerOrder = this.resolveProviderOrder(settings, options.provider);
    const errors = [];

    for (const provider of providerOrder) {
      try {
        if (provider === 's2_pro') {
          const s2Config = this.resolveS2Config(settings, options);
          if (!s2Config.endpoint) {
            errors.push({ provider, error: 'S2 Pro endpoint is not configured' });
            continue;
          }
          return await this.textToSpeechWithS2Pro(normalizedText, voiceId, { ...options, settings });
        }

        if (provider === 'elevenlabs') {
          const elevenVoiceId = trimString(voiceId) || trimString(settings.elevenlabsDefaultVoiceId);
          if (!elevenVoiceId || elevenVoiceId === 'default') {
            errors.push({ provider, error: 'ElevenLabs voice ID is not configured' });
            continue;
          }
          const result = await elevenLabsService.textToSpeechDetailed(normalizedText, elevenVoiceId, options);
          return {
            ...result,
            provider: 'elevenlabs',
            contentType: 'audio/mpeg',
            voiceId: elevenVoiceId
          };
        }
      } catch (error) {
        errors.push({ provider, error: error.message });
      }
    }

    const detail = errors.map((entry) => `${entry.provider}: ${entry.error}`).join('; ');
    throw new Error(detail || 'No TTS provider was able to generate speech');
  }

  async listVoices(provider = 'elevenlabs', overrides = {}) {
    if (provider === 'elevenlabs') {
      const voices = await elevenLabsService.getVoices({
        apiKey: trimString(overrides.apiKey),
        requireConfigured: true
      });
      return {
        success: true,
        provider: 'elevenlabs',
        voices: voices.map((voice) => ({
          id: voice.voice_id || voice.id,
          name: voice.name || voice.voice_id || voice.id,
          provider: 'elevenlabs',
          previewUrl: voice.preview_url,
          raw: voice
        }))
      };
    }

    return this.listS2Voices(overrides);
  }

  async testProvider(options = {}) {
    const provider = trimString(options.provider || 'elevenlabs').toLowerCase();
    if (provider === 's2_pro') {
      const voicesResult = await this.listS2Voices(options).catch((error) => ({
        success: false,
        error: error.message,
        voices: []
      }));
      const speech = await this.textToSpeechWithS2Pro(
        trimString(options.text) || DEFAULT_TEST_TEXT,
        trimString(options.voiceId) || undefined,
        options
      );
      return {
        success: true,
        provider: 's2_pro',
        message: `S2 Pro generated ${speech.audioBuffer.length} bytes of audio.`,
        endpoint: speech.endpoint,
        contentType: speech.contentType,
        voiceCount: voicesResult.voices.length,
        voices: voicesResult.voices
      };
    }

    const settings = options.settings || await Settings.getSettings();
    const voiceId = trimString(options.voiceId) || trimString(settings.elevenlabsDefaultVoiceId);
    const voicesResult = await this.listVoices('elevenlabs', options).catch((error) => ({
      success: false,
      error: error.message,
      voices: []
    }));
    const speech = await elevenLabsService.textToSpeechDetailed(
      trimString(options.text) || DEFAULT_TEST_TEXT,
      voiceId,
      { ...options, cache: false }
    );
    return {
      success: true,
      provider: 'elevenlabs',
      message: `ElevenLabs generated ${speech.audioBuffer.length} bytes of audio.`,
      contentType: 'audio/mpeg',
      voiceCount: voicesResult.voices.length,
      voices: voicesResult.voices
    };
  }
}

module.exports = new TtsProviderService();
