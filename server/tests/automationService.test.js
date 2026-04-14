const test = require('node:test');
const assert = require('node:assert/strict');

const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const automationService = require('../services/automationService');

const STANDALONE_AUTOMATION_ID = '507f1f77bcf86cd799439011';
const STANDALONE_AUTOMATION_ID_2 = '507f1f77bcf86cd799439012';
const WORKFLOW_MANAGED_AUTOMATION_ID = '507f1f77bcf86cd799439013';
const WORKFLOW_ID = '507f191e810c19729de860ea';

test('getAllAutomations queries only standalone automations', async (t) => {
  const originalFind = Automation.find;

  t.after(() => {
    Automation.find = originalFind;
  });

  let receivedQuery = null;
  Automation.find = (query = {}) => {
    receivedQuery = query;
    return {
      sort(sortArg) {
        assert.deepEqual(sortArg, { createdAt: -1 });
        return {
          lean: async () => []
        };
      }
    };
  };

  const automations = await automationService.getAllAutomations();

  assert.deepEqual(receivedQuery, { workflowId: null });
  assert.deepEqual(automations, []);
});

test('getAutomationById hides workflow-managed runtime automations', async (t) => {
  const originalFindById = Automation.findById;

  t.after(() => {
    Automation.findById = originalFindById;
  });

  Automation.findById = () => ({
    lean: async () => ({
      _id: WORKFLOW_MANAGED_AUTOMATION_ID,
      name: 'Mirrored Workflow Runtime',
      workflowId: WORKFLOW_ID
    })
  });

  await assert.rejects(
    automationService.getAutomationById(WORKFLOW_MANAGED_AUTOMATION_ID),
    /Automation with ID 507f1f77bcf86cd799439013 not found/
  );
});

test('getAutomationStats scopes counts and aggregations to standalone automations', async (t) => {
  const originalCountDocuments = Automation.countDocuments;
  const originalAggregate = Automation.aggregate;

  t.after(() => {
    Automation.countDocuments = originalCountDocuments;
    Automation.aggregate = originalAggregate;
  });

  const countQueries = [];
  const aggregatePipelines = [];

  Automation.countDocuments = async (query = {}) => {
    countQueries.push(query);
    if (query.enabled === true) {
      return 3;
    }
    if (query.enabled === false) {
      return 1;
    }
    if (query.lastRun) {
      return 2;
    }
    return 4;
  };

  Automation.aggregate = async (pipeline) => {
    aggregatePipelines.push(pipeline);
    if (aggregatePipelines.length === 1) {
      return [{ _id: 'security', count: 2 }];
    }
    return [
      { _id: 1, count: 1 },
      { _id: 5, count: 3 }
    ];
  };

  const stats = await automationService.getAutomationStats();

  assert.deepEqual(countQueries[0], { workflowId: null });
  assert.deepEqual(countQueries[1], { enabled: true, workflowId: null });
  assert.deepEqual(countQueries[2], { enabled: false, workflowId: null });
  assert.equal(countQueries[3].workflowId, null);
  assert.ok(countQueries[3].lastRun?.$gte instanceof Date);
  assert.deepEqual(aggregatePipelines[0][0], { $match: { workflowId: null } });
  assert.deepEqual(aggregatePipelines[1][0], { $match: { workflowId: null } });
  assert.equal(stats.total, 4);
  assert.equal(stats.enabled, 3);
  assert.equal(stats.disabled, 1);
  assert.equal(stats.recentExecutions, 2);
  assert.deepEqual(stats.categories, { security: 2 });
  assert.deepEqual(stats.priorityDistribution, { 1: 1, 5: 3 });
});

test('getAutomationHistory without an id excludes workflow-managed runtime histories', async (t) => {
  const originalFindAutomations = Automation.find;
  const originalFindHistory = AutomationHistory.find;

  t.after(() => {
    Automation.find = originalFindAutomations;
    AutomationHistory.find = originalFindHistory;
  });

  let automationQuery = null;
  let automationSelect = null;
  Automation.find = (query = {}) => {
    automationQuery = query;
    return {
      select(selectArg) {
        automationSelect = selectArg;
        return {
          lean: async () => [
            { _id: STANDALONE_AUTOMATION_ID },
            { _id: STANDALONE_AUTOMATION_ID_2 }
          ]
        };
      }
    };
  };

  let historyQuery = null;
  let historySort = null;
  let historyLimit = null;
  let populateArgs = null;
  AutomationHistory.find = (query = {}) => {
    historyQuery = query;
    return {
      sort(sortArg) {
        historySort = sortArg;
        return {
          limit(limitArg) {
            historyLimit = limitArg;
            return {
              populate(path, fields) {
                populateArgs = { path, fields };
                return {
                  lean: async () => [{ _id: 'history-1' }]
                };
              }
            };
          }
        };
      }
    };
  };

  const history = await automationService.getAutomationHistory(null, 25);

  assert.deepEqual(automationQuery, { workflowId: null });
  assert.equal(automationSelect, '_id');
  assert.deepEqual(historyQuery, {
    automationId: { $in: [STANDALONE_AUTOMATION_ID, STANDALONE_AUTOMATION_ID_2] }
  });
  assert.deepEqual(historySort, { startedAt: -1 });
  assert.equal(historyLimit, 25);
  assert.deepEqual(populateArgs, { path: 'automationId', fields: 'name category' });
  assert.deepEqual(history, [{ _id: 'history-1' }]);
});

test('getExecutionStats returns empty stats when only workflow-managed runtime automations exist', async (t) => {
  const originalFindAutomations = Automation.find;
  const originalAggregate = AutomationHistory.aggregate;

  t.after(() => {
    Automation.find = originalFindAutomations;
    AutomationHistory.aggregate = originalAggregate;
  });

  Automation.find = () => ({
    select() {
      return {
        lean: async () => []
      };
    }
  });
  AutomationHistory.aggregate = async () => {
    throw new Error('AutomationHistory.aggregate should not run when no standalone automations exist');
  };

  const stats = await automationService.getExecutionStats();

  assert.deepEqual(stats, {
    execution: {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      partialSuccessExecutions: 0,
      averageDuration: 0,
      totalActions: 0,
      successfulActions: 0,
      failedActions: 0
    },
    failures: []
  });
});

test('resumeRunningExecutions queues persisted running histories for background resume', async (t) => {
  const originalFindHistory = AutomationHistory.find;
  const originalExecuteAutomation = automationService.executeAutomation;

  const launched = [];

  AutomationHistory.find = () => ({
    sort() {
      return {
        select() {
          return {
            lean: async () => ([
              {
                _id: 'history-1',
                automationId: STANDALONE_AUTOMATION_ID,
                automationName: 'Bathroom Fan Auto Off',
                workflowId: WORKFLOW_ID,
                workflowName: 'Bathroom Fan Auto Off',
                correlationId: 'corr-1',
                status: 'running'
              }
            ])
          };
        }
      };
    }
  });

  automationService.executeAutomation = async (automationId, options = {}) => {
    launched.push({ automationId, options });
    return { success: true };
  };

  t.after(() => {
    AutomationHistory.find = originalFindHistory;
    automationService.executeAutomation = originalExecuteAutomation;
  });

  const result = await automationService.resumeRunningExecutions({ reason: 'server_startup' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.totalRunning, 1);
  assert.equal(result.launchedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0], {
    automationId: STANDALONE_AUTOMATION_ID,
    options: {
      resumeHistoryId: 'history-1',
      resumeReason: 'server_startup'
    }
  });
});

test('createAutomationFromText exposes Sense devices as energy monitors with Sense trigger properties', async (t) => {
  const automationServicePath = require.resolve('../services/automationService');
  delete require.cache[automationServicePath];

  const llmService = require('../services/llmService');
  const Device = require('../models/Device');
  const DeviceGroup = require('../models/DeviceGroup');
  const Scene = require('../models/Scene');
  const Settings = require('../models/Settings');

  const originalSendLLMRequestWithFallbackDetailed = llmService.sendLLMRequestWithFallbackDetailed;
  const originalDeviceFind = Device.find;
  const originalDeviceGroupFind = DeviceGroup.find;
  const originalSceneFind = Scene.find;
  const originalSettingsGetSettings = Settings.getSettings;
  const originalFindOne = Automation.findOne;
  const originalSave = Automation.prototype.save;

  let capturedPrompt = '';

  llmService.sendLLMRequestWithFallbackDetailed = async (prompt) => {
    capturedPrompt = prompt;
    return {
      response: JSON.stringify({
        automations: [
          {
            name: 'Dryer Power Alert',
            description: 'Notifies when the Sense dryer power rises above the threshold.',
            trigger: {
              type: 'device_state',
              conditions: {
                deviceId: 'sense-device-1',
                property: 'sense.currentPowerW',
                operator: 'gt',
                value: 25
              }
            },
            actions: [
              {
                type: 'notification',
                target: null,
                parameters: {
                  message: 'Dryer is running'
                }
              }
            ],
            category: 'energy',
            priority: 5
          }
        ]
      }),
      provider: 'openai',
      model: 'gpt-test'
    };
  };

  Device.find = () => ({
    lean: async () => ([
      {
        _id: { toString: () => 'sense-device-1' },
        name: 'Dryer',
        type: 'sensor',
        room: 'Electrical Panel',
        groups: [],
        properties: {
          source: 'sense',
          sense: {
            entityType: 'device',
            currentPowerW: 1420.5,
            trends: {
              day: {
                energyKwh: 2.34
              }
            }
          }
        }
      }
    ])
  });

  DeviceGroup.find = () => ({
    lean: async () => [],
    sort() {
      return {
        lean: async () => []
      };
    }
  });

  Scene.find = () => ({
    lean: async () => []
  });

  Settings.getSettings = async () => ({
    llmPriorityList: ['openai']
  });

  Automation.findOne = () => ({
    select: async () => null,
    then(resolve) {
      return resolve(null);
    }
  });
  Automation.prototype.save = async function saveAutomation() {
    const saved = {
      _id: STANDALONE_AUTOMATION_ID,
      name: this.name,
      description: this.description,
      trigger: this.trigger,
      actions: this.actions,
      enabled: this.enabled,
      priority: this.priority,
      category: this.category,
      conditions: this.conditions,
      cooldown: this.cooldown
    };
    this.toObject = () => saved;
    return this;
  };

  const freshAutomationService = require('../services/automationService');

  t.after(() => {
    llmService.sendLLMRequestWithFallbackDetailed = originalSendLLMRequestWithFallbackDetailed;
    Device.find = originalDeviceFind;
    DeviceGroup.find = originalDeviceGroupFind;
    Scene.find = originalSceneFind;
    Settings.getSettings = originalSettingsGetSettings;
    Automation.findOne = originalFindOne;
    Automation.prototype.save = originalSave;
    delete require.cache[automationServicePath];
  });

  const result = await freshAutomationService.createAutomationFromText(
    'Create an automation when the dryer power goes above 25 watts.'
  );

  assert.equal(result.success, true);
  assert.equal(result.automation?.trigger?.type, 'device_state');
  assert.equal(result.automation?.trigger?.conditions?.property, 'sense.currentPowerW');
  assert.match(capturedPrompt, /Type: energy_monitor/);
  assert.match(capturedPrompt, /Energy monitoring: power level via sense\.currentPowerW/);
  assert.match(capturedPrompt, /Trigger properties: status, isOnline, sense\.currentPowerW, sense\.trends\.day\.energyKwh/);
});
