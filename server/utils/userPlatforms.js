const USER_PLATFORMS = Object.freeze({
  HOMEBRAIN: 'homebrain',
  AXIOM: 'axiom'
});

const ALL_USER_PLATFORMS = Object.freeze([
  USER_PLATFORMS.HOMEBRAIN,
  USER_PLATFORMS.AXIOM
]);

const DEFAULT_USER_PLATFORMS = Object.freeze({
  [USER_PLATFORMS.HOMEBRAIN]: true,
  [USER_PLATFORMS.AXIOM]: false
});

function normalizeUserPlatforms(value, options = {}) {
  const defaults = options.includeDefaults === false
    ? {
        [USER_PLATFORMS.HOMEBRAIN]: false,
        [USER_PLATFORMS.AXIOM]: false
      }
    : DEFAULT_USER_PLATFORMS;

  let source = {};
  if (Array.isArray(value)) {
    source = Object.fromEntries(
      ALL_USER_PLATFORMS.map((platform) => [platform, value.includes(platform)])
    );
  } else if (value && typeof value === 'object') {
    source = value;
  }

  return {
    [USER_PLATFORMS.HOMEBRAIN]: Object.prototype.hasOwnProperty.call(source, USER_PLATFORMS.HOMEBRAIN)
      ? Boolean(source[USER_PLATFORMS.HOMEBRAIN])
      : defaults[USER_PLATFORMS.HOMEBRAIN],
    [USER_PLATFORMS.AXIOM]: Object.prototype.hasOwnProperty.call(source, USER_PLATFORMS.AXIOM)
      ? Boolean(source[USER_PLATFORMS.AXIOM])
      : defaults[USER_PLATFORMS.AXIOM]
  };
}

function hasPlatformAccess(userOrPlatforms, platform) {
  if (!ALL_USER_PLATFORMS.includes(platform)) {
    return false;
  }

  const platforms = normalizeUserPlatforms(userOrPlatforms?.platforms ?? userOrPlatforms);
  return Boolean(platforms[platform]);
}

function getEnabledPlatforms(userOrPlatforms) {
  const platforms = normalizeUserPlatforms(userOrPlatforms?.platforms ?? userOrPlatforms);
  return ALL_USER_PLATFORMS.filter((platform) => Boolean(platforms[platform]));
}

function buildPlatformAccessQuery(platform) {
  if (platform === USER_PLATFORMS.HOMEBRAIN) {
    return {
      $or: [
        { [`platforms.${USER_PLATFORMS.HOMEBRAIN}`]: true },
        { [`platforms.${USER_PLATFORMS.HOMEBRAIN}`]: { $exists: false } },
        { platforms: { $exists: false } }
      ]
    };
  }

  if (platform === USER_PLATFORMS.AXIOM) {
    return {
      [`platforms.${USER_PLATFORMS.AXIOM}`]: true
    };
  }

  return {};
}

module.exports = {
  USER_PLATFORMS,
  ALL_USER_PLATFORMS,
  DEFAULT_USER_PLATFORMS,
  normalizeUserPlatforms,
  hasPlatformAccess,
  getEnabledPlatforms,
  buildPlatformAccessQuery
};
