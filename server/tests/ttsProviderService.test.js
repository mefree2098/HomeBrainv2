const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../models/Settings');
const elevenLabsService = require('../services/elevenLabsService');
const ttsProviderService = require('../services/ttsProviderService');

test('TTS provider order defaults to ElevenLabs first', () => {
  assert.deepEqual(ttsProviderService.resolveProviderOrder({}), ['elevenlabs', 's2_pro']);
  assert.deepEqual(
    ttsProviderService.resolveProviderOrder({
      ttsProvider: 's2_pro',
      ttsProviderPriorityList: ['elevenlabs', 's2_pro']
    }),
    ['s2_pro', 'elevenlabs']
  );
});

test('ElevenLabs voice queries pass explicit API key overrides', async (t) => {
  const originalGetVoices = elevenLabsService.getVoices;
  let capturedOptions = null;

  elevenLabsService.getVoices = async (options) => {
    capturedOptions = options;
    return [{ voice_id: 'voice-anna', name: 'Anna' }];
  };

  t.after(() => {
    elevenLabsService.getVoices = originalGetVoices;
  });

  const result = await ttsProviderService.listVoices('elevenlabs', {
    apiKey: 'typed-elevenlabs-key'
  });

  assert.equal(capturedOptions.apiKey, 'typed-elevenlabs-key');
  assert.equal(capturedOptions.requireConfigured, true);
  assert.equal(result.provider, 'elevenlabs');
  assert.deepEqual(result.voices.map((voice) => voice.id), ['voice-anna']);
});

test('ElevenLabs TTS tests pass API key and selected voice to ElevenLabs service', async (t) => {
  const originalGetSettings = Settings.getSettings;
  const originalGetVoices = elevenLabsService.getVoices;
  const originalTextToSpeech = elevenLabsService.textToSpeechDetailed;
  let capturedSpeechArgs = null;

  Settings.getSettings = async () => ({
    elevenlabsDefaultVoiceId: 'stored-voice'
  });
  elevenLabsService.getVoices = async () => [{ voice_id: 'voice-anna', name: 'Anna' }];
  elevenLabsService.textToSpeechDetailed = async (...args) => {
    capturedSpeechArgs = args;
    return { audioBuffer: Buffer.from('mp3') };
  };

  t.after(() => {
    Settings.getSettings = originalGetSettings;
    elevenLabsService.getVoices = originalGetVoices;
    elevenLabsService.textToSpeechDetailed = originalTextToSpeech;
  });

  const result = await ttsProviderService.testProvider({
    provider: 'elevenlabs',
    apiKey: 'typed-elevenlabs-key',
    voiceId: 'selected-voice',
    text: 'Hello from HomeBrain.'
  });

  assert.equal(capturedSpeechArgs[0], 'Hello from HomeBrain.');
  assert.equal(capturedSpeechArgs[1], 'selected-voice');
  assert.equal(capturedSpeechArgs[2].apiKey, 'typed-elevenlabs-key');
  assert.equal(capturedSpeechArgs[2].cache, false);
  assert.equal(result.provider, 'elevenlabs');
  assert.equal(result.voiceCount, 1);
});
