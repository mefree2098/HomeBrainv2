const SecurityAlarm = require('../models/SecurityAlarm');
const axios = require('axios');

class SecurityAlarmService {
  constructor() {
    this.smartthingsBaseUrl = 'https://api.smartthings.com/v1';
  }

  /**
   * Get the main alarm system
   * @returns {Promise<Object>} Alarm system data
   */
  async getAlarmSystem() {
    try {
      console.log('SecurityAlarmService: Getting alarm system');
      const alarm = await SecurityAlarm.getMainAlarm();
      console.log('SecurityAlarmService: Successfully retrieved alarm system');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error getting alarm system:', error.message);
      throw new Error('Failed to get alarm system');
    }
  }

  /**
   * Arm the security system
   * @param {string} mode - 'stay' or 'away'
   * @param {string} userId - User ID who is arming the system
   * @param {string} smartthingsToken - SmartThings API token
   * @returns {Promise<Object>} Updated alarm system
   */
  async armAlarm(mode, userId, smartthingsToken) {
    try {
      console.log(`SecurityAlarmService: Arming alarm in ${mode} mode`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      
      // Check if already armed
      if (alarm.alarmState === 'armedStay' || alarm.alarmState === 'armedAway') {
        throw new Error('Alarm is already armed');
      }
      
      // If SmartThings integration is configured, send command to SmartThings
      if (alarm.smartthingsDeviceId && smartthingsToken) {
        await this.sendSmartThingsCommand(
          alarm.smartthingsDeviceId,
          mode === 'stay' ? 'armStay' : 'armAway',
          smartthingsToken
        );
      }
      
      // Update local alarm state
      await alarm.arm(mode, userId);
      
      console.log(`SecurityAlarmService: Successfully armed alarm in ${mode} mode`);
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error arming alarm:', error.message);
      throw error;
    }
  }

  /**
   * Disarm the security system
   * @param {string} userId - User ID who is disarming the system
   * @param {string} smartthingsToken - SmartThings API token
   * @returns {Promise<Object>} Updated alarm system
   */
  async disarmAlarm(userId, smartthingsToken) {
    try {
      console.log('SecurityAlarmService: Disarming alarm');
      
      const alarm = await SecurityAlarm.getMainAlarm();
      
      // Check if already disarmed
      if (alarm.alarmState === 'disarmed') {
        throw new Error('Alarm is already disarmed');
      }
      
      // If SmartThings integration is configured, send command to SmartThings
      if (alarm.smartthingsDeviceId && smartthingsToken) {
        await this.sendSmartThingsCommand(
          alarm.smartthingsDeviceId,
          'disarm',
          smartthingsToken
        );
      }
      
      // Update local alarm state
      await alarm.disarm(userId);
      
      console.log('SecurityAlarmService: Successfully disarmed alarm');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error disarming alarm:', error.message);
      throw error;
    }
  }

  /**
   * Get alarm status
   * @returns {Promise<Object>} Alarm status information
   */
  async getAlarmStatus() {
    try {
      console.log('SecurityAlarmService: Getting alarm status');
      
      const alarm = await SecurityAlarm.getMainAlarm();
      
      const status = {
        alarmState: alarm.alarmState,
        isArmed: ['armedStay', 'armedAway'].includes(alarm.alarmState),
        isTriggered: alarm.alarmState === 'triggered',
        lastArmed: alarm.lastArmed,
        lastDisarmed: alarm.lastDisarmed,
        lastTriggered: alarm.lastTriggered,
        armedBy: alarm.armedBy,
        disarmedBy: alarm.disarmedBy,
        zoneCount: alarm.zones.length,
        activeZones: alarm.zones.filter(zone => zone.enabled && !zone.bypassed).length,
        bypassedZones: alarm.zones.filter(zone => zone.bypassed).length,
        isOnline: alarm.isOnline,
        batteryLevel: alarm.batteryLevel,
        signalStrength: alarm.signalStrength
      };
      
      console.log('SecurityAlarmService: Successfully retrieved alarm status');
      return status;
    } catch (error) {
      console.error('SecurityAlarmService: Error getting alarm status:', error.message);
      throw new Error('Failed to get alarm status');
    }
  }

  /**
   * Add a security zone
   * @param {Object} zoneData - Zone configuration data
   * @returns {Promise<Object>} Updated alarm system
   */
  async addZone(zoneData) {
    try {
      console.log(`SecurityAlarmService: Adding zone: ${zoneData.name}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.addZone(zoneData);
      
      console.log('SecurityAlarmService: Successfully added zone');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error adding zone:', error.message);
      throw new Error('Failed to add security zone');
    }
  }

  /**
   * Remove a security zone
   * @param {string} deviceId - Device ID of the zone to remove
   * @returns {Promise<Object>} Updated alarm system
   */
  async removeZone(deviceId) {
    try {
      console.log(`SecurityAlarmService: Removing zone: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.removeZone(deviceId);
      
      console.log('SecurityAlarmService: Successfully removed zone');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error removing zone:', error.message);
      throw new Error('Failed to remove security zone');
    }
  }

  /**
   * Bypass or unbypass a security zone
   * @param {string} deviceId - Device ID of the zone
   * @param {boolean} bypass - Whether to bypass the zone
   * @returns {Promise<Object>} Updated alarm system
   */
  async bypassZone(deviceId, bypass = true) {
    try {
      console.log(`SecurityAlarmService: ${bypass ? 'Bypassing' : 'Unbypassing'} zone: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.bypassZone(deviceId, bypass);
      
      console.log('SecurityAlarmService: Successfully updated zone bypass status');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error updating zone bypass:', error.message);
      throw error;
    }
  }

  /**
   * Sync alarm status with SmartThings
   * @param {string} smartthingsToken - SmartThings API token
   * @returns {Promise<Object>} Updated alarm system
   */
  async syncWithSmartThings(smartthingsToken) {
    try {
      console.log('SecurityAlarmService: Syncing with SmartThings');
      
      const alarm = await SecurityAlarm.getMainAlarm();
      
      if (!alarm.smartthingsDeviceId) {
        throw new Error('No SmartThings device ID configured');
      }
      
      // Get device status from SmartThings
      const deviceStatus = await this.getSmartThingsDeviceStatus(
        alarm.smartthingsDeviceId,
        smartthingsToken
      );
      
      // Update local alarm state based on SmartThings status
      if (deviceStatus && deviceStatus.components && deviceStatus.components.main) {
        const securitySystemStatus = deviceStatus.components.main.securitySystem;
        
        if (securitySystemStatus) {
          const smartthingsState = securitySystemStatus.securitySystemStatus.value;
          
          // Map SmartThings states to our alarm states
          let newAlarmState = alarm.alarmState;
          switch (smartthingsState) {
            case 'disarmed':
              newAlarmState = 'disarmed';
              break;
            case 'armedStay':
              newAlarmState = 'armedStay';
              break;
            case 'armedAway':
              newAlarmState = 'armedAway';
              break;
            case 'triggered':
              newAlarmState = 'triggered';
              break;
            default:
              console.warn(`Unknown SmartThings alarm state: ${smartthingsState}`);
          }
          
          if (newAlarmState !== alarm.alarmState) {
            alarm.alarmState = newAlarmState;
            await alarm.save();
          }
        }
        
        alarm.lastSyncWithSmartThings = new Date();
        alarm.isOnline = true;
        await alarm.save();
      }
      
      console.log('SecurityAlarmService: Successfully synced with SmartThings');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error syncing with SmartThings:', error.message);
      
      // Mark as offline if sync fails
      const alarm = await SecurityAlarm.getMainAlarm();
      alarm.isOnline = false;
      await alarm.save();
      
      throw new Error('Failed to sync with SmartThings');
    }
  }

  /**
   * Send command to SmartThings device
   * @param {string} deviceId - SmartThings device ID
   * @param {string} command - Command to send
   * @param {string} token - SmartThings API token
   * @returns {Promise<Object>} SmartThings API response
   */
  async sendSmartThingsCommand(deviceId, command, token) {
    try {
      console.log(`SecurityAlarmService: Sending SmartThings command: ${command} to device: ${deviceId}`);
      
      const url = `${this.smartthingsBaseUrl}/devices/${deviceId}/commands`;
      const payload = {
        commands: [{
          component: 'main',
          capability: 'securitySystem',
          command: command
        }]
      };
      
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      console.log('SecurityAlarmService: Successfully sent SmartThings command');
      return response.data;
    } catch (error) {
      console.error('SecurityAlarmService: Error sending SmartThings command:', error.response?.data || error.message);
      throw new Error('Failed to send command to SmartThings');
    }
  }

  /**
   * Get SmartThings device status
   * @param {string} deviceId - SmartThings device ID
   * @param {string} token - SmartThings API token
   * @returns {Promise<Object>} Device status from SmartThings
   */
  async getSmartThingsDeviceStatus(deviceId, token) {
    try {
      console.log(`SecurityAlarmService: Getting SmartThings device status for: ${deviceId}`);
      
      const url = `${this.smartthingsBaseUrl}/devices/${deviceId}/status`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      console.log('SecurityAlarmService: Successfully retrieved SmartThings device status');
      return response.data;
    } catch (error) {
      console.error('SecurityAlarmService: Error getting SmartThings device status:', error.response?.data || error.message);
      throw new Error('Failed to get device status from SmartThings');
    }
  }

  /**
   * Configure SmartThings integration
   * @param {string} deviceId - SmartThings device ID
   * @returns {Promise<Object>} Updated alarm system
   */
  async configureSmartThingsIntegration(deviceId) {
    try {
      console.log(`SecurityAlarmService: Configuring SmartThings integration with device: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      alarm.smartthingsDeviceId = deviceId;
      await alarm.save();
      
      console.log('SecurityAlarmService: Successfully configured SmartThings integration');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error configuring SmartThings integration:', error.message);
      throw new Error('Failed to configure SmartThings integration');
    }
  }
}

module.exports = new SecurityAlarmService();