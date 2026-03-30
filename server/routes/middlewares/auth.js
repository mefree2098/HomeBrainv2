const UserService = require('../../services/userService.js');
const jwt = require('jsonwebtoken');
const { ALL_ROLES, ROLES } = require("../../../shared/config/roles");
const oidcService = require('../../services/oidcService');
const { USER_PLATFORMS, hasPlatformAccess } = require('../../utils/userPlatforms');

function extractToken(req) {
  const authorizationHeader = req.headers.authorization;
  const headerToken = authorizationHeader?.split(' ')[1];
  const queryToken = req.query?.token;

  let cookieToken = null;
  const rawCookies = req.headers.cookie;
  if (rawCookies) {
    cookieToken = rawCookies
      .split(';')
      .map(part => part.trim())
      .map(part => part.split('='))
      .reduce((acc, [key, value]) => {
        if (key && value && !acc) {
          if (decodeURIComponent(key) === 'hbAccessToken') {
            acc = decodeURIComponent(value);
          }
        }
        return acc;
      }, null);
  }

  return headerToken || queryToken || cookieToken || null;
}

function formatPlatformName(platform) {
  if (platform === USER_PLATFORMS.HOMEBRAIN) {
    return 'HomeBrain';
  }

  if (platform === USER_PLATFORMS.AXIOM) {
    return 'Axiom';
  }

  return String(platform || 'this platform');
}

async function resolveUserFromSubject(subject, allowedRoles = ALL_ROLES, options = {}) {
  const user = await UserService.get(subject);
  if (!user) {
    const error = new Error('User not found');
    error.status = 401;
    throw error;
  }

  if (!user.isActive) {
    const error = new Error('User account is inactive');
    error.status = 403;
    throw error;
  }

  const platform = Object.prototype.hasOwnProperty.call(options, 'platform')
    ? options.platform
    : USER_PLATFORMS.HOMEBRAIN;
  if (platform && !hasPlatformAccess(user, platform)) {
    const error = new Error(`${formatPlatformName(platform)} access is not enabled for this account`);
    error.status = 403;
    throw error;
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
    const error = new Error('Insufficient permissions');
    error.status = 403;
    throw error;
  }

  return user;
}

async function verifyAccessToken(token, allowedRoles = ALL_ROLES, req = null, options = {}) {
  if (!token) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  let jwtError = null;
  if (process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return await resolveUserFromSubject(decoded.sub, allowedRoles, options);
    } catch (err) {
      jwtError = err;
    }
  }

  try {
    const requestForOidc = req || {
      headers: {
        authorization: `Bearer ${token}`
      },
      get() {
        return undefined;
      },
      protocol: 'https',
      secure: true
    };
    const decoded = await oidcService.verifyIssuedAccessToken(requestForOidc, `Bearer ${token}`);
    return await resolveUserFromSubject(decoded.sub, allowedRoles, options);
  } catch (oidcError) {
    const shouldPreferJwtError = Boolean(
      jwtError
      && (oidcError?.status === 401 || oidcError?.oidcError === 'invalid_token')
    );
    const error = shouldPreferJwtError ? jwtError : oidcError;
    console.error('Token verification error:', error.message);
    if (error.name === 'JsonWebTokenError') {
      console.error('JWT signature verification failed');
    } else if (error.name === 'TokenExpiredError') {
      console.error('Access token has expired');
    }
    error.status = error.status || 403;
    throw error;
  }
}

const requireUser = (allowedRoles = ALL_ROLES, options = {}) => {
  return async (req, res, next) => {
    const token = extractToken(req);

    try {
      const user = await verifyAccessToken(token, allowedRoles, req, options);
      req.user = user;
      next();
    } catch (error) {
      return res.status(error.status || 403).json({ error: error.message });
    }
  };
};

const requireAdmin = (options = {}) => requireUser([ROLES.ADMIN], options);

module.exports = {
  requireUser,
  requireAdmin,
  verifyAccessToken,
  extractToken
};
