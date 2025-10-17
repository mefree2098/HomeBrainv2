const { EventEmitter } = require('events');

class DeviceUpdateEmitter extends EventEmitter {}

module.exports = new DeviceUpdateEmitter();
