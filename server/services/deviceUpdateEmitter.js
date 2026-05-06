const { EventEmitter } = require('events');
const { serializeDevice, serializeDevices } = require('./devicePayloadService');

class DeviceUpdateEmitter extends EventEmitter {
  constructor() {
    super();
    const maxListeners = Math.max(
      10,
      Number.parseInt(process.env.HOMEBRAIN_DEVICE_UPDATE_MAX_LISTENERS, 10) || 100
    );
    this.setMaxListeners(maxListeners);
  }

  normalizeDevice(device) {
    return serializeDevice(device);
  }

  normalizeDevices(devices) {
    return serializeDevices(devices);
  }
}

const deviceUpdateEmitter = new DeviceUpdateEmitter();

module.exports = deviceUpdateEmitter;
