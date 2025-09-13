const Device = require('../models/Device');

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
      
      if (!device.isOnline) {
        throw new Error('Device is offline and cannot be controlled');
      }
      
      let updateData = { lastSeen: new Date() };
      
      switch (action) {
        case 'toggle':
          updateData.status = !device.status;
          if (device.type === 'light' && updateData.status === false) {
            updateData.brightness = 0;
          }
          break;
          
        case 'turnOn':
          updateData.status = true;
          if (device.type === 'light' && device.brightness === 0) {
            updateData.brightness = 75; // Default brightness
          }
          break;
          
        case 'turnOff':
          updateData.status = false;
          if (device.type === 'light') {
            updateData.brightness = 0;
          }
          break;
          
        case 'setBrightness':
          if (device.type !== 'light') {
            throw new Error('Brightness control is only available for lights');
          }
          if (value < 0 || value > 100) {
            throw new Error('Brightness must be between 0 and 100');
          }
          updateData.brightness = value;
          updateData.status = value > 0;
          break;
          
        case 'setColor':
          if (device.type !== 'light') {
            throw new Error('Color control is only available for lights');
          }
          if (!value || typeof value !== 'string') {
            throw new Error('Color value must be a valid hex color string');
          }
          updateData.color = value;
          break;
          
        case 'setTemperature':
          if (device.type !== 'thermostat') {
            throw new Error('Temperature control is only available for thermostats');
          }
          if (value < -50 || value > 150) {
            throw new Error('Temperature must be between -50 and 150');
          }
          updateData.targetTemperature = value;
          updateData.status = true;
          break;
          
        case 'lock':
          if (device.type !== 'lock') {
            throw new Error('Lock control is only available for locks');
          }
          updateData.status = true; // true = locked
          break;
          
        case 'unlock':
          if (device.type !== 'lock') {
            throw new Error('Unlock control is only available for locks');
          }
          updateData.status = false; // false = unlocked
          break;
          
        case 'open':
          if (device.type !== 'garage') {
            throw new Error('Open control is only available for garage doors');
          }
          updateData.status = true; // true = open
          break;
          
        case 'close':
          if (device.type !== 'garage') {
            throw new Error('Close control is only available for garage doors');
          }
          updateData.status = false; // false = closed
          break;
          
        default:
          throw new Error(`Unknown action: ${action}`);
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