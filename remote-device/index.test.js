const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HomeBrainRemoteDevice,
  detectAudioFileExtension,
  getAudioPlaybackCommands,
  normalizeAudioCommand
} = require('./index');

function createFakeSidecar() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
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

test('detectAudioFileExtension recognizes common TTS audio formats', () => {
  assert.equal(detectAudioFileExtension(Buffer.from('ID3abc'), ''), '.mp3');
  assert.equal(detectAudioFileExtension(Buffer.from([0xff, 0xfb, 0x90, 0x64]), ''), '.mp3');
  assert.equal(detectAudioFileExtension(Buffer.from('RIFFxxxxWAVEfmt '), ''), '.wav');
  assert.equal(detectAudioFileExtension(Buffer.from('anything'), 'audio/mpeg; charset=binary'), '.mp3');
  assert.equal(detectAudioFileExtension(Buffer.from('anything'), 'audio/wav'), '.wav');
  assert.equal(detectAudioFileExtension(Buffer.from('not audio'), ''), '.bin');
});

test('getAudioPlaybackCommands never sends compressed or unknown bytes to aplay', () => {
  const mp3Commands = getAudioPlaybackCommands('/tmp/tts.mp3', { extension: '.mp3' });
  assert.deepEqual(mp3Commands.map(([command]) => command), ['mpg123', 'ffplay', 'play']);

  const unknownCommands = getAudioPlaybackCommands('/tmp/tts.bin', { extension: '.bin' });
  assert.deepEqual(unknownCommands.map(([command]) => command), ['ffplay', 'play']);

  const wavCommands = getAudioPlaybackCommands('/tmp/tts.wav', {
    extension: '.wav',
    playbackDevice: 'sysdefault:CARD=MS'
  });
  assert.equal(wavCommands.some(([command]) => command === 'aplay'), true);
  assert.deepEqual(wavCommands.at(-1), ['aplay', ['-q', '-D', 'sysdefault:CARD=MS', '/tmp/tts.wav']]);
});

test('audio process launches accept only supported executables and bounded argv', () => {
  assert.deepEqual(normalizeAudioCommand('aplay', ['-q', '/tmp/test.wav']), {
    command: 'aplay',
    args: ['-q', '/tmp/test.wav']
  });
  assert.throws(() => normalizeAudioCommand('sh', ['-c', 'id']), /Unsupported audio executable/);
  assert.throws(() => normalizeAudioCommand('aplay', ['bad\0arg']), /Invalid audio command argument/);
});

test('hub resource and websocket URLs remain on the configured origin', () => {
  const device = new HomeBrainRemoteDevice({
    hubUrl: 'https://hub.example.test',
    audio: {},
    wakeWord: {}
  });
  device.deviceId = 'device with spaces';

  assert.equal(
    device.buildAbsoluteHubUrl('/api/wake-word/model.bin'),
    'https://hub.example.test/api/wake-word/model.bin'
  );
  assert.throws(
    () => device.buildAbsoluteHubUrl('https://attacker.example/model.bin'),
    /configured HomeBrain origin/
  );
  assert.equal(
    device.buildWebSocketUrl('https://hub.example.test'),
    'wss://hub.example.test/ws/voice-device?deviceId=device+with+spaces'
  );
  assert.equal(device.normaliseHubBaseUrl('https://user:secret@hub.example.test'), null);
  assert.equal(device.normaliseHubBaseUrl('http://public.example.test'), null);
});

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

test('buildRecordingOptions auto-selects a preferred ALSA capture device', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      sampleRate: 16000,
      recordingDevice: 'auto',
      preferredInputName: 'Jabra'
    },
    wakeWord: {}
  });

  device.detectPreferredCaptureDevice = (preferredName) => {
    assert.equal(preferredName, 'Jabra');
    return {
      device: 'plughw:2,0',
      label: 'Jabra Speak USB Audio'
    };
  };

  assert.equal(device.buildRecordingOptions().device, 'plughw:2,0');
  assert.equal(device.config.audio.resolvedRecordingDevice, 'plughw:2,0');
});

test('selectAlsaCaptureDevice prefers Jabra USB capture devices', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {},
    wakeWord: {}
  });

  const devices = device.parseAlsaCaptureDevices([
    'card 0: vc4hdmi [vc4-hdmi], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]',
    'card 2: Jabra [Jabra SPEAK 510 USB], device 0: USB Audio [USB Audio]'
  ].join('\n'));

  const selected = device.selectAlsaCaptureDevice(devices, 'Jabra');

  assert.equal(selected.device, 'plughw:2,0');
  assert.match(selected.label, /Jabra/);
});

test('detectPreferredCaptureDevice probes ALSA candidates before selecting one', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {},
    wakeWord: {}
  });

  const devices = device.parseAlsaCaptureDevices([
    'card 2: Jabra [Jabra SPEAK 510 USB], device 0: USB Audio [USB Audio]'
  ].join('\n'));
  const probed = [];
  device.listAlsaCaptureDevices = () => ({ devices, error: null, output: '' });
  device.probeCaptureDevice = (candidate) => {
    probed.push(candidate);
    return {
      ok: candidate === 'sysdefault:CARD=Jabra',
      exit: candidate === 'sysdefault:CARD=Jabra' ? 'code 0' : 'code 1',
      stderr: candidate === 'sysdefault:CARD=Jabra' ? null : 'read error'
    };
  };

  const selected = device.detectPreferredCaptureDevice('Jabra', {
    sampleRate: 16000,
    channels: 1
  });

  assert.equal(selected.device, 'sysdefault:CARD=Jabra');
  assert.deepEqual(probed, [
    'plughw:CARD=Jabra,DEV=0',
    'sysdefault:CARD=Jabra'
  ]);
  assert.equal(device.config.audio.lastCaptureProbe.selected, 'sysdefault:CARD=Jabra');
});

test('auto capture falls back to a validated playback-card alias when ALSA enumeration fails', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      recordingDevice: 'auto',
      preferredInputName: 'Jabra',
      playbackDevice: 'sysdefault:CARD=MS',
      sampleRate: 16000,
      channels: 1
    },
    wakeWord: {}
  });
  device.listAlsaCaptureDevices = () => ({ devices: [], error: 'no cards listed', output: '' });
  device.probeCaptureDevice = (candidate) => ({
    ok: candidate === 'sysdefault:CARD=MS',
    exit: candidate === 'sysdefault:CARD=MS' ? 'code 0' : 'code 1',
    stderr: null
  });

  assert.equal(device.buildRecordingOptions().device, 'sysdefault:CARD=MS');
  assert.equal(device.config.audio.lastCaptureProbe.selected, 'sysdefault:CARD=MS');
});

test('applyConfigUpdate merges pushed audio config and restarts the detector', async () => {
  const device = new HomeBrainRemoteDevice({
    audio: {
      sampleRate: 16000,
      recordingDevice: 'default'
    },
    wakeWord: {}
  });

  device.syncWakeWordAssetsFromConfig = async () => false;
  device.detectPreferredCaptureDevice = () => ({
    device: 'plughw:2,0',
    label: 'Jabra Speak USB Audio'
  });

  const restartNeeded = await device.applyConfigUpdate({
    audio: {
      recordingDevice: 'auto',
      preferredInputName: 'Jabra'
    },
    voice: {
      endpointing: {
        maxDurationMs: 8000,
        silenceMs: 550,
        speechStartTimeoutMs: 3000,
        minRms: 0.0012
      }
    }
  });

  assert.equal(restartNeeded, true);
  assert.equal(device.config.audio.recordingDevice, 'auto');
  assert.equal(device.buildRecordingOptions().device, 'plughw:2,0');
  assert.equal(device.voiceConfig.endpointing.maxDurationMs, 8000);
  assert.equal(device.voiceConfig.endpointing.silenceMs, 550);
  assert.equal(device.voiceConfig.endpointing.speechStartTimeoutMs, 3000);
  assert.equal(device.voiceConfig.endpointing.minRms, 0.0012);
});

test('command endpoint timers accept bounded live tuning', () => {
  const device = new HomeBrainRemoteDevice({ audio: {}, wakeWord: {} });

  const endpointing = device.normalizeCommandEndpointing(9000, {
    maxDurationMs: 8000,
    minCaptureMs: 750,
    silenceMs: 550,
    speechStartTimeoutMs: 3000,
    minSpeechMs: 100,
    minRms: 0.0012
  });

  assert.deepEqual(endpointing, {
    maxDurationMs: 8000,
    minCaptureMs: 750,
    silenceMs: 550,
    speechStartTimeoutMs: 3000,
    minSpeechMs: 100,
    minRms: 0.0012
  });
});

test('syncWakeWordAssetsFromConfig downloads ONNX external data dependencies', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-wake-assets-'));
  t.after(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const modelBuffer = Buffer.from('model');
  const dependencyBuffer = Buffer.from('external-data');
  const checksum = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const downloadedUrls = [];

  const device = new HomeBrainRemoteDevice({
    hubUrl: 'https://homebrain.example',
    audio: {},
    wakeWord: {
      cacheDir
    }
  });

  device.downloadWakeWordAsset = async (url) => {
    downloadedUrls.push(url);
    return url.includes('dependency=') ? dependencyBuffer : modelBuffer;
  };

  const assetsChanged = await device.syncWakeWordAssetsFromConfig({
    wakeWord: {
      assets: [{
        label: 'Hey Anna',
        slug: 'hey-anna',
        fileName: 'hey-anna.onnx',
        format: 'onnx',
        engine: 'openwakeword',
        checksum: checksum(modelBuffer),
        downloadUrl: '/api/remote-devices/device/wake-words/hey-anna',
        dependencies: [{
          fileName: 'hey-anna.onnx.data',
          checksum: checksum(dependencyBuffer),
          downloadUrl: '/api/remote-devices/device/wake-words/hey-anna?dependency=hey-anna.onnx.data'
        }]
      }]
    }
  });

  assert.equal(assetsChanged, true);
  assert.equal(fs.readFileSync(path.join(cacheDir, 'hey-anna.onnx'), 'utf8'), 'model');
  assert.equal(fs.readFileSync(path.join(cacheDir, 'hey-anna.onnx.data'), 'utf8'), 'external-data');
  assert.equal(device.hasLocalWakeWordModels(), true);
  assert.equal(device.config.wakeWord.keywords[0].dependencies[0].fileName, 'hey-anna.onnx.data');
  assert.equal(device.config.wakeWord.keywords[0].dependencies[0].path, path.join(cacheDir, 'hey-anna.onnx.data'));
  assert.deepEqual(downloadedUrls, [
    'https://homebrain.example/api/remote-devices/device/wake-words/hey-anna',
    'https://homebrain.example/api/remote-devices/device/wake-words/hey-anna?dependency=hey-anna.onnx.data'
  ]);
});

test('startVoiceRecording uses resolved auto capture device for command audio', async (t) => {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  const spawned = [];
  childProcess.spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    spawned.push({ command, args, options, child });
    return child;
  };

  const device = new HomeBrainRemoteDevice({
    audio: {
      recordingDevice: 'auto',
      preferredInputName: 'Jabra',
      sampleRate: 16000,
      channels: 1
    },
    wakeWord: {}
  });

  device.detectPreferredCaptureDevice = () => ({
    device: 'sysdefault:CARD=MS',
    label: 'MS Jabra Speak2 40'
  });
  device.stopFeatureSidecar = () => {};
  device.sendMessage = () => true;

  device.startVoiceRecording(5000, true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'arecord');
  assert.deepEqual(spawned[0].args.slice(0, 4), ['-q', '-D', 'sysdefault:CARD=MS', '-t']);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('-c') + 1], '1');
  assert.equal(device.config.audio.resolvedRecordingDevice, 'sysdefault:CARD=MS');

  device.stopVoiceRecording();
});

test('startVoiceRecording prepends pending wake pre-roll audio', async (t) => {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    return child;
  };

  const device = new HomeBrainRemoteDevice({
    audio: { recordingDevice: 'default', sampleRate: 16000, channels: 1 },
    wakeWord: {}
  });
  const messages = [];
  const preRoll = Buffer.from([1, 2, 3, 4]);

  device.stopFeatureSidecar = () => {};
  device.sendMessage = (message) => {
    messages.push(message);
    return true;
  };
  device.pendingCommandPreRollBuffer = preRoll;

  device.startVoiceRecording(5000, true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(messages[0].type, 'audio_data');
  assert.equal(messages[0].isStart, true);
  assert.equal(messages[1].type, 'audio_data');
  assert.equal(messages[1].preRoll, true);
  assert.equal(messages[1].sequence, 0);
  assert.deepEqual(Buffer.from(messages[1].audioData, 'base64'), preRoll);

  device.stopVoiceRecording();
});

test('pending command audio bridges speech spoken while the hub acknowledges the wake word', () => {
  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: {}
  });
  device.pendingCommandPreRollBuffer = Buffer.from([1, 2]);
  device.pendingCommandBridgeOffset = 2;

  device.appendPendingCommandAudio(Buffer.from([3, 4, 5]));

  assert.deepEqual(device.pendingCommandPreRollBuffer, Buffer.from([1, 2, 3, 4, 5]));
  assert.equal(device.pendingCommandBridgeOffset, 2);
});

test('adaptive command endpointing ends after speech followed by silence', async () => {
  const device = new HomeBrainRemoteDevice({
    audio: { recordingDevice: 'default', sampleRate: 16000, channels: 1 },
    wakeWord: {}
  });
  const messages = [];
  device.recordingStream = { stop() {} };
  device.sidecar = createFakeSidecar();
  device.sendMessage = (message) => {
    messages.push(message);
    return true;
  };
  device.restartWakeWordDetection = async () => {};

  device.startVoiceRecording(2000, true, {
    minCaptureMs: 0,
    silenceMs: 250,
    speechStartTimeoutMs: 1000,
    minSpeechMs: 40,
    minRms: 0.001
  });
  const speechFrame = Buffer.alloc(2560);
  for (let offset = 0; offset < speechFrame.length; offset += 2) {
    speechFrame.writeInt16LE(offset % 4 === 0 ? 12000 : -12000, offset);
  }
  device.streamCommandAudioChunk(speechFrame, { source: 'wake_stream' });
  await new Promise((resolve) => setTimeout(resolve, 320));

  const final = messages.find((message) => message.isFinal === true);
  assert.ok(final);
  assert.equal(final.endpointReason, 'silence');
  assert.equal(final.speechDetected, true);
  assert.equal(device.isRecording, false);
});

test('wake detection plays an immediate local earcon before hub acknowledgment', () => {
  const device = new HomeBrainRemoteDevice({ audio: { sampleRate: 16000 }, wakeWord: {} });
  const sent = [];
  const earcons = [];
  device.isAuthenticated = true;
  device.wakeWordRuntime = { sidecar: {}, recording: {}, audio: {} };
  device.sendMessage = (message) => {
    sent.push(message);
    return true;
  };
  device.reportWakeWordRuntimeStatus = () => true;
  device.playEarcon = (kind) => {
    earcons.push(kind);
    return Promise.resolve(true);
  };

  device.onWakeWordDetected('anna', 0.9, 'Anna');

  assert.deepEqual(earcons, ['wake']);
  assert.equal(sent.some((message) => message.type === 'wake_word_detected'), true);
  assert.equal(device.lastVoiceInteraction.stage, 'wake');
  if (device.pendingWakeAckTimer) clearTimeout(device.pendingWakeAckTimer);
});

test('command result plays a local outcome earcon without delayed generic speech', async () => {
  const device = new HomeBrainRemoteDevice({ audio: {}, wakeWord: {} });
  const feedback = [];
  device.wakeWordRuntime = { sidecar: {}, recording: {}, audio: {} };
  device.reportWakeWordRuntimeStatus = () => true;
  device.playEarcon = async (kind) => {
    feedback.push(`earcon:${kind}`);
    return true;
  };
  device.enqueueTTSResponse = async (text, voice) => {
    feedback.push(`voice:${voice}:${text}`);
    return true;
  };

  await device.handleMessage(Buffer.from(JSON.stringify({
    type: 'command_result',
    interactionId: 'interaction-1',
    commandId: 'command-1',
    status: 'success',
    voice: 'anna-voice',
    timing: { wakeToResultMs: 1600 }
  })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(feedback, ['earcon:success']);
  assert.equal(device.lastVoiceInteraction.stage, 'success');
  assert.equal(device.lastVoiceInteraction.timing.wakeToResultMs, 1600);
});

test('startVoiceRecording reuses the active wake mic stream for command audio', async (t) => {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  let spawned = 0;
  childProcess.spawn = () => {
    spawned += 1;
    throw new Error('command recording should reuse the active wake stream');
  };

  const device = new HomeBrainRemoteDevice({
    audio: { recordingDevice: 'sysdefault:CARD=MS', sampleRate: 16000, channels: 1 },
    wakeWord: {}
  });
  const messages = [];
  let stopped = false;
  let restarts = 0;

  device.recordingStream = {
    stop() {
      stopped = true;
    }
  };
  device.sidecar = createFakeSidecar();
  device.sendMessage = (message) => {
    messages.push(message);
    return true;
  };
  device.restartWakeWordDetection = async () => {
    restarts += 1;
  };

  device.startVoiceRecording(5000, true);
  device.streamCommandAudioChunk(Buffer.from([9, 8, 7, 6]), { source: 'wake_stream' });

  assert.equal(spawned, 0);
  assert.equal(stopped, false);
  assert.equal(device.recordingStream != null, true);
  assert.equal(device.sidecar, null);
  assert.equal(messages[0].type, 'audio_data');
  assert.equal(messages[0].isStart, true);
  assert.equal(messages[1].source, 'wake_stream');
  assert.equal(messages[1].sequence, 0);
  assert.deepEqual(Buffer.from(messages[1].audioData, 'base64'), Buffer.from([9, 8, 7, 6]));

  device.stopVoiceRecording();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(restarts, 1);
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

test('wake sidecar resumes on the existing microphone stream without reopening ALSA', async () => {
  const device = new HomeBrainRemoteDevice({
    audio: { recordingDevice: 'sysdefault:CARD=MS', sampleRate: 16000 },
    wakeWord: {
      keywords: [{ label: 'Anna', path: '/tmp/anna.onnx', threshold: 0.7 }]
    }
  });
  const activeStream = { stop() { throw new Error('active microphone must stay open'); } };
  device.recordingStream = activeStream;
  device.detectPreferredCaptureDevice = () => {
    throw new Error('active microphone resume must not probe ALSA');
  };
  let sidecarStarts = 0;
  device.startFeatureSidecar = async () => { sidecarStarts += 1; };
  device.reportWakeWordRuntimeStatus = () => true;

  const resumed = await device.resumeWakeWordSidecarOnActiveStream();

  assert.equal(resumed, true);
  assert.equal(sidecarStarts, 1);
  assert.equal(device.recordingStream, activeStream);
  assert.equal(device.isWakeWordListening, true);
});

test('wake-only config comparison does not probe an automatic capture device', async () => {
  const device = new HomeBrainRemoteDevice({
    audio: { recordingDevice: 'auto', preferredInputName: 'Jabra', sampleRate: 16000 },
    wakeWord: {}
  });
  let probes = 0;
  device.detectPreferredCaptureDevice = () => {
    probes += 1;
    return { device: 'plughw:CARD=USB,DEV=0', label: 'Jabra' };
  };
  device.syncWakeWordAssetsFromConfig = async () => false;

  const restartNeeded = await device.applyConfigUpdate({
    wakeWord: { vad: { minRms: 0.008 } }
  });

  assert.equal(restartNeeded, true);
  assert.equal(probes, 0);
});

test('wake config updates restart only the sidecar when capture settings are unchanged', async () => {
  const device = new HomeBrainRemoteDevice({ audio: {}, wakeWord: {} });
  const activeStream = { stop() { throw new Error('mic must not reopen for wake tuning'); } };
  device.recordingStream = activeStream;
  device.configUpdateRequiresCaptureReopen = false;
  let sidecarStops = 0;
  let sidecarResumes = 0;
  let fullRestarts = 0;
  device.stopFeatureSidecar = () => { sidecarStops += 1; };
  device.resumeWakeWordSidecarOnActiveStream = async () => {
    sidecarResumes += 1;
    return true;
  };
  device.restartWakeWordDetection = async () => { fullRestarts += 1; };

  await device.restartWakeWordDetectionAfterConfigUpdate();

  assert.equal(sidecarStops, 1);
  assert.equal(sidecarResumes, 1);
  assert.equal(fullRestarts, 0);
  assert.equal(device.recordingStream, activeStream);
});

test('playTTSResponse uses authenticated POST JSON and the selected wake-word voice', async () => {
  const device = new HomeBrainRemoteDevice({
    hubUrl: 'https://hub.example.test',
    deviceToken: 'device-token',
    audio: { playbackDevice: 'sysdefault:CARD=MS' },
    wakeWord: {}
  });
  device.deviceId = '507f1f77bcf86cd799439011';
  let request = null;
  device.fetchHubAudio = async (url, options, timeoutMs) => {
    request = { url, options, timeoutMs };
    const audio = Uint8Array.from(Buffer.from('ID3cached-audio'));
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null },
      body: null,
      arrayBuffer: async () => audio.buffer
    };
  };
  device.playAudioClip = async (filePath, options) => {
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(options.playbackDevice, 'sysdefault:CARD=MS');
    return true;
  };

  const played = await device.playTTSResponse('The lights are on.', 'anna-voice-id', { kind: 'response' });

  assert.equal(played, true);
  assert.equal(request.url, 'https://hub.example.test/api/remote-devices/507f1f77bcf86cd799439011/tts');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-HomeBrain-Device-Token'], 'device-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    text: 'The lights are on.',
    voiceId: 'anna-voice-id'
  });
  assert.equal(request.timeoutMs, 60_000);
  assert.equal(request.url.includes('The lights are on'), false);

  await device.playTTSResponse('Done.', 'anna-voice-id', { kind: 'success' });
  assert.equal(request.timeoutMs, 2000);
});

test('enqueueSidecarAudio forwards quiet frames so streaming feature history stays continuous', () => {
  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: { vad: { minRms: 0.02 } }
  });
  const sidecar = createFakeSidecar();

  device.sidecar = sidecar;
  device.sidecarFrameBytes = 4;
  device.resetWakeWordRuntime('FeatureSidecar/OWW', device.buildRecordingOptions());
  device.reportWakeWordRuntimeStatus = () => {};

  device.enqueueSidecarAudio(Buffer.alloc(4));
  assert.equal(sidecar.stdin.writes.length, 2);
  assert.equal(sidecar.stdin.writes[0].toString('ascii', 0, 4), 'AUD0');
  assert.deepEqual(sidecar.stdin.writes[1], Buffer.alloc(4));
  assert.equal(device.wakeWordRuntime.audio.frames, 1);
  assert.equal(device.wakeWordRuntime.audio.lastFrameRms, 0);

  const loudFrame = Buffer.alloc(4);
  loudFrame.writeInt16LE(16000, 0);
  loudFrame.writeInt16LE(-16000, 2);
  device.enqueueSidecarAudio(loudFrame);

  assert.equal(sidecar.stdin.writes.length, 4);
  assert.equal(sidecar.stdin.writes[2].toString('ascii', 0, 4), 'AUD0');
  assert.deepEqual(sidecar.stdin.writes[3], loudFrame);
});

test('wake-word RMS gate treats zero config as the default minimum', () => {
  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: { vad: { minRms: 0 } }
  });

  assert.equal(device.getWakeWordMinRms(), 0.004);
  assert.equal(device.shouldProcessWakeWordFrame(Buffer.alloc(4)), false);
});

test('processAudioForWakeWord skips in-process inference for low-RMS frames', async () => {
  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: { vad: { minRms: 0.02 } }
  });
  let evaluations = 0;

  device.wakeWordFrameSamples = 2;
  device.wakeWordSessions = [{ label: 'Anna', threshold: 0.5 }];
  device.resetWakeWordRuntime('OpenWakeWord', device.buildRecordingOptions());
  device.reportWakeWordRuntimeStatus = () => {};
  device.evaluateWakeWordFrame = async () => {
    evaluations += 1;
    return null;
  };

  await device.processAudioForWakeWord(Buffer.alloc(4));
  assert.equal(evaluations, 0);
  assert.equal(device.wakeWordRuntime.audio.frames, 1);
  assert.equal(device.wakeWordRuntime.audio.lastFrameRms, 0);

  const loudFrame = Buffer.alloc(4);
  loudFrame.writeInt16LE(16000, 0);
  loudFrame.writeInt16LE(-16000, 2);
  await device.processAudioForWakeWord(loudFrame);

  assert.equal(evaluations, 1);
});

test('startFeatureSidecar captures sidecar stderr when startup exits', async (t) => {
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  const sidecar = createFakeSidecar();
  let spawnArgs = null;
  childProcess.spawn = (...args) => {
    spawnArgs = args;
    return sidecar;
  };

  const device = new HomeBrainRemoteDevice({
    audio: { sampleRate: 16000 },
    wakeWord: { python: './custom-venv/bin/python' }
  });

  device.reportWakeWordRuntimeStatus = () => {};
  let failureMessage = '';
  device.handleWakeWordEngineFailure = (error) => {
    failureMessage = error.message;
  };

  const keywords = [{ label: 'Anna', path: '/tmp/anna.onnx', threshold: 0.5 }];
  await device.startFeatureSidecar(keywords);

  assert.equal(spawnArgs[0], 'sh');
  assert.equal(spawnArgs[1][0], '-c');
  assert.match(spawnArgs[1][1], /python_can_run_sidecar/);
  assert.match(spawnArgs[1][1], /\*\/\*/);
  assert.equal(spawnArgs[2].stdio[2], 'pipe');
  assert.equal(spawnArgs[2].env.HOMEBRAIN_WAKEWORD_PYTHON, './custom-venv/bin/python');

  sidecar.stderr.emit('data', Buffer.from('openwakeword is required: missing module\n'));
  sidecar.emit('close', 1, null);

  assert.match(device.wakeWordRuntime.sidecar.stderr, /openwakeword is required/);
  assert.match(device.wakeWordRuntime.lastError.message, /Feature sidecar exited with code 1/);
  assert.match(device.wakeWordRuntime.lastError.message, /missing module/);
  assert.match(failureMessage, /missing module/);
});

test('handleWakeWordEngineFailure preserves string error messages', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {},
    wakeWord: {}
  });

  device.maxWakeWordRestarts = 0;
  device.reportWakeWordRuntimeStatus = () => {};
  device.releaseWakeWordEngine = () => {};
  device.startTestMode = () => {};
  device.resetWakeWordRuntime('FeatureSidecar/OWW', device.buildRecordingOptions());

  device.handleWakeWordEngineFailure('arecord has exited with error code 1.');

  assert.match(device.wakeWordRuntime.lastError.message, /arecord has exited with error code 1/);
});

test('handleRecordingStreamError appends recorder stderr details', () => {
  const device = new HomeBrainRemoteDevice({
    audio: {},
    wakeWord: {}
  });

  device.maxWakeWordRestarts = 0;
  device.reportWakeWordRuntimeStatus = () => {};
  device.releaseWakeWordEngine = () => {};
  device.startTestMode = () => {};
  device.resetWakeWordRuntime('FeatureSidecar/OWW', device.buildRecordingOptions());
  device.recordingStderrBuffer = 'ALSA lib pcm.c: Cannot open audio device default\n';

  device.handleRecordingStreamError('arecord has exited with error code 1.');

  assert.match(device.wakeWordRuntime.lastError.message, /arecord has exited with error code 1/);
  assert.match(device.wakeWordRuntime.lastError.message, /Cannot open audio device default/);
  assert.match(device.wakeWordRuntime.recording.stderr, /Cannot open audio device default/);
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
