const crypto = require('crypto');
const VoiceDevice = require('../models/VoiceDevice');

const DEVICE_CLAIM_TOKEN_TTL_MS = Math.max(
  60_000,
  Number(process.env.REMOTE_DEVICE_CLAIM_TOKEN_TTL_MS || 60 * 60 * 1000)
);
const REGISTRATION_CODE_TTL_MS = Math.max(
  60_000,
  Number(process.env.REMOTE_DEVICE_REGISTRATION_TTL_MS || 24 * 60 * 60 * 1000)
);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asTime(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSettings(device) {
  return device?.settings && typeof device.settings === 'object'
    ? device.settings
    : {};
}

function safeEquals(left, right) {
  const leftValue = Buffer.from(String(left || ''), 'utf8');
  const rightValue = Buffer.from(String(right || ''), 'utf8');
  if (leftValue.length !== rightValue.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftValue, rightValue);
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function issueRegistrationCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function issueDeviceClaimToken(ttlMs = DEVICE_CLAIM_TOKEN_TTL_MS) {
  return {
    claimToken: crypto.randomBytes(16).toString('hex'),
    claimTokenExpires: new Date(Date.now() + ttlMs)
  };
}

function issueDeviceToken() {
  const deviceToken = crypto.randomBytes(32).toString('hex');
  return {
    deviceToken,
    deviceTokenHash: hashDeviceToken(deviceToken),
    deviceTokenCreatedAt: new Date()
  };
}

function isDeviceRegistered(device) {
  return getSettings(device).registered === true;
}

function isRegistrationCredentialActive(device, registrationCode, nowMs = Date.now()) {
  const settings = getSettings(device);
  const requestedCode = trimString(registrationCode);
  const storedCode = trimString(settings.registrationCode);
  if (!requestedCode || !storedCode || settings.registered === true) {
    return false;
  }
  const expiresAt = asTime(settings.registrationExpires);
  return expiresAt > nowMs && safeEquals(storedCode, requestedCode);
}

function isClaimTokenActive(device, claimToken, nowMs = Date.now()) {
  const settings = getSettings(device);
  const requestedToken = trimString(claimToken);
  const storedToken = trimString(settings.claimToken);
  if (!requestedToken || !storedToken || settings.registered === true) {
    return false;
  }
  const expiresAt = asTime(settings.claimTokenExpires);
  return expiresAt > nowMs && safeEquals(storedToken, requestedToken);
}

function isDeviceTokenValid(device, deviceToken) {
  const settings = getSettings(device);
  const requestedToken = trimString(deviceToken);
  const storedHash = trimString(settings.deviceTokenHash);
  if (!requestedToken || !storedHash || settings.registered !== true) {
    return false;
  }
  return safeEquals(hashDeviceToken(requestedToken), storedHash);
}

function validateDeviceCredentials(device, credentials = {}, options = {}) {
  const {
    allowRegistrationCode = true,
    allowClaimToken = true,
    allowDeviceToken = true,
    nowMs = Date.now()
  } = options;

  if (!device) {
    return { authorized: false, method: null, reason: 'device_not_found' };
  }

  const normalizedCredentials = typeof credentials === 'string'
    ? { registrationCode: credentials }
    : credentials || {};

  if (allowDeviceToken && isDeviceTokenValid(device, normalizedCredentials.deviceToken)) {
    return { authorized: true, method: 'deviceToken', reason: null };
  }

  if (allowRegistrationCode && isRegistrationCredentialActive(device, normalizedCredentials.registrationCode, nowMs)) {
    return { authorized: true, method: 'registrationCode', reason: null };
  }

  if (allowClaimToken && isClaimTokenActive(device, normalizedCredentials.claimToken, nowMs)) {
    return { authorized: true, method: 'claimToken', reason: null };
  }

  return { authorized: false, method: null, reason: 'invalid_or_expired_credentials' };
}

async function validateDeviceAccess(deviceId, credentials = {}, options = {}) {
  const device = await VoiceDevice.findById(deviceId);
  const result = validateDeviceCredentials(device, credentials, options);
  return {
    ...result,
    device: result.authorized ? device : null
  };
}

async function getAuthorizedDevice(deviceId, credentials = {}, options = {}) {
  const result = await validateDeviceAccess(deviceId, credentials, options);
  return result.authorized ? result.device : null;
}

function buildOnboardingSettings(existingSettings = {}, options = {}) {
  const registrationCode = issueRegistrationCode();
  const issuedClaim = issueDeviceClaimToken(options.claimTokenTtlMs);
  const now = new Date();
  const lifecycle = {
    ...(existingSettings.lifecycle && typeof existingSettings.lifecycle === 'object'
      ? existingSettings.lifecycle
      : {}),
    state: options.state || 'registered',
    credentialVersion: Number(existingSettings.lifecycle?.credentialVersion || 0) + 1,
    registrationIssuedAt: now,
    registrationExpiresAt: new Date(Date.now() + REGISTRATION_CODE_TTL_MS)
  };

  if (options.reissued === true) {
    lifecycle.lastReissuedAt = now;
  }

  const settings = {
    ...existingSettings,
    registrationCode,
    registrationExpires: lifecycle.registrationExpiresAt,
    claimToken: issuedClaim.claimToken,
    claimTokenExpires: issuedClaim.claimTokenExpires,
    registered: false,
    lifecycle
  };

  if (options.clearDeviceToken === true) {
    delete settings.deviceTokenHash;
    delete settings.deviceTokenCreatedAt;
  }

  return {
    settings,
    registrationCode,
    registrationExpires: lifecycle.registrationExpiresAt,
    claimToken: issuedClaim.claimToken,
    claimTokenExpires: issuedClaim.claimTokenExpires
  };
}

function applyDeviceActivation(device, issuedDeviceToken, metadata = {}) {
  const settings = getSettings(device);
  const activatedAt = new Date();
  const lifecycle = {
    ...(settings.lifecycle && typeof settings.lifecycle === 'object' ? settings.lifecycle : {}),
    state: 'activated',
    activatedAt,
    lastActivatedAt: activatedAt
  };

  device.status = 'online';
  if (metadata.ipAddress) {
    device.ipAddress = metadata.ipAddress;
  }
  if (metadata.firmwareVersion) {
    device.firmwareVersion = metadata.firmwareVersion;
  }
  device.settings = {
    ...settings,
    registered: true,
    deviceTokenHash: issuedDeviceToken.deviceTokenHash,
    deviceTokenCreatedAt: issuedDeviceToken.deviceTokenCreatedAt,
    lifecycle
  };
  delete device.settings.registrationCode;
  delete device.settings.registrationExpires;
  delete device.settings.claimToken;
  delete device.settings.claimTokenExpires;
  device.lastSeen = activatedAt;
  if (typeof device.markModified === 'function') {
    device.markModified('settings');
  }
}

function applyOnboardingReissue(device, options = {}) {
  const onboarding = buildOnboardingSettings(getSettings(device), {
    state: 'onboarding_reissued',
    clearDeviceToken: true,
    reissued: true,
    claimTokenTtlMs: options.claimTokenTtlMs
  });
  device.status = 'offline';
  device.settings = onboarding.settings;
  device.updateStatus = {
    status: 'idle',
    version: device.firmwareVersion || null
  };
  if (typeof device.markModified === 'function') {
    device.markModified('settings');
  }
  return onboarding;
}

module.exports = {
  DEVICE_CLAIM_TOKEN_TTL_MS,
  REGISTRATION_CODE_TTL_MS,
  safeEquals,
  hashDeviceToken,
  issueRegistrationCode,
  issueDeviceClaimToken,
  issueDeviceToken,
  isDeviceRegistered,
  isRegistrationCredentialActive,
  isClaimTokenActive,
  isDeviceTokenValid,
  validateDeviceCredentials,
  validateDeviceAccess,
  getAuthorizedDevice,
  buildOnboardingSettings,
  applyDeviceActivation,
  applyOnboardingReissue
};
