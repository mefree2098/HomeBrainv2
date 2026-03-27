const mongoose = require('mongoose');

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const CalibrationSchema = new mongoose.Schema({
  tempOffsetC: {
    type: Number,
    default: 0
  },
  humidityOffsetPct: {
    type: Number,
    default: 0
  },
  pressureOffsetMb: {
    type: Number,
    default: 0
  },
  windSpeedMultiplier: {
    type: Number,
    default: 1,
    min: 0
  },
  rainMultiplier: {
    type: Number,
    default: 1,
    min: 0
  }
}, { _id: false });

const TempestIntegrationSchema = new mongoose.Schema({
  token: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: false
  },
  websocketEnabled: {
    type: Boolean,
    default: true
  },
  udpEnabled: {
    type: Boolean,
    default: false
  },
  udpBindAddress: {
    type: String,
    default: '0.0.0.0'
  },
  udpPort: {
    type: Number,
    default: 50222,
    min: 1,
    max: 65535
  },
  room: {
    type: String,
    default: 'Outside'
  },
  selectedStationId: {
    type: Number,
    default: null
  },
  selectedDeviceIds: {
    type: [Number],
    default: []
  },
  calibration: {
    type: CalibrationSchema,
    default: () => ({})
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastDiscoveryAt: {
    type: Date,
    default: null
  },
  lastSyncAt: {
    type: Date,
    default: null
  },
  lastObservationAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
  },
  websocket: {
    connected: {
      type: Boolean,
      default: false
    },
    lastConnectedAt: {
      type: Date,
      default: null
    },
    lastMessageAt: {
      type: Date,
      default: null
    },
    reconnectCount: {
      type: Number,
      default: 0
    }
  },
  udp: {
    listening: {
      type: Boolean,
      default: false
    },
    lastMessageAt: {
      type: Date,
      default: null
    }
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
  versionKey: false
});

TempestIntegrationSchema.pre('save', function() {
  this.updatedAt = new Date();
});

TempestIntegrationSchema.statics.getDefaultIntegration = function() {
  return {
    token: trimString(process.env.TEMPEST_TOKEN, ''),
    enabled: process.env.TEMPEST_ENABLED === 'true',
    websocketEnabled: process.env.TEMPEST_WS_ENABLED !== 'false',
    udpEnabled: process.env.TEMPEST_UDP_ENABLED === 'true',
    udpBindAddress: trimString(process.env.TEMPEST_UDP_BIND, '0.0.0.0'),
    udpPort: Number(process.env.TEMPEST_UDP_PORT || 50222),
    room: trimString(process.env.TEMPEST_ROOM, 'Outside'),
    selectedStationId: null,
    selectedDeviceIds: [],
    calibration: {
      tempOffsetC: Number(process.env.TEMPEST_TEMP_OFFSET_C || 0),
      humidityOffsetPct: Number(process.env.TEMPEST_HUMIDITY_OFFSET_PCT || 0),
      pressureOffsetMb: Number(process.env.TEMPEST_PRESSURE_OFFSET_MB || 0),
      windSpeedMultiplier: Number(process.env.TEMPEST_WIND_SPEED_MULTIPLIER || 1),
      rainMultiplier: Number(process.env.TEMPEST_RAIN_MULTIPLIER || 1)
    },
    isConnected: false,
    lastDiscoveryAt: null,
    lastSyncAt: null,
    lastObservationAt: null,
    lastError: '',
    websocket: {
      connected: false,
      lastConnectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0
    },
    udp: {
      listening: false,
      lastMessageAt: null
    }
  };
};

TempestIntegrationSchema.statics.getIntegration = async function() {
  const integration = await this.findOne();
  if (integration) {
    return integration;
  }

  return new this(this.getDefaultIntegration());
};

TempestIntegrationSchema.methods.toSanitized = function() {
  const sanitized = this.toObject ? this.toObject() : { ...this };

  if (sanitized.token) {
    sanitized.token = sanitized.token.replace(/.(?=.{4})/g, '*');
  }

  return sanitized;
};

module.exports = mongoose.model('TempestIntegration', TempestIntegrationSchema);
