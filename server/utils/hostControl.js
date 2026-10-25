const path = require('node:path');
const { requestHostControl } = require('../../scripts/homebrain-host-control');

function isHardenedService() {
  return process.env.HOMEBRAIN_HARDENED_SERVICE === '1';
}

function hostControlInvocation(action) {
  return { command: process.execPath, args: [path.resolve(__dirname, '../../scripts/homebrain-host-control.js'), action] };
}

function administratorRequired() {
  const error = new Error('Host software, kernel and permission changes require an authenticated SSH administrator.');
  error.code = 'HOST_ADMINISTRATOR_REQUIRED';
  error.status = 403;
  return error;
}

module.exports = { isHardenedService, hostControlInvocation, requestHostControl, administratorRequired };
