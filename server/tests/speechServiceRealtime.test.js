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
