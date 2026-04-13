const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = process.env.AUTH_ACCESS_TOKEN_TTL || '1d';
const REFRESH_TOKEN_TTL = process.env.AUTH_REFRESH_TOKEN_TTL || '365d';

const generateAccessToken = (user, options = {}) => {
  const payload = {
    sub: user._id
  };

  if (options.sessionId) {
    payload.sid = options.sessionId;
  }

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: options.expiresIn || ACCESS_TOKEN_TTL
  });
};

const generateRefreshToken = (user, options = {}) => {
  const payload = {
    sub: user._id,
    jti: options.tokenId || randomUUID()
  };

  if (options.sessionId) {
    payload.sid = options.sessionId;
  }

  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: options.expiresIn || REFRESH_TOKEN_TTL
  });
};

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  generateAccessToken,
  generateRefreshToken
};
