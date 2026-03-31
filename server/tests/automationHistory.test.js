const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AutomationHistory = require('../models/AutomationHistory');

test('AutomationHistory accepts security_alarm_status as a trigger type', () => {
  const history = new AutomationHistory({
    automationId: new mongoose.Types.ObjectId(),
    automationName: 'Alarm-driven automation',
    triggerType: 'security_alarm_status',
    totalActions: 1
  });

  const validationError = history.validateSync();
  assert.equal(validationError, undefined);
});
