const databaseConfig = require('../config/database');

function databaseAvailabilityGuard(req, res, next) {
  if (databaseConfig.isDatabaseReady()) {
    return next();
  }

  return res.status(503).json({
    success: false,
    message: 'HomeBrain database is reconnecting. Please retry shortly.',
    database: {
      status: databaseConfig.getDatabaseStateLabel()
    }
  });
}

module.exports = {
  databaseAvailabilityGuard
};
