const test = require('node:test');
const assert = require('node:assert/strict');

const EventStreamEvent = require('../models/EventStreamEvent');
const eventStreamService = require('../services/eventStreamService');

test('event stream actor attribution is private and indexed for deletion lookups', () => {
  const actorPath = EventStreamEvent.schema.path('actorUserId');
  const actorIndex = EventStreamEvent.schema.indexes().find(
    ([fields]) => fields.actorUserId === 1 && fields.type === 1 && fields.createdAt === -1
  );

  assert.equal(actorPath.instance, 'ObjectId');
  assert.equal(actorPath.options.select, false);
  assert.deepEqual(actorIndex?.[1]?.partialFilterExpression, {
    actorUserId: { $exists: true }
  });
});

test('publish persists actor attribution without exposing it publicly', async (t) => {
  const originalNextSequence = eventStreamService.nextSequence;
  const originalCreate = EventStreamEvent.create;
  const actorUserId = '507f1f77bcf86cd799439011';
  let persisted;

  eventStreamService.nextSequence = async () => 42;
  EventStreamEvent.create = async (input) => {
    persisted = input;
    return {
      toObject: () => ({
        _id: '507f1f77bcf86cd799439099',
        ...input,
        createdAt: new Date('2026-07-15T00:00:00.000Z')
      })
    };
  };

  t.after(() => {
    eventStreamService.nextSequence = originalNextSequence;
    EventStreamEvent.create = originalCreate;
  });

  const event = await eventStreamService.publish({
    type: 'voice.command_processed',
    source: 'voice',
    category: 'voice',
    actorUserId,
    payload: { wakeWord: 'homebrain' }
  });

  assert.equal(persisted.actorUserId, actorUserId);
  assert.equal(Object.hasOwn(event, 'actorUserId'), false);
  assert.deepEqual(event.payload, { wakeWord: 'homebrain' });
});

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
