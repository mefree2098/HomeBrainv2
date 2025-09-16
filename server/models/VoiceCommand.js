const mongoose = require('mongoose');

const voiceCommandSchema = new mongoose.Schema({
  // Raw voice command text as received from speech-to-text
  originalText: {
    type: String,
    required: true,
    trim: true
  },
  
  // Processed/normalized command text
  processedText: {
    type: String,
    required: true,
    trim: true
  },
  
  // Wake word that was used to trigger the command
  wakeWord: {
    type: String,
    required: true,
    enum: ['anna', 'henry', 'home-brain', 'computer', 'custom'],
    default: 'anna'
  },
  
  // Room/location where the command was spoken
  sourceRoom: {
    type: String,
    required: true,
    trim: true
  },
  
  // Voice device that captured the command
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VoiceDevice',
    required: true
  },
  
  // User profile associated with the voice (if recognized)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  
  // Parsed intent and entities from LLM
  intent: {
    action: {
      type: String,
      required: true,
      enum: ['device_control', 'scene_activate', 'automation_create', 'automation_control', 'query', 'system_control', 'unknown']
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.5
    },
    entities: {
      devices: [{
        name: String,
        room: String,
        deviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Device'
        }
      }],
      rooms: [String],
      scenes: [{
        name: String,
        sceneId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Scene'
        }
      }],
      parameters: {
        brightness: Number,
        temperature: Number,
        color: String,
        duration: Number,
        delay: Number
      }
    }
  },
  
  // Execution results
  execution: {
    status: {
      type: String,
      enum: ['pending', 'success', 'partial_success', 'failed', 'cancelled'],
      default: 'pending'
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    completedAt: Date,
    executionTime: Number, // milliseconds
    actions: [{
      type: {
        type: String,
        enum: ['device_control', 'scene_activate', 'automation_trigger', 'tts_response', 'notification']
      },
      target: String,
      parameters: mongoose.Schema.Types.Mixed,
      result: {
        success: Boolean,
        message: String,
        error: String
      }
    }],
    errorMessage: String
  },
  
  // Response generated for the user
  response: {
    text: String,
    voiceFile: String, // Path to generated TTS file
    playedAt: Date,
    responseTime: Number // milliseconds from command to response
  },
  
  // LLM processing details
  llmProcessing: {
    provider: {
      type: String,
      enum: ['openai', 'anthropic', 'local'],
      required: true
    },
    model: {
      type: String,
      required: true
    },
    prompt: String,
    rawResponse: String,
    processingTime: Number, // milliseconds
    tokensUsed: {
      input: Number,
      output: Number,
      total: Number
    }
  },
  
  // Quality and feedback
  quality: {
    speechRecognitionConfidence: {
      type: Number,
      min: 0,
      max: 1
    },
    userFeedback: {
      type: String,
      enum: ['positive', 'negative', 'neutral'],
      default: 'neutral'
    },
    correctionNeeded: {
      type: Boolean,
      default: false
    },
    actualIntent: String // If user corrects the interpretation
  },
  
  // Metadata
  sessionId: String, // For grouping related commands
  conversationId: String, // For multi-turn conversations
  isFollowUp: {
    type: Boolean,
    default: false
  },
  parentCommandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VoiceCommand'
  }
}, {
  timestamps: true, // Adds createdAt and updatedAt
  collection: 'voice_commands'
});

// Indexes for better query performance
voiceCommandSchema.index({ createdAt: -1 });
voiceCommandSchema.index({ deviceId: 1, createdAt: -1 });
voiceCommandSchema.index({ sourceRoom: 1, createdAt: -1 });
voiceCommandSchema.index({ userId: 1, createdAt: -1 });
voiceCommandSchema.index({ 'intent.action': 1 });
voiceCommandSchema.index({ 'execution.status': 1 });
voiceCommandSchema.index({ wakeWord: 1, createdAt: -1 });
voiceCommandSchema.index({ sessionId: 1 });

// Virtual field for command duration
voiceCommandSchema.virtual('totalDuration').get(function() {
  if (this.execution.completedAt && this.execution.startedAt) {
    return this.execution.completedAt - this.execution.startedAt;
  }
  return null;
});

// Method to mark command as completed
voiceCommandSchema.methods.markCompleted = function(status = 'success', errorMessage = null) {
  this.execution.status = status;
  this.execution.completedAt = new Date();
  this.execution.executionTime = this.execution.completedAt - this.execution.startedAt;
  if (errorMessage) {
    this.execution.errorMessage = errorMessage;
  }
  return this.save();
};

// Method to add execution action
voiceCommandSchema.methods.addAction = function(actionType, target, parameters = {}, result = null) {
  if (!this.execution.actions) {
    this.execution.actions = [];
  }
  
  this.execution.actions.push({
    type: actionType,
    target,
    parameters,
    result: result || { success: true, message: 'Action completed' }
  });
  
  return this;
};

// Static method to get recent commands by device
voiceCommandSchema.statics.getRecentByDevice = function(deviceId, limit = 10) {
  return this.find({ deviceId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('deviceId', 'name room')
    .populate('userId', 'name email');
};

// Static method to get commands by room
voiceCommandSchema.statics.getByRoom = function(room, limit = 20) {
  return this.find({ sourceRoom: room })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('deviceId', 'name')
    .populate('userId', 'name');
};

// Static method to get command statistics
voiceCommandSchema.statics.getStats = function(dateRange = null) {
  const match = {};
  if (dateRange) {
    match.createdAt = {
      $gte: new Date(dateRange.start),
      $lte: new Date(dateRange.end)
    };
  }
  
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalCommands: { $sum: 1 },
        successfulCommands: {
          $sum: { $cond: [{ $eq: ['$execution.status', 'success'] }, 1, 0] }
        },
        failedCommands: {
          $sum: { $cond: [{ $eq: ['$execution.status', 'failed'] }, 1, 0] }
        },
        averageResponseTime: { $avg: '$response.responseTime' },
        averageExecutionTime: { $avg: '$execution.executionTime' },
        topIntents: { $push: '$intent.action' },
        topRooms: { $push: '$sourceRoom' },
        topWakeWords: { $push: '$wakeWord' }
      }
    }
  ]);
};

module.exports = mongoose.model('VoiceCommand', voiceCommandSchema);