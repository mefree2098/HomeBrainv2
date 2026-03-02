const fs = require('node:fs');
const path = require('node:path');
const Insteon = require('home-controller').Insteon;
const Device = require('../models/Device');
const Settings = require('../models/Settings');

const DEFAULT_INSTEON_SERIAL_PORT = '/dev/ttyUSB0';
const DEFAULT_INSTEON_TCP_PORT = 9761;
const INSTEON_SERIAL_BY_ID_DIR = '/dev/serial/by-id';
const INSTEON_SERIAL_OPTIONS = Object.freeze({
  baudRate: 19200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
});

/**
 * Insteon PLM Service
 * Provides comprehensive integration with Insteon PowerLinc Modem (PLM)
 * Supports device discovery, control, status monitoring, and management
 */
class InsteonService {
  constructor() {
    this.hub = null;
    this.isConnected = false;
    this.devices = new Map(); // Cache of discovered devices
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.connectionTransport = null;
    this.connectionTarget = null;
    this.lastConnectionError = null;
    this._runtimeListenersAttached = false;
    this._runtimeErrorListener = null;
    this._runtimeCloseListener = null;
    this._serialPortModule = undefined;
    console.log('InsteonService: Initialized');
  }

  _loadSerialPortModule() {
    if (this._serialPortModule !== undefined) {
      return this._serialPortModule;
    }

    try {
      this._serialPortModule = require('serialport');
    } catch (error) {
      this._serialPortModule = null;
    }

    return this._serialPortModule;
  }

  _attachRuntimeListeners() {
    if (!this.hub || this._runtimeListenersAttached) {
      return;
    }

    this._runtimeErrorListener = (error) => {
      const err = error instanceof Error ? error : new Error(String(error || 'Unknown runtime error'));
      this.lastConnectionError = err.message;
      console.error(`InsteonService: Runtime PLM error on ${this.connectionTarget || 'unknown target'}: ${err.message}`);
    };

    this._runtimeCloseListener = (hadError) => {
      console.warn(`InsteonService: PLM connection closed${hadError ? ' after error' : ''}`);
      this.isConnected = false;
      this.hub = null;
      this.connectionTransport = null;
      this.connectionTarget = null;
      this._runtimeListenersAttached = false;
      this._runtimeCloseListener = null;
      this._runtimeErrorListener = null;
    };

    this.hub.on('error', this._runtimeErrorListener);
    this.hub.on('close', this._runtimeCloseListener);

    this._runtimeListenersAttached = true;
  }

  _detachRuntimeListeners() {
    if (!this.hub || !this._runtimeListenersAttached) {
      this._runtimeListenersAttached = false;
      return;
    }

    if (this._runtimeCloseListener) {
      this.hub.removeListener('close', this._runtimeCloseListener);
    }
    if (this._runtimeErrorListener) {
      this.hub.removeListener('error', this._runtimeErrorListener);
    }

    this._runtimeCloseListener = null;
    this._runtimeErrorListener = null;
    this._runtimeListenersAttached = false;
  }

  _normalizeSerialPath(serialPath) {
    if (typeof serialPath !== 'string') {
      return serialPath;
    }

    const trimmed = serialPath.trim();
    if (!trimmed) {
      return trimmed;
    }

    if (/^serial:\/\//i.test(trimmed)) {
      return trimmed.replace(/^serial:\/\//i, '');
    }

    return trimmed;
  }

  async _getSerialByIdEntries() {
    try {
      const fileNames = await fs.promises.readdir(INSTEON_SERIAL_BY_ID_DIR);
      const entries = [];

      for (const fileName of fileNames) {
        const symlinkPath = path.join(INSTEON_SERIAL_BY_ID_DIR, fileName);
        let resolvedPath = symlinkPath;

        try {
          resolvedPath = await fs.promises.realpath(symlinkPath);
        } catch (error) {
          // Keep symlink path when realpath resolution fails.
        }

        entries.push({
          symlinkPath,
          resolvedPath
        });
      }

      return entries;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`InsteonService: Unable to inspect ${INSTEON_SERIAL_BY_ID_DIR}: ${error.message}`);
      }
      return [];
    }
  }

  _isLikelyInsteonPort(port) {
    const fingerprint = [
      port.path,
      port.stablePath,
      port.manufacturer,
      port.friendlyName,
      port.vendorId,
      port.productId,
      port.pnpId
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return /(insteon|smarthome|powerlinc|plm|2413u|2413s)/.test(fingerprint);
  }

  async listLocalSerialPorts() {
    const SerialPort = this._loadSerialPortModule();
    let listedPorts = [];

    if (SerialPort && typeof SerialPort.list === 'function') {
      try {
        listedPorts = await SerialPort.list();
      } catch (error) {
        console.warn(`InsteonService: Failed to enumerate serial ports via serialport.list(): ${error.message}`);
      }
    }

    const byIdEntries = await this._getSerialByIdEntries();
    const byResolvedPath = new Map();

    byIdEntries.forEach((entry) => {
      const current = byResolvedPath.get(entry.resolvedPath) || [];
      current.push(entry.symlinkPath);
      byResolvedPath.set(entry.resolvedPath, current);
    });

    const portMap = new Map();

    listedPorts.forEach((portInfo) => {
      const serialPath = typeof portInfo.path === 'string' ? portInfo.path.trim() : '';
      if (!serialPath) {
        return;
      }

      const aliases = byResolvedPath.get(serialPath) || [];
      const stablePath = aliases.length > 0 ? aliases[0] : null;

      portMap.set(serialPath, {
        path: serialPath,
        stablePath,
        aliases,
        manufacturer: portInfo.manufacturer || null,
        friendlyName: portInfo.friendlyName || null,
        serialNumber: portInfo.serialNumber || null,
        vendorId: portInfo.vendorId || null,
        productId: portInfo.productId || null,
        pnpId: portInfo.pnpId || null
      });
    });

    byIdEntries.forEach((entry) => {
      const canonicalPath = entry.resolvedPath || entry.symlinkPath;
      const existing = portMap.get(canonicalPath);

      if (existing) {
        if (!existing.aliases.includes(entry.symlinkPath)) {
          existing.aliases.push(entry.symlinkPath);
        }
        if (!existing.stablePath) {
          existing.stablePath = entry.symlinkPath;
        }
        return;
      }

      portMap.set(canonicalPath, {
        path: canonicalPath,
        stablePath: entry.symlinkPath,
        aliases: [entry.symlinkPath],
        manufacturer: null,
        friendlyName: null,
        serialNumber: null,
        vendorId: null,
        productId: null,
        pnpId: null
      });
    });

    const ports = Array.from(portMap.values()).map((portInfo) => ({
      ...portInfo,
      likelyInsteon: this._isLikelyInsteonPort(portInfo)
    }));

    ports.sort((a, b) => {
      if (a.likelyInsteon !== b.likelyInsteon) {
        return a.likelyInsteon ? -1 : 1;
      }
      if (Boolean(a.stablePath) !== Boolean(b.stablePath)) {
        return a.stablePath ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });

    return ports;
  }

  _formatSerialEndpointHints(serialPorts) {
    if (!Array.isArray(serialPorts) || serialPorts.length === 0) {
      return 'No local serial ports detected. Verify USB cabling/power and run `ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/* 2>/dev/null`.';
    }

    const endpoints = serialPorts
      .slice(0, 6)
      .map((port) => port.stablePath || port.path);

    return `Detected serial endpoints: ${endpoints.join(', ')}`;
  }

  async _validateSerialEndpoint(serialPath) {
    const normalizedPath = this._normalizeSerialPath(serialPath);
    if (!normalizedPath) {
      throw new Error('INSTEON serial endpoint is empty. Set a USB serial path like /dev/serial/by-id/... or /dev/ttyUSB0.');
    }

    const serialPorts = await this.listLocalSerialPorts();
    const indexedPaths = new Map();
    serialPorts.forEach((port) => {
      indexedPaths.set(port.path, port);
      if (port.stablePath) {
        indexedPaths.set(port.stablePath, port);
      }
      (port.aliases || []).forEach((alias) => indexedPaths.set(alias, port));
    });
    const matchedPort = indexedPaths.get(normalizedPath) || null;

    if (normalizedPath.startsWith('/')) {
      try {
        await fs.promises.access(normalizedPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch (error) {
        const hint = this._formatSerialEndpointHints(serialPorts);
        if (error.code === 'ENOENT') {
          throw new Error(`INSTEON serial endpoint "${normalizedPath}" does not exist. ${hint}`);
        }
        if (error.code === 'EACCES') {
          throw new Error(`Cannot access INSTEON serial endpoint "${normalizedPath}" (permission denied). Ensure the HomeBrain service user is in the dialout group. ${hint}`);
        }
        throw new Error(`Cannot access INSTEON serial endpoint "${normalizedPath}": ${error.message}. ${hint}`);
      }
    }

    return {
      serialPath: normalizedPath,
      stablePath: matchedPort ? matchedPort.stablePath : null,
      matchedPort
    };
  }

  /**
   * Resolve INSTEON connection target from settings.
   * Supports:
   * - Serial path: /dev/ttyUSB0
   * - TCP endpoint: tcp://host:port or host:port
   * @param {string} rawTarget
   * @returns {{transport: 'serial', serialPath: string, label: string} | {transport: 'tcp', host: string, port: number, label: string}}
   */
  resolveConnectionTarget(rawTarget) {
    if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
      return {
        transport: 'serial',
        serialPath: DEFAULT_INSTEON_SERIAL_PORT,
        label: DEFAULT_INSTEON_SERIAL_PORT
      };
    }

    const target = rawTarget.trim();
    const normalizedSerialTarget = this._normalizeSerialPath(target);

    const parsePort = (value) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid TCP port "${value}"`);
      }
      return port;
    };
    const formatTcpLabel = (host, port) => {
      const printableHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      return `tcp://${printableHost}:${port}`;
    };

    if (/^serial:\/\//i.test(target)) {
      if (!normalizedSerialTarget) {
        throw new Error('Invalid INSTEON serial endpoint. Use serial:///dev/ttyUSB0 or /dev/ttyUSB0');
      }

      return {
        transport: 'serial',
        serialPath: normalizedSerialTarget,
        label: normalizedSerialTarget
      };
    }

    if (/^tcp:\/\//i.test(target)) {
      try {
        const url = new URL(target);
        if (!url.hostname) {
          throw new Error('Missing TCP host');
        }
        const port = url.port ? parsePort(url.port) : DEFAULT_INSTEON_TCP_PORT;
        const host = url.hostname;
        return {
          transport: 'tcp',
          host,
          port,
          label: formatTcpLabel(host, port)
        };
      } catch (error) {
        throw new Error(`Invalid INSTEON TCP endpoint "${target}". Use tcp://<host>:<port>`);
      }
    }

    const bracketHost = target.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (bracketHost) {
      const host = bracketHost[1];
      const port = parsePort(bracketHost[2]);
      return {
        transport: 'tcp',
        host,
        port,
        label: formatTcpLabel(host, port)
      };
    }

    const firstColon = target.indexOf(':');
    const lastColon = target.lastIndexOf(':');
    const looksLikePath = target.includes('/') || target.includes('\\');
    if (firstColon > 0 && firstColon === lastColon && !looksLikePath) {
      const host = target.slice(0, lastColon);
      if (!host) {
        throw new Error(`Invalid INSTEON TCP endpoint "${target}". Use tcp://<host>:<port>`);
      }
      const port = parsePort(target.slice(lastColon + 1));
      return {
        transport: 'tcp',
        host,
        port,
        label: formatTcpLabel(host, port)
      };
    }

    return {
      transport: 'serial',
      serialPath: normalizedSerialTarget,
      label: normalizedSerialTarget
    };
  }

  /**
   * Connect to Insteon PLM
   * @returns {Promise<Object>} Connection status
   */
  async connect() {
    console.log('InsteonService: Attempting to connect to PLM');

    try {
      const settings = await Settings.getSettings();
      const configuredTarget = settings.insteonPort || DEFAULT_INSTEON_SERIAL_PORT;
      const connection = this.resolveConnectionTarget(configuredTarget);
      let validatedSerial = null;

      if (this.isConnected && this.hub) {
        const alreadyConnectedToTarget =
          this.connectionTransport === connection.transport &&
          this.connectionTarget === connection.label;

        if (alreadyConnectedToTarget) {
          console.log('InsteonService: Already connected to PLM');
          return {
            success: true,
            message: 'Already connected to Insteon PLM',
            port: this.connectionTarget || connection.label,
            transport: this.connectionTransport || connection.transport
          };
        }

        console.log(`InsteonService: Endpoint changed (${this.connectionTarget || 'unknown'} -> ${connection.label}), reconnecting`);
        await this.disconnect();
      }

      if (connection.transport === 'tcp') {
        console.log(`InsteonService: Connecting to PLM over TCP at ${connection.label}`);
      } else {
        validatedSerial = await this._validateSerialEndpoint(connection.serialPath);
        connection.serialPath = validatedSerial.serialPath;
        connection.label = validatedSerial.serialPath;
        if (validatedSerial.stablePath && validatedSerial.serialPath.startsWith('/dev/tty')) {
          console.log(`InsteonService: Serial port ${validatedSerial.serialPath} also available as stable path ${validatedSerial.stablePath}`);
        }
        console.log(`InsteonService: Connecting to PLM on serial port ${connection.serialPath}`);
      }

      this.hub = new Insteon();
      this._attachRuntimeListeners();
      this.lastConnectionError = null;

      // Connect with timeout handling
      const connectionPromise = new Promise((resolve, reject) => {
        let settled = false;

        const timeout = setTimeout(() => {
          onError(new Error('Connection timeout after 10 seconds'));
        }, 10000);

        const cleanup = () => {
          clearTimeout(timeout);
          if (this.hub && typeof this.hub.removeListener === 'function') {
            this.hub.removeListener('connect', onConnect);
            this.hub.removeListener('error', onError);
          }
        };

        const onConnect = () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.isConnected = true;
          this.connectionAttempts = 0;
          this.connectionTransport = connection.transport;
          this.connectionTarget = connection.label;
          console.log('InsteonService: Successfully connected to PLM');
          const response = {
            success: true,
            message: 'Successfully connected to Insteon PLM',
            port: connection.label,
            transport: connection.transport
          };
          if (validatedSerial && validatedSerial.stablePath) {
            response.recommendedStablePort = validatedSerial.stablePath;
          }
          resolve(response);
        };

        const onError = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          const err = error instanceof Error ? error : new Error(String(error || 'Unknown connection error'));
          this.lastConnectionError = err.message;
          console.error('InsteonService: Connection error:', err.message);
          reject(err);
        };

        this.hub.once('connect', onConnect);
        this.hub.once('error', onError);

        try {
          if (connection.transport === 'tcp') {
            this.hub.connect(connection.host, connection.port);
          } else {
            this.hub.serial(connection.serialPath, { ...INSTEON_SERIAL_OPTIONS });
          }
        } catch (error) {
          onError(error);
        }
      });

      return await connectionPromise;
    } catch (error) {
      this.connectionAttempts++;
      console.error(`InsteonService: Connection failed (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts}):`, error.message);
      console.error(error.stack);

      this.isConnected = false;
      this.lastConnectionError = error.message;
      this._detachRuntimeListeners();
      this.hub = null;
      this.connectionTransport = null;
      this.connectionTarget = null;

      throw new Error(`Failed to connect to Insteon PLM: ${error.message}`);
    }
  }

  /**
   * Disconnect from Insteon PLM
   * @returns {Promise<Object>} Disconnection status
   */
  async disconnect() {
    console.log('InsteonService: Disconnecting from PLM');

    try {
      this._detachRuntimeListeners();
      if (this.hub && this.hub.close) {
        this.hub.close();
      }

      this.hub = null;
      this.isConnected = false;
      this.devices.clear();
      this.connectionTransport = null;
      this.connectionTarget = null;

      console.log('InsteonService: Successfully disconnected from PLM');

      return {
        success: true,
        message: 'Successfully disconnected from Insteon PLM'
      };
    } catch (error) {
      console.error('InsteonService: Error during disconnect:', error.message);
      console.error(error.stack);
      throw new Error('Failed to disconnect from Insteon PLM');
    }
  }

  /**
   * Test PLM connection
   * @returns {Promise<Object>} Connection test results
   */
  async testConnection() {
    console.log('InsteonService: Testing PLM connection');

    try {
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      // Get PLM info to verify connection
      const info = await this.getPLMInfo();

      console.log('InsteonService: Connection test successful');

      return {
        success: true,
        message: 'Insteon PLM connection is working',
        connected: this.isConnected,
        transport: this.connectionTransport,
        port: this.connectionTarget,
        plmInfo: info
      };
    } catch (error) {
      console.error('InsteonService: Connection test failed:', error.message);
      console.error(error.stack);

      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
        connected: false
      };
    }
  }

  /**
   * Get PLM information
   * @returns {Promise<Object>} PLM info
   */
  async getPLMInfo() {
    console.log('InsteonService: Getting PLM info');

    try {
      if (!this.isConnected || !this.hub) {
        throw new Error('Not connected to PLM');
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout getting PLM info'));
        }, 5000);

        this.hub.info((error, info) => {
          clearTimeout(timeout);

          if (error) {
            console.error('InsteonService: Error getting PLM info:', error.message);
            reject(error);
          } else {
            console.log('InsteonService: PLM info retrieved successfully');
            resolve({
              firmwareVersion: info.firmwareVersion,
              deviceId: info.deviceId,
              deviceCategory: info.deviceCategory,
              subcategory: info.subcategory
            });
          }
        });
      });
    } catch (error) {
      console.error('InsteonService: Failed to get PLM info:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Get all devices linked to PLM
   * @returns {Promise<Array>} Array of linked devices
   */
  async getAllLinkedDevices() {
    console.log('InsteonService: Getting all linked devices from PLM');

    try {
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout getting device links'));
        }, 30000); // 30 seconds for device discovery

        this.hub.links((error, links) => {
          clearTimeout(timeout);

          if (error) {
            console.error('InsteonService: Error getting device links:', error.message);
            reject(error);
          } else {
            console.log(`InsteonService: Found ${links.length} linked devices`);

            // Process and deduplicate devices
            const deviceMap = new Map();
            links.forEach(link => {
              if (link.at && !deviceMap.has(link.at)) {
                deviceMap.set(link.at, {
                  address: link.at,
                  group: link.group,
                  type: link.type,
                  data: link.data
                });
              }
            });

            const devices = Array.from(deviceMap.values());
            console.log(`InsteonService: Processed ${devices.length} unique devices`);
            resolve(devices);
          }
        });
      });
    } catch (error) {
      console.error('InsteonService: Failed to get linked devices:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Import devices from PLM to database
   * @returns {Promise<Object>} Import results
   */
  async importDevices() {
    console.log('InsteonService: Starting device import from PLM');

    try {
      const linkedDevices = await this.getAllLinkedDevices();
      const importedDevices = [];
      const skippedDevices = [];
      const errors = [];

      for (const device of linkedDevices) {
        try {
          // Check if device already exists in database
          const existingDevice = await Device.findOne({
            'properties.insteonAddress': device.address
          });

          if (existingDevice) {
            console.log(`InsteonService: Device ${device.address} already exists, skipping`);
            skippedDevices.push(device.address);
            continue;
          }

          // Get device info to determine type and capabilities
          const deviceInfo = await this.getDeviceInfo(device.address);

          // Create device in database
          const newDevice = await Device.create({
            name: `Insteon Device ${device.address}`,
            type: this._mapInsteonTypeToDeviceType(deviceInfo),
            room: 'Unassigned',
            status: false,
            brand: 'Insteon',
            model: deviceInfo.productKey || 'Unknown',
            properties: {
              source: 'insteon',
              insteonAddress: device.address,
              insteonGroup: device.group,
              insteonType: device.type,
              deviceCategory: deviceInfo.deviceCategory,
              subcategory: deviceInfo.subcategory
            },
            isOnline: true
          });

          console.log(`InsteonService: Imported device ${device.address} as ${newDevice._id}`);
          importedDevices.push(newDevice);

          // Cache device
          this.devices.set(device.address, newDevice);
        } catch (error) {
          console.error(`InsteonService: Error importing device ${device.address}:`, error.message);
          errors.push({
            address: device.address,
            error: error.message
          });
        }
      }

      console.log(`InsteonService: Import complete - ${importedDevices.length} imported, ${skippedDevices.length} skipped, ${errors.length} errors`);

      return {
        success: true,
        message: `Imported ${importedDevices.length} devices`,
        imported: importedDevices.length,
        skipped: skippedDevices.length,
        errors: errors.length,
        devices: importedDevices,
        errorDetails: errors
      };
    } catch (error) {
      console.error('InsteonService: Device import failed:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to import devices: ${error.message}`);
    }
  }

  /**
   * Get device information
   * @param {String} address - Insteon device address
   * @returns {Promise<Object>} Device information
   */
  async getDeviceInfo(address) {
    console.log(`InsteonService: Getting info for device ${address}`);

    try {
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout getting device info'));
        }, 10000);

        this.hub.info(address, (error, info) => {
          clearTimeout(timeout);

          if (error) {
            console.error(`InsteonService: Error getting device ${address} info:`, error.message);
            // Return basic info even on error
            resolve({
              deviceCategory: 0,
              subcategory: 0,
              firmwareVersion: 'Unknown'
            });
          } else {
            console.log(`InsteonService: Device ${address} info retrieved`);
            resolve(info);
          }
        });
      });
    } catch (error) {
      console.error(`InsteonService: Failed to get device info for ${address}:`, error.message);
      // Return basic info instead of throwing
      return {
        deviceCategory: 0,
        subcategory: 0,
        firmwareVersion: 'Unknown'
      };
    }
  }

  /**
   * Get device status
   * @param {String} deviceId - Database device ID
   * @returns {Promise<Object>} Device status
   */
  async getDeviceStatus(deviceId) {
    console.log(`InsteonService: Getting status for device ${deviceId}`);

    try {
      const device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const address = device.properties.insteonAddress;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout getting device status'));
        }, 5000);

        this.hub.level(address, (error, level) => {
          clearTimeout(timeout);

          if (error) {
            console.error(`InsteonService: Error getting device ${address} status:`, error.message);
            reject(error);
          } else {
            const status = level > 0;
            const brightness = Math.round((level / 255) * 100);

            console.log(`InsteonService: Device ${address} status - Level: ${level}, Brightness: ${brightness}%`);

            resolve({
              status,
              level,
              brightness,
              isOnline: true
            });
          }
        });
      });
    } catch (error) {
      console.error(`InsteonService: Failed to get device status:`, error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Turn device on
   * @param {String} deviceId - Database device ID
   * @param {Number} brightness - Optional brightness level (0-100)
   * @returns {Promise<Object>} Command result
   */
  async turnOn(deviceId, brightness = 100) {
    console.log(`InsteonService: Turning on device ${deviceId} at ${brightness}%`);

    try {
      const device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const address = device.properties.insteonAddress;
      const level = Math.round((brightness / 100) * 255);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout turning on device'));
        }, 5000);

        this.hub.turnOn(address, level, (error) => {
          clearTimeout(timeout);

          if (error) {
            console.error(`InsteonService: Error turning on device ${address}:`, error.message);
            reject(error);
          } else {
            console.log(`InsteonService: Device ${address} turned on at level ${level}`);

            // Update device in database
            device.status = true;
            device.brightness = brightness;
            device.updatedAt = new Date();
            device.save().catch(err => console.error('Error saving device state:', err.message));

            resolve({
              success: true,
              message: 'Device turned on',
              status: true,
              brightness
            });
          }
        });
      });
    } catch (error) {
      console.error('InsteonService: Failed to turn on device:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Turn device off
   * @param {String} deviceId - Database device ID
   * @returns {Promise<Object>} Command result
   */
  async turnOff(deviceId) {
    console.log(`InsteonService: Turning off device ${deviceId}`);

    try {
      const device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const address = device.properties.insteonAddress;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout turning off device'));
        }, 5000);

        this.hub.turnOff(address, (error) => {
          clearTimeout(timeout);

          if (error) {
            console.error(`InsteonService: Error turning off device ${address}:`, error.message);
            reject(error);
          } else {
            console.log(`InsteonService: Device ${address} turned off`);

            // Update device in database
            device.status = false;
            device.brightness = 0;
            device.updatedAt = new Date();
            device.save().catch(err => console.error('Error saving device state:', err.message));

            resolve({
              success: true,
              message: 'Device turned off',
              status: false,
              brightness: 0
            });
          }
        });
      });
    } catch (error) {
      console.error('InsteonService: Failed to turn off device:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Set device brightness
   * @param {String} deviceId - Database device ID
   * @param {Number} brightness - Brightness level (0-100)
   * @returns {Promise<Object>} Command result
   */
  async setBrightness(deviceId, brightness) {
    console.log(`InsteonService: Setting device ${deviceId} brightness to ${brightness}%`);

    if (brightness === 0) {
      return this.turnOff(deviceId);
    } else {
      return this.turnOn(deviceId, brightness);
    }
  }

  /**
   * Link new device to PLM
   * @param {Number} timeout - Timeout in seconds (default 30)
   * @returns {Promise<Object>} Link result
   */
  async linkDevice(timeout = 30) {
    console.log(`InsteonService: Starting device linking (timeout: ${timeout}s)`);

    try {
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      return new Promise((resolve, reject) => {
        const timeoutMs = timeout * 1000;
        const timer = setTimeout(() => {
          reject(new Error('Device linking timeout - no device found'));
        }, timeoutMs);

        this.hub.link((error, link) => {
          clearTimeout(timer);

          if (error) {
            console.error('InsteonService: Error during device linking:', error.message);
            reject(error);
          } else {
            console.log(`InsteonService: Device linked successfully - Address: ${link.at}`);
            resolve({
              success: true,
              message: 'Device linked successfully',
              address: link.at,
              group: link.group,
              type: link.type
            });
          }
        });

        console.log('InsteonService: PLM is now in linking mode - set device to linking mode within 30 seconds');
      });
    } catch (error) {
      console.error('InsteonService: Device linking failed:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Unlink device from PLM
   * @param {String} deviceId - Database device ID
   * @returns {Promise<Object>} Unlink result
   */
  async unlinkDevice(deviceId) {
    console.log(`InsteonService: Unlinking device ${deviceId}`);

    try {
      const device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const address = device.properties.insteonAddress;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout unlinking device'));
        }, 10000);

        this.hub.unlink(address, (error) => {
          clearTimeout(timeout);

          if (error) {
            console.error(`InsteonService: Error unlinking device ${address}:`, error.message);
            reject(error);
          } else {
            console.log(`InsteonService: Device ${address} unlinked successfully`);

            // Delete device from database
            Device.findByIdAndDelete(deviceId).catch(err =>
              console.error('Error deleting device from database:', err.message)
            );

            // Remove from cache
            this.devices.delete(address);

            resolve({
              success: true,
              message: 'Device unlinked and removed'
            });
          }
        });
      });
    } catch (error) {
      console.error('InsteonService: Device unlinking failed:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Delete device from database (without unlinking from PLM)
   * @param {String} deviceId - Database device ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteDevice(deviceId) {
    console.log(`InsteonService: Deleting device ${deviceId} from database`);

    try {
      const device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      const address = device.properties.insteonAddress;

      await Device.findByIdAndDelete(deviceId);
      this.devices.delete(address);

      console.log(`InsteonService: Device ${deviceId} deleted from database`);

      return {
        success: true,
        message: 'Device deleted from database'
      };
    } catch (error) {
      console.error('InsteonService: Device deletion failed:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Scan and update status for all Insteon devices
   * @returns {Promise<Object>} Scan results
   */
  async scanAllDevices() {
    console.log('InsteonService: Scanning all Insteon devices');

    try {
      const devices = await Device.find({ 'properties.source': 'insteon' });
      const results = {
        total: devices.length,
        online: 0,
        offline: 0,
        errors: []
      };

      for (const device of devices) {
        try {
          const status = await this.getDeviceStatus(device._id);

          device.status = status.status;
          device.brightness = status.brightness;
          device.isOnline = status.isOnline;
          device.lastSeen = new Date();
          await device.save();

          results.online++;
        } catch (error) {
          console.error(`InsteonService: Error scanning device ${device._id}:`, error.message);
          device.isOnline = false;
          await device.save();

          results.offline++;
          results.errors.push({
            deviceId: device._id,
            name: device.name,
            error: error.message
          });
        }
      }

      console.log(`InsteonService: Scan complete - ${results.online} online, ${results.offline} offline`);

      return {
        success: true,
        message: 'Device scan completed',
        results
      };
    } catch (error) {
      console.error('InsteonService: Device scan failed:', error.message);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Map Insteon device category to generic device type
   * @param {Object} deviceInfo - Insteon device info
   * @returns {String} Generic device type
   */
  _mapInsteonTypeToDeviceType(deviceInfo) {
    const category = deviceInfo.deviceCategory || 0;

    // Insteon device categories
    // 0x01 = Dimmable Lighting Control
    // 0x02 = Switched Lighting Control
    // 0x03 = Network Bridges
    // 0x04 = Irrigation Control
    // 0x05 = Climate Control
    // 0x06 = Pool and Spa Control
    // 0x07 = Sensors and Actuators
    // 0x09 = Energy Management
    // 0x0E = Windows Coverings
    // 0x0F = Access Control
    // 0x10 = Security, Health, Safety

    switch (category) {
      case 0x01:
      case 0x02:
        return 'light';
      case 0x05:
        return 'thermostat';
      case 0x0F:
        return 'lock';
      case 0x07:
      case 0x10:
        return 'sensor';
      default:
        return 'switch';
    }
  }

  /**
   * Get connection status
   * @returns {Object} Connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      deviceCount: this.devices.size,
      connectionAttempts: this.connectionAttempts,
      transport: this.connectionTransport,
      port: this.connectionTarget,
      lastConnectionError: this.lastConnectionError
    };
  }
}

module.exports = new InsteonService();
