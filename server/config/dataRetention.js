const DEFAULT_DATA_RETENTION_DAYS = Object.freeze({
  telemetrySamples: 365,
  eventStream: 30,
  automationHistory: 180,
  voiceCommands: 180
});

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDataRetentionDays(env = process.env) {
  return {
    telemetrySamples: parsePositiveInt(
      env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS,
      DEFAULT_DATA_RETENTION_DAYS.telemetrySamples
    ),
    eventStream: parsePositiveInt(
      env.HOMEBRAIN_EVENT_STREAM_RETENTION_DAYS,
      DEFAULT_DATA_RETENTION_DAYS.eventStream
    ),
    automationHistory: parsePositiveInt(
      env.HOMEBRAIN_AUTOMATION_HISTORY_RETENTION_DAYS,
      DEFAULT_DATA_RETENTION_DAYS.automationHistory
    ),
    voiceCommands: parsePositiveInt(
      env.HOMEBRAIN_VOICE_COMMAND_RETENTION_DAYS,
      DEFAULT_DATA_RETENTION_DAYS.voiceCommands
    )
  };
}

module.exports = {
  DEFAULT_DATA_RETENTION_DAYS,
  getDataRetentionDays,
  parsePositiveInt
};
