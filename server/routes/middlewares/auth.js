const UserService = require('../../services/userService.js');
const jwt = require('jsonwebtoken');
const {ALL_ROLES} = require("../../../shared/config/roles");

const requireUser = (allowedRoles = ALL_ROLES) => {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
      if (!process.env.JWT_SECRET) {
        console.error('JWT_SECRET environment variable is not set');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await UserService.get(decoded.sub);
      if (!user) {
        console.log(`User not found for token sub: ${decoded.sub}`);
        return res.status(401).json({ error: 'User not found' });
      }

      // If roles are specified, check if user has one of the allowed roles
      if (allowedRoles && allowedRoles.length > 0) {
        if (!allowedRoles.includes(user.role)) {
          console.log(`User ${user._id} has role ${user.role}, but requires one of: ${allowedRoles.join(', ')}`);
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      req.user = user;
      next();
    } catch (err) {
      console.error('Token verification error:', err.message);
      if (err.name === 'JsonWebTokenError') {
        console.error('JWT signature verification failed');
      } else if (err.name === 'TokenExpiredError') {
        console.error('Access token has expired');
      }
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
  };
};

module.exports = {
  requireUser,
};
