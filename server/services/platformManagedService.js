const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

const PlatformManagedService = require('../models/PlatformManagedService');
const eventStreamService = require('./eventStreamService');

const SERVICE_DEFINITIONS = Object.freeze([
  {
    serviceId: 'caddy',
    displayName: 'Caddy',
    packageName: 'caddy',
    systemdUnit: process.env.CADDY_SERVICE_NAME || 'caddy-api',
    setupCommand: 'setup-caddy',
    updateTarget: 'caddy',
    managementNotes: 'Public HTTP/HTTPS edge and reverse proxy.'
  },
  {
    serviceId: 'mqtt',
    displayName: 'Mosquitto MQTT',
    packageName: 'mosquitto',
    systemdUnit: process.env.HOMEBRAIN_MQTT_SERVICE_NAME || 'homebrain-mqtt',
    setupCommand: 'setup-mqtt',
    updateTarget: 'mqtt',
    managementNotes: 'Local platform event and device-state bus.'
  },
  {
    serviceId: 'pihole',
    displayName: 'Pi-hole',
    packageName: 'pihole',
    systemdUnit: 'pihole-FTL',
    setupCommand: 'setup-pihole',
    updateTarget: 'pihole',
    managementNotes: 'Managed DNS sinkhole and network filtering service.'
  }
]);

const DEFINITIONS_BY_ID = new Map(SERVICE_DEFINITIONS.map((definition) => [definition.serviceId, definition]));
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return {};
  }

  const firstJsonLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!firstJsonLine) {
    return {};
  }

  return JSON.parse(firstJsonLine);
}

class PlatformManagedServiceManager {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.spawnProcess = options.spawnProcess || spawn;
    this.checkIntervalMs = Math.max(
      60_000,
      Number(options.checkIntervalMs || process.env.HOMEBRAIN_PLATFORM_SERVICE_MONITOR_MS || DEFAULT_CHECK_INTERVAL_MS)
    );
    this.timer = null;
    this.started = false;
  }

  getDefinitions() {
    return SERVICE_DEFINITIONS.map((definition) => ({ ...definition }));
  }

  getSetupServicesPath() {
    return path.join(this.projectRoot, 'scripts', 'setup-services.sh');
  }

  isDatabaseReady() {
    return mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);
  }

  async runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        cwd: options.cwd || this.projectRoot,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (code) => {
        const result = {
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        };
        if (code === 0) {
          resolve(result);
          return;
        }
        const error = new Error(result.stderr || result.stdout || `Command exited with code ${code}`);
        error.code = code;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        reject(error);
      });
    });
  }

  async runSetupCommand(commandName, target = null) {
    const setupServicesPath = this.getSetupServicesPath();
    if (!fs.existsSync(setupServicesPath)) {
      throw new Error('scripts/setup-services.sh is missing');
    }

    const bashPath = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    const args = ['-n', bashPath, setupServicesPath, commandName];
    if (target) {
      args.push(target);
    }
    return this.runCommand('sudo', args);
  }

  async getOrCreateRecord(definition) {
    let record = await PlatformManagedService.findOne({ serviceId: definition.serviceId });
    if (!record) {
      record = await PlatformManagedService.create({
        serviceId: definition.serviceId,
        displayName: definition.displayName,
        packageName: definition.packageName
      });
    }
    return record;
  }

  normalizeRecord(record, definition, runtime = {}) {
    const doc = typeof record?.toObject === 'function' ? record.toObject() : record;
    const policy = doc?.policy || {};
    const updateAvailable = Boolean(doc?.updateAvailable);
    const eligibleAt = doc?.eligibleForAutoUpdateAt ? new Date(doc.eligibleForAutoUpdateAt).toISOString() : null;
    const autoUpdateEligible = updateAvailable
      && Boolean(policy.autoUpdateEnabled)
      && doc?.eligibleForAutoUpdateAt
      && new Date(doc.eligibleForAutoUpdateAt).getTime() <= Date.now();

    return {
      serviceId: definition.serviceId,
      displayName: definition.displayName,
      packageName: definition.packageName,
      systemdUnit: definition.systemdUnit,
      managementNotes: definition.managementNotes,
      installed: Boolean(runtime.installed),
      active: Boolean(runtime.active),
      currentVersion: doc?.currentVersion || runtime.currentVersion || '',
      latestVersion: doc?.latestVersion || '',
      updateAvailable,
      candidateFirstSeenAt: doc?.candidateFirstSeenAt ? new Date(doc.candidateFirstSeenAt).toISOString() : null,
      eligibleForAutoUpdateAt: eligibleAt,
      autoUpdateEligible: Boolean(autoUpdateEligible),
      lastCheckedAt: doc?.lastCheckedAt ? new Date(doc.lastCheckedAt).toISOString() : null,
      lastUpdatedAt: doc?.lastUpdatedAt ? new Date(doc.lastUpdatedAt).toISOString() : null,
      lastUpdateStatus: doc?.lastUpdateStatus || 'never',
      lastError: doc?.lastError || runtime.error || '',
      policy: {
        autoCheckEnabled: policy.autoCheckEnabled !== false,
        autoUpdateEnabled: policy.autoUpdateEnabled === true,
        checkIntervalDays: clampInteger(policy.checkIntervalDays, 7, 1, 90),
        stabilityDelayDays: clampInteger(policy.stabilityDelayDays, 30, 0, 365)
      }
    };
  }

  async getRuntimeStatus(definition) {
    const installed = await this.runCommand('bash', ['-lc', `command -v ${definition.serviceId === 'pihole' ? 'pihole' : definition.packageName}`])
      .then(() => true)
      .catch(() => false);
    const active = await this.runCommand('systemctl', ['is-active', '--quiet', definition.systemdUnit])
      .then(() => true)
      .catch(() => false);

    let currentVersion = '';
    try {
      if (definition.serviceId === 'caddy') {
        currentVersion = (await this.runCommand('bash', ['-lc', 'caddy version 2>/dev/null || true'])).stdout;
      } else if (definition.serviceId === 'mqtt') {
        currentVersion = (await this.runCommand('bash', ['-lc', "mosquitto -h 2>&1 | awk 'NR==1 {print}'"])).stdout;
      } else if (definition.serviceId === 'pihole') {
        currentVersion = (await this.runCommand('bash', ['-lc', "pihole version 2>/dev/null | tr '\\n' ' ' | sed 's/[[:space:]]\\+/ /g' || true"])).stdout;
      }
    } catch (error) {
      currentVersion = '';
    }

    return {
      installed,
      active,
      currentVersion
    };
  }

  async listServices() {
    if (!this.isDatabaseReady()) {
      return Promise.all(SERVICE_DEFINITIONS.map(async (definition) => (
        this.normalizeRecord(null, definition, await this.getRuntimeStatus(definition))
      )));
    }

    const services = [];
    for (const definition of SERVICE_DEFINITIONS) {
      const [record, runtime] = await Promise.all([
        this.getOrCreateRecord(definition),
        this.getRuntimeStatus(definition)
      ]);
      services.push(this.normalizeRecord(record, definition, runtime));
    }
    return services;
  }

  async checkForUpdates(serviceId, { actor = 'system' } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    const checkedAt = new Date();
    const record = await this.getOrCreateRecord(definition);
    let updateInfo;

    try {
      const result = await this.runSetupCommand('check-platform-service-updates', definition.updateTarget);
      updateInfo = parseJsonOutput(result.stdout);
    } catch (error) {
      record.lastCheckedAt = checkedAt;
      record.lastError = error.message || 'Update check failed';
      await record.save();
      throw error;
    }

    const nextLatest = String(updateInfo.latestVersion || '').trim();
    const nextCurrent = String(updateInfo.currentVersion || '').trim();
    const updateAvailable = updateInfo.updateAvailable === true;
    const existingLatest = record.latestVersion || '';
    const firstSeenAt = updateAvailable
      ? (existingLatest === nextLatest && record.candidateFirstSeenAt ? record.candidateFirstSeenAt : checkedAt)
      : null;
    const stabilityDelayDays = clampInteger(record.policy?.stabilityDelayDays, 30, 0, 365);

    record.currentVersion = nextCurrent || record.currentVersion || '';
    record.latestVersion = nextLatest || '';
    record.updateAvailable = updateAvailable;
    record.candidateFirstSeenAt = firstSeenAt;
    record.eligibleForAutoUpdateAt = updateAvailable && firstSeenAt ? addDays(firstSeenAt, stabilityDelayDays) : null;
    record.lastCheckedAt = checkedAt;
    record.lastError = '';
    await record.save();

    void eventStreamService.publishSafe({
      type: 'platform_service.update_checked',
      source: 'platform_services',
      category: 'platform',
      payload: {
        serviceId,
        actor,
        currentVersion: record.currentVersion,
        latestVersion: record.latestVersion,
        updateAvailable: record.updateAvailable,
        eligibleForAutoUpdateAt: record.eligibleForAutoUpdateAt
      },
      tags: ['platform-services', serviceId]
    });

    return this.normalizeRecord(record, definition, await this.getRuntimeStatus(definition));
  }

  async installService(serviceId, { actor = 'system' } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    try {
      await this.runSetupCommand(definition.setupCommand);
    } catch (error) {
      const record = await this.getOrCreateRecord(definition);
      record.lastUpdateStatus = 'failed';
      record.lastError = error.message || 'Install failed';
      await record.save();
      throw error;
    }

    void eventStreamService.publishSafe({
      type: 'platform_service.installed',
      source: 'platform_services',
      category: 'platform',
      payload: { serviceId, actor },
      tags: ['platform-services', serviceId]
    });
    return this.checkForUpdates(serviceId, { actor });
  }

  async updateService(serviceId, { actor = 'system', automatic = false } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    const record = await this.getOrCreateRecord(definition);
    try {
      await this.runSetupCommand('update-platform-service', definition.updateTarget);
    } catch (error) {
      record.lastUpdatedAt = new Date();
      record.lastUpdateStatus = 'failed';
      record.lastError = error.message || 'Update failed';
      await record.save();
      throw error;
    }

    record.lastUpdatedAt = new Date();
    record.lastUpdateStatus = 'success';
    record.updateAvailable = false;
    record.candidateFirstSeenAt = null;
    record.eligibleForAutoUpdateAt = null;
    record.lastError = '';
    await record.save();

    void eventStreamService.publishSafe({
      type: automatic ? 'platform_service.auto_updated' : 'platform_service.updated',
      source: 'platform_services',
      category: 'platform',
      payload: { serviceId, actor },
      tags: ['platform-services', serviceId, automatic ? 'auto-update' : 'manual-update']
    });

    return this.checkForUpdates(serviceId, { actor });
  }

  async updatePolicy(serviceId, policyPatch = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    const record = await this.getOrCreateRecord(definition);
    record.policy = {
      autoCheckEnabled: typeof policyPatch.autoCheckEnabled === 'boolean'
        ? policyPatch.autoCheckEnabled
        : record.policy?.autoCheckEnabled !== false,
      autoUpdateEnabled: typeof policyPatch.autoUpdateEnabled === 'boolean'
        ? policyPatch.autoUpdateEnabled
        : record.policy?.autoUpdateEnabled === true,
      checkIntervalDays: clampInteger(policyPatch.checkIntervalDays, record.policy?.checkIntervalDays || 7, 1, 90),
      stabilityDelayDays: clampInteger(policyPatch.stabilityDelayDays, record.policy?.stabilityDelayDays || 30, 0, 365)
    };
    if (record.updateAvailable && record.candidateFirstSeenAt) {
      record.eligibleForAutoUpdateAt = addDays(record.candidateFirstSeenAt, record.policy.stabilityDelayDays);
    }
    await record.save();
    return this.normalizeRecord(record, definition, await this.getRuntimeStatus(definition));
  }

  isDueForCheck(service) {
    if (!service.policy.autoCheckEnabled) {
      return false;
    }
    if (!service.lastCheckedAt) {
      return true;
    }
    const lastChecked = Date.parse(service.lastCheckedAt);
    if (!Number.isFinite(lastChecked)) {
      return true;
    }
    return Date.now() - lastChecked >= service.policy.checkIntervalDays * 24 * 60 * 60 * 1000;
  }

  async runPolicyPass({ actor = 'system:platform-service-monitor' } = {}) {
    if (!this.isDatabaseReady()) {
      return { checked: [], updated: [], skipped: true, reason: 'database-not-ready' };
    }

    const checked = [];
    const updated = [];
    const services = await this.listServices();

    for (const service of services) {
      try {
        let latest = service;
        if (this.isDueForCheck(service)) {
          latest = await this.checkForUpdates(service.serviceId, { actor });
          checked.push(service.serviceId);
        }
        if (latest.autoUpdateEligible) {
          await this.updateService(service.serviceId, { actor, automatic: true });
          updated.push(service.serviceId);
        }
      } catch (error) {
        console.warn(`PlatformManagedServiceManager: ${service.serviceId} policy action failed: ${error.message}`);
      }
    }

    return { checked, updated, skipped: false };
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {
      this.runPolicyPass().catch((error) => {
        console.warn(`PlatformManagedServiceManager: policy pass failed: ${error.message}`);
      });
    }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = new PlatformManagedServiceManager();
module.exports.PlatformManagedServiceManager = PlatformManagedServiceManager;
module.exports.SERVICE_DEFINITIONS = SERVICE_DEFINITIONS;
