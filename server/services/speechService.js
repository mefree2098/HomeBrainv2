const OpenAI = require('openai');
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

class SpeechService {
  constructor() {
    this.cachedConfigKey = null;
    this.cachedSettingsTimestamp = 0;
    this.cachedProviderConfig = null;
    this.openAiClient = null;
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
    const response = await client.audio.transcriptions.create({
      file,
      model: model || 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      language,
      temperature: 0
    });
    const durationMs = Date.now() - startedAt;

    const text = (response?.text || '').trim();
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

  async transcribeWithWhisperLocal({ audioBuffer, sampleRate, channels, format, language, model }) {
    if (format && format.toUpperCase() !== 'S16LE') {
      throw new Error(`Unsupported audio format "${format}". Only S16LE PCM is currently supported.`);
    }

    const activeModel = model || 'small';
    try {
      const status = await whisperService.getStatus();
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
