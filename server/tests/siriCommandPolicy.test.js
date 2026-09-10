const test = require('node:test');
const assert = require('node:assert/strict');
const coordinator = require('../services/deviceCommandCoordinatorService');
const { SiriCommandService } = require('../services/siriCommandService');

const light = { _id: '507f1f77bcf86cd799439012', name: 'Bed Lamp', room: 'Master Bedroom', type: 'light' };
const actor = '507f1f77bcf86cd799439011';

async function commandMetadata(kind, policy = coordinator.defaultPolicy) {
  let received;
  const capture = (metadata) => {
    received = coordinator.buildCommandMetadata({ device: light, action: 'turn_on', metadata, policy });
  };
  const service = new SiriCommandService({
    store: {},
    devices: {
      list: async () => [light],
      control: async (_id, _action, _value, options) => { capture(options.command); }
    },
    workflows: {
      run: async (_id, options) => { capture(options.context.commandContext); return { success: true }; }
    },
    scenes: {
      run: async (_id, options) => { capture(options.command); return { status: 'success', actionResults: [] }; }
    }
  });
  const target = kind === 'room' ? { id: light.room, name: 'Master Bedroom lights' }
    : kind === 'light' ? { id: light._id, name: light.name }
      : { id: '507f1f77bcf86cd799439013', name: 'Night TV' };
  const result = await service.execute({ accountId: actor, requestId: 'invocation', kind,
    action: kind === 'workflow' ? 'run' : kind === 'scene' ? 'activate' : 'turn_on' }, target);
  assert.equal(result.state, 'completed');
  return received;
}

for (const kind of ['room', 'light', 'workflow', 'scene']) {
  test(`Siri ${kind} commands reach the real coordinator as voice, not unknown`, async () => {
    const metadata = await commandMetadata(kind);
    const defaults = coordinator.defaultPolicy;
    assert.equal(metadata.source, 'voice');
    assert.equal(metadata.priority, defaults.sources.voice.priority);
    assert.equal(metadata.ttlSeconds, defaults.sources.voice.ttlSeconds);
    assert.equal(metadata.actor, actor);
    assert.match(metadata.reason, /^Siri:/);
    assert.ok(metadata.priority > defaults.sources.workflow.priority);
    assert.ok(metadata.priority < defaults.sources.security.priority);
  });
}

test('Siri respects configured voice priority and hold duration without overriding policy', async () => {
  const policy = coordinator.sanitizePolicy({ sources: { voice: { priority: 71, ttlSeconds: 33 } } });
  const metadata = await commandMetadata('light', policy);
  assert.equal(metadata.priority, 71);
  assert.equal(metadata.ttlSeconds, 33);
});

test('Siri trigger-only workflow context derives voice without weakening other source classification', () => {
  assert.equal(coordinator.deriveSource({ triggerSource: 'siri', workflowId: 'workflow' }), 'voice');
  assert.equal(coordinator.deriveSource({ triggerSource: 'scheduler', workflowId: 'workflow' }), 'workflow');
  assert.equal(coordinator.deriveSource({ triggerSource: 'siri-lookalike' }), 'unknown');
  assert.equal(coordinator.deriveSource({ triggerSource: 'security_alarm_status' }), 'security');
});
