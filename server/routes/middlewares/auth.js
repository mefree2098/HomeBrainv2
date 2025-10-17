const UserService = require('../../services/userService.js');
const jwt = require('jsonwebtoken');
const {ALL_ROLES} = require("../../../shared/config/roles");

async function verifyAccessToken(token, allowedRoles = ALL_ROLES) {
  if (!token) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET environment variable is not set');
    const error = new Error('Server configuration error');
    error.status = 500;
    throw error;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await UserService.get(decoded.sub);
    if (!user) {
      const error = new Error('User not found');
      error.status = 401;
      throw error;
    }

    if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      const error = new Error('Insufficient permissions');
      error.status = 403;
      throw error;
    }

    return user;
  } catch (err) {
    console.error('Token verification error:', err.message);
    if (err.name === 'JsonWebTokenError') {
      console.error('JWT signature verification failed');
    } else if (err.name === 'TokenExpiredError') {
      console.error('Access token has expired');
    }
    err.status = err.status || 403;
    throw err;
  }
}

const requireUser = (allowedRoles = ALL_ROLES) => {
  return async (req, res, next) => {
    const authHeaderToken = req.headers.authorization?.split(' ')[1];
    const queryToken = req.query?.token;

    try {
      const user = await verifyAccessToken(authHeaderToken || queryToken, allowedRoles);
      req.user = user;
      next();
    } catch (error) {
      return res.status(error.status || 403).json({ error: error.message });
    }
  };
};

module.exports = {
  requireUser,
  verifyAccessToken,
};
