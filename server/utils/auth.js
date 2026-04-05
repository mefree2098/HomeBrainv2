const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = process.env.AUTH_ACCESS_TOKEN_TTL || '1d';
const REFRESH_TOKEN_TTL = process.env.AUTH_REFRESH_TOKEN_TTL || '365d';

const generateAccessToken = (user) => {
  const payload = {
    sub: user._id
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
};

const generateRefreshToken = (user) => {
  const payload = {
    sub: user._id
  };
  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
};

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  generateAccessToken,
  generateRefreshToken
};
