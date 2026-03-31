const mongoose = require('mongoose');

const workflowTriggerSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['time', 'device_state', 'weather', 'location', 'sensor', 'schedule', 'manual', 'security_alarm_status']
  },
  conditions: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: false });

const workflowActionSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['device_control', 'scene_activate', 'notification', 'delay', 'condition', 'workflow_control', 'variable_control', 'repeat', 'isy_network_resource', 'http_request']
  },
  target: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  parameters: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: false });

const workflowNodeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['trigger', 'device_action', 'scene_action', 'delay', 'notification', 'condition']
  },
  label: {
    type: String,
    default: ''
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  }
}, { _id: false });

const workflowEdgeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  source: {
    type: String,
    required: true
  },
  target: {
    type: String,
    required: true
  },
  label: {
    type: String,
    default: ''
  },
  condition: {
    type: String,
    default: ''
  }
}, { _id: false });

const workflowSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: 800,
    default: ''
  },
  source: {
    type: String,
    enum: ['manual', 'natural_language', 'voice', 'chat', 'import'],
    default: 'manual'
  },
  enabled: {
    type: Boolean,
    default: true
  },
  category: {
    type: String,
    enum: ['security', 'comfort', 'energy', 'convenience', 'custom'],
    default: 'custom'
  },
  priority: {
    type: Number,
    min: 1,
    max: 10,
    default: 5
  },
  cooldown: {
    type: Number,
    min: 0,
    default: 0
  },
  trigger: {
    type: workflowTriggerSchema,
    required: true
  },
  actions: {
    type: [workflowActionSchema],
    default: []
  },
  graph: {
    nodes: {
      type: [workflowNodeSchema],
      default: []
    },
    edges: {
      type: [workflowEdgeSchema],
      default: []
    }
  },
  voiceAliases: {
    type: [String],
    default: []
  },
  linkedAutomationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Automation',
    default: null
  },
  lastRun: {
    type: Date,
    default: null
  },
  executionCount: {
    type: Number,
    default: 0
  },
  isyRunAtStartup: {
    type: Boolean,
    default: null
  },
  lastError: {
    message: String,
    timestamp: Date
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  versionKey: false,
  collection: 'workflows'
});

workflowSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

workflowSchema.index({ enabled: 1, updatedAt: -1 });
workflowSchema.index({ name: 1 }, { unique: true });
workflowSchema.index({ linkedAutomationId: 1 });
workflowSchema.index({ 'trigger.type': 1 });

module.exports = mongoose.model('Workflow', workflowSchema);
