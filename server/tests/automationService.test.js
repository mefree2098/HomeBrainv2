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
