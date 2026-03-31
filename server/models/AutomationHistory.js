const mongoose = require('mongoose');

const actionResultSchema = new mongoose.Schema({
  actionIndex: {
    type: Number,
    required: true
  },
  parentActionIndex: Number,
  repeatIteration: Number,
  actionType: {
    type: String,
    required: true,
    enum: ['device_control', 'scene_activate', 'notification', 'delay', 'condition', 'workflow_control', 'variable_control', 'repeat', 'isy_network_resource', 'http_request']
  },
  target: mongoose.Schema.Types.Mixed,
  parameters: mongoose.Schema.Types.Mixed,
  success: {
    type: Boolean,
    required: true
  },
  message: String,
  error: String,
  conditionMet: Boolean,
  conditionOutcome: String,
  executedAt: {
    type: Date,
    default: Date.now
  },
  durationMs: Number
}, { _id: false });

const currentActionSchema = new mongoose.Schema({
  actionIndex: Number,
  parentActionIndex: Number,
  actionType: String,
  target: mongoose.Schema.Types.Mixed,
  startedAt: Date,
  updatedAt: Date,
  message: String
}, { _id: false });

const executionEventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true
  },
  level: {
    type: String,
    enum: ['info', 'warn', 'error'],
    default: 'info'
  },
  message: {
    type: String,
    required: true
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const automationHistorySchema = new mongoose.Schema({
  automationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Automation',
    required: true
  },
  automationName: {
    type: String,
    required: true
  },
  workflowId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workflow',
    default: null
  },
  workflowName: {
    type: String,
    default: null
  },
  triggerType: {
    type: String,
    required: true,
    enum: ['time', 'device_state', 'weather', 'location', 'sensor', 'schedule', 'manual', 'voice', 'security_alarm_status']
  },
  triggerSource: {
    type: String, // 'system', 'voice_command', 'manual', 'scene'
    default: 'system'
  },
  // Voice command that triggered this (if applicable)
  voiceCommandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VoiceCommand'
  },
  correlationId: {
    type: String,
    index: true
  },
  // Execution details
  status: {
    type: String,
    enum: ['running', 'success', 'partial_success', 'failed', 'cancelled'],
    default: 'running'
  },
  startedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  completedAt: Date,
  durationMs: Number,
  triggerContext: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  currentAction: currentActionSchema,
  lastEvent: {
    type: executionEventSchema,
    default: null
  },
  runtimeEvents: {
    type: [executionEventSchema],
    default: []
  },
  // Action results
  actionResults: [actionResultSchema],
  totalActions: {
    type: Number,
    required: true
  },
  successfulActions: {
    type: Number,
    default: 0
  },
  failedActions: {
    type: Number,
    default: 0
  },
  // Error tracking
  error: {
    message: String,
    stack: String,
    failedAt: Date
  },
  // Metadata
  environment: {
    type: mongoose.Schema.Types.Mixed, // Capture relevant state at execution time
    default: {}
  }
}, {
  timestamps: true,
  collection: 'automation_history'
});

// Indexes for efficient querying
automationHistorySchema.index({ automationId: 1, startedAt: -1 });
automationHistorySchema.index({ workflowId: 1, startedAt: -1 });
automationHistorySchema.index({ status: 1, startedAt: -1 });
automationHistorySchema.index({ startedAt: -1 });
automationHistorySchema.index({ voiceCommandId: 1 });
automationHistorySchema.index({ correlationId: 1, startedAt: -1 });

// Method to mark execution as completed
automationHistorySchema.methods.markCompleted = function(status, error = null) {
  this.status = status;
  this.completedAt = new Date();
  this.durationMs = this.completedAt - this.startedAt;
  this.currentAction = null;

  if (error) {
    this.error = {
      message: error.message,
      stack: error.stack,
      failedAt: new Date()
    };
  }

  // Calculate success/failure counts
  this.successfulActions = this.actionResults.filter(a => a.success).length;
  this.failedActions = this.actionResults.filter(a => !a.success).length;

  return this.save();
};

// Static method to get history for an automation
automationHistorySchema.statics.getHistoryForAutomation = function(automationId, limit = 50) {
  return this.find({ automationId })
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean();
};

// Static method to get recent executions
automationHistorySchema.statics.getRecentExecutions = function(limit = 100) {
  return this.find()
    .sort({ startedAt: -1 })
    .limit(limit)
    .populate('automationId', 'name category')
    .lean();
};

// Static method to get execution stats
automationHistorySchema.statics.getExecutionStats = function(dateRange = null) {
  const match = {};
  if (dateRange) {
    match.startedAt = {
      $gte: new Date(dateRange.start),
      $lte: new Date(dateRange.end)
    };
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalExecutions: { $sum: 1 },
        successfulExecutions: {
          $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
        },
        failedExecutions: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
        },
        partialSuccessExecutions: {
          $sum: { $cond: [{ $eq: ['$status', 'partial_success'] }, 1, 0] }
        },
        averageDuration: { $avg: '$durationMs' },
        totalActions: { $sum: '$totalActions' },
        successfulActions: { $sum: '$successfulActions' },
        failedActions: { $sum: '$failedActions' }
      }
    }
  ]);
};

// Static method to get failure analysis
automationHistorySchema.statics.getFailureAnalysis = function(limit = 20) {
  return this.aggregate([
    {
      $match: {
        status: { $in: ['failed', 'partial_success'] }
      }
    },
    {
      $group: {
        _id: '$error.message',
        count: { $sum: 1 },
        automations: { $addToSet: '$automationName' },
        lastOccurrence: { $max: '$startedAt' }
      }
    },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]);
};

module.exports = mongoose.model('AutomationHistory', automationHistorySchema);
