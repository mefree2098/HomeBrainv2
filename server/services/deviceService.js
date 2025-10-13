const Device = require('../models/Device');
const smartThingsService = require('./smartThingsService');

class DeviceService {
  /**
   * Get all devices
   * @param {Object} filters - Optional filters (room, type, status, isOnline)
   * @returns {Promise<Array>} Array of devices
   */
  async getAllDevices(filters = {}) {
    try {
      console.log('DeviceService: Fetching all devices with filters:', filters);
      
      const query = {};
      if (filters.room) query.room = filters.room;
      if (filters.type) query.type = filters.type;
      if (filters.status !== undefined) query.status = filters.status;
      if (filters.isOnline !== undefined) query.isOnline = filters.isOnline;
      
      const devices = await Device.find(query).sort({ room: 1, name: 1 });
      console.log(`DeviceService: Found ${devices.length} devices`);
      
      return devices;
    } catch (error) {
      console.error('DeviceService: Error fetching all devices:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch devices');
    }
  }

  /**
   * Get device by ID
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Device object
   */
  async getDeviceById(deviceId) {
    try {
      console.log('DeviceService: Fetching device by ID:', deviceId);
      
      const device = await Device.findById(deviceId);
      if (!device) {
        console.log('DeviceService: Device not found for ID:', deviceId);
        throw new Error('Device not found');
      }
      
      console.log('DeviceService: Successfully found device:', device.name);
      return device;
    } catch (error) {
      console.error('DeviceService: Error fetching device by ID:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found') {
        throw error;
      }
      throw new Error('Failed to fetch device');
    }
  }

  /**
   * Create a new device
   * @param {Object} deviceData - Device data
   * @returns {Promise<Object>} Created device
   */
  async createDevice(deviceData) {
    try {
      console.log('DeviceService: Creating new device:', deviceData.name);
      
      // Validate required fields
      if (!deviceData.name || !deviceData.type || !deviceData.room) {
        throw new Error('Name, type, and room are required fields');
      }
      
      // Check if device with same name exists in the same room
      const existingDevice = await Device.findOne({
        name: deviceData.name,
        room: deviceData.room
      });
      
      if (existingDevice) {
        throw new Error('A device with this name already exists in this room');
      }
      
      const device = new Device(deviceData);
      const savedDevice = await device.save();
      
      console.log('DeviceService: Successfully created device:', savedDevice.name, 'with ID:', savedDevice._id);
      return savedDevice;
    } catch (error) {
      console.error('DeviceService: Error creating device:', error.message);
      console.error(error.stack);
      if (error.message.includes('required fields') || error.message.includes('already exists')) {
        throw error;
      }
      throw new Error('Failed to create device');
    }
  }

  /**
   * Update a device
   * @param {string} deviceId - Device ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} Updated device
   */
  async updateDevice(deviceId, updateData) {
    try {
      console.log('DeviceService: Updating device:', deviceId);
      
      // Check if device exists
      const existingDevice = await Device.findById(deviceId);
      if (!existingDevice) {
        throw new Error('Device not found');
      }
      
      // If updating name and room, check for duplicates
      if ((updateData.name && updateData.name !== existingDevice.name) || 
          (updateData.room && updateData.room !== existingDevice.room)) {
        const name = updateData.name || existingDevice.name;
        const room = updateData.room || existingDevice.room;
        
        const duplicateDevice = await Device.findOne({
          _id: { $ne: deviceId },
          name: name,
          room: room
        });
        
        if (duplicateDevice) {
          throw new Error('A device with this name already exists in this room');
        }
      }
      
      // Update lastSeen if device comes back online
      if (updateData.isOnline === true && existingDevice.isOnline === false) {
        updateData.lastSeen = new Date();
      }
      
      const updatedDevice = await Device.findByIdAndUpdate(
        deviceId,
        updateData,
        { new: true, runValidators: true }
      );
      
      console.log('DeviceService: Successfully updated device:', updatedDevice.name);
      return updatedDevice;
    } catch (error) {
      console.error('DeviceService: Error updating device:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found' || error.message.includes('already exists')) {
        throw error;
      }
      throw new Error('Failed to update device');
    }
  }

  /**
   * Delete a device
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Deleted device
   */
  async deleteDevice(deviceId) {
    try {
      console.log('DeviceService: Deleting device:', deviceId);
      
      const deletedDevice = await Device.findByIdAndDelete(deviceId);
      if (!deletedDevice) {
        throw new Error('Device not found');
      }
      
      console.log('DeviceService: Successfully deleted device:', deletedDevice.name);
      return deletedDevice;
    } catch (error) {
      console.error('DeviceService: Error deleting device:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found') {
        throw error;
      }
      throw new Error('Failed to delete device');
    }
  }

  /**
   * Control a device (toggle, set brightness, temperature, etc.)
   * @param {string} deviceId - Device ID
   * @param {string} action - Action to perform (toggle, setBrightness, setTemperature, etc.)
   * @param {*} value - Value for the action (optional)
   * @returns {Promise<Object>} Updated device
   */
  async controlDevice(deviceId, action, value) {
    try {
      console.log('DeviceService: Controlling device:', deviceId, 'action:', action, 'value:', value);

      const device = await Device.findById(deviceId);
      if (!device) {
        throw new Error('Device not found');
      }

      const normalizedAction = this.normalizeAction(action);

      if (!normalizedAction) {
        throw new Error(`Unknown action: ${action}`);
      }

      const isSmartThings = this.isSmartThingsDevice(device);

      if (!device.isOnline) {
        if (isSmartThings) {
          const refreshedOnline = await this.refreshSmartThingsOnlineStatus(device);
          if (!refreshedOnline) {
            throw new Error('Device is offline and cannot be controlled');
          }
        } else {
          throw new Error('Device is offline and cannot be controlled');
        }
      }

      const updateData = { lastSeen: new Date() };
      let commandValue = value;

      switch (normalizedAction) {
        case 'toggle':
          updateData.status = !device.status;
          if (device.type === 'light' && updateData.status === false) {
            updateData.brightness = 0;
          }
          commandValue = updateData.status;
          break;

        case 'turnon':
          updateData.status = true;
          if (device.type === 'light' && (device.brightness == null || device.brightness === 0)) {
            updateData.brightness = 75; // Default brightness
          }
          commandValue = updateData.status;
          break;

        case 'turnoff':
          updateData.status = false;
          if (device.type === 'light') {
            updateData.brightness = 0;
          }
          commandValue = updateData.status;
          break;

        case 'setbrightness': {
          if (device.type !== 'light') {
            throw new Error('Brightness control is only available for lights');
          }
          const numericBrightness = Number(value);
          if (!Number.isFinite(numericBrightness) || numericBrightness < 0 || numericBrightness > 100) {
            throw new Error('Brightness must be between 0 and 100');
          }
          const roundedBrightness = Math.round(numericBrightness);
          updateData.brightness = roundedBrightness;
          updateData.status = roundedBrightness > 0;
          commandValue = roundedBrightness;
          break;
        }

        case 'setcolor': {
          if (device.type !== 'light') {
            throw new Error('Color control is only available for lights');
          }
          if (!value || typeof value !== 'string') {
            throw new Error('Color value must be a valid hex color string');
          }
          const normalizedColor = this.normalizeHexColor(value);
          if (!normalizedColor) {
            throw new Error('Color value must be a valid hex color string');
          }
          updateData.color = normalizedColor;
          commandValue = normalizedColor;
          break;
        }

        case 'settemperature': {
          if (device.type !== 'thermostat') {
            throw new Error('Temperature control is only available for thermostats');
          }
          const numericTemp = Number(value);
          if (!Number.isFinite(numericTemp) || numericTemp < -50 || numericTemp > 150) {
            throw new Error('Temperature must be between -50 and 150');
          }
          updateData.targetTemperature = numericTemp;
          updateData.status = true;
          commandValue = numericTemp;
          break;
        }

        case 'lock':
          if (device.type !== 'lock') {
            throw new Error('Lock control is only available for locks');
          }
          updateData.status = true; // true = locked
          commandValue = 'lock';
          break;

        case 'unlock':
          if (device.type !== 'lock') {
            throw new Error('Unlock control is only available for locks');
          }
          updateData.status = false; // false = unlocked
          commandValue = 'unlock';
          break;

        case 'open':
          if (device.type !== 'garage') {
            throw new Error('Open control is only available for garage doors');
          }
          updateData.status = true; // true = open
          commandValue = 'open';
          break;

        case 'close':
          if (device.type !== 'garage') {
            throw new Error('Close control is only available for garage doors');
          }
          updateData.status = false; // false = closed
          commandValue = 'close';
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      if (isSmartThings) {
        await this.controlSmartThingsDevice(device, normalizedAction, commandValue, updateData);
        updateData.isOnline = true;
      }

      const updatedDevice = await Device.findByIdAndUpdate(
        deviceId,
        updateData,
        { new: true, runValidators: true }
      );

      console.log('DeviceService: Successfully controlled device:', updatedDevice.name, 'action:', action);
      return updatedDevice;
    } catch (error) {
      console.error('DeviceService: Error controlling device:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found' ||
          error.message.includes('offline') ||
          error.message.includes('only available') ||
          error.message.includes('must be') ||
          error.message.includes('Unknown action')) {
        throw error;
      }
      throw new Error('Failed to control device');
    }
  }

  normalizeAction(action) {
    if (!action) {
      return '';
    }
    return action.toString().toLowerCase().replace(/[^a-z]/g, '');
  }

  isSmartThingsDevice(device) {
    const source = (device?.properties?.source || '').toString().toLowerCase();
    return source === 'smartthings' && !!device?.properties?.smartThingsDeviceId;
  }

  normalizeHexColor(color) {
    if (typeof color !== 'string') {
      return null;
    }
    const trimmed = color.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(trimmed)) {
      return null;
    }
    return `#${trimmed.toLowerCase()}`;
  }

  hexToSmartThingsColor(color) {
    const normalized = this.normalizeHexColor(color);
    if (!normalized) {
      return null;
    }

    const r = parseInt(normalized.slice(1, 3), 16) / 255;
    const g = parseInt(normalized.slice(3, 5), 16) / 255;
    const b = parseInt(normalized.slice(5, 7), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === r) {
        hue = ((g - b) / delta) % 6;
      } else if (max === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
      hue *= 60;
      if (hue < 0) {
        hue += 360;
      }
    }

    const saturation = max === 0 ? 0 : delta / max;
    const value = max;

    return {
      hue: Math.round((hue % 360) / 3.6),
      saturation: Math.round(saturation * 100),
      level: Math.round(value * 100)
    };
  }

  async refreshSmartThingsOnlineStatus(device) {
    const smartThingsId = device?.properties?.smartThingsDeviceId;
    if (!smartThingsId) {
      return device.isOnline;
    }

    try {
      const details = await smartThingsService.getDevice(smartThingsId);
      if (!details) {
        return device.isOnline;
      }

      const online = (details.healthState?.state || '').toUpperCase() === 'ONLINE';
      const lastUpdated = details.healthState?.lastUpdatedDate ? new Date(details.healthState.lastUpdatedDate) : new Date();

      const updatePayload = {
        isOnline: online,
        lastSeen: lastUpdated,
        'properties.smartThingsHealthState': details.healthState || null
      };

      if (details.locationId) {
        updatePayload['properties.smartThingsLocationId'] = details.locationId;
      }

      await Device.updateOne({ _id: device._id }, { $set: updatePayload });

      device.isOnline = online;
      device.lastSeen = lastUpdated;
      device.properties = {
        ...(device.properties || {}),
        smartThingsHealthState: details.healthState || null,
        smartThingsLocationId: details.locationId || device.properties?.smartThingsLocationId || null
      };

      return online;
    } catch (error) {
      console.warn(`DeviceService: Unable to refresh SmartThings device ${smartThingsId} status: ${error.message}`);
      return device.isOnline;
    }
  }

  async controlSmartThingsDevice(device, normalizedAction, commandValue, updateData) {
    const smartThingsId = device?.properties?.smartThingsDeviceId;
    if (!smartThingsId) {
      throw new Error('SmartThings device ID is not configured for this device');
    }

    const capabilities = new Set(
      Array.isArray(device?.properties?.smartThingsCapabilities)
        ? device.properties.smartThingsCapabilities
        : []
    );

    switch (normalizedAction) {
      case 'toggle':
        if (commandValue) {
          await smartThingsService.turnDeviceOn(smartThingsId);
        } else {
          await smartThingsService.turnDeviceOff(smartThingsId);
        }
        break;

      case 'turnon':
        await smartThingsService.turnDeviceOn(smartThingsId);
        break;

      case 'turnoff':
        await smartThingsService.turnDeviceOff(smartThingsId);
        break;

      case 'setbrightness':
        await smartThingsService.setDeviceLevel(smartThingsId, commandValue);
        break;

      case 'setcolor': {
        const colorPayload = this.hexToSmartThingsColor(commandValue);
        if (!colorPayload) {
          throw new Error('Color value must be a valid hex color string');
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'colorControl',
          command: 'setColor',
          arguments: [colorPayload]
        }]);
        if (typeof colorPayload.level === 'number' && updateData.brightness === undefined) {
          updateData.brightness = colorPayload.level;
          updateData.status = colorPayload.level > 0;
        }
        break;
      }

      case 'settemperature': {
        const target = Number(commandValue);
        if (!Number.isFinite(target)) {
          throw new Error('Temperature must be between -50 and 150');
        }
        const commands = [];
        if (capabilities.has('thermostatHeatingSetpoint')) {
          commands.push({
            component: 'main',
            capability: 'thermostatHeatingSetpoint',
            command: 'setHeatingSetpoint',
            arguments: [target]
          });
        }
        if (capabilities.has('thermostatCoolingSetpoint')) {
          commands.push({
            component: 'main',
            capability: 'thermostatCoolingSetpoint',
            command: 'setCoolingSetpoint',
            arguments: [target]
          });
        }
        if (commands.length === 0) {
          commands.push({
            component: 'main',
            capability: 'thermostatSetpoint',
            command: 'setThermostatSetpoint',
            arguments: [target]
          });
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, commands);
        break;
      }

      case 'lock':
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'lock',
          command: 'lock'
        }]);
        break;

      case 'unlock':
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'lock',
          command: 'unlock'
        }]);
        break;

      case 'open':
      case 'close': {
        const commandName = normalizedAction === 'open' ? 'open' : 'close';
        const commands = [];
        if (capabilities.has('doorControl')) {
          commands.push({
            component: 'main',
            capability: 'doorControl',
            command: commandName
          });
        }
        if (capabilities.has('garageDoorControl')) {
          commands.push({
            component: 'main',
            capability: 'garageDoorControl',
            command: commandName
          });
        }
        if (commands.length === 0) {
          commands.push({
            component: 'main',
            capability: 'doorControl',
            command: commandName
          });
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, commands);
        break;
      }

      default:
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'switch',
          command: commandValue ? 'on' : 'off'
        }]);
        break;
    }
  }

  /**
   * Get devices grouped by room
   * @returns {Promise<Array>} Array of rooms with their devices
   */
  async getDevicesByRoom() {
    try {
      console.log('DeviceService: Fetching devices grouped by room');
      
      const devices = await Device.find().sort({ room: 1, name: 1 });
      
      // Group devices by room
      const roomMap = {};
      devices.forEach(device => {
        if (!roomMap[device.room]) {
          roomMap[device.room] = [];
        }
        roomMap[device.room].push(device);
      });
      
      // Convert to array format
      const rooms = Object.keys(roomMap).map(roomName => ({
        name: roomName,
        devices: roomMap[roomName]
      }));
      
      console.log(`DeviceService: Found ${rooms.length} rooms with devices`);
      return rooms;
    } catch (error) {
      console.error('DeviceService: Error fetching devices by room:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch devices by room');
    }
  }

  /**
   * Get device statistics
   * @returns {Promise<Object>} Device statistics
   */
  async getDeviceStats() {
    try {
      console.log('DeviceService: Fetching device statistics');
      
      const totalDevices = await Device.countDocuments();
      const onlineDevices = await Device.countDocuments({ isOnline: true });
      const activeDevices = await Device.countDocuments({ status: true });
      
      const devicesByType = await Device.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      
      const devicesByRoom = await Device.aggregate([
        { $group: { _id: '$room', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      
      const stats = {
        total: totalDevices,
        online: onlineDevices,
        offline: totalDevices - onlineDevices,
        active: activeDevices,
        inactive: totalDevices - activeDevices,
        byType: devicesByType,
        byRoom: devicesByRoom
      };
      
      console.log('DeviceService: Successfully generated device statistics');
      return stats;
    } catch (error) {
      console.error('DeviceService: Error fetching device statistics:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch device statistics');
    }
  }
}

module.exports = new DeviceService();
