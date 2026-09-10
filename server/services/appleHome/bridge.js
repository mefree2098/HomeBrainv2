'use strict';
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BlockList, isIP } = require('node:net');
const { catalog, assignBridges, digest, id } = require('./catalog');
const { hasPlatformAccess } = require('../../utils/userPlatforms');
const problem = (status, message) => Object.assign(new Error(message), { status });

function assertOwner(user) {
  if (!user || user.isActive !== true || user.isReadOnly || user.isReviewSandbox || user.role !== 'admin'
      || !hasPlatformAccess(user, 'homebrain')) throw problem(403, 'Apple Home requires an active HomeBrain administrator with control access.');
  return user;
}
function lanInterfaces(interfaces = os.networkInterfaces(), requested = process.env.HOMEBRAIN_HOMEKIT_INTERFACE) {
  const privateIPs = new BlockList();
  privateIPs.addSubnet('10.0.0.0', 8); privateIPs.addSubnet('172.16.0.0', 12); privateIPs.addSubnet('192.168.0.0', 16);
  privateIPs.addSubnet('169.254.0.0', 16); privateIPs.addSubnet('fc00::', 7, 'ipv6'); privateIPs.addSubnet('fe80::', 10, 'ipv6');
  const eligible = Object.entries(interfaces).filter(([, records]) => (records || []).some((record) => {
    const address = String(record.address || '').split('%')[0];
    const family = isIP(address);
    return !record.internal && family && privateIPs.check(address, family === 6 ? 'ipv6' : 'ipv4');
  })).map(([name]) => name);
  if (requested) {
    if (!eligible.includes(requested)) throw problem(503, 'The configured Apple Home LAN interface is unavailable.');
    return [requested];
  }
  if (!eligible.length) throw problem(503, 'Apple Home needs a LAN-connected HomeBrain host. No private LAN interface was found.');
  return eligible;
}

class AppleHomeBridge {
  constructor({ storage, load, getUser, readDevice, controlDevice, runTarget, commandStatus, events, audit = async () => {},
    supportsBrightness, loadHap = () => require('@homebridge/hap-nodejs'), interfaces = lanInterfaces }) {
    Object.assign(this, { storage, load, getUser, readDevice, controlDevice, runTarget, commandStatus, events, audit, supportsBrightness, loadHap, interfaces });
    this.bridges = new Map(); this.accessories = new Map(); this.operations = new Map();
    this.targets = []; this.skipped = []; this.lastError = ''; this.lastSync = null; this.config = null;
    this.queue = Promise.resolve(); this.initializing = null; this.interval = null; this.updateTimer = null;
    this.onDeviceUpdate = () => {
      if (!this.config?.enabled || this.updateTimer) return;
      this.updateTimer = setTimeout(() => { this.updateTimer = null; void this.refresh().catch(() => {}); }, 750);
      this.updateTimer.unref?.();
    };
  }
  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  initialize() {
    if (!this.initializing) this.initializing = this.serial(async () => {
      this.config = await this.storage.read();
      this.events?.on('devices:update', this.onDeviceUpdate);
      this.interval = setInterval(() => { void this.refresh().catch(() => {}); }, 30_000);
      this.interval.unref?.();
      if (this.config?.enabled) await this.reconcile();
    }).catch(async (error) => { this.lastError = this.safeError(error); this.initializationError = error; await this.stopPublishing(); });
    return this.initializing;
  }
  safeError(error) {
    return error?.status ? error.message : 'Apple Home bridge could not complete its operation. Check the hub LAN, dependency installation, storage permissions, and logs.';
  }
  async configure(user, input) {
    assertOwner(user);
    if (!input || typeof input.enabled !== 'boolean') throw problem(400, 'enabled must be true or false.');
    if (input.enabled && input.confirm !== 'SHARE WITH APPLE HOME') throw problem(400, 'Confirm sharing control with your Apple Home members.');
    await this.initialize();
    if (this.initializationError && !this.config) throw problem(503, 'Apple Home pairing storage could not be loaded. Do not replace or delete it; check hub logs.');
    return this.serial(async () => {
      const config = this.config || this.storage.create(id(user));
      if (input.enabled && config.ownerId !== id(user)) throw problem(409, 'This bridge belongs to another administrator. Disable it and have the existing owner manage the connection.');
      this.config = { ...config, enabled: input.enabled };
      await this.storage.write(this.config);
      try { if (input.enabled) await this.reconcile(); else await this.stopPublishing(); }
      catch (error) { this.lastError = this.safeError(error); await this.stopPublishing(); throw error; }
      await this.audit({ type: 'apple_home.configured', payload: { enabled: input.enabled, actor: id(user) } }).catch(() => {});
      return this.status(user);
    });
  }
  async refresh() {
    await this.initialize();
    return this.serial(async () => {
      if (!this.config?.enabled) return;
      try { await this.reconcile(); }
      catch (error) {
        this.lastError = this.safeError(error);
        // A disabled/deleted owner or failed catalog must never keep stale control endpoints live.
        await this.stopPublishing();
        throw error;
      }
    });
  }
  async owner() { return assertOwner(await this.getUser(this.config?.ownerId)); }
  async reconcile() {
    await this.owner();
    const input = await this.load();
    const next = catalog(input, this.config.namespace, this.supportsBrightness);
    const assignments = assignBridges(next.targets, this.config.assignments);
    const highestShard = Math.max(this.config.highestShard || 0, 0, ...Object.values(assignments));
    if (JSON.stringify(assignments) !== JSON.stringify(this.config.assignments) || this.config.highestShard !== highestShard) {
      this.config.assignments = assignments; this.config.highestShard = highestShard;
      await this.storage.write(this.config);
    }
    if (!this.hap) this.hap = this.loadHap();
    await this.storage.acquire();
    if (!this.storageConfigured) {
      this.hap.HAPStorage.setCustomStoragePath(path.join(this.storage.directory, 'hap'));
      this.storageConfigured = true;
    }
    const binding = this.interfaces();
    const shards = new Set(Array.from({ length: highestShard + 1 }, (_, index) => index));
    // Keep previously paired empty shards alive: do not invalidate pairings as accessories change.
    for (const shard of this.bridges.keys()) shards.add(shard);
    const previousTargets = new Map(this.targets.map((target) => [target.key, target]));
    this.targets = next.targets.map((target) => ({ ...target, bridgeIndex: assignments[target.key] }));
    this.skipped = next.skipped;
    for (const shard of shards) {
      if (!this.bridges.has(shard)) {
        const { Bridge, uuid, Service, Characteristic } = this.hap;
        const bridge = new Bridge(`HomeBrain ${this.config.namespace.slice(0, 4)}${shard ? ` ${shard + 1}` : ''}`,
          uuid.generate(`homebrain:${this.config.namespace}:bridge:${shard}`));
        bridge.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, 'HomeBrain')
          .setCharacteristic(Characteristic.Model, 'HomeBrain Apple Home Bridge')
          .setCharacteristic(Characteristic.SerialNumber, `HB${digest(this.config.namespace + ':bridge:' + shard).slice(0, 30)}`);
        bridge.on('error', () => { this.lastError = 'Apple Home network publisher failed. Check LAN connectivity and hub logs.'; });
        this.bridges.set(shard, bridge);
      }
    }
    const wanted = new Set(this.targets.map((target) => target.key));
    for (const [key, accessory] of this.accessories) {
      const target = this.targets.find((t) => t.key === key);
      const old = previousTargets.get(key);
      if (!wanted.has(key) || (target && old && target.brightness !== old.brightness)) {
        this.bridges.get(old?.bridgeIndex ?? assignments[key] ?? 0)?.removeBridgedAccessory(accessory);
        this.accessories.delete(key);
      }
    }
    const devices = new Map(input.devices.map((device) => [id(device), device]));
    for (const target of this.targets) {
      let accessory = this.accessories.get(target.key);
      if (!accessory) {
        accessory = this.makeAccessory(target);
        this.accessories.set(target.key, accessory);
        this.bridges.get(target.bridgeIndex).addBridgedAccessory(accessory);
      }
      this.updateAccessory(target, accessory, devices.get(target.id));
    }
    for (const [shard, bridge] of this.bridges) {
      if (bridge.homebrainPublished) continue;
      const bytes = Buffer.from(digest(`${this.config.namespace}:bridge:${shard}`).slice(0, 12), 'hex');
      bytes[0] = (bytes[0] | 2) & 0xfe;
      const username = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase();
      await bridge.publish({ username, pincode: this.config.pin, category: this.hap.Categories.BRIDGE,
        port: this.config.port + shard, setupID: digest(this.config.setupSeed + ':' + shard).slice(0, 4).toUpperCase(),
        bind: binding, advertiser: this.hap.MDNSAdvertiser.CIAO, addIdentifyingMaterial: false }, false);
      bridge.homebrainPublished = true;
    }
    this.lastError = ''; this.lastSync = new Date().toISOString();
  }
  makeAccessory(target) {
    const { Accessory, uuid, Service, Characteristic } = this.hap;
    const accessory = new Accessory(target.name, uuid.generate(`homebrain:${this.config.namespace}:${target.key}`));
    // HMAccessory.model is public; iOS no longer exposes the old SerialNumber characteristic.
    // Publish the same opaque, hub-scoped identifier in Model for safe native discovery.
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, 'HomeBrain')
      .setCharacteristic(Characteristic.Model, target.serial)
      .setCharacteristic(Characteristic.SerialNumber, target.serial);
    const Type = target.kind === 'light' || target.brightness ? Service.Lightbulb : Service.Switch;
    const service = accessory.addService(Type, target.name, target.key);
    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.read(target.key, 'on'))
      .onSet((value) => this.write(target.key, 'on', value));
    if (target.brightness) service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.read(target.key, 'brightness'))
      .onSet((value) => this.write(target.key, 'brightness', value));
    accessory.homebrainService = service;
    return accessory;
  }
  updateAccessory(target, accessory, device) {
    const { Characteristic, Service } = this.hap;
    accessory.displayName = target.name;
    accessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.Name, target.name);
    accessory.homebrainService.updateCharacteristic(Characteristic.Name, target.name);
    if (device) {
      const offline = device.isOnline === false;
      const value = offline ? new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE) : Boolean(device.status);
      accessory.homebrainService.updateCharacteristic(Characteristic.On, value);
      if (target.brightness) accessory.homebrainService.updateCharacteristic(Characteristic.Brightness,
        offline ? new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE) : Math.max(0, Math.min(100, Number(device.brightness) || 0)));
    } else accessory.homebrainService.updateCharacteristic(Characteristic.On, this.operations.has(target.key));
  }
  target(key) {
    if (!this.config?.enabled || !this.bridges.size) throw problem(503, 'Apple Home is disabled.');
    const target = this.targets.find((t) => t.key === key);
    if (!target) throw problem(404, 'Apple Home target was removed or disabled.');
    return target;
  }
  async read(key, field) {
    try {
      await this.owner();
      const target = this.target(key);
      if (target.kind === 'workflow' || target.kind === 'scene') return this.operations.has(key);
      const device = await this.readDevice(target.id);
      if (!device || device.isOnline === false) throw problem(503, 'Device unavailable.');
      return field === 'on' ? Boolean(device.status) : Math.max(0, Math.min(100, Number(device.brightness) || 0));
    } catch { throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  }
  async write(key, field, value) {
    try {
      const owner = await this.owner();
      const target = this.target(key);
      // Refresh eligibility before every effect, including workflow edits since the last periodic sync.
      if (['workflow', 'scene'].includes(target.kind)) {
        const input = await this.load();
        if (!catalog(input, this.config.namespace, this.supportsBrightness).targets.some((t) => t.key === key)) throw problem(404, 'Target no longer eligible.');
      }
      if (field === 'on' && typeof value !== 'boolean' && value !== 0 && value !== 1) throw problem(400, 'Invalid power value.');
      if (field === 'brightness' && (!target.brightness || !Number.isInteger(value) || value < 0 || value > 100)) throw problem(400, 'Invalid brightness.');
      if (['workflow', 'scene'].includes(target.kind)) {
        // A trigger switch is momentary, not an enable/disable control. Off never executes a workflow.
        if (!value || this.operations.has(key)) return;
        if (this.operations.size >= 32) throw problem(429, 'Too many Apple Home commands are in progress.');
        const requestId = randomUUID();
        const operation = { requestId, timer: null };
        // Reserve before the first await: concurrent writes must share one accepted invocation.
        this.operations.set(key, operation);
        try {
          const accepted = await this.runTarget(owner, target, requestId);
          if (!accepted || accepted.success !== true) throw problem(502, 'HomeBrain rejected the workflow trigger.');
          const poll = async () => {
            if (this.operations.get(key) !== operation) return;
            try {
              const result = await this.commandStatus(owner, requestId);
              if (result.state !== 'running') {
                this.operations.delete(key);
                if (result.state !== 'completed') this.lastError = 'An Apple Home workflow did not complete. Check its HomeBrain history.';
                this.accessories.get(key)?.homebrainService.updateCharacteristic(this.hap.Characteristic.On, false);
                return;
              }
            } catch {
              // Unknown result is not permission to run the physical workflow a second time.
              this.lastError = 'Apple Home workflow result unavailable. Check HomeBrain history.';
            }
            operation.timer = setTimeout(() => { void poll(); }, 2000);
            operation.timer.unref?.();
          };
          operation.timer = setTimeout(() => { void poll(); }, 1000);
          operation.timer.unref?.();
          await this.audit({ type: 'apple_home.trigger_accepted', payload: { actor: id(owner), targetId: target.id, kind: target.kind, requestId } }).catch(() => {});
        } catch (error) {
          if (this.operations.get(key) === operation) this.operations.delete(key);
          throw error;
        }
        return;
      }
      const context = { source: 'siri', triggerSource: 'apple_home', actor: id(owner), reason: `Apple Home ${field}: ${target.name}` };
      const previous = this.operations.get(key);
      const pending = Promise.resolve(previous).catch(() => {}).then(async () => {
        await this.owner(); this.target(key);
        const device = await this.readDevice(target.id);
        if (!device || device.isOnline === false) throw problem(503, 'Device is offline.');
        if (!catalog({ devices: [device], workflows: [], scenes: [] }, this.config.namespace, this.supportsBrightness).targets.some((t) => t.key === key)) throw problem(404, 'Device type or security classification changed.');
        const result = await this.controlDevice(target.id, field === 'brightness' ? 'set_brightness' : value ? 'turn_on' : 'turn_off',
          field === 'brightness' ? value : undefined, { command: context, requirePostActionVerification: true });
        if (result?.success === false) throw problem(502, 'Device command failed.');
      });
      this.operations.set(key, pending);
      try { await pending; } finally { if (this.operations.get(key) === pending) this.operations.delete(key); }
    } catch (error) {
      this.lastError = error?.status ? error.message : 'An Apple Home command failed. Check HomeBrain device/workflow history.';
      await this.audit({ type: 'apple_home.command_failed', severity: 'warn', payload: { target: key } }).catch(() => {});
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
  status(user) {
    if (user?.isReviewSandbox) throw problem(403, 'Apple Home cannot access a review sandbox.');
    return { success: true, enabled: Boolean(this.config?.enabled), running: this.bridges.size > 0 && [...this.bridges.values()].every((b) => b.homebrainPublished),
      namespace: this.config?.namespace || '', canManage: user?.role === 'admin' && !user?.isReadOnly && (!this.config || this.config.ownerId === id(user)),
      lastSync: this.lastSync, error: this.lastError,
      bridges: [...this.bridges].map(([index, bridge]) => ({ index, name: bridge.displayName, paired: Boolean(bridge._accessoryInfo?.paired()), port: this.config.port + index })),
      targets: this.targets, skipped: this.skipped };
  }
  async pairing(user) {
    assertOwner(user);
    if (!this.config?.enabled || this.config.ownerId !== id(user)) throw problem(403, 'Enable this bridge as its owner first.');
    await this.refresh();
    return { success: true, pin: this.config.pin,
      bridges: [...this.bridges].map(([index, bridge]) => ({ index, name: bridge.displayName,
        paired: Boolean(bridge._accessoryInfo?.paired()), setupURI: bridge.setupURI() })) };
  }
  async stopPublishing() {
    const bridges = [...this.bridges.values()]; this.bridges.clear(); this.accessories.clear();
    for (const bridge of bridges) await bridge.unpublish().catch(() => {});
    await this.storage.release();
  }
  async shutdown() {
    clearInterval(this.interval); clearTimeout(this.updateTimer);
    this.events?.off('devices:update', this.onDeviceUpdate);
    await this.serial(() => this.stopPublishing());
    for (const value of this.operations.values()) if (!(value instanceof Promise)) clearTimeout(value.timer);
    this.operations.clear();
  }
}
module.exports = { AppleHomeBridge, assertOwner, lanInterfaces };
