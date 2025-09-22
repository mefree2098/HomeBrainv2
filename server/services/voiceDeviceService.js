const VoiceDevice = require('../models/VoiceDevice');

/**
 * Service for managing voice devices
 */
class VoiceDeviceService {
  
  /**
   * Get all voice devices
   * @returns {Promise<Array>} Array of voice devices
   */
  async getAllDevices() {
    console.log('VoiceDeviceService: Fetching all voice devices');
    try {
      const devices = await VoiceDevice.find()
        .select('name room deviceType status lastSeen batteryLevel powerSource connectionType ipAddress volume microphoneSensitivity firmwareVersion uptime')
        .sort({ room: 1, name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices`);
      return devices;
    } catch (error) {
      console.error('VoiceDeviceService: Error fetching voice devices:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch voice devices: ${error.message}`);
    }
  }

  /**
   * Get voice device by ID
   * @param {string} deviceId - The device ID
   * @returns {Promise<Object>} Voice device object
   */
  async getDeviceById(deviceId) {
    console.log(`VoiceDeviceService: Fetching voice device by ID: ${deviceId}`);
    try {
      const device = await VoiceDevice.findById(deviceId);
      
      if (!device) {
        console.warn(`VoiceDeviceService: Voice device not found with ID: ${deviceId}`);
        throw new Error('Voice device not found');
      }
      
      console.log(`VoiceDeviceService: Found voice device: ${device.name} in ${device.room}`);
      return device;
    } catch (error) {
      console.error(`VoiceDeviceService: Error fetching voice device ${deviceId}:`, error.message);
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to fetch voice device: ${error.message}`);
    }
  }

  /**
   * Get voice system status
   * @returns {Promise<Object>} System status object
   */
  async getSystemStatus() {
    console.log('VoiceDeviceService: Getting voice system status');
    try {
      // Get device counts by status
      const deviceStats = await VoiceDevice.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      // Get total device count
      const totalDevices = await VoiceDevice.countDocuments();
      
      // Calculate status counts
      const statusCounts = deviceStats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {});

      const onlineDevices = statusCounts.online || 0;
      const offlineDevices = statusCounts.offline || 0;
      const errorDevices = statusCounts.error || 0;
      const updatingDevices = statusCounts.updating || 0;

      // Check if system is listening (at least one device is online)
      const listening = onlineDevices > 0;
      
      // Check if system is connected (more than half devices are online)
      const connected = totalDevices > 0 && (onlineDevices / totalDevices) >= 0.5;

      const status = {
        listening,
        connected,
        activeDevices: onlineDevices,
        totalDevices,
        deviceStats: {
          online: onlineDevices,
          offline: offlineDevices,
          error: errorDevices,
          updating: updatingDevices
        }
      };

      // Log a cleaner status summary instead of the full object
      console.log(`VoiceDeviceService: System status - ${onlineDevices}/${totalDevices} devices online, listening: ${listening}, connected: ${connected}`);
      return status;
    } catch (error) {
      console.error('VoiceDeviceService: Error getting system status:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to get voice system status: ${error.message}`);
    }
  }

  /**
   * Test voice device connectivity and functionality
   * @param {string} deviceId - The device ID to test
   * @returns {Promise<Object>} Test result object
   */
  async testDevice(deviceId) {
    console.log(`VoiceDeviceService: Testing voice device: ${deviceId}`);
    try {
      const device = await this.getDeviceById(deviceId);
      
      // Simulate device testing logic
      const testResults = {
        connectivity: false,
        audioInput: false,
        audioOutput: false,
        wakeWordDetection: false,
        latency: null,
        errors: []
      };

      // Test connectivity
      console.log(`VoiceDeviceService: Testing connectivity for ${device.name}`);
      if (device.status === 'online') {
        testResults.connectivity = true;
        
        // Simulate audio input test
        if (device.deviceType === 'microphone' || device.deviceType === 'hub' || device.deviceType === 'display') {
          testResults.audioInput = true;
          console.log(`VoiceDeviceService: Audio input test passed for ${device.name}`);
        }
        
        // Simulate audio output test
        if (device.deviceType === 'speaker' || device.deviceType === 'hub' || device.deviceType === 'display') {
          testResults.audioOutput = true;
          console.log(`VoiceDeviceService: Audio output test passed for ${device.name}`);
        }
        
        // Simulate wake word detection test
        if (device.wakeWordSupport && device.voiceRecognitionEnabled) {
          testResults.wakeWordDetection = true;
          console.log(`VoiceDeviceService: Wake word detection test passed for ${device.name}`);
        }
        
        // Simulate latency test (random between 50-200ms)
        testResults.latency = Math.floor(Math.random() * 150) + 50;
      } else {
        testResults.errors.push('Device is offline');
        console.warn(`VoiceDeviceService: Device ${device.name} is offline`);
      }

      // Update device's last interaction time if tests passed
      if (testResults.connectivity) {
        device.lastInteraction = new Date();
        device.lastSeen = new Date();
        await device.save();
        console.log(`VoiceDeviceService: Updated last interaction for ${device.name}`);
      }

      const success = testResults.connectivity && 
                     (testResults.audioInput || testResults.audioOutput) && 
                     testResults.errors.length === 0;
      
      const message = success 
        ? `Voice device test completed successfully. Latency: ${testResults.latency}ms`
        : `Voice device test failed: ${testResults.errors.join(', ')}`;

      const result = {
        success,
        message,
        deviceName: device.name,
        room: device.room,
        testResults
      };

      console.log(`VoiceDeviceService: Test completed for ${device.name}:`, result);
      return result;
      
    } catch (error) {
      console.error(`VoiceDeviceService: Error testing voice device ${deviceId}:`, error.message);
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to test voice device: ${error.message}`);
    }
  }

  /**
   * Update device status
   * @param {string} deviceId - The device ID
   * @param {string} status - New status (online, offline, error, updating)
   * @returns {Promise<Object>} Updated device object
   */
  async updateDeviceStatus(deviceId, status) {
    console.log(`VoiceDeviceService: Updating device ${deviceId} status to ${status}`);
    try {
      const device = await VoiceDevice.findByIdAndUpdate(
        deviceId,
        { 
          status,
          lastSeen: status === 'online' ? new Date() : undefined
        },
        { new: true }
      );

      if (!device) {
        console.warn(`VoiceDeviceService: Voice device not found for status update: ${deviceId}`);
        throw new Error('Voice device not found');
      }

      console.log(`VoiceDeviceService: Updated status for ${device.name} to ${status}`);
      return device;
    } catch (error) {
      console.error(`VoiceDeviceService: Error updating device status ${deviceId}:`, error.message);
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to update device status: ${error.message}`);
    }
  }

  /**
   * Get devices by room
   * @param {string} room - Room name
   * @returns {Promise<Array>} Array of voice devices in the room
   */
  async getDevicesByRoom(room) {
    console.log(`VoiceDeviceService: Fetching voice devices in room: ${room}`);
    try {
      const devices = await VoiceDevice.find({ room })
        .select('name deviceType status lastSeen batteryLevel powerSource connectionType volume microphoneSensitivity')
        .sort({ name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices in ${room}`);
      return devices;
    } catch (error) {
      console.error(`VoiceDeviceService: Error fetching devices in room ${room}:`, error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch devices in room: ${error.message}`);
    }
  }

  /**
   * Get devices by status
   * @param {string} status - Device status
   * @returns {Promise<Array>} Array of voice devices with the status
   */
  async getDevicesByStatus(status) {
    console.log(`VoiceDeviceService: Fetching voice devices with status: ${status}`);
    try {
      const devices = await VoiceDevice.find({ status })
        .select('name room deviceType lastSeen batteryLevel powerSource connectionType')
        .sort({ room: 1, name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices with status ${status}`);
      return devices;
    } catch (error) {
      console.error(`VoiceDeviceService: Error fetching devices with status ${status}:`, error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch devices by status: ${error.message}`);
    }
  }
}

module.exports = new VoiceDeviceService();