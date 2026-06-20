const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { HomeBrainRemoteDevice } = require('./index');

function createFakeSidecar() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = {
    writes: [],
    ended: false,
    write(data) {
      this.writes.push(data);
    },
    end() {
      this.ended = true;
    }
  };
  child.killSignal = null;
  child.kill = (signal) => {
    child.killSignal = signal;
  };
  return child;
}

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
    audioType: 'raw',
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
    audioType: 'raw',
    device: 'hw:2,0'
  });
});

test('buildRecordingOptions preserves explicit audio type overrides', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      sampleRate: 16000,
      audioType: 'wav'
    },
    wakeWord: {}
  });

  assert.equal(device.buildRecordingOptions().audioType, 'wav');
});

test('isWakeWordDetectorActive treats the feature sidecar as an active detector', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {},
    wakeWord: {}
  });

  device.recordingStream = { stop() {} };
  device.sidecar = { pid: 1234 };

  assert.equal(device.isWakeWordDetectorActive(), true);
});

test('stale stopped sidecar close does not clear the replacement sidecar', async (t) => {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  const oldSidecar = createFakeSidecar();
  const nextSidecar = createFakeSidecar();
  const spawned = [oldSidecar, nextSidecar];
  childProcess.spawn = () => spawned.shift();

  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: {}
  });

  device.reportWakeWordRuntimeStatus = () => {};
  device.handleWakeWordEngineFailure = () => {
    throw new Error('stale stopped sidecar should not fail the replacement detector');
  };

  const keywords = [{ label: 'Anna', path: '/tmp/anna.onnx', threshold: 0.5 }];
  await device.startFeatureSidecar(keywords);
  device.stopFeatureSidecar();
  await device.startFeatureSidecar(keywords);

  oldSidecar.emit('close', null, 'SIGTERM');

  assert.equal(oldSidecar.killSignal, 'SIGTERM');
  assert.equal(device.sidecar, nextSidecar);
});
