const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const ApplianceIntegration = require('../models/ApplianceIntegration');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const notificationService = require('./notificationService');
const { ApplianceWorker, ensureRuntime } = require('./applianceWorkerService');

const PROVIDERS = ['midea', 'econet'];
const keyPath = path.resolve(__dirname, '../data/appliances/credentials.key');
const normalizeAction = (action) => String(action || '').toLowerCase().replace(/[^a-z]/g, '');

function validateProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown appliance integration');
  return provider;
}

function validateLocalIp(ip) {
  if (!ip) return '';
  if (!net.isIPv4(ip)) throw new Error('Enter the appliance’s local IPv4 address');
  const [a, b] = ip.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error('Appliance discovery requires a private LAN address');
  }
  return ip;
}

async function credentialKey() {
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFile(keyPath);
}

async function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

async function decrypt(value) {
  if (!value) return {};
  // Do not generate a replacement key when restoring a database without its key.
  const key = await fs.readFile(keyPath);
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}

function stateUpdate(provider, state, previous = {}) {
  const prior = previous.properties || {};
  const update = { isOnline: state.online === true, 'properties.appliance.lastError': state.error || '' };
  if (!state.online) return update;
  const capabilities = state.capabilities || prior.appliance?.capabilities || {};
  update.lastSeen = new Date();
  if (typeof state.power === 'boolean') update.status = state.power;
  if (Number.isFinite(state.temperature)) update.temperature = state.temperature;
  if (Number.isFinite(state.targetTemperature)) update.targetTemperature = state.targetTemperature;
  update['properties.source'] = provider;
  update['properties.applianceId'] = String(state.id);
  update['properties.appliance'] = { ...state, observedAt: new Date().toISOString(), capabilities, lastError: '' };
  update['properties.hvacMode'] = state.mode;
  update['properties.lastActiveHvacMode'] = state.lastActiveMode || prior.lastActiveHvacMode;
  update['properties.supportedThermostatModes'] = capabilities.modes || [];
  update['properties.temperatureUnit'] = 'F';
  delete update['properties.appliance.lastError'];
  return update;
}

class ApplianceService {
  constructor() {
    this.workers = new Map(); this.queues = new Map(); this.discovered = new Map();
    this.failures = new Map(); this.timer = null; this.polling = false;
  }

  async serial(provider, operation) {
    validateProvider(provider);
    const prior = this.queues.get(provider) || Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    this.queues.set(provider, pending);
    try { return await pending; }
    finally { if (this.queues.get(provider) === pending) this.queues.delete(provider); }
  }

  async integration(provider) {
    return ApplianceIntegration.findOne({ provider }).select('+secrets');
  }

  async worker(provider, integration, { allowDisabled = false } = {}) {
    if (!allowDisabled && !integration?.enabled) throw new Error('Enable this appliance integration in Settings');
    let worker = this.workers.get(provider);
    if (!worker?.child) {
      worker = new ApplianceWorker();
      this.workers.set(provider, worker);
      const secrets = await decrypt(integration?.secrets);
      await worker.start({ provider, email: integration?.email || '', ...secrets });
    }
    return worker;
  }

  reset(provider) { this.workers.get(provider)?.stop(); this.workers.delete(provider); }

  async getStatus(provider) {
    validateProvider(provider);
    const integration = await ApplianceIntegration.findOne({ provider }).lean();
    const devices = await Device.find({ 'properties.source': provider }).lean();
    return { success: true, integration: integration || { provider, enabled: false, configured: false, connected: false, connections: [] }, devices: deviceUpdateEmitter.normalizeDevices(devices) };
  }

  async configure(provider, input) {
    return this.serial(provider, async () => {
      let integration = await this.integration(provider);
      if (!integration) integration = new ApplianceIntegration({ provider });
      const secrets = await decrypt(integration.secrets);
      if (provider === 'econet') {
        if (typeof input.email === 'string') integration.email = input.email.trim();
        if (typeof input.password === 'string' && input.password) secrets.password = input.password;
        integration.configured = Boolean(integration.email && secrets.password);
      }
      if (typeof input.enabled === 'boolean') integration.enabled = input.enabled;
      if (typeof input.room === 'string' && input.room.trim()) integration.room = input.room.trim().slice(0, 100);
      integration.secrets = await encrypt(secrets);
      integration.connected = false;
      integration.lastError = '';
      await integration.save();
      this.reset(provider);
      if (!integration.enabled) {
        await Device.updateMany({ 'properties.source': provider }, { isOnline: false, 'properties.appliance.lastError': 'Integration disabled' });
        const devices = await Device.find({ 'properties.source': provider }).lean();
        deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevices(devices));
      }
      return this.getStatus(provider);
    });
  }

  async discover(input = {}) {
    const ip = validateLocalIp(String(input.ip || '').trim());
    return this.serial('midea', async () => {
      const integration = await this.integration('midea');
      const worker = await this.worker('midea', integration, { allowDisabled: true });
      const result = await worker.request({ op: 'discover', ip });
      this.discovered.clear();
      for (const d of result.discovered) this.discovered.set(String(d.state.id), d);
      return { success: true, devices: result.discovered.map((d) => d.state) };
    });
  }

  async pair(input) {
    return this.serial('midea', async () => {
      const found = this.discovered.get(String(input.id));
      if (!found) throw new Error('Discover the AC again before pairing');
      let integration = await this.integration('midea');
      if (!integration) integration = new ApplianceIntegration({ provider: 'midea' });
      const secrets = await decrypt(integration.secrets);
      const connection = found.connection;
      secrets.devices = [...(secrets.devices || []).filter((d) => String(d.id) !== String(input.id)), connection];
      integration.connections = [...integration.connections.filter((d) => String(d.id) !== String(input.id)), {
        id: String(input.id), ip: connection.ip, name: String(input.name || 'Air Conditioner').trim().slice(0, 100), room: String(input.room || 'Theater').trim().slice(0, 100)
      }];
      integration.secrets = await encrypt(secrets);
      integration.configured = true;
      integration.enabled = true;
      await integration.save();
      this.reset('midea');
      await this.persistStates('midea', [found.state], integration);
      return this.getStatus('midea');
    });
  }

  async persistStates(provider, states, integration) {
    const updated = [];
    for (const state of states) {
      const identity = { 'properties.source': provider, 'properties.applianceId': String(state.id) };
      const previous = await Device.findOne(identity).lean();
      const connection = integration.connections?.find((d) => String(d.id) === String(state.id));
      if (!previous && !state.online) continue;
      const failureKey = provider + ':' + state.id;
      const failures = state.online ? 0 : (this.failures.get(failureKey) || 0) + 1;
      this.failures.set(failureKey, failures);
      if (!state.online && failures < 2 && previous?.isOnline) continue;
      const defaults = {
        name: connection?.name || state.name || 'Rheem Water Heater',
        room: connection?.room || integration.room || (provider === 'midea' ? 'Theater' : 'Utility'),
        type: provider === 'midea' ? 'thermostat' : 'water_heater'
      };
      const changes = stateUpdate(provider, state, previous || {});
      if (connection) { changes.name = connection.name; changes.room = connection.room; }
      const onInsert = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in changes)));
      const device = await Device.findOneAndUpdate(identity, { $set: changes, $setOnInsert: onInsert }, { upsert: true, returnDocument: 'after', runValidators: true });
      updated.push(device);
      const alert = state.online === false ? 'offline' : (state.errorCode ? `error ${state.errorCode}` : (state.alertCount > 0 ? `${state.alertCount} active heater alert(s)` : (state.filterAlert ? 'filter maintenance reminder' : '')));
      const old = previous?.properties?.appliance || {};
      const oldAlert = previous?.isOnline === false ? 'offline' : (old.errorCode ? `error ${old.errorCode}` : (old.alertCount > 0 ? `${old.alertCount} active heater alert(s)` : (old.filterAlert ? 'filter maintenance reminder' : '')));
      if (alert && alert !== oldAlert) {
        await notificationService.createSystemNotification({
          channel: 'normal', severity: 'warning', category: 'device', source: provider,
          eventType: 'appliance.alert', eventKey: `${provider}:${state.id}:${alert}:${new Date().toISOString().slice(0, 10)}`,
          deviceId: String(device._id), title: `${device.name}: ${alert}`,
          message: alert === 'offline' ? 'HomeBrain cannot reach this appliance. Check its Wi-Fi connection.' : (provider === 'econet' ? 'Open EcoNet for the active alert details and service instructions.' : 'Check the AC display or manufacturer app for details.'),
        });
      }
    }
    if (updated.length) deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevices(updated));
    return updated;
  }

  async sync(provider) {
    return this.serial(provider, async () => {
      const integration = await this.integration(provider);
      const worker = await this.worker(provider, integration);
      try {
        const result = await worker.request({ op: 'poll' });
        // DHCP recovery returns private connection data only to this service.
        if (result.connections?.length) {
          const secrets = await decrypt(integration.secrets);
          secrets.devices = result.connections;
          integration.secrets = await encrypt(secrets);
          for (const connection of integration.connections) {
            const found = result.connections.find((d) => String(d.id) === String(connection.id));
            if (found) connection.ip = found.ip;
          }
          await integration.save();
        }
        const devices = await this.persistStates(provider, result.devices, integration);
        const online = devices.some((d) => d.isOnline);
        await ApplianceIntegration.updateOne({ provider }, { connected: online, lastSyncAt: new Date(), lastError: online ? '' : 'No appliance is currently reachable' });
        return this.getStatus(provider);
      } catch (error) {
        const devices = await Device.find({ 'properties.source': provider }).lean();
        await this.persistStates(provider, devices.map((d) => ({ id: d.properties.applianceId, online: false, error: error.message })), integration);
        await ApplianceIntegration.updateOne({ provider }, { connected: false, lastError: error.message });
        throw error;
      }
    });
  }

  async controlDevice(device, action, value) {
    const provider = device.properties.source;
    if (provider !== 'midea') throw new Error('This water heater integration is for monitoring');
    return this.serial(provider, async () => {
      const integration = await this.integration(provider);
      const worker = await this.worker(provider, integration);
      try {
        const result = await worker.request({ op: 'command', id: String(device.properties.applianceId), action: normalizeAction(action), value });
        const [updated] = await this.persistStates(provider, result.devices, integration);
        return updated;
      } catch (error) {
        await Device.updateOne({ _id: device._id }, { 'properties.appliance.lastError': error.message });
        throw error;
      }
    });
  }

  async initialize() {
    if (this.timer) return;
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const enabled = await ApplianceIntegration.find({ enabled: true, configured: true }).select('provider').lean();
        await Promise.allSettled(enabled.map(({ provider }) => this.sync(provider)));
      } finally { this.polling = false; }
    };
    this.timer = setInterval(() => { tick().catch(() => {}); }, 60000);
    this.timer.unref();
    tick().catch(() => {});
  }

  shutdown() { clearInterval(this.timer); this.timer = null; for (const provider of PROVIDERS) this.reset(provider); }
}

module.exports = new ApplianceService();
module.exports.ApplianceService = ApplianceService;
module.exports.ensureRuntime = ensureRuntime;
module.exports._test = { stateUpdate, validateLocalIp, encrypt, decrypt };
