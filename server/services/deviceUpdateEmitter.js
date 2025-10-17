const { EventEmitter } = require('events');

class DeviceUpdateEmitter extends EventEmitter {
  normalizeDevice(device) {
    if (!device) {
      return null;
    }

    const plain =
      typeof device.toObject === 'function'
        ? device.toObject({ depopulate: true })
        : JSON.parse(JSON.stringify(device));

    if (plain._id && typeof plain._id !== 'string') {
      try {
        plain._id = plain._id.toString();
      } catch (error) {
        plain._id = String(plain._id);
      }
    }

    if (!plain.id && plain._id) {
      plain.id = plain._id;
    }

    return plain;
  }

  normalizeDevices(devices) {
    if (!Array.isArray(devices)) {
      return [];
    }

    return devices
      .map((device) => this.normalizeDevice(device))
      .filter(Boolean);
  }
}

const deviceUpdateEmitter = new DeviceUpdateEmitter();

module.exports = deviceUpdateEmitter;
