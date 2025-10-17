const SecurityAlarm = require('../models/SecurityAlarm');
const smartThingsService = require('./smartThingsService');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');

const STATUS_STALE_THRESHOLD_MS = Number(process.env.SECURITY_ALARM_STATUS_STALE_MS || 60000);
const ONLINE_GRACE_PERIOD_MS = Number(process.env.SECURITY_ALARM_ONLINE_GRACE_MS || 120000);

class SecurityAlarmService {
  constructor() {
    this.smartthingsBaseUrl = 'https://api.smartthings.com/v1';
  }

  /**
   * Check if SmartThings STHM is properly configured for security operations
   * @returns {Promise<boolean>} True if STHM is configured and connected
   */
  async isSmartThingsConfiguredForSthm() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();

      return !!(integration.isConfigured && integration.isConnected);
    } catch (error) {
      console.error('SecurityAlarmService: Error checking SmartThings configuration:', error.message);
      return false;
    }
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
   * @returns {Promise<Object>} Updated alarm system
   */
  async armAlarm(mode, userId) {
    try {
      console.log(`SecurityAlarmService: Arming alarm in ${mode} mode`);

      const alarm = await SecurityAlarm.getMainAlarm();

      // Check if already armed
      if (alarm.alarmState === 'armedStay' || alarm.alarmState === 'armedAway') {
        throw new Error('Alarm is already armed');
      }

      // Send command to SmartThings if properly configured
      const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
      if (isSthmConfigured) {
        try {
          const targetState = mode === 'stay' ? 'ArmedStay' : 'ArmedAway';
          await smartThingsService.setSecurityArmState(targetState);
          console.log('SecurityAlarmService: SmartThings command sent successfully');
        } catch (smartThingsError) {
          console.warn('SecurityAlarmService: SmartThings command failed, continuing with local arming:', smartThingsError.message);
          // Continue with local arming even if SmartThings fails
        }
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
   * @returns {Promise<Object>} Updated alarm system
   */
  async disarmAlarm(userId) {
    try {
      console.log('SecurityAlarmService: Disarming alarm');

      const alarm = await SecurityAlarm.getMainAlarm();

      // Check if already disarmed
      if (alarm.alarmState === 'disarmed') {
        throw new Error('Alarm is already disarmed');
      }

      // Send command to SmartThings if properly configured
      const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
      if (isSthmConfigured) {
        try {
          await smartThingsService.setSecurityArmState('Disarmed');
          console.log('SecurityAlarmService: SmartThings disarm command sent successfully');
        } catch (smartThingsError) {
          console.warn('SecurityAlarmService: SmartThings command failed, continuing with local disarming:', smartThingsError.message);
          // Continue with local disarming even if SmartThings fails
        }
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

      let alarm = await SecurityAlarm.getMainAlarm();
      const now = Date.now();
      const lastSyncTimestamp = alarm.lastSyncWithSmartThings ? new Date(alarm.lastSyncWithSmartThings).getTime() : 0;
      const timeSinceLastSync = lastSyncTimestamp ? now - lastSyncTimestamp : Number.POSITIVE_INFINITY;

      const isSmartThingsConfigured = await this.isSmartThingsConfiguredForSthm();
      const shouldAttemptSync = isSmartThingsConfigured && (timeSinceLastSync > STATUS_STALE_THRESHOLD_MS || !alarm.isOnline);

      if (shouldAttemptSync) {
        try {
          alarm = await this.syncWithSmartThings();
        } catch (syncError) {
          console.warn('SecurityAlarmService: SmartThings sync during status lookup failed:', syncError.message);
          alarm = await SecurityAlarm.getMainAlarm();
        }
      }

      const updatedLastSyncTimestamp = alarm.lastSyncWithSmartThings ? new Date(alarm.lastSyncWithSmartThings).getTime() : 0;
      const updatedTimeSinceSync = updatedLastSyncTimestamp ? now - updatedLastSyncTimestamp : Number.POSITIVE_INFINITY;
      const computedIsOnline = Boolean(alarm.isOnline) || updatedTimeSinceSync <= ONLINE_GRACE_PERIOD_MS;

      if (computedIsOnline !== alarm.isOnline) {
        alarm.isOnline = computedIsOnline;
        await alarm.save();
      }

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
        isOnline: computedIsOnline,
        lastSyncWithSmartThings: alarm.lastSyncWithSmartThings,
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
   * @returns {Promise<Object>} Updated alarm system
   */
  async syncWithSmartThings() {
    try {
      console.log('SecurityAlarmService: Syncing with SmartThings');

      const alarm = await SecurityAlarm.getMainAlarm();

      let synced = false;

      if (await this.isSmartThingsConfiguredForSthm()) {
        try {
          const securityState = await smartThingsService.getSecurityArmState();
          if (securityState?.armState) {
            const mappedState = this.mapSmartThingsArmState(securityState.armState);
            if (mappedState && mappedState !== alarm.alarmState) {
              alarm.alarmState = mappedState;
            }
            if (securityState.deviceId && alarm.smartthingsDeviceId !== securityState.deviceId) {
              console.log(`SecurityAlarmService: Tracking SmartThings security device ${securityState.deviceId}`);
              alarm.smartthingsDeviceId = securityState.deviceId;
            }
            alarm.lastSyncWithSmartThings = new Date();
            alarm.isOnline = true;
            await alarm.save();
            synced = true;
          }
        } catch (securityError) {
          console.warn('SecurityAlarmService: Unable to sync via SmartThings security endpoint:', securityError.message);
        }
      }

      if (!synced) {
        if (!alarm.smartthingsDeviceId) {
          console.warn('SecurityAlarmService: No SmartThings device ID configured; unable to sync via device status');
        } else {
        const deviceStatus = await smartThingsService.getDeviceStatus(alarm.smartthingsDeviceId);

        if (deviceStatus?.components?.main?.securitySystem) {
          const smartthingsState = deviceStatus.components.main.securitySystem.securitySystemStatus.value;
          const mappedState = this.mapSmartThingsArmState(smartthingsState);

          if (mappedState && mappedState !== alarm.alarmState) {
            alarm.alarmState = mappedState;
          }

          alarm.lastSyncWithSmartThings = new Date();
          alarm.isOnline = true;
          await alarm.save();
          synced = true;
        }
      }
      }

      if (!synced) {
        console.warn('SecurityAlarmService: SmartThings did not provide security state; keeping local state');
        alarm.isOnline = false;
        alarm.lastSyncWithSmartThings = new Date();
        await alarm.save();
      } else {
        alarm.isOnline = true;
        await alarm.save();
      }

      console.log('SecurityAlarmService: SmartThings sync complete');
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

  mapSmartThingsArmState(armState) {
    if (!armState) {
      return null;
    }

    switch (armState.toLowerCase()) {
      case 'disarmed':
      case 'disarm':
        return 'disarmed';
      case 'armedstay':
      case 'stay':
      case 'armed_stay':
        return 'armedStay';
      case 'armedaway':
      case 'away':
      case 'armed_away':
        return 'armedAway';
      case 'triggered':
        return 'triggered';
      default:
        console.warn(`SecurityAlarmService: Unknown SmartThings arm state received: ${armState}`);
        return null;
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
