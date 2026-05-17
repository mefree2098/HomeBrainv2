const test = require('node:test');
const assert = require('node:assert/strict');

const eventStreamService = require('../services/eventStreamService');

test('publishSafe skips immediately when MongoDB is disconnected', async (t) => {
  const originalPublish = eventStreamService.publish;
  const originalWarn = console.warn;
  const originalLastWarningAt = eventStreamService.lastDisconnectedPublishWarningAt;
  let publishCalled = false;

  eventStreamService.publish = async () => {
    publishCalled = true;
    return { id: 'unexpected' };
  };
  eventStreamService.lastDisconnectedPublishWarningAt = 0;
  console.warn = () => {};

  t.after(() => {
    eventStreamService.publish = originalPublish;
    eventStreamService.lastDisconnectedPublishWarningAt = originalLastWarningAt;
    console.warn = originalWarn;
  });

  const result = await eventStreamService.publishSafe({
    type: 'test.disconnected',
    source: 'test'
  });

  assert.equal(result, null);
  assert.equal(publishCalled, false);
});
