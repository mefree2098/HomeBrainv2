const test = require('node:test');
const assert = require('node:assert/strict');

const voiceCommandService = require('../services/voiceCommandService');
const eventStreamService = require('../services/eventStreamService');
const voiceDeviceRoutes = require('../routes/voiceDeviceRoutes');

const interpretRoute = voiceDeviceRoutes.stack.find(
  (layer) => layer.route?.path === '/commands/interpret'
);
const interpretHandler = interpretRoute.route.stack.at(-1).handle;

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function installMocks(t, processCommand) {
  const originalProcessCommand = voiceCommandService.processCommand;
  const originalPublishSafe = eventStreamService.publishSafe;
  const originalLog = console.log;
  const originalError = console.error;
  const published = [];

  voiceCommandService.processCommand = processCommand;
  eventStreamService.publishSafe = async (event) => {
    published.push(event);
    return null;
  };
  console.log = () => {};
  console.error = () => {};

  t.after(() => {
    voiceCommandService.processCommand = originalProcessCommand;
    eventStreamService.publishSafe = originalPublishSafe;
    console.log = originalLog;
    console.error = originalError;
  });

  return published;
}

test('voice success events retain attribution but omit command and response text', async (t) => {
  const actorUserId = '507f1f77bcf86cd799439011';
  const published = installMocks(t, async () => ({
    responseText: 'The kitchen light is on.',
    llm: { provider: 'test', model: 'test-model' },
    usedFallback: false
  }));
  const req = {
    body: {
      commandText: 'Turn on the kitchen light',
      room: 'Kitchen',
      wakeWord: 'homebrain',
      deviceId: 'kitchen-light'
    },
    user: { _id: actorUserId, role: 'user' }
  };
  const res = responseRecorder();

  await interpretHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0].actorUserId, actorUserId);
  assert.equal(published[0].type, 'voice.command_processed');
  assert.equal(Object.hasOwn(published[0].payload, 'command'), false);
  assert.equal(Object.hasOwn(published[0].payload, 'responseText'), false);
  assert.deepEqual(published[0].payload, {
    wakeWord: 'homebrain',
    room: 'Kitchen',
    deviceId: 'kitchen-light'
  });
});

test('voice failure events retain attribution but omit command text', async (t) => {
  const actorUserId = '507f1f77bcf86cd799439012';
  const published = installMocks(t, async () => {
    throw new Error('Processor unavailable');
  });
  const req = {
    body: { commandText: 'Unlock the front door' },
    user: { _id: actorUserId, role: 'user' }
  };
  const res = responseRecorder();

  await interpretHandler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(published.length, 1);
  assert.equal(published[0].actorUserId, actorUserId);
  assert.equal(published[0].type, 'voice.command_failed');
  assert.equal(Object.hasOwn(published[0].payload, 'command'), false);
  assert.equal(published[0].payload.error, 'Processor unavailable');
});
