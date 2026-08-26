const test = require('node:test');
const assert = require('node:assert/strict');

const speechService = require('../services/speechService');
const whisperService = require('../services/whisperService');

test('room voice transcription defaults to greedy beam size one', async (t) => {
  const originalGetStatus = whisperService.getStatus;
  const originalTranscribe = whisperService.transcribe;
  const originalBeamSize = process.env.STT_BEAM_SIZE;
  t.after(() => {
    whisperService.getStatus = originalGetStatus;
    whisperService.transcribe = originalTranscribe;
    if (originalBeamSize === undefined) delete process.env.STT_BEAM_SIZE;
    else process.env.STT_BEAM_SIZE = originalBeamSize;
  });
  delete process.env.STT_BEAM_SIZE;
  whisperService.getStatus = async () => ({
    activeModel: 'small',
    activeDevice: 'cpu',
    installedModels: [{ name: 'small' }]
  });
  let request = null;
  whisperService.transcribe = async (options) => {
    request = options;
    return {
      text: 'turn off the office',
      segments: [],
      language: 'en',
      provider: 'whisper_local',
      model: 'small',
      processingTimeMs: 25
    };
  };

  const result = await speechService.transcribeWithWhisperLocal({
    audioBuffer: Buffer.alloc(3200),
    sampleRate: 16000,
    channels: 1,
    format: 'S16LE',
    language: 'en',
    model: 'small'
  });

  assert.equal(request.beamSize, 1);
  assert.equal(result.beamSize, 1);
  assert.equal(result.text, 'turn off the office');
});

test('room voice transcription falls back locally when LAN Whisper is unavailable', async (t) => {
  const originals = {
    getProviderConfig: speechService.getProviderConfig,
    transcribeWithLanWhisper: speechService.transcribeWithLanWhisper,
    transcribeWithWhisperLocal: speechService.transcribeWithWhisperLocal,
    getStatus: whisperService.getStatus
  };
  t.after(() => {
    speechService.getProviderConfig = originals.getProviderConfig;
    speechService.transcribeWithLanWhisper = originals.transcribeWithLanWhisper;
    speechService.transcribeWithWhisperLocal = originals.transcribeWithWhisperLocal;
    whisperService.getStatus = originals.getStatus;
  });

  speechService.getProviderConfig = async () => ({
    provider: 'lan_whisper',
    model: 'large-v3',
    language: 'en',
    lanEndpoint: 'http://192.168.1.30:8000',
    lanApiKey: '',
    lanTimeoutMs: 1000
  });
  speechService.transcribeWithLanWhisper = async () => {
    throw new Error('connection refused');
  };
  whisperService.getStatus = async () => ({ activeModel: 'tiny' });
  let localRequest = null;
  speechService.transcribeWithWhisperLocal = async (options) => {
    localRequest = options;
    return { provider: 'whisper_local', model: 'tiny', text: 'turn off the office' };
  };

  const result = await speechService.transcribe({
    audioBuffer: Buffer.alloc(3200),
    sampleRate: 16000,
    channels: 1,
    format: 'S16LE'
  });

  assert.equal(localRequest.model, 'tiny');
  assert.equal(result.text, 'turn off the office');
  assert.equal(result.fallbackFrom, 'lan_whisper');
  assert.match(result.fallbackReason, /connection refused/);
});

test('wake verification can fail closed without starting the slower local fallback', async (t) => {
  const originals = {
    getProviderConfig: speechService.getProviderConfig,
    transcribeWithLanWhisper: speechService.transcribeWithLanWhisper,
    transcribeWithWhisperLocal: speechService.transcribeWithWhisperLocal
  };
  t.after(() => {
    speechService.getProviderConfig = originals.getProviderConfig;
    speechService.transcribeWithLanWhisper = originals.transcribeWithLanWhisper;
    speechService.transcribeWithWhisperLocal = originals.transcribeWithWhisperLocal;
  });

  speechService.getProviderConfig = async () => ({
    provider: 'lan_whisper',
    model: 'large-v3',
    language: 'en',
    lanEndpoint: 'http://192.168.1.30:8000',
    lanApiKey: '',
    lanTimeoutMs: 1000
  });
  speechService.transcribeWithLanWhisper = async () => {
    throw new Error('connection refused');
  };
  let localFallbackCalled = false;
  speechService.transcribeWithWhisperLocal = async () => {
    localFallbackCalled = true;
    return { text: 'unexpected fallback' };
  };

  await assert.rejects(
    speechService.transcribe({
      audioBuffer: Buffer.alloc(3200),
      sampleRate: 16000,
      channels: 1,
      format: 'S16LE',
      allowFallback: false
    }),
    /connection refused/
  );
  assert.equal(localFallbackCalled, false);
});
