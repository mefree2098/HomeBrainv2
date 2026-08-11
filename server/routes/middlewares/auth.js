const UserService = require('../../services/userService.js');
const authSessionService = require('../../services/authSessionService.js');
const codexSkillIntegrationService = require('../../services/codexSkillIntegrationService.js');
const jwt = require('jsonwebtoken');
const { ALL_ROLES, ROLES } = require("../../../shared/config/roles");
const oidcService = require('../../services/oidcService');
const { USER_PLATFORMS, hasPlatformAccess } = require('../../utils/userPlatforms');
const { ACCESS_TOKEN_COOKIE_NAME, getCookieValue } = require('../../utils/authCookies');

const READ_ONLY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractToken(req) {
  const authorizationHeader = req.headers.authorization;
  const [scheme, headerToken] = authorizationHeader?.split(/\s+/, 2) || [];
  const bearerToken = scheme?.toLowerCase() === 'bearer' ? headerToken : null;
  const cookieToken = getCookieValue(req, ACCESS_TOKEN_COOKIE_NAME);

  return bearerToken || cookieToken || null;
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

function allowsReadOnlyMutation(req, options = {}) {
  const allow = options.allowReadOnlyMutation;
  if (allow === true) return true;
  if (typeof allow === 'function') return allow(req);
  return false;
}

function shouldBlockReadOnlyMutation(req, user, options = {}) {
  return Boolean(
    user?.isReadOnly
    && !READ_ONLY_SAFE_METHODS.has(String(req.method || '').toUpperCase())
    && !allowsReadOnlyMutation(req, options)
  );
}

async function resolveUserFromSubject(subject, allowedRoles = ALL_ROLES, options = {}) {
  const user = await UserService.get(subject);
  return assertResolvedUser(user, allowedRoles, options);
}

function assertResolvedUser(user, allowedRoles = ALL_ROLES, options = {}) {
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
  if (req && typeof req === 'object') {
    req.authTokenClaims = null;
  }
  if (!token) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (codexSkillIntegrationService.looksLikeCodexSkillToken(token)) {
    const resolved = await codexSkillIntegrationService.resolveAuthenticatedUser(token, req);
    return assertResolvedUser(resolved.user, allowedRoles, options);
  }

  let jwtError = null;
  if (process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256']
      });
      if (decoded?.sid) {
        await authSessionService.assertSessionActive(decoded.sub, decoded.sid);
      }
      if (req && typeof req === 'object') {
        req.authTokenClaims = decoded;
      }
      return await resolveUserFromSubject(decoded.sub, allowedRoles, options);
    } catch (err) {
      if (err?.name !== 'JsonWebTokenError' && err?.name !== 'TokenExpiredError') {
        throw err;
      }
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
    if (req && typeof req === 'object') {
      req.authTokenClaims = decoded;
    }
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
      if (shouldBlockReadOnlyMutation(req, user, options)) {
        return res.status(403).json({
          success: false,
          error: 'Read-only accounts cannot modify HomeBrain data.'
        });
      }
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
