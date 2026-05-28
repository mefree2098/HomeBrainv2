const directRadioProtocolCatalogService = require('./directRadioProtocolCatalogService');

const DEFAULT_CHECK_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.HOMEBRAIN_DEVICE_LIBRARY_UPDATE_CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000)
);

class DeviceLibraryUpdateService {
  constructor() {
    this.timer = null;
    this.runningPromise = null;
    this.lastResult = null;
  }

  start(options = {}) {
    if (this.timer) {
      return this.getStatus();
    }

    const checkIntervalMs = Math.max(60 * 1000, Number(options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS));
    this.timer = setInterval(() => {
      void this.tick({ source: 'interval' });
    }, checkIntervalMs);
    this.timer.unref?.();

    if (options.immediate !== false) {
      void this.tick({ source: 'startup' });
    }

    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(options = {}) {
    if (this.runningPromise) {
      return this.runningPromise;
    }

    const status = directRadioProtocolCatalogService.getUpdateStatus();
    if (!options.force && !status.due) {
      this.lastResult = {
        success: true,
        skipped: true,
        reason: 'not_due',
        source: options.source || 'manual',
        nextDueAt: status.nextDueAt,
        status
      };
      return this.lastResult;
    }

    this.runningPromise = directRadioProtocolCatalogService.refreshExternalCatalogs({
      force: options.force === true
    })
      .then((result) => {
        this.lastResult = {
          ...result,
          source: options.source || 'manual'
        };
        return this.lastResult;
      })
      .finally(() => {
        this.runningPromise = null;
      });

    return this.runningPromise;
  }

  getStatus() {
    return {
      running: Boolean(this.runningPromise),
      scheduled: Boolean(this.timer),
      lastResult: this.lastResult,
      catalogUpdate: directRadioProtocolCatalogService.getUpdateStatus()
    };
  }
}

const service = new DeviceLibraryUpdateService();
service.DeviceLibraryUpdateService = DeviceLibraryUpdateService;

module.exports = service;
