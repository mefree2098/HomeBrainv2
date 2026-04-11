const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.RAINMACHINE_HISTORY_RETENTION_DAYS || process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const RainMachineDailyStatSchema = new mongoose.Schema({
  controllerId: {
    type: String,
    required: true,
    index: true
  },
  controllerName: {
    type: String,
    default: ''
  },
  day: {
    type: String,
    required: true
  },
  dayDate: {
    type: Date,
    required: true,
    index: true
  },
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  raw: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false
});

RainMachineDailyStatSchema.index(
  { controllerId: 1, day: 1 },
  { unique: true, name: 'rainmachine_daily_stat_unique' }
);
RainMachineDailyStatSchema.index(
  { dayDate: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'rainmachine_daily_stats_ttl'
  }
);

module.exports = mongoose.model('RainMachineDailyStat', RainMachineDailyStatSchema);
