const mongoose = require('mongoose');

const SecurityAlarmSchema = new mongoose.Schema({
  // Basic alarm information
  name: {
    type: String,
    required: true,
    default: 'Home Security System'
  },
  
  // Current alarm state
  alarmState: {
    type: String,
    enum: ['disarmed', 'armedStay', 'armedAway', 'triggered', 'arming', 'disarming'],
    default: 'disarmed'
  },
  
  // SmartThings integration
  smartthingsDeviceId: {
    type: String,
    required: false,
    sparse: true // Allow multiple null values but unique non-null values
  },
  
  // Alarm configuration
  entryDelay: {
    type: Number,
    default: 30, // seconds
    min: 0,
    max: 300
  },
  
  exitDelay: {
    type: Number,
    default: 60, // seconds  
    min: 0,
    max: 300
  },
  
  // Monitoring zones
  zones: [{
    name: {
      type: String,
      required: true
    },
    deviceId: {
      type: String,
      required: true
    },
    deviceType: {
      type: String,
      enum: ['doorWindow', 'motion', 'glass', 'smoke', 'co', 'flood', 'panic'],
      required: true
    },
    enabled: {
      type: Boolean,
      default: true
    },
    bypassable: {
      type: Boolean,
      default: true
    },
    bypassed: {
      type: Boolean,
      default: false
    }
  }],
  
  // Alarm history
  lastArmed: {
    type: Date,
    default: null
  },
  
  lastDisarmed: {
    type: Date,
    default: null
  },
  
  lastTriggered: {
    type: Date,
    default: null
  },
  
  armedBy: {
    type: String,
    default: null
  },
  
  disarmedBy: {
    type: String,
    default: null
  },
  
  // User access codes (hashed)
  userCodes: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    code: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true
    },
    enabled: {
      type: Boolean,
      default: true
    }
  }],
  
  // System status
  batteryLevel: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  
  signalStrength: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  
  // Notifications
  notificationSettings: {
    emailOnArm: {
      type: Boolean,
      default: false
    },
    emailOnDisarm: {
      type: Boolean,
      default: false
    },
    emailOnTrigger: {
      type: Boolean,
      default: true
    },
    voiceAnnouncements: {
      type: Boolean,
      default: true
    }
  },
  
  // Integration status
  lastSyncWithSmartThings: {
    type: Date,
    default: null
  },
  
  isOnline: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for faster queries
SecurityAlarmSchema.index({ alarmState: 1 });
SecurityAlarmSchema.index({ 'zones.deviceId': 1 });

// Static method to get the main alarm system
SecurityAlarmSchema.statics.getMainAlarm = async function() {
  console.log('SecurityAlarm: Getting main alarm system');
  
  let alarm = await this.findOne();
  
  if (!alarm) {
    console.log('SecurityAlarm: No alarm system found, creating default alarm');
    alarm = new this({
      name: 'Home Security System',
      alarmState: 'disarmed'
    });
    await alarm.save();
    console.log('SecurityAlarm: Default alarm system created');
  }
  
  return alarm;
};

// Instance method to arm the alarm
SecurityAlarmSchema.methods.arm = function(mode, userId) {
  console.log(`SecurityAlarm: Arming alarm in ${mode} mode by user ${userId}`);
  
  if (mode === 'stay') {
    this.alarmState = 'armedStay';
  } else if (mode === 'away') {
    this.alarmState = 'armedAway';
  } else {
    throw new Error('Invalid arm mode. Must be "stay" or "away"');
  }
  
  this.lastArmed = new Date();
  this.armedBy = userId || 'system';
  
  return this.save();
};

// Instance method to disarm the alarm
SecurityAlarmSchema.methods.disarm = function(userId) {
  console.log(`SecurityAlarm: Disarming alarm by user ${userId}`);
  
  this.alarmState = 'disarmed';
  this.lastDisarmed = new Date();
  this.disarmedBy = userId || 'system';
  
  // Clear any bypassed zones
  this.zones.forEach(zone => {
    zone.bypassed = false;
  });
  
  return this.save();
};

// Instance method to trigger the alarm
SecurityAlarmSchema.methods.trigger = function(triggeredZone) {
  console.log(`SecurityAlarm: Alarm triggered by zone: ${triggeredZone}`);
  
  this.alarmState = 'triggered';
  this.lastTriggered = new Date();
  
  return this.save();
};

// Instance method to add a zone
SecurityAlarmSchema.methods.addZone = function(zoneData) {
  console.log(`SecurityAlarm: Adding new zone: ${zoneData.name}`);
  
  this.zones.push(zoneData);
  return this.save();
};

// Instance method to remove a zone
SecurityAlarmSchema.methods.removeZone = function(deviceId) {
  console.log(`SecurityAlarm: Removing zone with device ID: ${deviceId}`);
  
  this.zones = this.zones.filter(zone => zone.deviceId !== deviceId);
  return this.save();
};

// Instance method to bypass/unbypass a zone
SecurityAlarmSchema.methods.bypassZone = function(deviceId, bypass = true) {
  console.log(`SecurityAlarm: ${bypass ? 'Bypassing' : 'Unbypassing'} zone with device ID: ${deviceId}`);
  
  const zone = this.zones.find(z => z.deviceId === deviceId);
  if (zone && zone.bypassable) {
    zone.bypassed = bypass;
    return this.save();
  }
  
  throw new Error('Zone not found or not bypassable');
};

module.exports = mongoose.model('SecurityAlarm', SecurityAlarmSchema);