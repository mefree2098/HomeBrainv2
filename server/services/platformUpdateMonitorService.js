const automationSchedulerService = require('./automationSchedulerService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const harmonyService = require('./harmonyService');
const insteonService = require('./insteonService');

class PlatformUpdateMonitorService {
  constructor() {
    this.started = false;
    this.pendingDeviceIds = new Set();
    this.automationDebounceTimer = null;
    this.automationDebounceMs = Math.max(
      100,
      Number(process.env.HOMEBRAIN_DEVICE_UPDATE_AUTOMATION_DEBOUNCE_MS || 250)
    );
    this.handleDeviceUpdate = this.handleDeviceUpdate.bind(this);
  }

  _clearAutomationDebounceTimer() {
    if (this.automationDebounceTimer) {
      clearTimeout(this.automationDebounceTimer);
      this.automationDebounceTimer = null;
    }
  }

  _scheduleAutomationEvaluation() {
    if (!this.started) {
      return;
    }

    this._clearAutomationDebounceTimer();
    this.automationDebounceTimer = setTimeout(() => {
      this.automationDebounceTimer = null;
      this.flushPendingAutomationEvaluation().catch((error) => {
        console.warn(`PlatformUpdateMonitorService: Failed to flush automation evaluation: ${error.message}`);
      });
    }, this.automationDebounceMs);

    if (typeof this.automationDebounceTimer.unref === 'function') {
      this.automationDebounceTimer.unref();
    }
  }

  handleDeviceUpdate(devices = []) {
    if (!Array.isArray(devices) || devices.length === 0) {
      return;
    }

    devices.forEach((device) => {
      const id = device?._id || device?.id || null;
      if (id) {
        this.pendingDeviceIds.add(String(id));
      }
    });

    if (this.pendingDeviceIds.size > 0) {
      this._scheduleAutomationEvaluation();
    }
  }

  async flushPendingAutomationEvaluation() {
    const deviceIds = Array.from(this.pendingDeviceIds);
    this.pendingDeviceIds.clear();

    if (!this.started || deviceIds.length === 0) {
      return;
    }

    await automationSchedulerService.tick({
      source: 'device_update',
      reason: 'realtime-device-update',
      deviceIds
    });
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    deviceUpdateEmitter.on('devices:update', this.handleDeviceUpdate);
    insteonService.startRuntimeMonitoring();
    harmonyService.startBackgroundMonitoring();
  }

  async stop({ disconnectInsteon = false } = {}) {
    this.started = false;
    deviceUpdateEmitter.removeListener('devices:update', this.handleDeviceUpdate);
    this.pendingDeviceIds.clear();
    this._clearAutomationDebounceTimer();
    harmonyService.stopBackgroundMonitoring();

    if (disconnectInsteon) {
      await insteonService.disconnect({ stopRuntimeMonitoring: true });
    } else {
      insteonService.stopRuntimeMonitoring();
    }
  }
}

module.exports = new PlatformUpdateMonitorService();
module.exports.PlatformUpdateMonitorService = PlatformUpdateMonitorService;
