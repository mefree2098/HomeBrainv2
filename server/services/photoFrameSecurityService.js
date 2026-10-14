const { invalid } = require('./photoFrameConfig');

function requireEnabled(frame) {
  if (frame.config?.securityControlsEnabled !== true) {
    throw Object.assign(new Error('Security controls are disabled for this frame'), { status: 403 });
  }
}

function publicStatus(status) {
  return {
    alarmState: status.alarmState,
    available: status.isOnline === true && ['disarmed', 'armedStay', 'armedAway', 'arming', 'triggered'].includes(status.alarmState),
    pinSettings: {
      requireForArm: status.pinSettings?.requireForArm === true,
      requireForDisarm: status.pinSettings?.requireForDisarm === true
    }
  };
}

async function status(frame) {
  requireEnabled(frame);
  return publicStatus(await require('./securityAlarmService').getAlarmStatus({ refreshDoorLocks: false }));
}

async function control(frame, input) {
  requireEnabled(frame);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['armStay', 'armAway', 'disarm'].includes(input.action)) {
    throw invalid('Choose Arm Stay, Arm Away, or Disarm');
  }
  if (input.pin !== undefined && (typeof input.pin !== 'string' || !/^\d{4,8}$/.test(input.pin))) {
    throw invalid('Security PIN must be 4–8 digits');
  }
  const service = require('./securityAlarmService');
  const current = await service.getAlarmStatus({ refreshDoorLocks: false });
  if (current.isOnline !== true) throw Object.assign(new Error('The security system is unavailable'), { status: 503 });
  const actor = `Photo frame: ${frame.name}`;
  const options = input.pin === undefined ? {} : { pin: input.pin };
  // The existing alarm service re-reads and enforces the current platform PIN
  // policy before any arm/disarm command. A frame cannot override that policy.
  if (input.action === 'disarm') await service.disarmAlarm(actor, options);
  else await service.armAlarm(input.action === 'armStay' ? 'stay' : 'away', actor, options);
  return publicStatus(await service.getAlarmStatus({ refreshDoorLocks: false }));
}

module.exports = { status, control };
