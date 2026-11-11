const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const DecoIntegration = require('../models/DecoIntegration');
const { DecoClient, normalizeHost, normalizeMac } = require('./decoClient');

const keyPath = path.resolve(__dirname, '../data/deco/credentials.key');
const MAX_AGE_MS = 180000;

async function encrypt(password) {
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await fs.readFile(keyPath), iv);
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

async function decrypt(value) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', await fs.readFile(keyPath), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

function fresh(config, now = Date.now()) {
  const age = now - new Date(config?.lastSyncAt || 0).getTime();
  return config?.enabled === true && config.connected === true && age >= 0 && age < MAX_AGE_MS;
}

class DecoService {
  constructor({ model = DecoIntegration, clientFactory = (host, password) => new DecoClient(host, password), vault = { encrypt, decrypt } } = {}) {
    this.model = model; this.clientFactory = clientFactory; this.vault = vault;
    this.queue = Promise.resolve(); this.client = null; this.nextAttemptAt = 0; this.scanCursor = 0;
  }

  async serial(operation) {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }

  async getStatus() {
    const config = await this.model.findOne({ key: 'default' }).lean() || { host: '192.168.1.1', enabled: false, configured: false, clients: [], nodes: [] };
    const { secrets, ...publicConfig } = config;
    return { success: true, integration: { ...publicConfig, connected: fresh(config), stale: !fresh(config) } };
  }

  async configure(input) {
    return this.serial(async () => {
      const config = await this.model.findOne({ key: 'default' }).select('+secrets') || new this.model({ key: 'default' });
      const host = normalizeHost(input.host ?? config.host);
      const password = typeof input.password === 'string' ? input.password : '';
      if (password.length > 1024) throw new Error('Deco password is too long');
      if (host !== config.host && !password) throw new Error('Enter the password when changing the Deco address');
      if (password) config.secrets = await this.vault.encrypt(password);
      config.host = host;
      if (typeof input.enabled === 'boolean') config.enabled = input.enabled;
      config.configured = Boolean(config.secrets);
      config.connected = false; config.lastError = ''; config.clients = []; config.nodes = []; config.lastSyncAt = null;
      await config.save();
      this.client = null; this.nextAttemptAt = 0;
      return this.getStatus();
    });
  }

  async sync({ force = false } = {}) {
    return this.serial(async () => {
      const config = await this.model.findOne({ key: 'default' }).select('+secrets');
      if (!config?.enabled || !config.configured) return this.getStatus();
      if (!force && Date.now() < this.nextAttemptAt) return this.getStatus();
      if (!force && fresh(config) && Date.now() - new Date(config.lastSyncAt).getTime() < 60000) return this.getStatus();
      try {
        if (!this.client) this.client = this.clientFactory(config.host, await this.vault.decrypt(config.secrets));
        const snapshot = await this.client.snapshot();
        config.clients = snapshot.clients; config.nodes = snapshot.nodes; config.metadataError = snapshot.metadataError;
        config.connected = true; config.lastSyncAt = new Date(); config.lastError = '';
        this.nextAttemptAt = Date.now() + 60000;
      } catch (error) {
        this.client = null; config.connected = false;
        // Only fixed, sanitized client errors are saved. Never persist transport requests or secrets.
        config.lastError = /^(Deco |Cannot reach Deco)/.test(error.message) ? error.message : 'Deco connection failed; check the address and saved password';
        this.nextAttemptAt = Date.now() + 15 * 60000;
      }
      await config.save();
      return this.getStatus();
    });
  }

  async addressHints(connections = []) {
    // Router polling has its own timer. An unavailable router must never hold up
    // an otherwise healthy AC command while attempting a login or network read.
    const { integration } = await this.getStatus();
    if (!fresh(integration)) return {};
    const online = integration.clients.filter((client) => client.online === true && client.ip);
    const candidates = [...new Set(online.map((client) => client.ip))];
    const rotated = candidates.slice(this.scanCursor).concat(candidates.slice(0, this.scanCursor)).slice(0, 32);
    this.scanCursor = candidates.length ? (this.scanCursor + 32) % candidates.length : 0;
    return Object.fromEntries(connections.map((connection) => {
      const mac = normalizeMac(connection.networkMac);
      const matched = mac ? online.filter((client) => client.mac === mac).map((client) => client.ip) : [];
      return [String(connection.id), [...new Set([...matched, ...rotated])].slice(0, 32)];
    }));
  }

  async confirmedMacs(connections, states) {
    const { integration } = await this.getStatus();
    if (!fresh(integration)) return {};
    const result = {};
    for (const connection of connections || []) {
      if (!states?.some((state) => state.online === true && String(state.id) === String(connection.id))) continue;
      const matches = integration.clients.filter((client) => client.online === true && client.ip === connection.ip);
      if (matches.length === 1) result[String(connection.id)] = matches[0].mac;
    }
    return result;
  }

  async appliancePresence(connections = []) {
    const { integration } = await this.getStatus();
    return connections.map((connection) => {
      const mac = normalizeMac(connection.networkMac);
      const client = mac ? integration.clients.find((entry) => entry.mac === mac) : null;
      return { id: String(connection.id), name: connection.name, mac: mac || null,
        routerOnline: fresh(integration) && client ? client.online : null,
        ip: fresh(integration) && client?.online === true ? client.ip : null,
        checkedAt: integration.lastSyncAt || null, identityConfirmed: Boolean(mac) };
    });
  }

  initialize() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sync().catch(() => {}); }, 60000);
    this.timer.unref();
    this.sync().catch(() => {});
  }

  shutdown() { clearInterval(this.timer); this.timer = null; this.client = null; }
}

module.exports = new DecoService();
module.exports.DecoService = DecoService;
module.exports.fresh = fresh;
