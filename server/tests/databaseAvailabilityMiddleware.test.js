const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfig = require('../config/database');
const { databaseAvailabilityGuard } = require('../middleware/databaseAvailability');

function createResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    }
  };
}

test('databaseAvailabilityGuard calls next when MongoDB is connected', (t) => {
  const originalIsDatabaseReady = databaseConfig.isDatabaseReady;

  t.after(() => {
    databaseConfig.isDatabaseReady = originalIsDatabaseReady;
  });

  databaseConfig.isDatabaseReady = () => true;

  let nextCalled = false;
  const res = createResponseRecorder();

  databaseAvailabilityGuard({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.payload, null);
});

test('databaseAvailabilityGuard returns 503 when MongoDB is unavailable', (t) => {
  const originalIsDatabaseReady = databaseConfig.isDatabaseReady;
  const originalGetDatabaseStateLabel = databaseConfig.getDatabaseStateLabel;

  t.after(() => {
    databaseConfig.isDatabaseReady = originalIsDatabaseReady;
    databaseConfig.getDatabaseStateLabel = originalGetDatabaseStateLabel;
  });

  databaseConfig.isDatabaseReady = () => false;
  databaseConfig.getDatabaseStateLabel = () => 'disconnected';

  let nextCalled = false;
  const res = createResponseRecorder();

  databaseAvailabilityGuard({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, {
    success: false,
    message: 'HomeBrain database is reconnecting. Please retry shortly.',
    database: {
      status: 'disconnected'
    }
  });
});
