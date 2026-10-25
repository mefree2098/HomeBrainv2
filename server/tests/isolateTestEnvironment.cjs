'use strict';

const path = require('node:path');
const os = require('node:os');

if (process.env.NODE_ENV !== 'test') throw new Error('Test environment bootstrap is test-only');
// A deploy runs these tests inside the live service's sandbox. Unit tests must
// never inherit its real database connection or privileged control socket.
process.env.DATABASE_URL = 'mongodb://127.0.0.1:1/homebrain_unit_tests';
process.env.HOMEBRAIN_HARDENED_SERVICE = '0';
process.env.HOMEBRAIN_HOST_CONTROL_SOCKET = path.join(os.tmpdir(), `homebrain-unit-tests-${process.pid}.sock`);
