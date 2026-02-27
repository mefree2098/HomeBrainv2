const OpenAI = require('openai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Settings = require('../models/Settings');
const whisperService = require('./whisperService');

function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample = 16) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    throw new Error('pcmToWav: audio data must be a Buffer');
  }
  const header = Buffer.alloc(44);
  const subchunk2Size = pcmBuffer.length;
  const chunkSize = 36 + subchunk2Size;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM subchunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(subchunk2Size, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function normalizeMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return 'audio/webm';
  }
  return mimeType.split(';')[0].trim().toLowerCase();
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  switch (normalized) {
    case 'audio/webm':
      return 'webm';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    default:
      return 'webm';
  }
}

class SpeechService {
  constructor() {
    this.cachedConfigKey = null;
    this.cachedSettingsTimestamp = 0;
    this.cachedProviderConfig = null;
    this.openAiClient = null;
    this.modelResponseFormatCache = new Map();
  }

  async getProviderConfig() {
    const now = Date.now();
    if (this.cachedProviderConfig && now - this.cachedSettingsTimestamp < 30_000) {
      return this.cachedProviderConfig;
    }

    const settings = await Settings.getSettings();
    const provider = process.env.STT_PROVIDER || settings.sttProvider || 'openai';
    const normalizedProvider = provider === 'local' ? 'whisper_local' : provider;

    let model;
    if (normalizedProvider === 'whisper_local') {
      model = process.env.STT_MODEL || settings.sttModel || 'small';
    } else {
      model =
        process.env.STT_MODEL ||
        settings.sttModel ||
        (normalizedProvider === 'openai' ? 'gpt-4o-mini-transcribe' : 'openai');
    }
    const language = process.env.STT_LANGUAGE || settings.sttLanguage || 'en';

    const config = { provider: normalizedProvider, model, language };
    this.cachedProviderConfig = config;
    this.cachedSettingsTimestamp = now;
    return config;
  }

  async getOpenAiClient() {
    if (this.openAiClient) {
      return this.openAiClient;
    }

    const settings = await Settings.getSettings();
    const apiKey =
      process.env.OPENAI_API_KEY ||
      settings.openaiApiKey ||
      process.env.STT_OPENAI_API_KEY;

    if (!apiKey || !apiKey.trim()) {
      throw new Error('OpenAI API key not configured for speech-to-text');
    }

    this.openAiClient = new OpenAI({ apiKey: apiKey.trim() });
    return this.openAiClient;
  }

  computeConfidence(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      return 0.6;
    }

    const confidences = segments
      .map((segment) => {
        if (typeof segment.confidence === 'number') {
          return segment.confidence;
        }
        if (typeof segment.avg_logprob === 'number') {
          // avg_logprob typically ranges from approx [-5, 0]
          const normalized = 1 + (segment.avg_logprob / 5);
          return Math.max(0, Math.min(1, normalized));
        }
        return null;
      })
      .filter((value) => typeof value === 'number');

    if (!confidences.length) {
      return 0.6;
    }

    const sum = confidences.reduce((acc, value) => acc + value, 0);
    return Math.max(0, Math.min(1, sum / confidences.length));
  }

  normalizeModelName(model) {
    if (typeof model !== 'string') {
      return '';
    }
    return model.trim().toLowerCase();
  }

  getPreferredOpenAiResponseFormat(model) {
    const normalizedModel = this.normalizeModelName(model);
    const cachedFormat = this.modelResponseFormatCache.get(normalizedModel);
    if (cachedFormat) {
      return cachedFormat;
    }

    // Newer GPT-4o transcription variants reject verbose_json and support json/text.
    if (normalizedModel.includes('gpt-4o') && normalizedModel.includes('transcribe')) {
      return 'json';
    }

    // Whisper-family models commonly support verbose_json segments.
    return 'verbose_json';
  }

  extractTranscriptionText(response) {
    if (!response) {
      return '';
    }
    if (typeof response === 'string') {
      return response.trim();
    }
    if (typeof response.text === 'string') {
      return response.text.trim();
    }
    return '';
  }

  parseOpenAiResponseFormatError(error) {
    const message = (error?.message || '').toLowerCase();
    if (!message.includes('response_format')) {
      return null;
    }

    if (message.includes("use 'json' or 'text'")) {
      return ['json', 'text'];
    }
    if (message.includes("use 'json'")) {
      return ['json'];
    }
    if (message.includes("use 'text'")) {
      return ['text'];
    }
    return ['json', 'text'];
  }

  async createOpenAiTranscription({ client, file, model, language, temperature = 0 }) {
    const normalizedModel = this.normalizeModelName(model || 'gpt-4o-mini-transcribe');
    const preferredFormat = this.getPreferredOpenAiResponseFormat(model);
    const attemptedFormats = new Set([preferredFormat]);
    const fallbackFormats = preferredFormat === 'verbose_json'
      ? ['json', 'text']
      : ['text', 'verbose_json'];

    const tryFormat = async (responseFormat) => {
      const payload = {
        file,
        model: model || 'gpt-4o-mini-transcribe',
        response_format: responseFormat,
        language,
        temperature
      };
      return client.audio.transcriptions.create(payload);
    };

    try {
      const response = await tryFormat(preferredFormat);
      this.modelResponseFormatCache.set(normalizedModel, preferredFormat);
      return response;
    } catch (error) {
      const suggestedFormats = this.parseOpenAiResponseFormatError(error);
      if (!suggestedFormats) {
        throw error;
      }

      const orderedFormats = [...suggestedFormats, ...fallbackFormats].filter((format) => !attemptedFormats.has(format));
      for (const format of orderedFormats) {
        attemptedFormats.add(format);
        try {
          const retryResponse = await tryFormat(format);
          this.modelResponseFormatCache.set(normalizedModel, format);
          return retryResponse;
        } catch (retryError) {
          if (!this.parseOpenAiResponseFormatError(retryError)) {
            throw retryError;
          }
        }
      }

      throw error;
    }
  }

  async transcribe({ audioBuffer, sampleRate = 16000, channels = 1, format = 'S16LE', language }) {
    if (!audioBuffer || !audioBuffer.length) {
      throw new Error('No audio data provided for transcription');
    }

    const providerConfig = await this.getProviderConfig();
    const sttLanguage = language || providerConfig.language || 'en';

    switch (providerConfig.provider) {
      case 'openai':
        return this.transcribeWithOpenAI({
          audioBuffer,
          sampleRate,
          channels,
          format,
          language: sttLanguage,
          model: providerConfig.model
        });
      case 'whisper_local':
        return this.transcribeWithWhisperLocal({
          audioBuffer,
          sampleRate,
          channels,
          format,
          language: sttLanguage,
          model: providerConfig.model
        });
      default:
        throw new Error(`Unsupported speech-to-text provider: ${providerConfig.provider}`);
    }
  }

  async transcribeMediaBuffer({ audioBuffer, mimeType = 'audio/webm', language, model }) {
    if (!audioBuffer || !audioBuffer.length) {
      throw new Error('No audio data provided for transcription');
    }

    const providerConfig = await this.getProviderConfig();
    const sttLanguage = language || providerConfig.language || 'en';
    if (providerConfig.provider === 'whisper_local') {
      const resolvedModel = model || providerConfig.model || 'small';
      return this.transcribeMediaWithWhisperLocal({
        audioBuffer,
        mimeType,
        language: sttLanguage,
        model: resolvedModel
      });
    }

    const resolvedModel = model || providerConfig.model || 'gpt-4o-mini-transcribe';
    return this.transcribeMediaWithOpenAI({
      audioBuffer,
      mimeType,
      language: sttLanguage,
      model: resolvedModel
    });
  }

  async transcribeWithOpenAI({ audioBuffer, sampleRate, channels, format, language, model }) {
    if (format && format.toUpperCase() !== 'S16LE') {
      throw new Error(`Unsupported audio format "${format}". Only S16LE PCM is currently supported.`);
    }

    const client = await this.getOpenAiClient();
    const wavBuffer = pcmToWav(audioBuffer, sampleRate, channels);
    const file = await OpenAI.toFile(wavBuffer, `command-${Date.now()}.wav`, {
      type: 'audio/wav'
    });

    const startedAt = Date.now();
    const response = await this.createOpenAiTranscription({
      client,
      file,
      model: model || 'gpt-4o-mini-transcribe',
      language,
      temperature: 0
    });
    const durationMs = Date.now() - startedAt;

    const text = this.extractTranscriptionText(response);
    const segments = Array.isArray(response?.segments) ? response.segments : [];

    return {
      provider: 'openai',
      model: model || 'gpt-4o-mini-transcribe',
      text,
      language: response?.language || language,
      duration: response?.duration || null,
      segments,
      confidence: this.computeConfidence(segments),
      processingTimeMs: durationMs
    };
  }

  async transcribeMediaWithOpenAI({ audioBuffer, mimeType, language, model }) {
    const client = await this.getOpenAiClient();
    const normalizedMimeType = normalizeMimeType(mimeType);
    const extension = extensionForMimeType(normalizedMimeType);

    const file = await OpenAI.toFile(audioBuffer, `browser-${Date.now()}.${extension}`, {
      type: normalizedMimeType
    });

    const startedAt = Date.now();
    const response = await this.createOpenAiTranscription({
      client,
      file,
      model: model || 'gpt-4o-mini-transcribe',
      language,
      temperature: 0
    });
    const durationMs = Date.now() - startedAt;

    const text = this.extractTranscriptionText(response);
    const segments = Array.isArray(response?.segments) ? response.segments : [];

    return {
      provider: 'openai',
      model: model || 'gpt-4o-mini-transcribe',
      text,
      language: response?.language || language,
      duration: response?.duration || null,
      segments,
      confidence: this.computeConfidence(segments),
      processingTimeMs: durationMs
    };
  }

  async transcribeMediaWithWhisperLocal({ audioBuffer, mimeType, language, model }) {
    const normalizedMimeType = normalizeMimeType(mimeType);
    const extension = extensionForMimeType(normalizedMimeType);
    const tempDir = path.join(os.tmpdir(), 'homebrain-whisper-media');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
    await fs.promises.writeFile(filePath, audioBuffer);

    const activeModel = model || 'small';
    let status = null;
    try {
      status = await whisperService.getStatus();
      if (status.activeModel !== activeModel && status.installedModels?.some((m) => m.name === activeModel)) {
        await whisperService.setActiveModel(activeModel);
      } else if (status.activeModel !== activeModel && status.installedModels?.length) {
        try {
          await whisperService.downloadModel(activeModel);
          await whisperService.setActiveModel(activeModel);
        } catch (downloadError) {
          console.warn(`Whisper local: failed to download model ${activeModel}:`, downloadError.message);
        }
      }
    } catch (error) {
      console.warn('Whisper local: failed to sync model state:', error.message);
    }

    try {
      const startedAt = Date.now();
      const response = await whisperService.transcribeFile({
        filePath,
        language,
        // Browser fallback clips are short and often begin/end mid-utterance;
        // disabling VAD here prevents Whisper from dropping usable speech.
        vadFilter: false
      });
      const durationMs = Date.now() - startedAt;

      const segments = Array.isArray(response?.segments) ? response.segments : [];
      const confidenceFromAvg = typeof response?.avgLogProb === 'number'
        ? Math.max(0, Math.min(1, 1 + (response.avgLogProb / 5)))
        : null;
      const confidence = confidenceFromAvg ?? this.computeConfidence(segments);

      return {
        provider: 'whisper_local',
        model: response?.model || activeModel,
        device: response?.device || status?.activeDevice || null,
        computeType: response?.computeType || null,
        text: (response?.text || '').trim(),
        language: response?.language || language,
        duration: null,
        segments,
        confidence,
        processingTimeMs: response?.processingTimeMs || durationMs
      };
    } finally {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }

  async transcribeWithWhisperLocal({ audioBuffer, sampleRate, channels, format, language, model }) {
    if (format && format.toUpperCase() !== 'S16LE') {
      throw new Error(`Unsupported audio format "${format}". Only S16LE PCM is currently supported.`);
    }

    const activeModel = model || 'small';
    let status = null;
    try {
      status = await whisperService.getStatus();
      if (status.activeModel !== activeModel && status.installedModels?.some((m) => m.name === activeModel)) {
        await whisperService.setActiveModel(activeModel);
      } else if (status.activeModel !== activeModel && status.installedModels?.length) {
        // If requested model not downloaded yet, attempt to download then set active
        try {
          await whisperService.downloadModel(activeModel);
          await whisperService.setActiveModel(activeModel);
        } catch (downloadError) {
          console.warn(`Whisper local: failed to download model ${activeModel}:`, downloadError.message);
        }
      }
    } catch (error) {
      console.warn('Whisper local: failed to sync model state:', error.message);
    }

    const startedAt = Date.now();
    const response = await whisperService.transcribe({
      audioBuffer,
      sampleRate,
      channels,
      language
    });
    const durationMs = Date.now() - startedAt;

    const segments = Array.isArray(response?.segments) ? response.segments : [];
    const confidenceFromAvg = typeof response?.avgLogProb === 'number'
      ? Math.max(0, Math.min(1, 1 + (response.avgLogProb / 5)))
      : null;

    const confidence = confidenceFromAvg ?? this.computeConfidence(segments);

    return {
      provider: 'whisper_local',
      model: response?.model || activeModel,
      device: response?.device || status?.activeDevice || null,
      computeType: response?.computeType || null,
      text: (response?.text || '').trim(),
      language: response?.language || language,
      duration: null,
      segments,
      confidence,
      processingTimeMs: response?.processingTimeMs || durationMs
    };
  }
}

module.exports = new SpeechService();
