const assert = require('node:assert/strict');
const test = require('node:test');

const { HomeBrainRemoteDevice } = require('./index');

test('buildRecordingOptions passes the configured ALSA recorder and capture device', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      sampleRate: 16000,
      channels: 1,
      recordProgram: 'arecord',
      recordingDevice: 'plughw:CARD=Jabra,DEV=0',
      threshold: 0.2
    },
    wakeWord: {}
  });

  assert.deepEqual(device.buildRecordingOptions(), {
    sampleRate: 16000,
    sampleRateHertz: 16000,
    channels: 1,
    threshold: 0.2,
    verbose: false,
    recorder: 'arecord',
    recordProgram: 'arecord',
    device: 'plughw:CARD=Jabra,DEV=0'
  });
});

test('buildRecordingOptions preserves recorder override and microphoneDevice fallback', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      sampleRate: 48000,
      channels: 2,
      recorder: 'sox',
      microphoneDevice: 'hw:2,0'
    },
    wakeWord: {}
  });

  assert.deepEqual(device.buildRecordingOptions(), {
    sampleRate: 48000,
    sampleRateHertz: 48000,
    channels: 2,
    threshold: 0.5,
    verbose: false,
    recorder: 'sox',
    recordProgram: 'sox',
    device: 'hw:2,0'
  });
});
