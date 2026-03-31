const test = require('node:test');
const assert = require('node:assert/strict');

test('createWorkflowFromText can reach automationService after startup dependency loading', async (t) => {
  const modulePaths = [
    '../services/automationSchedulerService',
    '../services/workflowService',
    '../services/automationService',
    '../services/workflowExecutionService',
    '../services/insteonService',
    '../services/eventStreamService'
  ].map((relativePath) => require.resolve(relativePath));

  modulePaths.forEach((modulePath) => {
    delete require.cache[modulePath];
  });

  const automationSchedulerService = require('../services/automationSchedulerService');
  const automationService = require('../services/automationService');
  const workflowService = require('../services/workflowService');

  assert.ok(automationSchedulerService);

  const originalCreateAutomationFromText = automationService.createAutomationFromText;
  automationService.createAutomationFromText = async () => ({
    success: true,
    handledDirectCommand: true,
    message: 'Handled directly for test'
  });

  t.after(() => {
    automationService.createAutomationFromText = originalCreateAutomationFromText;
    modulePaths.forEach((modulePath) => {
      delete require.cache[modulePath];
    });
  });

  const result = await workflowService.createWorkflowFromText('turn on the office lights', null, 'chat');

  assert.equal(result.success, true);
  assert.equal(result.handledDirectCommand, true);
  assert.equal(result.message, 'Handled directly for test');
});
