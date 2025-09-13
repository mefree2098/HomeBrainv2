const UserService = require('../../services/userService.js');
const jwt = require('jsonwebtoken');
const {ALL_ROLES} = require("../../../shared/config/roles");

const requireUser = (allowedRoles = ALL_ROLES) => {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await UserService.get(decoded.sub);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // If roles are specified, check if user has one of the allowed roles
      if (allowedRoles && allowedRoles.length > 0) {
        if (!allowedRoles.includes(user.role)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      req.user = user;
      next();
    } catch (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
  };
};

module.exports = {
  requireUser,
};
