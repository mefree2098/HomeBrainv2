const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const axios = require('axios');
const Insteon = require('home-controller').Insteon;
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const Settings = require('../models/Settings');
const Workflow = require('../models/Workflow');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

let cachedWorkflowService = null;
const getWorkflowService = () => {
  if (!cachedWorkflowService) {
    cachedWorkflowService = require('./workflowService');
  }
  return cachedWorkflowService;
};

const DEFAULT_INSTEON_SERIAL_PORT = '/dev/ttyUSB0';
const DEFAULT_INSTEON_TCP_PORT = 9761;
const INSTEON_SERIAL_BY_ID_DIR = '/dev/serial/by-id';
const DEFAULT_ISY_IMPORT_GROUP = 1;
const DEFAULT_ISY_REMOTE_LINK_TIMEOUT_MS = 12000;
const DEFAULT_ISY_MANUAL_LINK_TIMEOUT_MS = 60000;
const DEFAULT_ISY_LINK_PAUSE_MS = 350;
const DEFAULT_ISY_TOPOLOGY_SCENE_TIMEOUT_MS = 20000;
const DEFAULT_ISY_TOPOLOGY_PAUSE_MS = 400;
const DEFAULT_ISY_PORT_HTTP = 80;
const DEFAULT_ISY_PORT_HTTPS = 443;
const DEFAULT_ISY_SYNC_RUN_RETENTION = 20;
const DEFAULT_ISY_SYNC_RUN_LOG_LIMIT = 1000;
const DEFAULT_LINKED_STATUS_RUN_RETENTION = 20;
const DEFAULT_LINKED_STATUS_RUN_LOG_LIMIT = 1000;
const DEFAULT_INSTEON_LOCAL_BRIDGE_HOST = '127.0.0.1';
const INSTEON_LOCAL_BRIDGE_START_TIMEOUT_MS = 8000;
const INSTEON_LOCAL_BRIDGE_SCRIPT = path.join(__dirname, '..', 'scripts', 'insteon_serial_bridge.py');
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
    this._runtimeCommandListener = null;
    this._serialPortModule = undefined;
    this._serialPortLoadError = null;
    this._localSerialBridge = null;
    this._pendingRuntimeStateRefreshes = new Map();
    this.enableLocalSerialBridge = process.env.HOMEBRAIN_INSTEON_ENABLE_LOCAL_TCP_BRIDGE !== 'false';
    this._isySyncRuns = new Map();
    this._isySyncRunRetention = Number(process.env.HOMEBRAIN_ISY_SYNC_RUN_RETENTION || DEFAULT_ISY_SYNC_RUN_RETENTION);
    this._isySyncRunLogLimit = Number(process.env.HOMEBRAIN_ISY_SYNC_RUN_LOG_LIMIT || DEFAULT_ISY_SYNC_RUN_LOG_LIMIT);
    this._linkedStatusRuns = new Map();
    this._linkedStatusRunRetention = Number(process.env.HOMEBRAIN_LINKED_STATUS_RUN_RETENTION || DEFAULT_LINKED_STATUS_RUN_RETENTION);
    this._linkedStatusRunLogLimit = Number(process.env.HOMEBRAIN_LINKED_STATUS_RUN_LOG_LIMIT || DEFAULT_LINKED_STATUS_RUN_LOG_LIMIT);
    console.log('InsteonService: Initialized');
  }

  _loadSerialPortModule() {
    if (this._serialPortModule !== undefined) {
      return this._serialPortModule;
    }

    try {
      this._serialPortModule = require('serialport');
      this._serialPortLoadError = null;
    } catch (error) {
      this._serialPortModule = null;
      this._serialPortLoadError = error;
      console.warn(`InsteonService: Failed to load serialport module: ${error.message}`);
    }

    return this._serialPortModule;
  }

  _buildSerialTransportUnavailableMessage(serialPath = '', bridgeError = null) {
    const endpoint = typeof serialPath === 'string' && serialPath.trim()
      ? ` Endpoint: "${serialPath.trim()}".`
      : '';
    const loadError = this._serialPortLoadError?.message
      ? ` serialport load error: ${this._serialPortLoadError.message}.`
      : '';
    const bridgeFailure = bridgeError?.message
      ? ` Local serial TCP bridge fallback failed: ${bridgeError.message}.`
      : '';

    return [
      'Serial transport is unavailable because the HomeBrain runtime cannot load the "serialport" module.',
      endpoint,
      loadError,
      bridgeFailure,
      'HomeBrain automatically attempts a local TCP bridge fallback. If this still fails, ensure Python 3 is available and the HomeBrain service user can access the selected serial endpoint.'
    ].join(' ').replace(/\s+/g, ' ').trim();
  }

  getSerialTransportDiagnostics() {
    const serialPortModule = this._loadSerialPortModule();
    return {
      supported: Boolean(serialPortModule),
      module: serialPortModule ? 'serialport' : null,
      error: serialPortModule ? null : (this._serialPortLoadError?.message || 'serialport module not available')
    };
  }

  _isLocalSerialBridgeActive() {
    const child = this._localSerialBridge?.process || null;
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  async _stopLocalSerialBridge({ reason = 'cleanup', timeoutMs = 1500 } = {}) {
    const bridge = this._localSerialBridge;
    if (!bridge || !bridge.process) {
      this._localSerialBridge = null;
      return;
    }

    const child = bridge.process;
    this._localSerialBridge = null;

    if (child.exitCode !== null || child.killed) {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const killTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
        finish();
      }, timeoutMs);

      child.once('exit', () => {
        clearTimeout(killTimer);
        finish();
      });

      try {
        child.kill('SIGTERM');
      } catch (error) {
        clearTimeout(killTimer);
        finish();
      }
    });

    console.log(`InsteonService: Local serial bridge stopped (${reason})`);
  }

  async _ensureLocalSerialBridge(serialPath, { baudRate = INSTEON_SERIAL_OPTIONS.baudRate } = {}) {
    const normalizedSerialPath = this._normalizeSerialPath(serialPath);
    if (!normalizedSerialPath) {
      throw new Error('Cannot start local serial bridge: serial endpoint is empty.');
    }

    if (!this.enableLocalSerialBridge) {
      throw new Error('Local serial TCP bridge is disabled by configuration.');
    }

    if (this._isLocalSerialBridgeActive() && this._localSerialBridge?.serialPath === normalizedSerialPath) {
      return {
        host: this._localSerialBridge.host,
        port: this._localSerialBridge.port,
        serialPath: this._localSerialBridge.serialPath,
        reused: true
      };
    }

    if (this._isLocalSerialBridgeActive()) {
      await this._stopLocalSerialBridge({ reason: 'serial endpoint changed' });
    }

    if (!fs.existsSync(INSTEON_LOCAL_BRIDGE_SCRIPT)) {
      throw new Error(`Bridge script not found: ${INSTEON_LOCAL_BRIDGE_SCRIPT}`);
    }

    const pythonBin = process.env.PYTHON_BIN || 'python3';
    const bridgeArgs = [
      INSTEON_LOCAL_BRIDGE_SCRIPT,
      '--serial',
      normalizedSerialPath,
      '--baud',
      String(Number(baudRate) || INSTEON_SERIAL_OPTIONS.baudRate),
      '--host',
      DEFAULT_INSTEON_LOCAL_BRIDGE_HOST,
      '--port',
      '0'
    ];

    console.log(`InsteonService: Starting local serial bridge for ${normalizedSerialPath}`);

    const child = spawn(pythonBin, bridgeArgs, {
      cwd: path.join(__dirname, '..', '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const parseLines = (buffer, emit) => {
      let working = buffer;
      let newlineIndex = working.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = working.slice(0, newlineIndex).trim();
        if (line) {
          emit(line);
        }
        working = working.slice(newlineIndex + 1);
        newlineIndex = working.indexOf('\n');
      }
      return working;
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lastBridgeError = '';

    return new Promise((resolve, reject) => {
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (child.exitCode === null && !child.killed) {
          try {
            child.kill('SIGTERM');
          } catch (killError) {
            // ignore
          }
        }
        reject(error);
      };

      const startupTimeout = setTimeout(() => {
        fail(new Error(`Timed out starting local serial bridge for ${normalizedSerialPath}`));
      }, INSTEON_LOCAL_BRIDGE_START_TIMEOUT_MS);

      const onBridgeLine = (line, source) => {
        if (source === 'stderr') {
          lastBridgeError = line;
          console.warn(`InsteonService: local bridge stderr: ${line}`);
          return;
        }

        const readyMatch = line.match(/^BRIDGE_READY\s+(\d+)$/);
        if (readyMatch) {
          const port = Number(readyMatch[1]);
          clearTimeout(startupTimeout);
          settled = true;
          this._localSerialBridge = {
            process: child,
            host: DEFAULT_INSTEON_LOCAL_BRIDGE_HOST,
            port,
            serialPath: normalizedSerialPath,
            startedAt: new Date().toISOString()
          };
          console.log(`InsteonService: Local serial bridge ready on ${DEFAULT_INSTEON_LOCAL_BRIDGE_HOST}:${port}`);
          resolve({
            host: DEFAULT_INSTEON_LOCAL_BRIDGE_HOST,
            port,
            serialPath: normalizedSerialPath,
            reused: false
          });
          return;
        }

        console.log(`InsteonService: local bridge stdout: ${line}`);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        stdoutBuffer = parseLines(stdoutBuffer, (line) => onBridgeLine(line, 'stdout'));
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk;
        stderrBuffer = parseLines(stderrBuffer, (line) => onBridgeLine(line, 'stderr'));
      });

      child.once('error', (error) => {
        clearTimeout(startupTimeout);
        fail(new Error(`Local serial bridge process failed to start: ${error.message}`));
      });

      child.on('exit', (code, signal) => {
        if (this._localSerialBridge?.process === child) {
          this._localSerialBridge = null;
        }

        if (!settled) {
          clearTimeout(startupTimeout);
          const detail = lastBridgeError || `exit code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`;
          fail(new Error(`Local serial bridge exited before ready: ${detail}`));
          return;
        }

        console.warn(`InsteonService: Local serial bridge exited (${code ?? 'unknown'}${signal ? ` signal ${signal}` : ''})`);
      });
    });
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
      this._clearPendingRuntimeStateRefreshes();
      this._runtimeListenersAttached = false;
      this._runtimeCloseListener = null;
      this._runtimeErrorListener = null;
      this._runtimeCommandListener = null;
    };

    this._runtimeCommandListener = (command) => {
      this._handleRuntimeCommand(command).catch((error) => {
        console.warn(`InsteonService: Runtime command handling error: ${error.message}`);
      });
    };

    this.hub.on('error', this._runtimeErrorListener);
    this.hub.on('close', this._runtimeCloseListener);
    this.hub.on('command', this._runtimeCommandListener);

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
    if (this._runtimeCommandListener) {
      this.hub.removeListener('command', this._runtimeCommandListener);
    }

    this._runtimeCloseListener = null;
    this._runtimeErrorListener = null;
    this._runtimeCommandListener = null;
    this._clearPendingRuntimeStateRefreshes();
    this._runtimeListenersAttached = false;
  }

  _clearPendingRuntimeStateRefreshes() {
    for (const timer of this._pendingRuntimeStateRefreshes.values()) {
      clearTimeout(timer);
    }
    this._pendingRuntimeStateRefreshes.clear();
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

  _normalizeInsteonAddress(rawAddress) {
    if (typeof rawAddress !== 'string') {
      throw new Error(`Invalid INSTEON address "${rawAddress}"`);
    }

    const normalized = rawAddress.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    if (!/^[0-9A-F]{6}$/.test(normalized)) {
      throw new Error(`Invalid INSTEON address "${rawAddress}"`);
    }

    return normalized;
  }

  _formatInsteonAddress(normalizedAddress) {
    const clean = this._normalizeInsteonAddress(normalizedAddress);
    return `${clean.slice(0, 2)}.${clean.slice(2, 4)}.${clean.slice(4, 6)}`;
  }

  _extractInsteonAddressTokens(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      return [];
    }

    return rawText.match(/\b(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{2}(?:[.\-:\s][0-9A-Fa-f]{2}){2})\b/g) || [];
  }

  _isISYInsteonFamily(familyValue) {
    const normalized = String(familyValue ?? '').trim().toLowerCase();
    if (!normalized) {
      // Older ISY nodes payloads may omit family; keep them eligible and rely on address validation.
      return true;
    }

    if (['1', '01', 'insteon'].includes(normalized)) {
      return true;
    }

    if (normalized.startsWith('insteon')) {
      return true;
    }

    return false;
  }

  _isISYInsteonNode(node = {}) {
    if (!node || typeof node !== 'object') {
      return false;
    }

    if (!this._isISYInsteonFamily(node.family)) {
      return false;
    }

    const resolvedAddress = this._normalizePossibleInsteonAddress(
      node.resolvedAddress
      || node.normalizedAddress
      || node.normalizedParent
      || node.normalizedPnode
      || node.address
      || node.parent
      || node.pnode
    );

    return Boolean(resolvedAddress);
  }

  _parseISYImportPayload(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const candidates = [];
    const invalidEntries = [];
    const pushCandidate = (value, source, name = null) => {
      candidates.push({ value, source, name });
    };

    const collectFromArray = (value, source) => {
      if (!Array.isArray(value)) {
        return;
      }

      value.forEach((entry, index) => {
        if (typeof entry === 'string') {
          pushCandidate(entry, `${source}[${index}]`);
          return;
        }

        if (entry && typeof entry === 'object') {
          const rawAddress = entry.address
            || entry.id
            || entry.deviceId
            || entry.insteonAddress
            || entry.resolvedAddress
            || entry.normalizedAddress
            || entry.normalizedParent
            || entry.normalizedPnode
            || entry?.properties?.insteonAddress;
          const rawName = typeof entry.name === 'string'
            ? entry.name
            : (typeof entry.displayName === 'string' ? entry.displayName : null);

          pushCandidate(rawAddress, `${source}[${index}]`, rawName);
          return;
        }

        invalidEntries.push({
          source: `${source}[${index}]`,
          value: entry,
          reason: 'Expected a string address or object with address/id'
        });
      });
    };

    collectFromArray(request.deviceIds, 'deviceIds');
    collectFromArray(request.addresses, 'addresses');
    collectFromArray(request.devices, 'devices');

    if (typeof request.deviceIds === 'string') {
      this._extractInsteonAddressTokens(request.deviceIds).forEach((token) =>
        pushCandidate(token, 'deviceIds')
      );
    }

    ['rawDeviceList', 'rawList', 'text', 'isyDeviceList'].forEach((key) => {
      if (typeof request[key] === 'string') {
        this._extractInsteonAddressTokens(request[key]).forEach((token) => {
          pushCandidate(token, key);
        });
      }
    });

    const parsedDevicesByAddress = new Map();
    let duplicateCount = 0;

    candidates.forEach((candidate) => {
      const rawValue = typeof candidate.value === 'string' ? candidate.value.trim() : '';
      if (!rawValue) {
        invalidEntries.push({
          source: candidate.source,
          value: candidate.value,
          reason: 'Address is empty'
        });
        return;
      }

      let normalizedAddress;
      try {
        normalizedAddress = this._normalizeInsteonAddress(rawValue);
      } catch (error) {
        invalidEntries.push({
          source: candidate.source,
          value: candidate.value,
          reason: error.message
        });
        return;
      }

      const name = typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : null;

      if (parsedDevicesByAddress.has(normalizedAddress)) {
        duplicateCount += 1;
        const existing = parsedDevicesByAddress.get(normalizedAddress);
        const existingName = typeof existing?.name === 'string' ? existing.name.trim() : '';
        const existingLooksAddressLike = this._isAddressLikeISYName(existingName);
        const candidateLooksAddressLike = this._isAddressLikeISYName(name || '');
        if (
          name
          && (
            !existingName
            || (existingLooksAddressLike && !candidateLooksAddressLike)
          )
        ) {
          existing.name = name;
        }
        return;
      }

      parsedDevicesByAddress.set(normalizedAddress, {
        address: normalizedAddress,
        displayAddress: this._formatInsteonAddress(normalizedAddress),
        name
      });
    });

    const parsedDevices = Array.from(parsedDevicesByAddress.values());

    const group = Number(request.group ?? request.linkGroup ?? DEFAULT_ISY_IMPORT_GROUP);
    if (!Number.isInteger(group) || group < 0 || group > 255) {
      throw new Error('ISY import group must be an integer between 0 and 255');
    }

    const linkMode = (typeof request.linkMode === 'string' && request.linkMode.toLowerCase() === 'manual')
      ? 'manual'
      : 'remote';

    const timeoutDefault = linkMode === 'manual'
      ? DEFAULT_ISY_MANUAL_LINK_TIMEOUT_MS
      : DEFAULT_ISY_REMOTE_LINK_TIMEOUT_MS;
    const timeoutMs = Number(request.perDeviceTimeoutMs ?? request.timeoutMs ?? timeoutDefault);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300000) {
      throw new Error('ISY import timeout must be between 5000 and 300000 milliseconds');
    }

    const pauseBetweenMs = Number(request.pauseBetweenMs ?? request.pauseBetweenLinksMs ?? DEFAULT_ISY_LINK_PAUSE_MS);
    if (!Number.isFinite(pauseBetweenMs) || pauseBetweenMs < 0 || pauseBetweenMs > 10000) {
      throw new Error('ISY import pauseBetweenMs must be between 0 and 10000 milliseconds');
    }

    const retries = Number(request.retries ?? request.linkRetries ?? 1);
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
      throw new Error('ISY import retries must be an integer between 0 and 5');
    }

    return {
      devices: parsedDevices,
      invalidEntries,
      duplicateCount,
      options: {
        group,
        linkMode,
        timeoutMs,
        pauseBetweenMs,
        retries,
        skipLinking: Boolean(request.skipLinking || request.importOnly),
        checkExistingLinks: request.checkExistingLinks !== false,
        ensureControllerLinks: request.ensureControllerLinks !== false
      }
    };
  }

  _normalizeTopologyParticipant(rawValue, fieldName = 'participant') {
    if (typeof rawValue === 'object' && rawValue !== null) {
      rawValue = rawValue.address || rawValue.id || rawValue.deviceId || rawValue.insteonAddress || null;
    }

    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      throw new Error(`Missing ${fieldName} address`);
    }

    const trimmed = rawValue.trim().toLowerCase();
    if (['gw', 'plm', 'gateway', 'new_plm', 'new-plm', 'usb_plm', 'usb-plm'].includes(trimmed)) {
      return 'gw';
    }

    return this._normalizeInsteonAddress(rawValue);
  }

  _normalizeHexByte(value, fieldName = 'data byte') {
    if (Number.isInteger(value) && value >= 0 && value <= 255) {
      return value.toString(16).toUpperCase().padStart(2, '0');
    }

    if (typeof value === 'string' && value.trim()) {
      const clean = value.trim().toUpperCase().replace(/^0X/, '');
      if (/^[0-9A-F]{1,2}$/.test(clean)) {
        return clean.padStart(2, '0');
      }
    }

    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  _parseTopologyResponder(rawResponder, sourceLabel) {
    const responder = typeof rawResponder === 'string'
      ? { id: rawResponder }
      : (rawResponder && typeof rawResponder === 'object' ? { ...rawResponder } : null);

    if (!responder) {
      throw new Error(`Responder at ${sourceLabel} must be a string or object`);
    }

    const rawId = responder.id || responder.address || responder.deviceId || responder.insteonAddress;
    const id = this._normalizeTopologyParticipant(rawId, `responder (${sourceLabel})`);

    const parsedResponder = { id };

    if (Array.isArray(responder.data) && responder.data.length > 0) {
      if (responder.data.length < 3) {
        throw new Error(`Responder data at ${sourceLabel} must include 3 bytes`);
      }
      parsedResponder.data = responder.data.slice(0, 3).map((byte, index) =>
        this._normalizeHexByte(byte, `responder data[${index}] at ${sourceLabel}`)
      );
      return parsedResponder;
    }

    if (responder.level !== undefined && responder.level !== null) {
      const level = Number(responder.level);
      if (!Number.isFinite(level) || level < 0 || level > 100) {
        throw new Error(`Responder level at ${sourceLabel} must be between 0 and 100`);
      }
      parsedResponder.level = level;
    }

    if (responder.ramp !== undefined && responder.ramp !== null) {
      const ramp = Number(responder.ramp);
      if (!Number.isFinite(ramp) || ramp < 0) {
        throw new Error(`Responder ramp at ${sourceLabel} must be a non-negative number`);
      }
      parsedResponder.ramp = ramp;
    }

    if (typeof responder.name === 'string' && responder.name.trim()) {
      parsedResponder.name = responder.name.trim();
    } else if (typeof responder.displayName === 'string' && responder.displayName.trim()) {
      parsedResponder.name = responder.displayName.trim();
    }

    return parsedResponder;
  }

  _convertLinkRecordsToScenes(linkRecords) {
    const sceneMap = new Map();
    const invalidEntries = [];

    linkRecords.forEach((record, index) => {
      try {
        if (!record || typeof record !== 'object') {
          throw new Error('Link record must be an object');
        }

        const controller = this._normalizeTopologyParticipant(
          record.controller || record.controllerId || record.source,
          `linkRecords[${index}].controller`
        );
        const group = Number(record.group ?? record.sceneGroup ?? DEFAULT_ISY_IMPORT_GROUP);
        if (!Number.isInteger(group) || group < 0 || group > 255) {
          throw new Error(`Invalid group ${record.group}`);
        }

        const remove = Boolean(record.remove);
        const responder = this._parseTopologyResponder(
          record.responder || record.target || record.device || record.deviceId,
          `linkRecords[${index}]`
        );

        const sceneName = typeof record.scene === 'string' && record.scene.trim()
          ? record.scene.trim()
          : (typeof record.sceneName === 'string' && record.sceneName.trim() ? record.sceneName.trim() : null);
        const sceneKey = `${controller}|${group}|${remove ? 1 : 0}|${sceneName || ''}`;

        if (!sceneMap.has(sceneKey)) {
          sceneMap.set(sceneKey, {
            name: sceneName || `Group ${group}`,
            group,
            controller,
            remove,
            responders: []
          });
        }

        sceneMap.get(sceneKey).responders.push(responder);
      } catch (error) {
        invalidEntries.push({
          source: `linkRecords[${index}]`,
          value: record,
          reason: error.message
        });
      }
    });

    return {
      scenes: Array.from(sceneMap.values()),
      invalidEntries
    };
  }

  _parseISYTopologyPayload(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const invalidEntries = [];

    let scenesInput = [];
    if (Array.isArray(request.scenes)) {
      scenesInput = scenesInput.concat(request.scenes);
    } else if (typeof request.scenes === 'string' && request.scenes.trim()) {
      try {
        const parsedScenes = JSON.parse(request.scenes);
        if (Array.isArray(parsedScenes)) {
          scenesInput = scenesInput.concat(parsedScenes);
        }
      } catch (error) {
        throw new Error('scenes must be valid JSON when provided as a string');
      }
    }

    if (Array.isArray(request.topology?.scenes)) {
      scenesInput = scenesInput.concat(request.topology.scenes);
    }

    if (Array.isArray(request.linkRecords)) {
      const converted = this._convertLinkRecordsToScenes(request.linkRecords);
      scenesInput = scenesInput.concat(converted.scenes);
      invalidEntries.push(...converted.invalidEntries);
    }

    const scenes = [];
    scenesInput.forEach((scene, index) => {
      try {
        if (!scene || typeof scene !== 'object') {
          throw new Error('Scene must be an object');
        }

        const name = typeof scene.name === 'string' && scene.name.trim()
          ? scene.name.trim()
          : (typeof scene.scene === 'string' && scene.scene.trim() ? scene.scene.trim() : `Scene ${index + 1}`);

        const group = Number(scene.group ?? scene.sceneGroup ?? DEFAULT_ISY_IMPORT_GROUP);
        if (!Number.isInteger(group) || group < 0 || group > 255) {
          throw new Error(`Invalid group ${scene.group}`);
        }

        const controller = this._normalizeTopologyParticipant(
          scene.controller || scene.controllerId || scene.source || 'gw',
          `scenes[${index}].controller`
        );

        const respondersInput = scene.responders || scene.members || scene.devices || [];
        if (!Array.isArray(respondersInput) || respondersInput.length === 0) {
          throw new Error('Scene must include at least one responder');
        }

        const responders = respondersInput.map((responder, responderIndex) =>
          this._parseTopologyResponder(responder, `scenes[${index}].responders[${responderIndex}]`)
        );

        scenes.push({
          name,
          group,
          controller,
          remove: Boolean(scene.remove),
          responders
        });
      } catch (error) {
        invalidEntries.push({
          source: `scenes[${index}]`,
          value: scene,
          reason: error.message
        });
      }
    });

    if (scenes.length === 0) {
      throw new Error('No valid ISY scene topology entries were found');
    }

    const pauseBetweenScenesMs = Number(request.pauseBetweenScenesMs ?? request.pauseBetweenMs ?? DEFAULT_ISY_TOPOLOGY_PAUSE_MS);
    if (!Number.isFinite(pauseBetweenScenesMs) || pauseBetweenScenesMs < 0 || pauseBetweenScenesMs > 10000) {
      throw new Error('ISY topology pauseBetweenScenesMs must be between 0 and 10000 milliseconds');
    }

    const sceneTimeoutMs = Number(request.sceneTimeoutMs ?? request.timeoutMs ?? DEFAULT_ISY_TOPOLOGY_SCENE_TIMEOUT_MS);
    if (!Number.isFinite(sceneTimeoutMs) || sceneTimeoutMs < 5000 || sceneTimeoutMs > 300000) {
      throw new Error('ISY topology sceneTimeoutMs must be between 5000 and 300000 milliseconds');
    }

    const responderFallback = request.responderFallback !== false
      && request.sceneResponderFallback !== false;

    return {
      scenes,
      invalidEntries,
      options: {
        dryRun: request.dryRun !== false,
        upsertDevices: request.upsertDevices !== false,
        continueOnError: request.continueOnError !== false,
        checkExistingSceneLinks: request.checkExistingSceneLinks !== false,
        responderFallback,
        pauseBetweenScenesMs,
        sceneTimeoutMs
      }
    };
  }

  _maskSecret(secret) {
    if (typeof secret !== 'string' || secret.length <= 4) {
      return secret || '';
    }
    return `${'*'.repeat(secret.length - 4)}${secret.slice(-4)}`;
  }

  _isMaskedSecretValue(value) {
    if (typeof value !== 'string') {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    if (/^[*•]+$/.test(trimmed)) {
      return true;
    }

    return /^[*•]{4,}[^*•\s]+$/.test(trimmed);
  }

  async _resolveISYConnection(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const settings = await Settings.getSettings();
    const settingsConnection = {
      host: settings.isyHost || '',
      port: settings.isyPort,
      username: settings.isyUsername || '',
      password: settings.isyPassword || '',
      useHttps: settings.isyUseHttps,
      ignoreTlsErrors: settings.isyIgnoreTlsErrors
    };

    const connectionInput = request.connection && typeof request.connection === 'object'
      ? request.connection
      : request;

    let rawHost = connectionInput.isyHost ?? connectionInput.host ?? settingsConnection.host;
    if (typeof rawHost !== 'string' || !rawHost.trim()) {
      throw new Error('ISY host is required. Configure settings.isyHost or pass host in request.');
    }
    rawHost = rawHost.trim();

    let useHttps = connectionInput.isyUseHttps;
    if (useHttps === undefined) {
      useHttps = connectionInput.useHttps;
    }
    if (useHttps === undefined) {
      useHttps = settingsConnection.useHttps;
    }
    if (useHttps === undefined) {
      useHttps = true;
    }
    useHttps = Boolean(useHttps);

    let parsedHost = rawHost;
    const schemeMatch = rawHost.match(/^(https?):\/\//i);
    if (schemeMatch) {
      useHttps = schemeMatch[1].toLowerCase() === 'https';
      try {
        const parsedUrl = new URL(rawHost);
        parsedHost = parsedUrl.hostname;
        if (connectionInput.isyPort === undefined && connectionInput.port === undefined && parsedUrl.port) {
          connectionInput.port = Number(parsedUrl.port);
        }
      } catch (error) {
        throw new Error(`Invalid ISY host URL: ${rawHost}`);
      }
    } else {
      parsedHost = rawHost.replace(/\/+$/, '');
      if (parsedHost.includes('/')) {
        parsedHost = parsedHost.split('/')[0];
      }
    }

    const portRaw = connectionInput.isyPort ?? connectionInput.port ?? settingsConnection.port;
    let port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      port = useHttps ? DEFAULT_ISY_PORT_HTTPS : DEFAULT_ISY_PORT_HTTP;
    }

    const username = String(connectionInput.isyUsername ?? connectionInput.username ?? settingsConnection.username ?? '').trim();

    const hasExplicitPasswordInput = connectionInput.isyPassword !== undefined || connectionInput.password !== undefined;
    const explicitPasswordRaw = hasExplicitPasswordInput
      ? String(connectionInput.isyPassword ?? connectionInput.password ?? '')
      : '';
    const storedPasswordRaw = String(settingsConnection.password ?? '');
    const explicitPassword = this._isMaskedSecretValue(explicitPasswordRaw) ? '' : explicitPasswordRaw;
    const storedPassword = this._isMaskedSecretValue(storedPasswordRaw) ? '' : storedPasswordRaw;
    const password = explicitPassword || storedPassword;

    if (!username || !password) {
      if (username && !password && this._isMaskedSecretValue(storedPasswordRaw)) {
        throw new Error('ISY credentials are required. Stored ISY password appears masked; re-enter the ISY password in Settings and save.');
      }
      throw new Error('ISY credentials are required (username and password)');
    }

    let ignoreTlsErrors = connectionInput.isyIgnoreTlsErrors;
    if (ignoreTlsErrors === undefined) {
      ignoreTlsErrors = connectionInput.ignoreTlsErrors;
    }
    if (ignoreTlsErrors === undefined) {
      ignoreTlsErrors = settingsConnection.ignoreTlsErrors;
    }
    if (ignoreTlsErrors === undefined) {
      ignoreTlsErrors = true;
    }
    ignoreTlsErrors = Boolean(ignoreTlsErrors);

    const shouldPersistConnection = request.persistConnection === true || connectionInput.persistConnection === true;
    if (shouldPersistConnection) {
      const settingsUpdates = {
        isyHost: parsedHost,
        isyPort: port,
        isyUsername: username,
        isyUseHttps: useHttps,
        isyIgnoreTlsErrors: ignoreTlsErrors
      };

      if (hasExplicitPasswordInput && explicitPasswordRaw.trim() && !this._isMaskedSecretValue(explicitPasswordRaw)) {
        settingsUpdates.isyPassword = explicitPasswordRaw;
      }

      try {
        await Settings.updateSettings(settingsUpdates);
      } catch (error) {
        console.warn(`InsteonService: Failed to persist ISY connection settings: ${error.message}`);
      }
    }

    return {
      host: parsedHost,
      port,
      username,
      password,
      useHttps,
      ignoreTlsErrors
    };
  }

  _isyBaseUrl(connection) {
    return `${connection.useHttps ? 'https' : 'http'}://${connection.host}:${connection.port}`;
  }

  _extractXmlAttr(attributesRaw, attrName, fallback = '') {
    if (typeof attributesRaw !== 'string') {
      return fallback;
    }

    const regex = new RegExp(`\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i');
    const match = attributesRaw.match(regex);
    return match ? match[1] : fallback;
  }

  _extractXmlTagValue(xmlFragment, tagName, fallback = '') {
    if (typeof xmlFragment !== 'string') {
      return fallback;
    }
    const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = xmlFragment.match(regex);
    if (!match) {
      return fallback;
    }
    return match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\'')
      .trim();
  }

  _normalizePossibleInsteonAddress(rawValue) {
    if (rawValue === null || rawValue === undefined) {
      return null;
    }

    const input = String(rawValue).trim();
    if (!input) {
      return null;
    }

    try {
      return this._normalizeInsteonAddress(input);
    } catch (error) {
      // Continue with ISY-specific fallback parsing.
    }

    // ISY node addresses often include child suffixes (for example: AA.BB.CC.1 or AA.BB.CC.1D).
    const tokenized = input
      .toUpperCase()
      .split(/[^0-9A-F]+/)
      .filter(Boolean);

    if (tokenized.length >= 3 && tokenized[0].length === 2 && tokenized[1].length === 2 && tokenized[2].length === 2) {
      return `${tokenized[0]}${tokenized[1]}${tokenized[2]}`;
    }

    return null;
  }

  _coerceNumericValue(value, fallback = 0) {
    if (Number.isInteger(value)) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return fallback;
      }
      if (/^0x[0-9a-f]+$/i.test(trimmed)) {
        const parsedHex = Number.parseInt(trimmed, 16);
        return Number.isInteger(parsedHex) ? parsedHex : fallback;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    }
    return fallback;
  }

  _normalizeInsteonInfoPayload(info = {}, fallbackAddress = null) {
    const rawInfo = info && typeof info === 'object' ? info : {};

    const rawDeviceId = rawInfo.deviceId
      || rawInfo.id
      || rawInfo.address
      || rawInfo.imAddress
      || rawInfo.insteonAddress
      || fallbackAddress;

    const normalizedDeviceId = this._normalizePossibleInsteonAddress(rawDeviceId);
    const rawCategory = rawInfo.deviceCategory;
    const rawSubcategory = rawInfo.subcategory ?? rawInfo.deviceSubCategory;

    const normalized = {
      deviceId: normalizedDeviceId || null,
      firmwareVersion: String(rawInfo.firmwareVersion ?? rawInfo.firmware ?? rawInfo.version ?? 'Unknown'),
      deviceCategory: this._coerceNumericValue(
        rawCategory && typeof rawCategory === 'object' ? rawCategory.id : rawCategory,
        0
      ),
      subcategory: this._coerceNumericValue(
        rawSubcategory && typeof rawSubcategory === 'object' ? rawSubcategory.id : rawSubcategory,
        0
      )
    };

    const productKey = rawInfo.productKey ?? rawInfo.productCode ?? rawInfo.product;
    if (typeof productKey === 'string' && productKey.trim()) {
      normalized.productKey = productKey.trim();
    }

    return normalized;
  }

  _deriveTopologyGroupNumber(groupAddress, usedGroups = new Set()) {
    const normalized = String(groupAddress || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    const candidates = [];

    if (/^\d+$/.test(String(groupAddress || '').trim())) {
      const decimal = Number(groupAddress);
      if (Number.isInteger(decimal) && decimal >= 0 && decimal <= 255) {
        candidates.push(decimal);
      }
    }

    if (/^[0-9A-F]+$/.test(normalized) && normalized.length > 0) {
      const asHex = parseInt(normalized, 16);
      if (Number.isInteger(asHex) && asHex >= 0 && asHex <= 255) {
        candidates.push(asHex);
      }
      if (normalized.length >= 2) {
        const lowByte = parseInt(normalized.slice(-2), 16);
        if (Number.isInteger(lowByte) && lowByte >= 0 && lowByte <= 255) {
          candidates.push(lowByte);
        }
      }
    }

    for (const candidate of candidates) {
      if (!usedGroups.has(candidate)) {
        usedGroups.add(candidate);
        return candidate;
      }
    }

    for (let fallback = 1; fallback <= 255; fallback += 1) {
      if (!usedGroups.has(fallback)) {
        usedGroups.add(fallback);
        return fallback;
      }
    }

    return 1;
  }

  _parseISYNodesXml(xml = '') {
    if (typeof xml !== 'string' || !xml.trim()) {
      throw new Error('ISY nodes response is empty');
    }

    const deviceRegex = /<node\b([^>]*)>([\s\S]*?)<\/node>/gi;
    const groupRegex = /<group\b([^>]*)>([\s\S]*?)<\/group>/gi;
    const linkRegex = /<link\b([^>]*)>([\s\S]*?)<\/link>/gi;
    const devices = [];
    const groups = [];

    let match;
    while ((match = deviceRegex.exec(xml)) !== null) {
      const attrs = match[1] || '';
      const body = match[2] || '';
      const rawAddress = this._extractXmlTagValue(body, 'address', '');
      const parent = this._extractXmlTagValue(body, 'parent', '');
      const pnode = this._extractXmlTagValue(body, 'pnode', '');
      const normalizedAddress = this._normalizePossibleInsteonAddress(rawAddress);
      const normalizedParent = this._normalizePossibleInsteonAddress(parent);
      const normalizedPnode = this._normalizePossibleInsteonAddress(pnode);

      devices.push({
        address: rawAddress,
        resolvedAddress: normalizedAddress || normalizedParent || normalizedPnode,
        normalizedAddress,
        normalizedParent,
        normalizedPnode,
        name: this._extractXmlTagValue(body, 'name', ''),
        family: this._extractXmlTagValue(body, 'family', ''),
        type: this._extractXmlTagValue(body, 'type', ''),
        parent,
        pnode,
        enabled: this._extractXmlTagValue(body, 'enabled', this._extractXmlAttr(attrs, 'enabled', 'true')) === 'true',
        flag: Number(this._extractXmlAttr(attrs, 'flag', '0')) || 0
      });
    }

    while ((match = groupRegex.exec(xml)) !== null) {
      const attrs = match[1] || '';
      const body = match[2] || '';
      const rawAddress = this._extractXmlTagValue(body, 'address', '');
      const members = [];
      const controllers = [];
      let linkMatch;

      while ((linkMatch = linkRegex.exec(body)) !== null) {
        const linkAttrs = linkMatch[1] || '';
        const linkAddressRaw = linkMatch[2] ? linkMatch[2].trim() : '';
        const normalized = this._normalizePossibleInsteonAddress(linkAddressRaw);
        if (!normalized) {
          continue;
        }
        members.push(normalized);
        const linkType = Number(this._extractXmlAttr(linkAttrs, 'type', '0'));
        if (linkType === 1) {
          controllers.push(normalized);
        }
      }

      groups.push({
        address: rawAddress,
        name: this._extractXmlTagValue(body, 'name', ''),
        parent: this._extractXmlTagValue(body, 'parent', ''),
        pnode: this._extractXmlTagValue(body, 'pnode', ''),
        flag: Number(this._extractXmlAttr(attrs, 'flag', '0')) || 0,
        members: Array.from(new Set(members)),
        controllers: Array.from(new Set(controllers))
      });
    }

    return {
      devices,
      groups
    };
  }

  _parseISYProgramsXml(xml = '') {
    if (typeof xml !== 'string' || !xml.trim()) {
      return [];
    }

    const programRegex = /<program\b([^>]*)>([\s\S]*?)<\/program>/gi;
    const programs = [];
    let match;
    while ((match = programRegex.exec(xml)) !== null) {
      const attrs = match[1] || '';
      const body = match[2] || '';
      const isFolder = this._extractXmlAttr(attrs, 'folder', 'false') === 'true';
      if (isFolder) {
        continue;
      }

      const id = this._extractXmlAttr(attrs, 'id', '');
      const name = this._extractXmlTagValue(body, 'name', id || 'Unnamed Program');
      const enabled = this._extractXmlAttr(attrs, 'enabled', 'false') === 'true';
      const runAtStartup = this._extractXmlAttr(attrs, 'runAtStartup', 'false') === 'true';
      const status = this._extractXmlAttr(attrs, 'status', 'false') === 'true';
      const parentId = this._extractXmlAttr(attrs, 'parentId', '');
      const lastRunTime = this._extractXmlTagValue(body, 'lastRunTime', '');
      const lastFinishTime = this._extractXmlTagValue(body, 'lastFinishTime', '');
      const ifRaw = this._extractISYProgramSection(body, 'if');
      const thenRaw = this._extractISYProgramSection(body, 'then');
      const elseRaw = this._extractISYProgramSection(body, 'else');
      const ifLines = this._extractISYProgramLines(ifRaw);
      const thenLines = this._extractISYProgramLines(thenRaw);
      const elseLines = this._extractISYProgramLines(elseRaw);

      programs.push({
        id,
        name,
        enabled,
        runAtStartup,
        status,
        parentId,
        lastRunTime,
        lastFinishTime,
        ifRaw,
        thenRaw,
        elseRaw,
        ifLines,
        thenLines,
        elseLines
      });
    }

    return programs;
  }

  _parseISYNetworkResourcesXml(xml = '') {
    if (typeof xml !== 'string' || !xml.trim()) {
      return [];
    }

    const resources = [];
    const seen = new Set();
    const parseHeaderMap = (rawHeaders = '') => {
      if (typeof rawHeaders !== 'string' || !rawHeaders.trim()) {
        return {};
      }

      const headerMap = {};
      rawHeaders
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const separator = line.indexOf(':');
          if (separator <= 0) {
            return;
          }
          const name = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim();
          if (!name) {
            return;
          }
          headerMap[name] = value;
        });

      return headerMap;
    };

    const parseControlInfo = (body = '') => {
      const controlInfoBody = this._extractXmlTagValue(body, 'ControlInfo', '');
      const source = controlInfoBody || body;

      const protocol = this._extractXmlTagValue(source, 'protocol', '').toLowerCase();
      const host = this._extractXmlTagValue(source, 'host', '');
      const portRaw = this._extractXmlTagValue(source, 'port', '');
      const portNumeric = Number(portRaw);
      const method = this._extractXmlTagValue(source, 'method', '');
      const path = this._extractXmlTagValue(source, 'path',
        this._extractXmlTagValue(source, 'uri',
          this._extractXmlTagValue(source, 'resource', '')));
      const url = this._extractXmlTagValue(source, 'url',
        this._extractXmlTagValue(source, 'requestUrl',
          this._extractXmlTagValue(source, 'address', '')));
      const timeoutRaw = this._extractXmlTagValue(source, 'timeout', '');
      const timeoutNumeric = Number(timeoutRaw);
      const payload = this._extractXmlTagValue(source, 'data',
        this._extractXmlTagValue(source, 'body',
          this._extractXmlTagValue(source, 'content', '')));
      const headersRaw = this._extractXmlTagValue(source, 'headers', this._extractXmlTagValue(source, 'header', ''));
      const headerMap = parseHeaderMap(headersRaw);

      const namedHeaderRegex = /<header\b([^>]*)>([\s\S]*?)<\/header>/gi;
      let headerMatch;
      while ((headerMatch = namedHeaderRegex.exec(source)) !== null) {
        const headerAttrs = headerMatch[1] || '';
        const headerName = this._extractXmlAttr(headerAttrs, 'name', this._extractXmlAttr(headerAttrs, 'key', '')).trim();
        if (!headerName) {
          continue;
        }
        headerMap[headerName] = String(headerMatch[2] || '').trim();
      }

      const controlInfo = {};
      if (protocol) {
        controlInfo.protocol = protocol;
      }
      if (host) {
        controlInfo.host = host;
      }
      if (Number.isInteger(portNumeric) && portNumeric > 0 && portNumeric <= 65535) {
        controlInfo.port = portNumeric;
      }
      if (method) {
        controlInfo.method = method;
      }
      if (path) {
        controlInfo.path = path;
      }
      if (url) {
        controlInfo.url = url;
      }
      if (Number.isFinite(timeoutNumeric) && timeoutNumeric > 0) {
        controlInfo.timeout = Math.round(timeoutNumeric);
      }
      if (payload) {
        controlInfo.payload = payload;
      }
      if (Object.keys(headerMap).length > 0) {
        controlInfo.headers = headerMap;
      }

      return controlInfo;
    };

    const pushResource = (attrs = '', body = '') => {
      const idCandidates = [
        this._extractXmlAttr(attrs, 'id', ''),
        this._extractXmlAttr(attrs, 'resourceId', ''),
        this._extractXmlAttr(attrs, 'rid', ''),
        this._extractXmlTagValue(body, 'id', ''),
        this._extractXmlTagValue(body, 'resourceId', ''),
        this._extractXmlTagValue(body, 'rid', ''),
        this._extractXmlTagValue(body, 'id_20', '')
      ];
      const nameCandidates = [
        this._extractXmlTagValue(body, 'name', ''),
        this._extractXmlAttr(attrs, 'name', ''),
        this._extractXmlTagValue(body, 'label', ''),
        this._extractXmlAttr(attrs, 'label', ''),
        this._extractXmlTagValue(body, 'title', ''),
        this._extractXmlAttr(attrs, 'title', ''),
        this._extractXmlTagValue(body, 'sName', '')
      ];

      const id = idCandidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || '';
      const rawName = nameCandidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || '';
      const name = rawName || (id ? `Resource ${id}` : '');
      if (!id && !name) {
        return;
      }

      const normalizedName = this._normalizeISYLookupKey(name);
      const dedupeKey = id ? `id:${id}` : `name:${normalizedName}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      const controlInfo = parseControlInfo(body);
      const enabledRaw = this._extractXmlTagValue(body, 'enabled', this._extractXmlAttr(attrs, 'enabled', 'true'));
      resources.push({
        id: id || null,
        name,
        enabled: String(enabledRaw || 'true').trim().toLowerCase() !== 'false',
        method: controlInfo.method || this._extractXmlTagValue(body, 'method', this._extractXmlAttr(attrs, 'method', '')),
        url: controlInfo.url || this._extractXmlTagValue(body, 'url', this._extractXmlAttr(attrs, 'url', '')),
        controlInfo
      });
    };

    const resourceRegex = /<resource\b([^>]*)>([\s\S]*?)<\/resource>/gi;
    const netRuleRegex = /<NetRule\b([^>]*)>([\s\S]*?)<\/NetRule>/gi;
    let match;
    while ((match = resourceRegex.exec(xml)) !== null) {
      pushResource(match[1] || '', match[2] || '');
    }
    while ((match = netRuleRegex.exec(xml)) !== null) {
      pushResource(match[1] || '', match[2] || '');
    }

    const selfClosingRegex = /<resource\b([^>]*)\/>/gi;
    const selfClosingNetRuleRegex = /<NetRule\b([^>]*)\/>/gi;
    while ((match = selfClosingRegex.exec(xml)) !== null) {
      pushResource(match[1] || '', '');
    }
    while ((match = selfClosingNetRuleRegex.exec(xml)) !== null) {
      pushResource(match[1] || '', '');
    }

    return resources;
  }

  async _fetchISYNetworkResources(connection) {
    const paths = [
      '/rest/networking/resources',
      '/rest/networking/resources/'
    ];
    let lastError = null;

    for (const resourcePath of paths) {
      try {
        const resourcesXml = await this._requestISYResource(connection, resourcePath);
        return this._parseISYNetworkResourcesXml(resourcesXml);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Unable to fetch ISY network resources');
  }

  _extractISYProgramSection(programBody = '', tagName = '') {
    if (typeof programBody !== 'string' || !programBody.trim() || typeof tagName !== 'string' || !tagName.trim()) {
      return '';
    }

    return this._extractXmlTagValue(programBody, tagName.trim(), '');
  }

  _extractISYProgramLines(section = '') {
    if (typeof section !== 'string' || !section.trim()) {
      return [];
    }

    const normalized = section
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(li|p|div|tr|td|th)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'');

    return normalized
      .split(/\r?\n+/)
      .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^-?\s*no actions?/i.test(line))
      .filter((line) => !/to add one, press ['"]?action['"]?/i.test(line));
  }

  _buildTopologyScenesFromISYGroups(groups = []) {
    const scenes = [];
    const usedGroups = new Set();

    groups.forEach((group, index) => {
      const members = Array.isArray(group.members) ? Array.from(new Set(group.members)) : [];
      if (members.length === 0) {
        return;
      }

      const controllers = Array.isArray(group.controllers) && group.controllers.length > 0
        ? Array.from(new Set(group.controllers))
        : ['gw'];
      const groupNumber = this._deriveTopologyGroupNumber(group.address || index + 1, usedGroups);
      const baseName = group.name || `ISY Scene ${index + 1}`;
      const multipleControllers = controllers.length > 1;

      controllers.forEach((controller) => {
        const normalizedController = controller === 'gw' ? 'gw' : this._normalizePossibleInsteonAddress(controller);
        if (!normalizedController) {
          return;
        }

        const responders = members
          .filter((member) => member !== normalizedController)
          .map((member) => ({ id: member }));
        if (responders.length === 0) {
          return;
        }

        const controllerLabel = normalizedController === 'gw'
          ? 'GW'
          : this._formatInsteonAddress(normalizedController);

        scenes.push({
          name: multipleControllers ? `${baseName} (${controllerLabel})` : baseName,
          group: groupNumber,
          controller: normalizedController,
          responders
        });
      });
    });

    return scenes;
  }

  async _requestISYResource(connection, resourcePath) {
    const sanitizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
    const url = `${this._isyBaseUrl(connection)}${sanitizedPath}`;

    const requestConfig = {
      timeout: 15000,
      responseType: 'text',
      auth: {
        username: connection.username,
        password: connection.password
      },
      validateStatus: (status) => status >= 200 && status < 300
    };

    if (connection.useHttps) {
      requestConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: !connection.ignoreTlsErrors
      });
    }

    try {
      const response = await axios.get(url, requestConfig);
      return typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
      const status = error.response?.status;
      let detail = status ? `HTTP ${status}` : error.message;
      if (status === 401) {
        detail = 'HTTP 401 (unauthorized; verify ISY username/password. If the password field is masked, re-enter and save the real password.)';
      }
      throw new Error(`ISY request failed for ${sanitizedPath}: ${detail}`);
    }
  }

  _isHttp404Error(error) {
    return /HTTP 404/i.test(String(error?.message || ''));
  }

  async _probeISYConnection(connection) {
    const probePaths = [
      '/rest/ping',
      '/rest/config',
      '/rest/nodes?members=false',
      '/rest/nodes'
    ];

    let lastError = null;
    for (const probePath of probePaths) {
      try {
        await this._requestISYResource(connection, probePath);
        return {
          path: probePath,
          usedFallback: probePath !== '/rest/ping'
        };
      } catch (error) {
        lastError = error;
        if (!this._isHttp404Error(error)) {
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Unable to validate ISY REST connectivity');
  }

  _mergeISYProgramDetail(baseProgram, detailProgram) {
    if (!detailProgram || typeof detailProgram !== 'object') {
      return baseProgram;
    }

    return {
      ...baseProgram,
      ifRaw: detailProgram.ifRaw || baseProgram.ifRaw || '',
      thenRaw: detailProgram.thenRaw || baseProgram.thenRaw || '',
      elseRaw: detailProgram.elseRaw || baseProgram.elseRaw || '',
      ifLines: Array.isArray(detailProgram.ifLines) && detailProgram.ifLines.length > 0
        ? detailProgram.ifLines
        : (baseProgram.ifLines || []),
      thenLines: Array.isArray(detailProgram.thenLines) && detailProgram.thenLines.length > 0
        ? detailProgram.thenLines
        : (baseProgram.thenLines || []),
      elseLines: Array.isArray(detailProgram.elseLines) && detailProgram.elseLines.length > 0
        ? detailProgram.elseLines
        : (baseProgram.elseLines || [])
    };
  }

  async _fetchISYProgramDetail(connection, programId) {
    if (!programId) {
      return null;
    }

    const encodedId = encodeURIComponent(String(programId));
    const paths = [
      `/rest/programs/${encodedId}?subfolders=false`,
      `/rest/programs/${encodedId}?folderContents=false`,
      `/rest/programs/${encodedId}`
    ];

    for (const pathCandidate of paths) {
      try {
        const detailXml = await this._requestISYResource(connection, pathCandidate);
        const detailPrograms = this._parseISYProgramsXml(detailXml);
        if (!Array.isArray(detailPrograms) || detailPrograms.length === 0) {
          continue;
        }

        const byId = detailPrograms.find((entry) => String(entry.id || '') === String(programId));
        return byId || detailPrograms[0];
      } catch (error) {
        // Continue to next candidate endpoint.
      }
    }

    return null;
  }

  async _enrichISYProgramsWithDetails(connection, programs = []) {
    if (!Array.isArray(programs) || programs.length === 0) {
      return [];
    }

    const enriched = [];
    for (const program of programs) {
      if (!program || !program.id) {
        enriched.push(program);
        continue;
      }

      const detail = await this._fetchISYProgramDetail(connection, program.id);
      if (!detail) {
        enriched.push(program);
        continue;
      }

      enriched.push(this._mergeISYProgramDetail(program, detail));
    }

    return enriched;
  }

  async extractISYData(payload = {}) {
    const connection = await this._resolveISYConnection(payload);
    const fetchWithFallback = async (primaryPath, fallbackPath) => {
      try {
        return await this._requestISYResource(connection, primaryPath);
      } catch (primaryError) {
        if (!fallbackPath) {
          throw primaryError;
        }
        return this._requestISYResource(connection, fallbackPath);
      }
    };

    const [nodesXml, programsXml, networkResources] = await Promise.all([
      // Prefer full node listing first so ISY subnodes (button/load endpoints) are included.
      fetchWithFallback('/rest/nodes', '/rest/nodes?members=false'),
      fetchWithFallback('/rest/programs?subfolders=true', '/rest/programs'),
      this._fetchISYNetworkResources(connection).catch((error) => {
        console.warn(`InsteonService: ISY network resource extraction unavailable: ${error.message}`);
        return [];
      })
    ]);

    const nodeData = this._parseISYNodesXml(nodesXml);
    const basePrograms = this._parseISYProgramsXml(programsXml);
    const programs = await this._enrichISYProgramsWithDetails(connection, basePrograms);
    const insteonNodes = nodeData.devices.filter((node) => this._isISYInsteonNode(node));
    const excludedNodes = nodeData.devices.length - insteonNodes.length;
    const deviceIds = insteonNodes
      .map((device) => this._normalizePossibleInsteonAddress(
        device?.resolvedAddress
        || device?.normalizedAddress
        || device?.normalizedParent
        || device?.normalizedPnode
        || device?.address
        || device?.parent
        || device?.pnode
      ))
      .filter(Boolean);
    const uniqueDeviceIds = Array.from(new Set(deviceIds));
    const topologyScenes = this._buildTopologyScenesFromISYGroups(nodeData.groups);

    return {
      connection: {
        host: connection.host,
        port: connection.port,
        useHttps: connection.useHttps,
        ignoreTlsErrors: connection.ignoreTlsErrors,
        username: connection.username,
        passwordMasked: this._maskSecret(connection.password)
      },
      devices: insteonNodes,
      excludedNodes,
      groups: nodeData.groups,
      programs,
      networkResources,
      deviceIds: uniqueDeviceIds,
      topologyScenes,
      counts: {
        nodes: nodeData.devices.length,
        insteonNodes: insteonNodes.length,
        excludedNonInsteonNodes: excludedNodes,
        groups: nodeData.groups.length,
        programs: programs.length,
        networkResources: networkResources.length,
        programsWithLogicBlocks: programs.filter((program) =>
          (Array.isArray(program.ifLines) && program.ifLines.length > 0)
          || (Array.isArray(program.thenLines) && program.thenLines.length > 0)
          || (Array.isArray(program.elseLines) && program.elseLines.length > 0)
        ).length,
        uniqueDeviceIds: uniqueDeviceIds.length,
        topologyScenes: topologyScenes.length
      }
    };
  }

  _isyProgramMarker(programId) {
    return `[ISY_PROGRAM_ID:${programId}]`;
  }

  _isyProgramElseMarker(programId) {
    return `[ISY_PROGRAM_ID:${programId}][ISY_PROGRAM_PATH:ELSE]`;
  }

  _escapeRegexLiteral(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _normalizeISYLookupKey(value = '') {
    return String(value || '')
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  _extractPotentialInsteonAddress(token = '') {
    const direct = this._normalizePossibleInsteonAddress(token);
    if (direct) {
      return direct;
    }

    const match = String(token || '').toUpperCase().match(/([0-9A-F]{2})[^0-9A-F]?([0-9A-F]{2})[^0-9A-F]?([0-9A-F]{2})/);
    if (!match) {
      return null;
    }
    return this._normalizePossibleInsteonAddress(`${match[1]}${match[2]}${match[3]}`);
  }

  _isAddressLikeISYName(value = '') {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return false;
    }

    return Boolean(this._normalizePossibleInsteonAddress(trimmed));
  }

  _sanitizeISYDeviceName(value = '') {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return null;
    }

    if (this._isAddressLikeISYName(trimmed)) {
      return null;
    }

    return trimmed;
  }

  _buildISYDeviceReplayList(devices = []) {
    const byAddress = new Map();

    (Array.isArray(devices) ? devices : []).forEach((device) => {
      const address = this._normalizePossibleInsteonAddress(
        device?.resolvedAddress
        || device?.normalizedAddress
        || device?.normalizedParent
        || device?.normalizedPnode
        || device?.address
        || device?.parent
        || device?.pnode
      );

      if (!address) {
        return;
      }

      const candidateName = this._sanitizeISYDeviceName(device?.name || device?.displayName || '');
      if (!byAddress.has(address)) {
        byAddress.set(address, { address, name: candidateName });
        return;
      }

      const existing = byAddress.get(address);
      if (!existing?.name && candidateName) {
        existing.name = candidateName;
        return;
      }

      if (existing?.name && candidateName) {
        const existingLooksAddressLike = this._isAddressLikeISYName(existing.name);
        const candidateLooksAddressLike = this._isAddressLikeISYName(candidateName);
        if (existingLooksAddressLike && !candidateLooksAddressLike) {
          existing.name = candidateName;
        }
      }
    });

    return Array.from(byAddress.values()).map((entry) => ({
      address: entry.address,
      name: entry.name || undefined
    }));
  }

  async _buildISYProgramLookup(programs = [], options = {}) {
    const [devices, scenes] = await Promise.all([
      Device.find({}).select('_id name type properties').lean(),
      Scene.find({}).select('_id name deviceActions').lean()
    ]);
    const resources = Array.isArray(options.resources) ? options.resources : [];

    const devicesByAddress = new Map();
    const devicesByName = new Map();
    const devicesById = new Map();
    devices.forEach((device) => {
      if (!device || !device._id) {
        return;
      }

      const deviceId = device._id.toString();
      devicesById.set(deviceId, device);

      const normalizedName = this._normalizeISYLookupKey(device.name || '');
      if (normalizedName && !devicesByName.has(normalizedName)) {
        devicesByName.set(normalizedName, device);
      }

      const rawAddress = device?.properties?.insteonAddress;
      const normalizedAddress = this._normalizePossibleInsteonAddress(rawAddress);
      if (normalizedAddress && !devicesByAddress.has(normalizedAddress)) {
        devicesByAddress.set(normalizedAddress, device);
      }
    });

    const scenesByName = new Map();
    scenes.forEach((scene) => {
      if (!scene || !scene._id) {
        return;
      }
      const normalizedName = this._normalizeISYLookupKey(scene.name || '');
      if (normalizedName && !scenesByName.has(normalizedName)) {
        scenesByName.set(normalizedName, scene);
      }
    });

    const programsByName = new Map();
    const programsById = new Map();
    (Array.isArray(programs) ? programs : []).forEach((program) => {
      if (!program || !program.id) {
        return;
      }
      programsById.set(String(program.id), program);
      const normalizedName = this._normalizeISYLookupKey(program.name || '');
      if (normalizedName && !programsByName.has(normalizedName)) {
        programsByName.set(normalizedName, program);
      }
    });

    const resourcesByName = new Map();
    const resourcesById = new Map();
    resources.forEach((resource) => {
      if (!resource || typeof resource !== 'object') {
        return;
      }

      const id = String(resource.id || '').trim();
      const name = String(resource.name || '').trim();
      const normalizedName = this._normalizeISYLookupKey(name);

      if (id && !resourcesById.has(id)) {
        resourcesById.set(id, resource);
      }
      if (id && /^\d+$/.test(id)) {
        const canonicalNumericId = String(Number(id));
        if (!resourcesById.has(canonicalNumericId)) {
          resourcesById.set(canonicalNumericId, resource);
        }
      }
      if (normalizedName && !resourcesByName.has(normalizedName)) {
        resourcesByName.set(normalizedName, resource);
      }
    });

    return {
      devicesByAddress,
      devicesByName,
      devicesById,
      scenesByName,
      programsByName,
      programsById,
      resourcesByName,
      resourcesById
    };
  }

  _resolveISYProgram(token = '', lookup = {}) {
    const normalizedToken = this._normalizeISYLookupKey(token);
    if (!normalizedToken) {
      return null;
    }

    if (lookup.programsByName instanceof Map && lookup.programsByName.has(normalizedToken)) {
      return lookup.programsByName.get(normalizedToken);
    }

    if (lookup.programsById instanceof Map && lookup.programsById.has(String(token).trim())) {
      return lookup.programsById.get(String(token).trim());
    }

    return null;
  }

  _normalizeISYVariableKey(value = '') {
    return String(value || '')
      .trim()
      .replace(/^\$/, '')
      .toLowerCase();
  }

  _parseISYClockValue(token = '') {
    const trimmed = String(token || '').trim();
    if (!trimmed) {
      return null;
    }

    const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i);
    if (!match) {
      return null;
    }

    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = String(match[3] || '').toLowerCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }

    if (meridiem === 'pm' && hour < 12) {
      hour += 12;
    } else if (meridiem === 'am' && hour === 12) {
      hour = 0;
    }

    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  _parseISYDurationSeconds(token = '') {
    const normalized = String(token || '').trim();
    if (!normalized) {
      return null;
    }

    const regex = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|times?)/ig;
    let totalSeconds = 0;
    let matched = false;
    let match;
    while ((match = regex.exec(normalized)) !== null) {
      const amount = Number(match[1]);
      const unit = String(match[2] || '').toLowerCase();
      if (!Number.isFinite(amount)) {
        continue;
      }
      matched = true;
      if (unit.startsWith('hour') || unit.startsWith('hr')) {
        totalSeconds += amount * 3600;
      } else if (unit.startsWith('min')) {
        totalSeconds += amount * 60;
      } else if (unit.startsWith('sec')) {
        totalSeconds += amount;
      }
    }

    if (matched) {
      return Math.max(0, Math.round(totalSeconds));
    }

    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.round(numeric));
    }

    return null;
  }

  _extractISYProgramDays(lines = []) {
    const joined = Array.isArray(lines) ? lines.join(' ') : String(lines || '');
    const dayAliases = new Map([
      ['mon', 'monday'],
      ['monday', 'monday'],
      ['tue', 'tuesday'],
      ['tues', 'tuesday'],
      ['tuesday', 'tuesday'],
      ['wed', 'wednesday'],
      ['wednesday', 'wednesday'],
      ['thu', 'thursday'],
      ['thur', 'thursday'],
      ['thurs', 'thursday'],
      ['thursday', 'thursday'],
      ['fri', 'friday'],
      ['friday', 'friday'],
      ['sat', 'saturday'],
      ['saturday', 'saturday'],
      ['sun', 'sunday'],
      ['sunday', 'sunday']
    ]);

    if (/\bon\s+never\b/i.test(joined)) {
      return [];
    }

    const dayMatches = joined.match(/\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi) || [];
    return Array.from(new Set(dayMatches
      .map((day) => dayAliases.get(day.toLowerCase()))
      .filter(Boolean)));
  }

  _parseISYVariableValueToken(token = '') {
    const trimmed = String(token || '').trim();
    if (!trimmed) {
      return { kind: 'literal', value: 0 };
    }

    const randomMatch = trimmed.match(/^random\s+(.+)$/i);
    if (randomMatch) {
      return {
        kind: 'random',
        max: this._parseISYVariableValueToken(randomMatch[1])
      };
    }

    if (/^\$/.test(trimmed)) {
      return {
        kind: 'variable',
        name: this._normalizeISYVariableKey(trimmed)
      };
    }

    if (/^(true|false)$/i.test(trimmed)) {
      return {
        kind: 'literal',
        value: trimmed.toLowerCase() === 'true'
      };
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return {
        kind: 'literal',
        value: numeric
      };
    }

    return {
      kind: 'literal',
      value: trimmed
    };
  }

  _resolveISYProgramDevice(token = '', lookup = {}) {
    const normalizedToken = this._normalizeISYLookupKey(token);
    const normalizedAddress = this._extractPotentialInsteonAddress(token);

    if (normalizedAddress && lookup.devicesByAddress instanceof Map && lookup.devicesByAddress.has(normalizedAddress)) {
      return lookup.devicesByAddress.get(normalizedAddress);
    }

    if (normalizedToken && lookup.devicesByName instanceof Map && lookup.devicesByName.has(normalizedToken)) {
      return lookup.devicesByName.get(normalizedToken);
    }

    return null;
  }

  _resolveISYProgramScene(token = '', lookup = {}) {
    const normalizedToken = this._normalizeISYLookupKey(token);
    if (normalizedToken && lookup.scenesByName instanceof Map && lookup.scenesByName.has(normalizedToken)) {
      return lookup.scenesByName.get(normalizedToken);
    }
    return null;
  }

  _resolveISYNetworkResource(token = '', lookup = {}) {
    const rawToken = String(token || '').replace(/^['"]|['"]$/g, '').trim();
    if (!rawToken) {
      return null;
    }

    if (lookup.resourcesById instanceof Map) {
      if (lookup.resourcesById.has(rawToken)) {
        return lookup.resourcesById.get(rawToken);
      }
      if (/^\d+$/.test(rawToken)) {
        const canonicalNumericId = String(Number(rawToken));
        if (lookup.resourcesById.has(canonicalNumericId)) {
          return lookup.resourcesById.get(canonicalNumericId);
        }
      }
    }

    const normalizedToken = this._normalizeISYLookupKey(rawToken);
    if (normalizedToken && lookup.resourcesByName instanceof Map && lookup.resourcesByName.has(normalizedToken)) {
      return lookup.resourcesByName.get(normalizedToken);
    }

    return null;
  }

  _normalizeHttpMethod(method = 'GET') {
    const normalized = String(method || '').trim().toUpperCase();
    if (!normalized) {
      return 'GET';
    }

    if (!/^[A-Z]+$/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  _buildHttpUrlFromISYNetworkResource(resource = {}) {
    const controlInfo = resource?.controlInfo && typeof resource.controlInfo === 'object'
      ? resource.controlInfo
      : {};

    const directUrl = String(controlInfo.url || resource.url || '').trim();
    if (/^https?:\/\//i.test(directUrl)) {
      return directUrl;
    }

    const protocolRaw = String(controlInfo.protocol || '').trim().toLowerCase();
    if (!['http', 'https'].includes(protocolRaw)) {
      return null;
    }

    const host = String(controlInfo.host || '').trim();
    if (!host) {
      return null;
    }

    const rawPath = String(controlInfo.path || directUrl || '').trim();
    const normalizedPath = rawPath
      ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`)
      : '';

    const port = Number(controlInfo.port);
    const hasPort = Number.isInteger(port)
      && port > 0
      && port <= 65535
      && !((protocolRaw === 'http' && port === 80) || (protocolRaw === 'https' && port === 443));

    return `${protocolRaw}://${host}${hasPort ? `:${port}` : ''}${normalizedPath}`;
  }

  _parseISYNetworkResourcePayload(rawPayload = '') {
    if (typeof rawPayload !== 'string') {
      return rawPayload;
    }

    const trimmed = rawPayload.trim();
    if (!trimmed) {
      return '';
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return trimmed;
    }
  }

  _createHttpRequestActionFromISYNetworkResource(resource = {}, statement = '', extra = {}) {
    const controlInfo = resource?.controlInfo && typeof resource.controlInfo === 'object'
      ? resource.controlInfo
      : {};
    const protocol = String(controlInfo.protocol || '').trim().toLowerCase();
    if (!['http', 'https'].includes(protocol)) {
      return null;
    }

    const url = this._buildHttpUrlFromISYNetworkResource(resource);
    if (!url) {
      return null;
    }

    const method = this._normalizeHttpMethod(controlInfo.method || resource.method || 'GET');
    if (!method) {
      return null;
    }

    const payload = this._parseISYNetworkResourcePayload(controlInfo.payload || '');
    const timeoutMs = Number(controlInfo.timeout);
    const parameters = {
      method,
      source: 'isy_network_resource',
      statement,
      ...(Object.keys(extra).length > 0 ? extra : {}),
      ...(resource?.id ? { resourceId: String(resource.id) } : {}),
      ...(resource?.name ? { resourceName: String(resource.name) } : {}),
      ...(controlInfo.headers && typeof controlInfo.headers === 'object' ? { headers: controlInfo.headers } : {}),
      ...(Object.prototype.hasOwnProperty.call(controlInfo, 'timeout')
        && Number.isFinite(timeoutMs)
        && timeoutMs > 0
        ? { timeoutMs: Math.round(timeoutMs) }
        : {})
    };

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && payload !== '') {
      parameters.body = payload;
    }

    return {
      type: 'http_request',
      target: url,
      parameters
    };
  }

  _parseISYProgramTimeTrigger(lines = []) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return null;
    }

    const joined = lines.join(' ');
    const match = joined.match(/\btime\s+is\s+(.+?)(?:\bon\b|$)/i);
    if (!match) {
      return null;
    }

    const clock = this._parseISYClockValue(match[1]);
    if (!clock) {
      return null;
    }

    const [hourToken, minuteToken] = clock.split(':');
    const hour = Number(hourToken);
    const minute = Number(minuteToken);
    const days = this._extractISYProgramDays(lines);

    const conditions = {
      hour,
      minute
    };
    if (days.length > 0) {
      conditions.days = days;
    }

    return {
      type: 'time',
      conditions
    };
  }

  _parseISYProgramDeviceTrigger(lines = [], lookup = {}) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return {
        trigger: null,
        note: ''
      };
    }

    const joined = lines.join(' ');
    const comparisonMatch = joined.match(/\b(?:status|control)\s+['"]?([^'"]+?)['"]?\s+(?:is\s+)?(above|below|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\b/i);
    if (comparisonMatch) {
      const deviceToken = comparisonMatch[1];
      const operatorText = comparisonMatch[2].toLowerCase();
      const value = Number(comparisonMatch[3]);
      const device = this._resolveISYProgramDevice(deviceToken, lookup);
      if (!device || !device._id) {
        return {
          trigger: null,
          note: `Could not resolve IF device "${deviceToken}" for program trigger.`
        };
      }

      const property = /\btemp|temperature\b/i.test(joined)
        ? 'temperature'
        : (/\bhumid|humidity\b/i.test(joined) ? 'humidity' : 'brightness');
      const operatorMap = {
        above: '>',
        below: '<'
      };

      return {
        trigger: {
          type: 'device_state',
          conditions: {
            deviceId: device._id.toString(),
            property,
            operator: operatorMap[operatorText] || operatorText,
            value
          }
        },
        note: ''
      };
    }

    const stateMatch = joined.match(/\b(?:status|control)\s+['"]?([^'"]+?)['"]?\s+is\s+(?:switched\s+)?(not\s+)?(on|off|true|false|open|closed|locked|unlocked|\d{1,3}%?)\b/i);
    if (!stateMatch) {
      return {
        trigger: null,
        note: ''
      };
    }

    const deviceToken = stateMatch[1];
    const negated = Boolean(stateMatch[2]);
    const stateRaw = String(stateMatch[3] || '').trim().toLowerCase();
    const device = this._resolveISYProgramDevice(deviceToken, lookup);
    if (!device || !device._id) {
      return {
        trigger: null,
        note: `Could not resolve IF device "${deviceToken}" for program trigger.`
      };
    }

    if (/%$/.test(stateRaw)) {
      const level = Number(stateRaw.replace('%', ''));
      if (Number.isFinite(level)) {
        return {
          trigger: {
            type: 'device_state',
            conditions: {
              deviceId: device._id.toString(),
              property: 'brightness',
              operator: negated ? '!=' : 'eq',
              value: Math.max(0, Math.min(100, Math.round(level)))
            }
          },
          note: ''
        };
      }
    }

    const isTruthy = ['on', 'true', 'open', 'unlocked'].includes(stateRaw);
    const isFalsy = ['off', 'false', 'closed', 'locked'].includes(stateRaw);
    if (!isTruthy && !isFalsy) {
      return {
        trigger: null,
        note: `Unsupported IF state "${stateRaw}" for device "${deviceToken}".`
      };
    }

    const stateValue = negated ? !isTruthy : isTruthy;
    return {
      trigger: {
        type: 'device_state',
        conditions: {
          deviceId: device._id.toString(),
          property: 'status',
          state: stateValue,
          operator: 'eq',
          value: stateValue
        }
      },
      note: ''
    };
  }

  _translateISYProgramTrigger(program = {}, lookup = {}) {
    const lines = Array.isArray(program.ifLines) ? program.ifLines : [];
    const notes = [];

    const timeTrigger = this._parseISYProgramTimeTrigger(lines);
    if (timeTrigger) {
      return {
        trigger: timeTrigger,
        notes
      };
    }

    const deviceTrigger = this._parseISYProgramDeviceTrigger(lines, lookup);
    if (deviceTrigger.note) {
      notes.push(deviceTrigger.note);
    }
    if (deviceTrigger.trigger) {
      return {
        trigger: deviceTrigger.trigger,
        notes
      };
    }

    if (lines.length > 0) {
      notes.push('IF conditions were not recognized; using manual trigger.');
    }

    return {
      trigger: {
        type: 'manual',
        conditions: {
          source: 'isy_program',
          isyProgramId: program.id
        }
      },
      notes
    };
  }

  _buildISYConditionExpressionFromTrigger(trigger = {}) {
    if (!trigger || typeof trigger !== 'object') {
      return null;
    }

    if (trigger.type === 'time') {
      const conditions = trigger.conditions && typeof trigger.conditions === 'object'
        ? trigger.conditions
        : {};
      const hour = Number(conditions.hour);
      const minute = Number(conditions.minute);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return null;
      }
      const expression = {
        kind: 'time_is',
        hour,
        minute
      };
      if (Array.isArray(conditions.days) && conditions.days.length > 0) {
        expression.days = conditions.days;
      }
      return expression;
    }

    if (trigger.type === 'device_state' || trigger.type === 'sensor') {
      const conditions = trigger.conditions && typeof trigger.conditions === 'object'
        ? trigger.conditions
        : {};
      if (!conditions.deviceId) {
        return null;
      }
      return {
        kind: 'device_state',
        deviceId: String(conditions.deviceId),
        property: conditions.property || 'status',
        operator: conditions.operator || 'eq',
        value: Object.prototype.hasOwnProperty.call(conditions, 'value') ? conditions.value : conditions.state
      };
    }

    if (trigger.type === 'schedule') {
      const conditions = trigger.conditions && typeof trigger.conditions === 'object'
        ? trigger.conditions
        : {};
      if (conditions.start && conditions.end) {
        return {
          kind: 'time_window',
          start: conditions.start,
          end: conditions.end,
          ...(Array.isArray(conditions.days) && conditions.days.length > 0 ? { days: conditions.days } : {})
        };
      }
    }

    return null;
  }

  _parseISYProgramIfLineExpression(line = '', lookup = {}, options = {}) {
    const cleanedLine = String(line || '')
      .replace(/^\s*(and|or)\s+/i, '')
      .replace(/^\(+\s*/, '')
      .replace(/\s*\)+$/, '')
      .trim();
    if (!cleanedLine) {
      return null;
    }

    const allLines = Array.isArray(options.allLines) ? options.allLines : [];
    const allDays = this._extractISYProgramDays(allLines);

    const fromToMatch = cleanedLine.match(/^from\s+(.+?)\s+to\s+(.+)$/i);
    if (fromToMatch) {
      const start = this._parseISYClockValue(fromToMatch[1]);
      const end = this._parseISYClockValue(fromToMatch[2].replace(/\(.*$/, '').trim());
      if (start && end) {
        const expression = {
          kind: 'time_window',
          start,
          end
        };
        if (allDays.length > 0) {
          expression.days = allDays;
        }
        return expression;
      }
    }

    const fromForMatch = cleanedLine.match(/^from\s+(.+?)\s+for\s+(.+)$/i);
    if (fromForMatch) {
      const start = this._parseISYClockValue(fromForMatch[1]);
      const durationSeconds = this._parseISYDurationSeconds(fromForMatch[2]);
      if (start && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        const [startHour, startMinute] = start.split(':').map((value) => Number(value));
        const totalStart = (startHour * 60) + startMinute;
        const totalEnd = (totalStart + Math.round(durationSeconds / 60)) % (24 * 60);
        const endHour = String(Math.floor(totalEnd / 60)).padStart(2, '0');
        const endMinute = String(totalEnd % 60).padStart(2, '0');
        const expression = {
          kind: 'time_window',
          start,
          end: `${endHour}:${endMinute}`
        };
        if (allDays.length > 0) {
          expression.days = allDays;
        }
        return expression;
      }
    }

    const timeTrigger = this._parseISYProgramTimeTrigger([cleanedLine]);
    if (timeTrigger) {
      const expression = this._buildISYConditionExpressionFromTrigger(timeTrigger);
      if (expression && allDays.length > 0 && !Array.isArray(expression.days)) {
        expression.days = allDays;
      }
      return expression;
    }

    const deviceTrigger = this._parseISYProgramDeviceTrigger([cleanedLine], lookup);
    if (deviceTrigger && deviceTrigger.trigger) {
      return this._buildISYConditionExpressionFromTrigger(deviceTrigger.trigger);
    }

    const programMatch = cleanedLine.match(/^program\s+['"]?(.+?)['"]?\s+is\s+(not\s+)?(true|false)\b/i);
    if (programMatch) {
      const programToken = programMatch[1];
      const isyProgram = this._resolveISYProgram(programToken, lookup);
      const rawExpected = programMatch[3].toLowerCase() === 'true';
      const expected = programMatch[2] ? !rawExpected : rawExpected;

      return {
        kind: 'isy_program_state',
        isyProgramId: isyProgram?.id || null,
        programName: isyProgram?.name || programToken,
        property: 'status',
        operator: 'eq',
        value: expected
      };
    }

    const variableMatch = cleanedLine.match(/^(?:state|integer)?\s*(?:variable\s+)?\$?([A-Za-z0-9_.:-]+)\s*(is\s+not|is|<=|>=|<|>)\s*(.+)$/i);
    if (variableMatch) {
      const variableName = this._normalizeISYVariableKey(variableMatch[1]);
      const operatorToken = variableMatch[2].toLowerCase().replace(/\s+/g, ' ').trim();
      const operatorMap = {
        is: 'eq',
        'is not': 'neq',
        '<': '<',
        '<=': '<=',
        '>': '>',
        '>=': '>='
      };
      return {
        kind: 'isy_variable',
        name: variableName,
        operator: operatorMap[operatorToken] || 'eq',
        value: this._parseISYVariableValueToken(variableMatch[3])
      };
    }

    if (/^on\s+/i.test(cleanedLine)) {
      return null;
    }

    return null;
  }

  _combineISYBooleanExpressions(operator, left, right) {
    const op = operator === 'or' ? 'or' : 'and';
    if (!left) {
      return right || null;
    }
    if (!right) {
      return left;
    }

    const conditions = [];
    if (left.op === op && Array.isArray(left.conditions)) {
      conditions.push(...left.conditions);
    } else {
      conditions.push(left);
    }
    if (right.op === op && Array.isArray(right.conditions)) {
      conditions.push(...right.conditions);
    } else {
      conditions.push(right);
    }

    return {
      op,
      conditions
    };
  }

  _mergeISYProgramIfLines(lines = []) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return [];
    }

    const merged = [];
    lines.forEach((rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) {
        return;
      }

      const isContinuation = /^(to\b|for\b|on\b)/i.test(line);
      if (isContinuation && merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${line}`.replace(/\s+/g, ' ').trim();
      } else {
        merged.push(line);
      }
    });

    return merged;
  }

  _tokenizeISYIfLines(lines = [], lookup = {}) {
    const mergedLines = this._mergeISYProgramIfLines(lines);
    const tokens = [];
    let previousWasExpression = false;

    mergedLines.forEach((rawLine) => {
      let working = String(rawLine || '').trim();
      if (!working) {
        return;
      }

      let operator = null;
      const opMatch = working.match(/^(and|or)\b/i);
      if (opMatch) {
        operator = opMatch[1].toLowerCase();
        working = working.slice(opMatch[0].length).trim();
      }

      if (!operator && previousWasExpression) {
        operator = 'and';
      }
      if (operator) {
        tokens.push({ type: 'op', value: operator });
      }

      while (working.startsWith('(')) {
        tokens.push({ type: 'lparen' });
        working = working.slice(1).trim();
      }

      let trailingClosers = 0;
      while (working.endsWith(')')) {
        trailingClosers += 1;
        working = working.slice(0, -1).trim();
      }

      if (working) {
        const expression = this._parseISYProgramIfLineExpression(working, lookup, {
          allLines: mergedLines
        });
        if (expression) {
          tokens.push({ type: 'expr', value: expression });
          previousWasExpression = true;
        } else {
          previousWasExpression = false;
        }
      }

      for (let i = 0; i < trailingClosers; i += 1) {
        tokens.push({ type: 'rparen' });
      }
    });

    return tokens;
  }

  _buildISYConditionExpression(program = {}, lookup = {}) {
    const ifLines = Array.isArray(program.ifLines) ? program.ifLines : [];
    if (ifLines.length === 0) {
      return null;
    }

    const tokens = this._tokenizeISYIfLines(ifLines, lookup);
    if (tokens.length === 0) {
      return null;
    }

    const output = [];
    const operators = [];
    const precedence = {
      or: 1,
      and: 2
    };

    tokens.forEach((token) => {
      if (token.type === 'expr') {
        output.push(token);
        return;
      }

      if (token.type === 'op') {
        while (operators.length > 0) {
          const top = operators[operators.length - 1];
          if (top.type !== 'op') {
            break;
          }
          if (precedence[top.value] >= precedence[token.value]) {
            output.push(operators.pop());
          } else {
            break;
          }
        }
        operators.push(token);
        return;
      }

      if (token.type === 'lparen') {
        operators.push(token);
        return;
      }

      if (token.type === 'rparen') {
        while (operators.length > 0 && operators[operators.length - 1].type !== 'lparen') {
          output.push(operators.pop());
        }
        if (operators.length > 0 && operators[operators.length - 1].type === 'lparen') {
          operators.pop();
        }
      }
    });

    while (operators.length > 0) {
      const token = operators.pop();
      if (token.type === 'op') {
        output.push(token);
      }
    }

    const stack = [];
    output.forEach((token) => {
      if (token.type === 'expr') {
        stack.push(token.value);
        return;
      }
      if (token.type !== 'op') {
        return;
      }

      const right = stack.pop();
      const left = stack.pop();
      if (!left || !right) {
        return;
      }
      stack.push(this._combineISYBooleanExpressions(token.value, left, right));
    });

    if (stack.length === 0) {
      return null;
    }
    if (stack.length === 1) {
      return stack[0];
    }
    let combined = stack[0];
    for (let i = 1; i < stack.length; i += 1) {
      combined = this._combineISYBooleanExpressions('and', combined, stack[i]);
    }
    return combined;
  }

  _createISYNotificationAction(message, extra = {}) {
    return {
      type: 'notification',
      target: null,
      parameters: {
        message,
        ...extra
      }
    };
  }

  _deriveISYSceneOffActions(scene, lookup = {}) {
    if (!scene || !Array.isArray(scene.deviceActions) || scene.deviceActions.length === 0) {
      return [];
    }

    const derived = [];
    const seen = new Set();
    scene.deviceActions.forEach((entry) => {
      if (!entry || !entry.deviceId) {
        return;
      }

      const target = entry.deviceId.toString();
      const device = lookup.devicesById instanceof Map ? lookup.devicesById.get(target) : null;
      if (!device) {
        return;
      }

      let actionName = null;
      if (device.type === 'light' || device.type === 'switch') {
        actionName = 'turn_off';
      } else if (device.type === 'lock') {
        actionName = 'lock';
      } else if (device.type === 'garage') {
        actionName = 'close';
      }

      if (!actionName) {
        return;
      }

      const key = `${target}:${actionName}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      derived.push({
        type: 'device_control',
        target,
        parameters: {
          action: actionName
        }
      });
    });

    return derived;
  }

  _createISYWorkflowControlAction(line = '', lookup = {}) {
    const runMatch = String(line || '').match(/^run\s+program\s+['"]?(.+?)['"]?\s*(?:\((if|then\s*path|else\s*path)\))?$/i);
    if (runMatch) {
      const programToken = runMatch[1];
      const mode = String(runMatch[2] || 'if').toLowerCase().replace(/\s+/g, '');
      const targetProgram = this._resolveISYProgram(programToken, lookup);
      const modeMap = {
        if: 'run_if',
        thenpath: 'run_then',
        elsepath: 'run_else'
      };

      return {
        type: 'workflow_control',
        target: null,
        parameters: {
          operation: modeMap[mode] || 'run_if',
          targetIsyProgramId: targetProgram?.id || null,
          programName: targetProgram?.name || programToken
        }
      };
    }

    const simpleProgramMatch = String(line || '').match(/^(stop|enable|disable)\s+program\s+['"]?(.+?)['"]?$/i);
    if (simpleProgramMatch) {
      const command = simpleProgramMatch[1].toLowerCase();
      const programToken = simpleProgramMatch[2];
      const targetProgram = this._resolveISYProgram(programToken, lookup);
      return {
        type: 'workflow_control',
        target: null,
        parameters: {
          operation: command,
          targetIsyProgramId: targetProgram?.id || null,
          programName: targetProgram?.name || programToken
        }
      };
    }

    const startupMatch = String(line || '').match(/^set\s+program\s+['"]?(.+?)['"]?\s+to\s+(run|not\s+run)\s+at\s+startup$/i);
    if (startupMatch) {
      const programToken = startupMatch[1];
      const targetProgram = this._resolveISYProgram(programToken, lookup);
      const startupMode = /not\s+run/i.test(startupMatch[2]) ? 'set_not_run_at_startup' : 'set_run_at_startup';
      return {
        type: 'workflow_control',
        target: null,
        parameters: {
          operation: startupMode,
          targetIsyProgramId: targetProgram?.id || null,
          programName: targetProgram?.name || programToken
        }
      };
    }

    return null;
  }

  _createISYNetworkResourceAction(line = '', lookup = {}, extra = {}) {
    const normalized = String(line || '').trim();
    if (!normalized) {
      return null;
    }

    const resourceMatch = normalized.match(/^(?:run\s+)?(?:network\s+resource|resource)\s+(.+)$/i);
    if (!resourceMatch) {
      return null;
    }

    const token = String(resourceMatch[1] || '').trim();
    const quotedToken = token.match(/^['"]([^'"]+)['"]/);
    const numericToken = quotedToken ? null : token.match(/^#?(\d+)\b/);
    const lookupToken = quotedToken
      ? quotedToken[1]
      : (numericToken ? numericToken[1] : token.replace(/^['"]|['"]$/g, '').trim());
    const resolved = this._resolveISYNetworkResource(lookupToken, lookup);

    const resourceId = resolved?.id
      ? String(resolved.id).trim()
      : (numericToken ? String(numericToken[1]).trim() : null);
    const resourceName = resolved?.name
      || (quotedToken ? quotedToken[1].trim() : (!numericToken ? lookupToken : null));
    const httpRequestAction = this._createHttpRequestActionFromISYNetworkResource(
      resolved || {},
      normalized,
      extra
    );
    if (httpRequestAction) {
      return httpRequestAction;
    }

    return {
      type: 'isy_network_resource',
      target: resourceId || resourceName || null,
      parameters: {
        statement: normalized,
        ...(resourceId ? { resourceId } : {}),
        ...(resourceName ? { resourceName } : {}),
        ...extra
      }
    };
  }

  _createISYVariableControlAction(line = '') {
    const normalized = String(line || '').trim();
    if (!normalized) {
      return null;
    }

    const initMatch = normalized.match(/^(?:initialize\s+)?\$?([A-Za-z0-9_.:-]+)\s+init\s+to\s+(.+)$/i);
    if (initMatch) {
      return {
        type: 'variable_control',
        target: null,
        parameters: {
          operation: 'init',
          variable: this._normalizeISYVariableKey(initMatch[1]),
          value: this._parseISYVariableValueToken(initMatch[2])
        }
      };
    }

    const calcMatch = normalized.match(/^\$?([A-Za-z0-9_.:-]+)\s*(=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)\s*(.+)$/i);
    if (!calcMatch) {
      return null;
    }

    const operatorMap = {
      '=': 'assign',
      '+=': 'add',
      '-=': 'subtract',
      '*=': 'multiply',
      '/=': 'divide',
      '%=': 'modulo',
      '&=': 'bit_and',
      '|=': 'bit_or',
      '^=': 'bit_xor'
    };

    return {
      type: 'variable_control',
      target: null,
      parameters: {
        operation: operatorMap[calcMatch[2]] || 'assign',
        variable: this._normalizeISYVariableKey(calcMatch[1]),
        value: this._parseISYVariableValueToken(calcMatch[3])
      }
    };
  }

  _translateISYProgramActionLines(lines = [], lookup = {}, options = {}) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return {
        actions: [],
        untranslatedLines: [],
        translatedCount: 0
      };
    }

    const branch = (options.branch || 'then').toString().toLowerCase();
    const ifExpression = options.ifExpression && typeof options.ifExpression === 'object'
      ? options.ifExpression
      : null;
    const suppressUntranslatedSummary = options.suppressUntranslatedSummary === true;
    const actions = [];
    const untranslatedLines = [];
    let translatedCount = 0;

    const lineItems = lines.map((line) => String(line || '').trim()).filter(Boolean);
    let index = 0;
    while (index < lineItems.length) {
      const line = lineItems[index];
      if (!line) {
        index += 1;
        continue;
      }

      const repeatEveryMatch = line.match(/^repeat\s+every\s+(.+?)(\s+random)?$/i);
      const repeatForMatch = repeatEveryMatch ? null : line.match(/^repeat\s+(?:for\s+)?(\d+)\s+times?(?:\s+random)?/i);
      if (repeatEveryMatch || repeatForMatch) {
        let nextRepeatIndex = index + 1;
        while (nextRepeatIndex < lineItems.length && !/^repeat\b/i.test(lineItems[nextRepeatIndex])) {
          nextRepeatIndex += 1;
        }

        const blockLines = lineItems.slice(index + 1, nextRepeatIndex);
        const nested = this._translateISYProgramActionLines(blockLines, lookup, {
          ...options,
          suppressUntranslatedSummary: true
        });

        if (nested.untranslatedLines.length > 0) {
          untranslatedLines.push(...nested.untranslatedLines);
        }

        if (repeatEveryMatch) {
          const intervalSeconds = this._parseISYDurationSeconds(repeatEveryMatch[1]) ?? 0;
          const continueWhile = ifExpression
            ? (branch === 'then'
                ? ifExpression
                : {
                    op: 'not',
                    condition: ifExpression
                  })
            : null;
          actions.push({
            type: 'repeat',
            target: null,
            parameters: {
              mode: 'every',
              intervalSeconds,
              random: Boolean(repeatEveryMatch[2]),
              actions: nested.actions,
              continueWhile,
              maxIterations: 500
            }
          });
          translatedCount += 1 + nested.translatedCount;
        } else if (repeatForMatch) {
          actions.push({
            type: 'repeat',
            target: null,
            parameters: {
              mode: 'for',
              count: Math.max(0, Math.round(Number(repeatForMatch[1]))),
              random: /\brandom\b/i.test(line),
              actions: nested.actions
            }
          });
          translatedCount += 1 + nested.translatedCount;
        }

        index = nextRepeatIndex;
        continue;
      }

      const waitMatch = line.match(/^wait\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)?(\s+random)?/i);
      if (waitMatch) {
        const amount = Number(waitMatch[1]);
        const unit = String(waitMatch[2] || 'seconds').toLowerCase();
        let seconds = amount;
        if (unit.startsWith('min')) {
          seconds = amount * 60;
        } else if (unit.startsWith('hour') || unit.startsWith('hr')) {
          seconds = amount * 3600;
        }

        actions.push({
          type: 'delay',
          target: null,
          parameters: {
            seconds: Math.max(0, Math.round(seconds)),
            random: /\brandom\b/i.test(line)
          }
        });
        translatedCount += 1;
        index += 1;
        continue;
      }

      const sceneMatch = line.match(/^set\s+scene\s+['"]?(.+?)['"]?\s+(on|off|query)\b/i);
      if (sceneMatch) {
        const sceneToken = sceneMatch[1];
        const sceneState = String(sceneMatch[2] || '').toLowerCase();
        const scene = this._resolveISYProgramScene(sceneToken, lookup);
        if (scene && scene._id) {
          if (sceneState === 'on') {
            actions.push({
              type: 'scene_activate',
              target: scene._id.toString(),
              parameters: {}
            });
            translatedCount += 1;
            index += 1;
            continue;
          }

          if (sceneState === 'off') {
            const offActions = this._deriveISYSceneOffActions(scene, lookup);
            if (offActions.length > 0) {
              actions.push(...offActions);
              translatedCount += 1;
              index += 1;
              continue;
            }
          }

          if (sceneState === 'query') {
            actions.push(this._createISYNotificationAction(`ISY scene query requested: ${line}`, {
              isyProgramBranch: branch
            }));
            translatedCount += 1;
            index += 1;
            continue;
          }
        }

        untranslatedLines.push(line);
        index += 1;
        continue;
      }

      const quotedDeviceMatch = line.match(/^set\s+(?!scene\b)(?:device\s+)?['"]([^'"]+)['"]\s+(.+)$/i);
      const unquotedDeviceMatch = quotedDeviceMatch
        ? null
        : line.match(/^set\s+(?!scene\b)(?:device\s+)?([A-Za-z0-9 .:_-]+?)\s+(on|off|fast on|fast off|dim|bright|\d{1,3}%|to\s+\d{1,3}%)(.*)$/i);

      const deviceToken = quotedDeviceMatch ? quotedDeviceMatch[1] : (unquotedDeviceMatch ? unquotedDeviceMatch[1] : null);
      const trailing = quotedDeviceMatch ? quotedDeviceMatch[2] : (unquotedDeviceMatch ? `${unquotedDeviceMatch[2]}${unquotedDeviceMatch[3] || ''}` : '');
      if (deviceToken && trailing) {
        const device = this._resolveISYProgramDevice(deviceToken, lookup);
        if (!device || !device._id) {
          untranslatedLines.push(line);
          index += 1;
          continue;
        }

        const trailingLower = String(trailing).trim().toLowerCase();
        const percentMatch = trailingLower.match(/(?:to\s+)?(\d{1,3})\s*%/);
        if (percentMatch) {
          const brightness = Math.max(0, Math.min(100, Number(percentMatch[1])));
          actions.push({
            type: 'device_control',
            target: device._id.toString(),
            parameters: {
              action: 'set_brightness',
              brightness
            }
          });
          translatedCount += 1;
          index += 1;
          continue;
        }

        if (/^(on|fast on)\b/.test(trailingLower)) {
          actions.push({
            type: 'device_control',
            target: device._id.toString(),
            parameters: {
              action: 'turn_on'
            }
          });
          translatedCount += 1;
          index += 1;
          continue;
        }

        if (/^(off|fast off)\b/.test(trailingLower)) {
          actions.push({
            type: 'device_control',
            target: device._id.toString(),
            parameters: {
              action: 'turn_off'
            }
          });
          translatedCount += 1;
          index += 1;
          continue;
        }

        untranslatedLines.push(line);
        index += 1;
        continue;
      }

      if (/^send\s+notification\b/i.test(line)) {
        actions.push(this._createISYNotificationAction(line, {
          isyProgramBranch: branch
        }));
        translatedCount += 1;
        index += 1;
        continue;
      }

      const variableAction = this._createISYVariableControlAction(line);
      if (variableAction) {
        actions.push(variableAction);
        translatedCount += 1;
        index += 1;
        continue;
      }

      const workflowControlAction = this._createISYWorkflowControlAction(line, lookup);
      if (workflowControlAction) {
        actions.push(workflowControlAction);
        translatedCount += 1;
        index += 1;
        continue;
      }

      const networkResourceAction = this._createISYNetworkResourceAction(line, lookup, {
        isyProgramBranch: branch
      });
      if (networkResourceAction) {
        actions.push(networkResourceAction);
        translatedCount += 1;
        index += 1;
        continue;
      }

      untranslatedLines.push(line);
      index += 1;
    }

    if (untranslatedLines.length > 0 && !suppressUntranslatedSummary) {
      const preview = untranslatedLines.slice(0, 3).join(' | ');
      actions.push(this._createISYNotificationAction(
        `Untranslated ISY ${branch.toUpperCase()} statements: ${preview}${untranslatedLines.length > 3 ? ' | ...' : ''}`,
        {
          isyProgramBranch: branch,
          untranslatedCount: untranslatedLines.length
        }
      ));
    }

    return {
      actions,
      untranslatedLines,
      translatedCount
    };
  }

  _invertISYProgramTrigger(trigger) {
    if (!trigger || typeof trigger !== 'object') {
      return null;
    }
    if (!['device_state', 'sensor'].includes(trigger.type)) {
      return null;
    }

    const conditions = {
      ...(trigger.conditions && typeof trigger.conditions === 'object' ? trigger.conditions : {})
    };
    const operator = String(conditions.operator || '').toLowerCase();
    const inverseOperator = {
      eq: 'neq',
      '==': '!=',
      neq: 'eq',
      '!=': '==',
      '>': '<=',
      '>=': '<',
      '<': '>=',
      '<=': '>'
    };

    if (operator && inverseOperator[operator]) {
      conditions.operator = inverseOperator[operator];
    } else if (typeof conditions.state === 'boolean') {
      conditions.state = !conditions.state;
      if (typeof conditions.value === 'boolean') {
        conditions.value = !conditions.value;
      } else {
        conditions.value = conditions.state;
      }
      conditions.operator = 'eq';
    } else if (typeof conditions.value === 'boolean') {
      conditions.value = !conditions.value;
      conditions.operator = 'eq';
      if (Object.prototype.hasOwnProperty.call(conditions, 'state')) {
        conditions.state = conditions.value;
      }
    } else {
      return null;
    }

    return {
      type: trigger.type,
      conditions
    };
  }

  _buildISYWorkflowDescription(lines = []) {
    const description = lines
      .filter((line) => typeof line === 'string' && line.trim())
      .join('\n')
      .trim();

    if (description.length <= 790) {
      return description;
    }
    return `${description.slice(0, 787)}...`;
  }

  _buildISYProgramWorkflowPayloads(program = {}, lookup = {}, options = {}) {
    const enableWorkflows = options.enableWorkflows === true;
    const marker = this._isyProgramMarker(program.id);
    const elseMarker = this._isyProgramElseMarker(program.id);
    const baseName = `ISY Program ${program.id}: ${program.name || 'Unnamed'}`;
    const ifExpression = this._buildISYConditionExpression(program, lookup);
    const triggerTranslation = this._translateISYProgramTrigger(program, lookup);
    const thenTranslation = this._translateISYProgramActionLines(program.thenLines || [], lookup, {
      branch: 'then',
      ifExpression
    });
    const elseTranslation = this._translateISYProgramActionLines(program.elseLines || [], lookup, {
      branch: 'else',
      ifExpression
    });

    const mainNotes = [
      'Imported from ISY program with IF/THEN/ELSE translation.',
      `Enabled on ISY: ${program.enabled ? 'yes' : 'no'}`,
      `Run at startup: ${program.runAtStartup ? 'yes' : 'no'}`,
      `Status: ${program.status ? 'true' : 'false'}`,
      ifExpression
        ? 'IF expression parsed and executed with edge-change semantics.'
        : triggerTranslation.notes.join(' '),
      thenTranslation.untranslatedLines.length > 0
        ? `${thenTranslation.untranslatedLines.length} THEN statements could not be translated and were captured as notifications.`
        : '',
      program.lastRunTime ? `Last run: ${program.lastRunTime}` : '',
      program.lastFinishTime ? `Last finish: ${program.lastFinishTime}` : ''
    ];

    const mainActions = thenTranslation.actions.length > 0
      ? thenTranslation.actions
      : [this._createISYNotificationAction(`ISY program "${program.name || program.id}" had no translatable THEN actions`, {
          isyProgramId: program.id,
          isyProgramBranch: 'then'
        })];

    const mainPayload = {
      name: baseName,
      description: this._buildISYWorkflowDescription([
        marker,
        '[ISY_PROGRAM_PATH:THEN]',
        `[ISY_PROGRAM_NAME:${program.name || ''}]`,
        ...mainNotes
      ]),
      source: 'import',
      enabled: enableWorkflows,
      category: 'custom',
      priority: 5,
      cooldown: 0,
      trigger: triggerTranslation.trigger,
      isyRunAtStartup: program.runAtStartup === true,
      actions: mainActions
    };

    let elsePayload = null;
    let elseHandledInPrimary = false;
    if (ifExpression) {
      const branchedMainActions = [
        {
          type: 'condition',
          target: null,
          parameters: {
            evaluator: 'isy_program_if',
            expression: ifExpression,
            edge: 'change',
            stateKey: `isy_program:${program.id}:if`,
            isyProgramId: program.id,
            isyProgramName: program.name || '',
            programStateKey: `isy_program:${program.id}`,
            onFalseActions: elseTranslation.actions
          }
        },
        ...mainActions
      ];

      mainPayload.actions = branchedMainActions;
      mainPayload.trigger = {
        type: 'schedule',
        conditions: {
          cron: '* * * * *'
        }
      };
      elseHandledInPrimary = elseTranslation.actions.length > 0;
      mainPayload.description = this._buildISYWorkflowDescription([
        mainPayload.description,
        'Program executes on IF condition edge changes via schedule polling; ELSE actions are attached to the same workflow.'
      ]);
    } else if (elseTranslation.actions.length > 0) {
      mainPayload.description = this._buildISYWorkflowDescription([
        mainPayload.description,
        'ELSE path exists but IF expression could not be parsed for auto-branch execution.'
      ]);
    }

    return {
      marker,
      elseMarker,
      baseName,
      mainPayload,
      elsePayload,
      elseHandledInPrimary,
      translatedActions: thenTranslation.translatedCount + elseTranslation.translatedCount,
      hasUntranslated: thenTranslation.untranslatedLines.length > 0 || elseTranslation.untranslatedLines.length > 0
    };
  }

  async importISYProgramsAsWorkflows(programs = [], options = {}) {
    const isDryRun = options.dryRun !== false;
    const enableWorkflows = options.enableWorkflows === true;
    const programList = Array.isArray(programs) ? programs : [];
    const lookup = await this._buildISYProgramLookup(programList, {
      resources: options.resources
    });
    const results = {
      success: true,
      dryRun: isDryRun,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      translatedPrograms: 0,
      placeholderPrograms: 0,
      elseCreated: 0,
      elseUpdated: 0,
      elseSkipped: 0,
      workflows: [],
      errors: []
    };

    for (const program of programList) {
      if (!program || !program.id) {
        continue;
      }

      results.processed += 1;
      try {
        const translation = this._buildISYProgramWorkflowPayloads(program, lookup, {
          enableWorkflows
        });
        if (translation.translatedActions > 0) {
          results.translatedPrograms += 1;
        } else {
          results.placeholderPrograms += 1;
        }

        const markerRegex = new RegExp(this._escapeRegexLiteral(translation.marker));
        const elsePathRegex = new RegExp(this._escapeRegexLiteral('[ISY_PROGRAM_PATH:ELSE]'));
        const existingMain = await Workflow.findOne({
          $and: [
            { description: { $regex: markerRegex } },
            { description: { $not: elsePathRegex } }
          ]
        }).lean();

        if (isDryRun) {
          results.workflows.push({
            programId: program.id,
            path: 'then',
            name: translation.mainPayload.name,
            status: existingMain ? 'would-update' : 'would-create'
          });
          if (existingMain) {
            results.updated += 1;
          } else {
            results.created += 1;
          }

          if (translation.elsePayload) {
            const existingElse = await Workflow.findOne({
              description: { $regex: new RegExp(this._escapeRegexLiteral(translation.elseMarker)) }
            }).lean();

            results.workflows.push({
              programId: program.id,
              path: 'else',
              name: translation.elsePayload.name,
              status: existingElse ? 'would-update' : 'would-create'
            });

            if (existingElse) {
              results.updated += 1;
            } else {
              results.created += 1;
            }
          } else if (translation.elseHandledInPrimary) {
            results.workflows.push({
              programId: program.id,
              path: 'else',
              name: translation.mainPayload.name,
              status: 'embedded-in-primary'
            });
          } else {
            results.elseSkipped += 1;
          }
          continue;
        }

        let mainWorkflowId = null;
        let mainWorkflowName = translation.mainPayload.name;
        if (existingMain) {
          const updated = await getWorkflowService().updateWorkflow(existingMain._id.toString(), translation.mainPayload);
          results.updated += 1;
          mainWorkflowId = updated?._id || existingMain._id;
          mainWorkflowName = updated?.name || translation.mainPayload.name;
          results.workflows.push({
            programId: program.id,
            path: 'then',
            workflowId: updated._id,
            name: updated.name,
            status: 'updated'
          });
        } else {
          const created = await getWorkflowService().createWorkflow(translation.mainPayload, { source: 'import' });
          results.created += 1;
          mainWorkflowId = created?._id || null;
          mainWorkflowName = created?.name || translation.mainPayload.name;
          results.workflows.push({
            programId: program.id,
            path: 'then',
            workflowId: created._id,
            name: created.name,
            status: 'created'
          });
        }

        if (!translation.elsePayload) {
          if (translation.elseHandledInPrimary) {
            results.workflows.push({
              programId: program.id,
              path: 'else',
              workflowId: mainWorkflowId,
              name: mainWorkflowName,
              status: 'embedded-in-primary'
            });
            continue;
          }
          results.elseSkipped += 1;
          continue;
        }

        const existingElse = await Workflow.findOne({
          description: { $regex: new RegExp(this._escapeRegexLiteral(translation.elseMarker)) }
        }).lean();

        if (existingElse) {
          const updatedElse = await getWorkflowService().updateWorkflow(existingElse._id.toString(), translation.elsePayload);
          results.updated += 1;
          results.elseUpdated += 1;
          results.workflows.push({
            programId: program.id,
            path: 'else',
            workflowId: updatedElse._id,
            name: updatedElse.name,
            status: 'updated'
          });
        } else {
          const createdElse = await getWorkflowService().createWorkflow(translation.elsePayload, { source: 'import' });
          results.created += 1;
          results.elseCreated += 1;
          results.workflows.push({
            programId: program.id,
            path: 'else',
            workflowId: createdElse._id,
            name: createdElse.name,
            status: 'created'
          });
        }
      } catch (error) {
        results.failed += 1;
        results.success = false;
        results.errors.push({
          programId: program.id,
          name: program.name,
          error: error.message
        });
      }
    }

    return results;
  }

  async executeISYNetworkResource(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const connection = await this._resolveISYConnection(request);

    let resourceId = request.resourceId ?? request.id ?? request.target ?? '';
    if (typeof resourceId === 'number' && Number.isFinite(resourceId)) {
      resourceId = String(Math.trunc(resourceId));
    } else {
      resourceId = String(resourceId || '').trim().replace(/^#/, '');
    }

    let resourceName = String(request.resourceName ?? request.name ?? '').trim();
    if (!resourceId && resourceName) {
      const resources = await this._fetchISYNetworkResources(connection);
      const resourcesByName = new Map();
      const resourcesById = new Map();
      resources.forEach((resource) => {
        if (!resource || typeof resource !== 'object') {
          return;
        }

        const id = String(resource.id || '').trim();
        const normalizedName = this._normalizeISYLookupKey(resource.name || '');
        if (id && !resourcesById.has(id)) {
          resourcesById.set(id, resource);
        }
        if (normalizedName && !resourcesByName.has(normalizedName)) {
          resourcesByName.set(normalizedName, resource);
        }
      });

      const resolved = this._resolveISYNetworkResource(resourceName, {
        resourcesByName,
        resourcesById
      });
      if (resolved?.id) {
        resourceId = String(resolved.id).trim();
        if (!resourceName && resolved.name) {
          resourceName = String(resolved.name).trim();
        }
      }
    }

    if (!resourceId) {
      throw new Error(`Unable to resolve ISY network resource${resourceName ? ` "${resourceName}"` : ''}`);
    }

    await this._requestISYResource(connection, `/rest/networking/resources/${encodeURIComponent(resourceId)}`);
    return {
      success: true,
      resourceId,
      resourceName: resourceName || null,
      message: `Executed ISY network resource${resourceName ? ` "${resourceName}"` : ''} (id ${resourceId})`
    };
  }

  _sanitizeISYSyncRunRequest(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    return {
      dryRun: request.dryRun !== false,
      importDevices: request.importDevices !== false,
      importTopology: request.importTopology !== false,
      importPrograms: request.importPrograms !== false,
      enableProgramWorkflows: request.enableProgramWorkflows === true,
      continueOnError: request.continueOnError !== false,
      linkMode: request.linkMode === 'manual' ? 'manual' : 'remote'
    };
  }

  _normalizeISYSyncLogEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (!message) {
      return null;
    }

    const timestamp = typeof entry.timestamp === 'string' && entry.timestamp.trim()
      ? entry.timestamp.trim()
      : new Date().toISOString();
    const level = typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info';
    const stage = typeof entry.stage === 'string' ? entry.stage : null;
    const progress = Number(entry.progress);

    return {
      timestamp,
      message,
      level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
      stage,
      progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null
    };
  }

  _snapshotISYSyncRun(run) {
    if (!run || typeof run !== 'object') {
      return null;
    }

    const logs = Array.isArray(run.logs) ? run.logs.slice() : [];
    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt || null,
      request: run.request,
      cancelRequested: Boolean(run.cancelRequested),
      logs,
      result: run.result || null,
      error: run.error || null
    };
  }

  _pruneISYSyncRuns() {
    const retention = Number.isInteger(this._isySyncRunRetention) && this._isySyncRunRetention > 0
      ? this._isySyncRunRetention
      : DEFAULT_ISY_SYNC_RUN_RETENTION;

    while (this._isySyncRuns.size > retention) {
      const oldestRunId = this._isySyncRuns.keys().next().value;
      if (!oldestRunId) {
        break;
      }
      this._isySyncRuns.delete(oldestRunId);
    }
  }

  _appendISYSyncRunLog(runId, entry) {
    const run = this._isySyncRuns.get(runId);
    if (!run) {
      return;
    }

    const normalizedEntry = this._normalizeISYSyncLogEntry(entry);
    if (!normalizedEntry) {
      return;
    }

    run.logs.push(normalizedEntry);
    const logLimit = Number.isInteger(this._isySyncRunLogLimit) && this._isySyncRunLogLimit > 0
      ? this._isySyncRunLogLimit
      : DEFAULT_ISY_SYNC_RUN_LOG_LIMIT;
    if (run.logs.length > logLimit) {
      run.logs.splice(0, run.logs.length - logLimit);
    }
    run.updatedAt = new Date().toISOString();
  }

  _createISYSyncRun(payload = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();

    const run = {
      id,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      request: this._sanitizeISYSyncRunRequest(payload),
      cancelRequested: false,
      logs: [],
      result: null,
      error: null
    };

    this._isySyncRuns.set(id, run);
    this._pruneISYSyncRuns();
    return run;
  }

  getISYSyncRun(runId) {
    const id = typeof runId === 'string' ? runId.trim() : '';
    if (!id) {
      return null;
    }

    const run = this._isySyncRuns.get(id);
    return this._snapshotISYSyncRun(run);
  }

  cancelISYSyncRun(runId) {
    const id = typeof runId === 'string' ? runId.trim() : '';
    if (!id) {
      return null;
    }

    const run = this._isySyncRuns.get(id);
    if (!run) {
      return null;
    }

    if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.status)) {
      return this._snapshotISYSyncRun(run);
    }

    run.cancelRequested = true;
    run.updatedAt = new Date().toISOString();
    this._appendISYSyncRunLog(run.id, {
      message: 'Cancellation requested by user; waiting for the current migration operation to finish.',
      stage: 'cancel',
      level: 'warn'
    });

    return this._snapshotISYSyncRun(run);
  }

  startISYSyncRun(payload = {}) {
    const run = this._createISYSyncRun(payload);
    this._appendISYSyncRunLog(run.id, {
      message: `Queued ${run.request.dryRun ? 'dry-run preview' : 'migration run'}`,
      stage: 'queued',
      progress: 0
    });

    (async () => {
      try {
        const result = await this.syncFromISY(payload, {
          onProgress: (entry) => this._appendISYSyncRunLog(run.id, entry),
          shouldCancel: () => Boolean(this._isySyncRuns.get(run.id)?.cancelRequested)
        });

        const storedRun = this._isySyncRuns.get(run.id);
        if (!storedRun) {
          return;
        }

        storedRun.status = result?.success === false ? 'completed_with_errors' : 'completed';
        storedRun.result = result;
        storedRun.error = null;
        storedRun.finishedAt = new Date().toISOString();
        storedRun.updatedAt = storedRun.finishedAt;
        this._appendISYSyncRunLog(run.id, {
          message: result?.message || 'ISY sync finished',
          stage: 'complete',
          level: result?.success === false ? 'warn' : 'info',
          progress: 100
        });
      } catch (error) {
        const storedRun = this._isySyncRuns.get(run.id);
        if (!storedRun) {
          return;
        }

        const cancelled = this._isISYSyncCancelledError(error);
        storedRun.status = cancelled ? 'cancelled' : 'failed';
        storedRun.result = null;
        storedRun.error = cancelled ? 'Migration cancelled by user.' : error.message;
        storedRun.finishedAt = new Date().toISOString();
        storedRun.updatedAt = storedRun.finishedAt;
        this._appendISYSyncRunLog(run.id, {
          message: cancelled ? 'ISY migration cancelled by user' : (error.message || 'ISY sync failed'),
          stage: 'complete',
          level: cancelled ? 'warn' : 'error',
          progress: 100
        });
      }
    })();

    return this._snapshotISYSyncRun(run);
  }

  _isISYSyncCancelledError(error) {
    return Boolean(error && (error.code === 'ISY_SYNC_CANCELLED' || error.isCancelled === true));
  }

  _buildISYSyncCancelledError(message = 'ISY migration cancelled by user.') {
    const cancellationError = new Error(message);
    cancellationError.code = 'ISY_SYNC_CANCELLED';
    cancellationError.isCancelled = true;
    return cancellationError;
  }

  _throwIfISYSyncCancelled(shouldCancel, message = 'ISY migration cancelled by user.') {
    if (typeof shouldCancel === 'function' && shouldCancel()) {
      throw this._buildISYSyncCancelledError(message);
    }
  }

  _normalizeLinkedStatusRunRequest(payload = {}) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const normalizeNumber = (value, fallback, min = 0) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return fallback;
      }
      return Math.max(min, Math.round(parsed));
    };

    return {
      levelTimeoutMs: normalizeNumber(request.levelTimeoutMs, 3000, 500),
      pingTimeoutMs: normalizeNumber(request.pingTimeoutMs, 3000, 500),
      infoTimeoutMs: normalizeNumber(request.infoTimeoutMs, 3000, 500),
      pauseBetweenMs: normalizeNumber(request.pauseBetweenMs, 120, 0)
    };
  }

  _normalizeLinkedStatusLogEntry(entry = {}) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (!message) {
      return null;
    }

    const stage = typeof entry.stage === 'string' ? entry.stage.trim() : '';
    const level = ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
    const timestamp = typeof entry.timestamp === 'string' && entry.timestamp.trim()
      ? entry.timestamp
      : new Date().toISOString();
    const progress = Number.isFinite(Number(entry.progress))
      ? Math.max(0, Math.min(100, Number(entry.progress)))
      : null;

    return {
      timestamp,
      message,
      stage: stage || null,
      level,
      progress
    };
  }

  _snapshotLinkedStatusRun(run) {
    if (!run || typeof run !== 'object') {
      return null;
    }

    const logs = Array.isArray(run.logs) ? run.logs.slice() : [];
    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt || null,
      request: run.request,
      cancelRequested: Boolean(run.cancelRequested),
      logs,
      result: run.result || null,
      error: run.error || null
    };
  }

  _pruneLinkedStatusRuns() {
    const retention = Number.isInteger(this._linkedStatusRunRetention) && this._linkedStatusRunRetention > 0
      ? this._linkedStatusRunRetention
      : DEFAULT_LINKED_STATUS_RUN_RETENTION;

    while (this._linkedStatusRuns.size > retention) {
      const oldestRunId = this._linkedStatusRuns.keys().next().value;
      if (!oldestRunId) {
        break;
      }
      this._linkedStatusRuns.delete(oldestRunId);
    }
  }

  _appendLinkedStatusRunLog(runId, entry) {
    const run = this._linkedStatusRuns.get(runId);
    if (!run) {
      return;
    }

    const normalizedEntry = this._normalizeLinkedStatusLogEntry(entry);
    if (!normalizedEntry) {
      return;
    }

    run.logs.push(normalizedEntry);
    const logLimit = Number.isInteger(this._linkedStatusRunLogLimit) && this._linkedStatusRunLogLimit > 0
      ? this._linkedStatusRunLogLimit
      : DEFAULT_LINKED_STATUS_RUN_LOG_LIMIT;
    if (run.logs.length > logLimit) {
      run.logs.splice(0, run.logs.length - logLimit);
    }
    run.updatedAt = new Date().toISOString();
  }

  _createLinkedStatusRun(payload = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();

    const run = {
      id,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      request: this._normalizeLinkedStatusRunRequest(payload),
      cancelRequested: false,
      logs: [],
      result: null,
      error: null
    };

    this._linkedStatusRuns.set(id, run);
    this._pruneLinkedStatusRuns();
    return run;
  }

  getLinkedStatusRun(runId) {
    const id = typeof runId === 'string' ? runId.trim() : '';
    if (!id) {
      return null;
    }

    const run = this._linkedStatusRuns.get(id);
    return this._snapshotLinkedStatusRun(run);
  }

  cancelLinkedStatusRun(runId) {
    const id = typeof runId === 'string' ? runId.trim() : '';
    if (!id) {
      return null;
    }

    const run = this._linkedStatusRuns.get(id);
    if (!run) {
      return null;
    }

    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return this._snapshotLinkedStatusRun(run);
    }

    run.cancelRequested = true;
    run.updatedAt = new Date().toISOString();
    this._appendLinkedStatusRunLog(run.id, {
      message: 'Cancellation requested by user; waiting for current device operation to finish.',
      stage: 'cancel',
      level: 'warn'
    });

    return this._snapshotLinkedStatusRun(run);
  }

  startLinkedStatusRun(payload = {}) {
    const run = this._createLinkedStatusRun(payload);
    this._appendLinkedStatusRunLog(run.id, {
      message: 'Queued linked-device query run',
      stage: 'queued',
      progress: 0
    });

    (async () => {
      try {
        const result = await this.queryLinkedDevicesStatus(run.request, {
          onProgress: (entry) => this._appendLinkedStatusRunLog(run.id, entry),
          shouldCancel: () => Boolean(this._linkedStatusRuns.get(run.id)?.cancelRequested)
        });

        const storedRun = this._linkedStatusRuns.get(run.id);
        if (!storedRun) {
          return;
        }

        storedRun.status = 'completed';
        storedRun.result = result;
        storedRun.error = null;
        storedRun.finishedAt = new Date().toISOString();
        storedRun.updatedAt = storedRun.finishedAt;
        this._appendLinkedStatusRunLog(run.id, {
          message: result?.message || 'Linked-device query completed',
          stage: 'complete',
          progress: 100
        });
      } catch (error) {
        const storedRun = this._linkedStatusRuns.get(run.id);
        if (!storedRun) {
          return;
        }

        const cancelled = error?.code === 'QUERY_CANCELLED' || error?.isCancelled === true;
        storedRun.status = cancelled ? 'cancelled' : 'failed';
        storedRun.result = null;
        storedRun.error = cancelled ? 'Query cancelled by user.' : (error.message || 'Linked-device query failed.');
        storedRun.finishedAt = new Date().toISOString();
        storedRun.updatedAt = storedRun.finishedAt;
        this._appendLinkedStatusRunLog(run.id, {
          message: cancelled ? 'Linked-device query cancelled' : (error.message || 'Linked-device query failed'),
          stage: 'complete',
          level: cancelled ? 'warn' : 'error',
          progress: 100
        });
      }
    })();

    return this._snapshotLinkedStatusRun(run);
  }

  async testISYConnection(payload = {}) {
    try {
      const connection = await this._resolveISYConnection(payload);
      const probe = await this._probeISYConnection(connection);
      const message = probe.usedFallback
        ? `ISY connection successful (validated via ${probe.path}; /rest/ping not available on this ISY)`
        : 'ISY connection successful';

      return {
        success: true,
        message,
        connection: {
          host: connection.host,
          port: connection.port,
          useHttps: connection.useHttps,
          ignoreTlsErrors: connection.ignoreTlsErrors,
          username: connection.username,
          passwordMasked: this._maskSecret(connection.password)
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `ISY connection failed: ${error.message}`
      };
    }
  }

  async syncFromISY(payload = {}, runtime = {}) {
    console.log('InsteonService: Starting automated ISY extraction/sync workflow');

    const request = payload && typeof payload === 'object' ? payload : {};
    const onProgress = runtime && typeof runtime.onProgress === 'function'
      ? runtime.onProgress
      : null;
    const shouldCancel = runtime && typeof runtime.shouldCancel === 'function'
      ? runtime.shouldCancel
      : null;
    const reportProgress = (message, details = {}) => {
      if (!onProgress) {
        return;
      }

      try {
        onProgress({
          timestamp: new Date().toISOString(),
          message,
          ...details
        });
      } catch (error) {
        console.warn(`InsteonService: Failed to publish ISY sync progress update: ${error.message}`);
      }
    };
    const throwIfCancelled = (message = 'ISY migration cancelled by user.') => {
      this._throwIfISYSyncCancelled(shouldCancel, message);
    };

    const options = {
      dryRun: request.dryRun !== false,
      importDevices: request.importDevices !== false,
      importTopology: request.importTopology !== false,
      importPrograms: request.importPrograms !== false,
      enableProgramWorkflows: request.enableProgramWorkflows === true,
      continueOnError: request.continueOnError !== false
    };

    throwIfCancelled();
    reportProgress('Connecting to ISY and extracting metadata', { stage: 'extract', progress: 5 });
    const extraction = await this.extractISYData(request);
    throwIfCancelled('ISY migration cancelled after extraction.');
    const deviceReplayList = this._buildISYDeviceReplayList(extraction.devices);
    const excludedNodeText = extraction?.counts?.excludedNonInsteonNodes
      ? ` (${extraction.counts.excludedNonInsteonNodes} non-INSTEON nodes excluded)`
      : '';
    reportProgress(
      `Extraction complete: ${extraction.deviceIds.length} device IDs${excludedNodeText}, ${extraction.topologyScenes.length} scenes, ${extraction.programs.length} programs`,
      { stage: 'extract', progress: 25 }
    );
    const results = {
      success: true,
      dryRun: options.dryRun,
      message: '',
      options,
      extractedCounts: extraction.counts,
      extraction: {
        host: extraction.connection.host,
        port: extraction.connection.port,
        useHttps: extraction.connection.useHttps,
        nodes: extraction.counts?.nodes ?? extraction.devices.length,
        insteonNodes: extraction.counts?.insteonNodes ?? extraction.devices.length,
        excludedNonInsteonNodes: extraction.counts?.excludedNonInsteonNodes ?? 0,
        groups: extraction.groups.length,
        programs: extraction.programs.length,
        networkResources: extraction.networkResources.length,
        uniqueDeviceIds: extraction.deviceIds.length,
        topologyScenes: extraction.topologyScenes.length
      },
      devices: null,
      topology: null,
      programs: null,
      excludedNodes: extraction.excludedNodes || 0,
      errors: []
    };

    if (options.dryRun) {
      throwIfCancelled();
      reportProgress('Dry run mode enabled; no PLM writes will be performed', { stage: 'dry-run', progress: 35 });
      if (options.importTopology) {
        throwIfCancelled();
        reportProgress(`Previewing topology replay for ${extraction.topologyScenes.length} scenes`, { stage: 'topology', progress: 45 });
        results.topology = await this.applyISYSceneTopology({
          scenes: extraction.topologyScenes,
          dryRun: true
        }, {
          onProgress: (entry) => reportProgress(entry?.message || 'Topology preview update', {
            ...entry,
            stage: 'topology'
          }),
          shouldCancel
        });
        reportProgress(
          `Topology preview complete: ${results.topology.sceneCount || 0} scenes, ${results.topology.failedScenes || 0} failed`,
          { stage: 'topology', level: results.topology.success === false ? 'warn' : 'info', progress: 60 }
        );
      }
      if (options.importPrograms) {
        throwIfCancelled();
        reportProgress(`Previewing workflow import for ${extraction.programs.length} programs`, { stage: 'programs', progress: 70 });
        results.programs = await this.importISYProgramsAsWorkflows(extraction.programs, {
          dryRun: true,
          enableWorkflows: options.enableProgramWorkflows,
          resources: extraction.networkResources
        });
        reportProgress(
          `Program preview complete: ${results.programs?.processed || 0} processed, ${results.programs?.failed || 0} failed`,
          { stage: 'programs', level: results.programs?.success === false ? 'warn' : 'info', progress: 90 }
        );
      }

      results.message = [
        `Dry run complete`,
        options.importDevices
          ? `${extraction.deviceIds.length} INSTEON device IDs available for import (${extraction.devices.length} ISY nodes scanned)`
          : 'device import skipped',
        options.importTopology ? `${extraction.topologyScenes.length} topology scenes parsed` : 'topology import skipped',
        options.importPrograms ? `${extraction.programs.length} programs parsed` : 'program import skipped'
      ].join(', ');

      reportProgress(results.message, { stage: 'complete', progress: 100 });
      return results;
    }

    if (options.importDevices && extraction.deviceIds.length > 0) {
      throwIfCancelled();
      reportProgress(
        `Starting device replay for ${extraction.deviceIds.length} device IDs (${deviceReplayList.filter((entry) => Boolean(entry?.name)).length} names resolved)`,
        { stage: 'devices', progress: 35 }
      );
      try {
        results.devices = await this.importDevicesFromISY({
          devices: deviceReplayList,
          deviceIds: extraction.deviceIds,
          group: request.group ?? DEFAULT_ISY_IMPORT_GROUP,
          linkMode: request.linkMode || 'remote',
          perDeviceTimeoutMs: request.perDeviceTimeoutMs,
          retries: request.retries,
          pauseBetweenMs: request.pauseBetweenMs,
          checkExistingLinks: request.checkExistingLinks === true,
          skipLinking: request.skipLinking === true
        }, {
          onProgress: (entry) => reportProgress(entry?.message || 'Device replay update', {
            ...entry,
            stage: 'devices'
          }),
          shouldCancel
        });
        reportProgress(
          `Device replay complete: ${results.devices.accepted || 0} accepted, ${results.devices.linked || 0} linked, ${results.devices.linkWriteSucceeded || 0}/${results.devices.linkWriteAttempts || 0} link writes succeeded, ${results.devices.failed || 0} failed`,
          { stage: 'devices', level: results.devices.success === false ? 'warn' : 'info', progress: 55 }
        );
      } catch (error) {
        if (this._isISYSyncCancelledError(error)) {
          throw error;
        }
        results.success = false;
        results.errors.push({
          stage: 'devices',
          error: error.message
        });
        reportProgress(`Device replay failed: ${error.message}`, { stage: 'devices', level: 'error', progress: 55 });
        if (!options.continueOnError) {
          throw error;
        }
      }
    } else if (options.importDevices) {
      reportProgress('Device replay skipped: no valid INSTEON IDs extracted from ISY', { stage: 'devices', level: 'warn', progress: 55 });
    }

    if (options.importTopology && extraction.topologyScenes.length > 0) {
      throwIfCancelled();
      reportProgress(`Starting topology replay for ${extraction.topologyScenes.length} scenes`, { stage: 'topology', progress: 60 });
      try {
        results.topology = await this.applyISYSceneTopology({
          scenes: extraction.topologyScenes,
          dryRun: false,
          upsertDevices: false,
          continueOnError: request.continueOnError !== false,
          sceneTimeoutMs: request.sceneTimeoutMs,
          pauseBetweenScenesMs: request.pauseBetweenScenesMs,
          responderFallback: request.responderFallback
        }, {
          onProgress: (entry) => reportProgress(entry?.message || 'Topology replay update', {
            ...entry,
            stage: 'topology'
          }),
          shouldCancel
        });

        reportProgress(
          `Topology replay complete: ${results.topology.appliedScenes || 0} applied, ${results.topology.partialScenes || 0} partial, ${results.topology.fallbackScenes || 0} via fallback, ${results.topology.failedScenes || 0} failed, ${results.topology.skippedExistingScenes || 0} already in desired state`,
          { stage: 'topology', level: results.topology.success === false ? 'warn' : 'info', progress: 80 }
        );
        if (!results.topology.success) {
          results.success = false;
        }
      } catch (error) {
        if (this._isISYSyncCancelledError(error)) {
          throw error;
        }
        results.success = false;
        results.errors.push({
          stage: 'topology',
          error: error.message
        });
        reportProgress(`Topology replay failed: ${error.message}`, { stage: 'topology', level: 'error', progress: 80 });
        if (!options.continueOnError) {
          throw error;
        }
      }
    } else if (options.importTopology) {
      reportProgress('Topology replay skipped: no scenes parsed from ISY metadata', { stage: 'topology', level: 'warn', progress: 80 });
    }

    if (options.importPrograms && extraction.programs.length > 0) {
      throwIfCancelled();
      reportProgress(`Starting program translation for ${extraction.programs.length} programs`, { stage: 'programs', progress: 85 });
      try {
        results.programs = await this.importISYProgramsAsWorkflows(extraction.programs, {
          dryRun: false,
          enableWorkflows: options.enableProgramWorkflows,
          resources: extraction.networkResources
        });
        reportProgress(
          `Program translation complete: ${results.programs?.processed || 0} processed, ${results.programs?.failed || 0} failed`,
          { stage: 'programs', level: results.programs?.success === false ? 'warn' : 'info', progress: 95 }
        );
        if (!results.programs.success) {
          results.success = false;
        }
      } catch (error) {
        if (this._isISYSyncCancelledError(error)) {
          throw error;
        }
        results.success = false;
        results.errors.push({
          stage: 'programs',
          error: error.message
        });
        reportProgress(`Program translation failed: ${error.message}`, { stage: 'programs', level: 'error', progress: 95 });
        if (!options.continueOnError) {
          throw error;
        }
      }
    } else if (options.importPrograms) {
      reportProgress('Program translation skipped: no ISY programs parsed', { stage: 'programs', level: 'warn', progress: 95 });
    }

    const failedStages = new Set(
      Array.isArray(results.errors)
        ? results.errors.map((entry) => String(entry?.stage || '').toLowerCase()).filter(Boolean)
        : []
    );

    results.message = [
      `ISY sync complete`,
      results.devices
        ? `${results.devices.imported || 0} devices imported`
        : (failedStages.has('devices') ? 'devices failed' : 'devices skipped'),
      results.topology
        ? `${results.topology.appliedScenes || 0} scenes applied${results.topology.partialScenes ? ` (${results.topology.partialScenes} partial, ${results.topology.fallbackScenes || 0} via fallback${results.topology.skippedExistingScenes ? `, ${results.topology.skippedExistingScenes} already in desired state` : ''})` : (results.topology.skippedExistingScenes ? ` (${results.topology.skippedExistingScenes} already in desired state)` : '')}`
        : (failedStages.has('topology') ? 'topology failed' : 'topology skipped'),
      results.programs
        ? `${results.programs.created || 0} workflows created`
        : (failedStages.has('programs') ? 'programs failed' : 'programs skipped')
    ].join(', ');

    throwIfCancelled('ISY migration cancelled before completion.');
    reportProgress(results.message, { stage: 'complete', level: results.success ? 'info' : 'warn', progress: 100 });
    return results;
  }

  _collectTopologyDevices(scenes) {
    const deviceMap = new Map();
    const addDevice = (address, name, group) => {
      if (!address || address === 'gw') {
        return;
      }

      if (!deviceMap.has(address)) {
        deviceMap.set(address, {
          address,
          name: name || null,
          group
        });
        return;
      }

      const existing = deviceMap.get(address);
      if (!existing.name && name) {
        existing.name = name;
      }
    };

    scenes.forEach((scene) => {
      addDevice(scene.controller, scene.name, scene.group);
      scene.responders.forEach((responder) => {
        addDevice(responder.id, responder.name || scene.name, scene.group);
      });
    });

    return Array.from(deviceMap.values());
  }

  async _runTopologySceneWrite(scene, responders, { timeoutMs, shouldCancel = null }) {
    this._throwIfISYSyncCancelled(shouldCancel);
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    this._throwIfISYSyncCancelled(shouldCancel);
    await this._cancelLinkingSafe();
    this._throwIfISYSyncCancelled(shouldCancel);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (cancelInterval) {
          clearInterval(cancelInterval);
        }
        reject(new Error(`Timeout applying scene "${scene.name}"`));
      }, timeoutMs + 2000);
      const cancelInterval = typeof shouldCancel === 'function'
        ? setInterval(() => {
            if (settled || !shouldCancel()) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            clearInterval(cancelInterval);
            reject(this._buildISYSyncCancelledError('ISY migration cancelled while applying scene topology.'));
          }, 200)
        : null;

      const settle = (handler) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancelInterval) {
          clearInterval(cancelInterval);
        }
        handler(value);
      };

      const resolveOnce = settle(resolve);
      const rejectOnce = settle((error) => reject(error instanceof Error ? error : new Error(String(error))));

      try {
        this.hub.scene(
          scene.controller,
          responders.map(({ id, level, ramp, data }) => ({ id, level, ramp, data })),
          { group: scene.group, remove: scene.remove },
          (error) => {
            if (error) {
              rejectOnce(new Error(`Scene "${scene.name}" failed: ${error.message}`));
              return;
            }
            resolveOnce({
              group: scene.group,
              controller: scene.controller,
              responderCount: scene.responders.length
            });
          }
        );
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async _applyTopologyScene(scene, { timeoutMs, responderFallback = true, onFallbackProgress = null, shouldCancel = null }) {
    const fallbackProgress = typeof onFallbackProgress === 'function'
      ? onFallbackProgress
      : null;
    const throwIfCancelled = (message = 'ISY migration cancelled while applying scene topology.') => {
      this._throwIfISYSyncCancelled(shouldCancel, message);
    };

    try {
      throwIfCancelled();
      await this._runTopologySceneWrite(scene, scene.responders, { timeoutMs, shouldCancel });
      return {
        group: scene.group,
        controller: scene.controller,
        responderCount: scene.responders.length,
        fallbackUsed: false,
        fullSceneError: null,
        appliedResponders: scene.responders.map((responder) => responder.id),
        failedResponders: []
      };
    } catch (fullSceneError) {
      if (this._isISYSyncCancelledError(fullSceneError)) {
        throw fullSceneError;
      }

      const canFallback = responderFallback && Array.isArray(scene.responders) && scene.responders.length > 1;
      if (!canFallback) {
        throw fullSceneError;
      }

      const fullSceneErrorMessage = fullSceneError instanceof Error
        ? fullSceneError.message
        : String(fullSceneError || 'Unknown scene error');
      fallbackProgress?.(
        `Scene ${scene.name || `Group ${scene.group}`} failed as a bulk write; retrying per responder`,
        { level: 'warn' }
      );

      const appliedResponders = [];
      const failedResponders = [];

      for (const responder of scene.responders) {
        throwIfCancelled();
        const responderLabel = this._formatInsteonAddress(responder.id);
        try {
          await this._runTopologySceneWrite(
            {
              ...scene,
              name: `${scene.name || `Group ${scene.group}`} (responder ${responderLabel})`,
              responders: [responder]
            },
            [responder],
            { timeoutMs, shouldCancel }
          );
          appliedResponders.push(responder.id);
          fallbackProgress?.(
            `Fallback applied responder ${responderLabel} for scene ${scene.name || `Group ${scene.group}`}`,
            { level: 'warn' }
          );
        } catch (responderError) {
          if (this._isISYSyncCancelledError(responderError)) {
            throw responderError;
          }

          const responderMessage = responderError instanceof Error
            ? responderError.message
            : String(responderError || 'Unknown responder error');
          failedResponders.push({
            id: responder.id,
            error: responderMessage
          });
          fallbackProgress?.(
            `Fallback failed responder ${responderLabel}: ${responderMessage}`,
            { level: 'warn' }
          );
        }
      }

      if (appliedResponders.length === 0) {
        const firstResponderError = failedResponders[0]?.error || 'No responder-level detail available';
        throw new Error(
          `Scene "${scene.name}" failed: ${fullSceneErrorMessage}. Responder fallback failed for all ${scene.responders.length} responders. First responder error: ${firstResponderError}`
        );
      }

      return {
        group: scene.group,
        controller: scene.controller,
        responderCount: scene.responders.length,
        fallbackUsed: true,
        fullSceneError: fullSceneErrorMessage,
        appliedResponders,
        failedResponders
      };
    }
  }

  async _sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async _cancelLinkingSafe() {
    if (!this.hub || typeof this.hub.cancelLinking !== 'function') {
      return;
    }

    try {
      await this.hub.cancelLinking();
    } catch (error) {
      console.warn(`InsteonService: Unable to cancel previous linking session: ${error.message}`);
    }
  }

  async _executeRemoteLink(address, { group, timeoutMs, controller = false }) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    await this._cancelLinkingSafe();

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const role = controller ? 'as controller' : 'as responder';
        reject(new Error(`Timeout linking device ${this._formatInsteonAddress(normalizedAddress)} ${role}`));
      }, timeoutMs + 2000);

      const settle = (handler) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        handler(value);
      };

      const resolveOnce = settle(resolve);
      const rejectOnce = settle((error) => reject(error instanceof Error ? error : new Error(String(error))));

      try {
        this.hub.link(normalizedAddress, { group, controller }, (error, link) => {
          if (error) {
            const role = controller ? 'as controller' : 'as responder';
            rejectOnce(new Error(`Failed to link ${this._formatInsteonAddress(normalizedAddress)} ${role}: ${error.message}`));
            return;
          }
          if (!link) {
            const role = controller ? 'as controller' : 'as responder';
            rejectOnce(new Error(`Link command returned no confirmation for ${this._formatInsteonAddress(normalizedAddress)} ${role}`));
            return;
          }
          resolveOnce(link || null);
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async _linkDeviceRemote(address, { group, timeoutMs, ensureControllerLinks = true }) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const responderLink = await this._executeRemoteLink(normalizedAddress, {
      group,
      timeoutMs,
      controller: false
    });

    let controllerLink = null;
    let controllerLinkError = null;
    if (ensureControllerLinks) {
      try {
        controllerLink = await this._executeRemoteLink(normalizedAddress, {
          group,
          timeoutMs,
          controller: true
        });
      } catch (error) {
        controllerLinkError = error instanceof Error ? error : new Error(String(error));
      }
    }

    return {
      responderLink,
      controllerLink,
      controllerLinkError
    };
  }

  async _linkDeviceManual(address, { group, timeoutMs }) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const expectedAddress = this._normalizeInsteonAddress(address);
    await this._cancelLinkingSafe();

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timeout waiting for manual link of ${this._formatInsteonAddress(expectedAddress)}`));
      }, timeoutMs + 2000);

      const settle = (handler) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        handler(value);
      };

      const resolveOnce = settle(resolve);
      const rejectOnce = settle((error) => reject(error instanceof Error ? error : new Error(String(error))));

      try {
        this.hub.link({ group, timeout: timeoutMs }, (error, link) => {
          if (error) {
            rejectOnce(new Error(`Manual linking failed: ${error.message}`));
            return;
          }

          const rawLinkedAddress = link && (link.id || link.at || link.address);
          if (!rawLinkedAddress) {
            rejectOnce(new Error('Manual linking did not return a linked address'));
            return;
          }

          let linkedAddress;
          try {
            linkedAddress = this._normalizeInsteonAddress(String(rawLinkedAddress));
          } catch (normalizeError) {
            rejectOnce(new Error(`Manual linking returned an invalid address: ${rawLinkedAddress}`));
            return;
          }

          if (linkedAddress !== expectedAddress) {
            rejectOnce(new Error(
              `Manual linking completed for ${this._formatInsteonAddress(linkedAddress)} but expected ${this._formatInsteonAddress(expectedAddress)}`
            ));
            return;
          }

          resolveOnce(link || null);
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async _deviceHasLinkToPLM(address, group, plmId, { requireControllerLinks = true } = {}) {
    const hasResponderLink = await this._deviceHasResponderLinkToController(address, group, plmId);
    if (!hasResponderLink) {
      return false;
    }

    if (!requireControllerLinks) {
      return true;
    }

    const hasControllerLink = await this._deviceHasControllerLinkToTarget(address, group, plmId);
    if (hasControllerLink === null) {
      return true;
    }

    return hasControllerLink;
  }

  async _deviceHasResponderLinkToController(address, group, controllerAddress) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const normalizedControllerId = this._normalizeInsteonAddress(controllerAddress);

    try {
      const links = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout reading link table for ${this._formatInsteonAddress(normalizedAddress)}`));
        }, 12000);

        this.hub.links(normalizedAddress, (error, linkRecords) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }
          resolve(Array.isArray(linkRecords) ? linkRecords : []);
        });
      });

      return links.some((link) => {
        if (!link || link.isInUse === false || link.controller === true) {
          return false;
        }

        const rawId = typeof link.id === 'string' ? link.id : '';
        let normalizedLinkedId;
        try {
          normalizedLinkedId = this._normalizeInsteonAddress(rawId);
        } catch (error) {
          return false;
        }

        return Number(link.group) === group && normalizedLinkedId === normalizedControllerId;
      });
    } catch (error) {
      console.warn(
        `InsteonService: Could not inspect responder links for ${this._formatInsteonAddress(normalizedAddress)}: ${error.message}`
      );
      return false;
    }
  }

  async _deviceHasControllerLinkToTarget(address, group, targetAddress) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const normalizedTargetId = this._normalizeInsteonAddress(targetAddress);

    try {
      const links = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout reading link table for ${this._formatInsteonAddress(normalizedAddress)}`));
        }, 12000);

        this.hub.links(normalizedAddress, (error, linkRecords) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }
          resolve(Array.isArray(linkRecords) ? linkRecords : []);
        });
      });

      return links.some((link) => {
        if (!link || link.isInUse === false || link.controller !== true) {
          return false;
        }

        const rawId = typeof link.id === 'string' ? link.id : '';
        let normalizedLinkedId;
        try {
          normalizedLinkedId = this._normalizeInsteonAddress(rawId);
        } catch (error) {
          return false;
        }

        return Number(link.group) === group && normalizedLinkedId === normalizedTargetId;
      });
    } catch (error) {
      console.warn(
        `InsteonService: Could not inspect controller links for ${this._formatInsteonAddress(normalizedAddress)}: ${error.message}`
      );
      return null;
    }
  }

  async _isTopologySceneAlreadyLinked(scene, { normalizedPlmId = null } = {}) {
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.responders) || scene.responders.length === 0) {
      return false;
    }

    let controller = scene.controller;
    if (controller === 'gw') {
      controller = normalizedPlmId || null;
    }

    const normalizedController = this._normalizePossibleInsteonAddress(controller);
    if (!normalizedController) {
      return false;
    }

    const group = Number(scene.group);
    if (!Number.isInteger(group) || group < 0 || group > 255) {
      return false;
    }

    const expectLinkPresent = scene.remove !== true;
    for (const responder of scene.responders) {
      const responderId = this._normalizePossibleInsteonAddress(
        responder?.id || responder?.address || responder?.deviceId || responder?.insteonAddress || ''
      );

      if (!responderId) {
        return false;
      }

      const hasLink = await this._deviceHasResponderLinkToController(responderId, group, normalizedController);
      if (expectLinkPresent && !hasLink) {
        return false;
      }
      if (!expectLinkPresent && hasLink) {
        return false;
      }
    }

    return true;
  }

  async _findExistingInsteonDeviceByAddress(address) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const dottedAddress = this._formatInsteonAddress(normalizedAddress);
    const addressVariants = Array.from(new Set([
      normalizedAddress,
      normalizedAddress.toLowerCase(),
      dottedAddress,
      dottedAddress.toLowerCase()
    ]));

    return Device.findOne({
      'properties.insteonAddress': { $in: addressVariants }
    });
  }

  _emitDeviceRealtimeUpdate(device) {
    const payload = deviceUpdateEmitter.normalizeDevices([device]);
    if (payload.length > 0) {
      deviceUpdateEmitter.emit('devices:update', payload);
    }
  }

  async _persistDeviceRuntimeState(device, patch = {}) {
    if (!device || typeof patch !== 'object' || patch === null) {
      return device || null;
    }

    const nextState = {
      ...patch
    };

    if (nextState.status !== undefined) {
      nextState.status = Boolean(nextState.status);
    }

    if (nextState.brightness !== undefined) {
      const numericBrightness = Number(nextState.brightness);
      if (Number.isFinite(numericBrightness)) {
        nextState.brightness = Math.max(0, Math.min(100, Math.round(numericBrightness)));
      } else {
        delete nextState.brightness;
      }
    }

    if (nextState.isOnline !== undefined) {
      nextState.isOnline = Boolean(nextState.isOnline);
    }

    if (nextState.lastSeen === undefined) {
      nextState.lastSeen = new Date();
    }

    Object.assign(device, nextState);
    await device.save();

    const normalizedAddress = this._normalizePossibleInsteonAddress(device?.properties?.insteonAddress || '');
    if (normalizedAddress) {
      this.devices.set(normalizedAddress, device);
    }

    this._emitDeviceRealtimeUpdate(device);
    return device;
  }

  async _persistDeviceRuntimeStateByAddress(address, patch = {}) {
    const normalizedAddress = this._normalizePossibleInsteonAddress(address);
    if (!normalizedAddress) {
      return null;
    }

    const device = await this._findExistingInsteonDeviceByAddress(normalizedAddress);
    if (!device) {
      return null;
    }

    return this._persistDeviceRuntimeState(device, patch);
  }

  _stateFromInsteonLevel(level) {
    const numericLevel = Number(level);
    const boundedPercent = Number.isFinite(numericLevel)
      ? Math.max(0, Math.min(100, Math.round(numericLevel)))
      : 0;
    return {
      level: boundedPercent,
      status: boundedPercent > 0,
      brightness: boundedPercent,
      isOnline: true,
      lastSeen: new Date()
    };
  }

  _parseRuntimeCommand(command) {
    const payload = command?.standard || command?.extended || null;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const normalizedAddress = this._normalizePossibleInsteonAddress(payload.id);
    if (!normalizedAddress) {
      return null;
    }

    const command1 = String(payload.command1 || '').trim().toUpperCase();
    const command2Hex = String(payload.command2 || '').trim().toUpperCase();
    const command2 = Number.parseInt(command2Hex, 16);
    const hasNumericCommand2 = Number.isFinite(command2);

    let inferredState = null;
    if (command1 === '11' || command1 === '12' || command1 === '21') {
      const inferredBrightness = hasNumericCommand2
        ? Math.round((Math.max(0, Math.min(255, command2)) / 255) * 100)
        : 100;
      inferredState = {
        status: true,
        brightness: inferredBrightness,
        isOnline: true,
        lastSeen: new Date()
      };
    } else if (command1 === '13' || command1 === '14') {
      inferredState = {
        status: false,
        brightness: 0,
        isOnline: true,
        lastSeen: new Date()
      };
    } else if (command1 === '19' && hasNumericCommand2) {
      inferredState = {
        status: command2 > 0,
        brightness: Math.round((Math.max(0, Math.min(255, command2)) / 255) * 100),
        isOnline: true,
        lastSeen: new Date()
      };
    }

    return {
      address: normalizedAddress,
      command1,
      command2: command2Hex,
      inferredState
    };
  }

  _scheduleRuntimeStateRefresh(address, reason = 'command') {
    const normalizedAddress = this._normalizePossibleInsteonAddress(address);
    if (!normalizedAddress) {
      return;
    }

    if (this._pendingRuntimeStateRefreshes.has(normalizedAddress)) {
      return;
    }

    const timer = setTimeout(() => {
      this._pendingRuntimeStateRefreshes.delete(normalizedAddress);
      this._confirmDeviceStateByAddress(normalizedAddress, {
        attempts: 2,
        timeoutMs: 3500,
        pauseBetweenMs: 180,
        persistState: true
      }).catch((error) => {
        console.warn(`InsteonService: Runtime state refresh (${reason}) failed for ${this._formatInsteonAddress(normalizedAddress)}: ${error.message}`);
      });
    }, 300);

    this._pendingRuntimeStateRefreshes.set(normalizedAddress, timer);
  }

  async _handleRuntimeCommand(command) {
    const parsed = this._parseRuntimeCommand(command);
    if (!parsed) {
      return;
    }

    if (parsed.inferredState) {
      await this._persistDeviceRuntimeStateByAddress(parsed.address, parsed.inferredState);
    }

    this._scheduleRuntimeStateRefresh(parsed.address, `cmd:${parsed.command1}`);
  }

  async _upsertInsteonDevice({ address, group, insteonType, name, deviceInfo, markLinkedToCurrentPlm = false }) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const existingDevice = await this._findExistingInsteonDeviceByAddress(normalizedAddress);
    const info = deviceInfo || await this.getDeviceInfo(normalizedAddress);
    const existingProperties = existingDevice ? (existingDevice.properties || {}) : {};
    const existingCategory = this._coerceNumericValue(existingProperties.deviceCategory, 0);
    const existingSubcategory = this._coerceNumericValue(existingProperties.subcategory, 0);
    const incomingCategory = this._coerceNumericValue(info?.deviceCategory, 0);
    const incomingSubcategory = this._coerceNumericValue(info?.subcategory, 0);
    const resolvedCategory = incomingCategory > 0 ? incomingCategory : existingCategory;
    const resolvedSubcategory = (incomingCategory > 0 || incomingSubcategory > 0)
      ? incomingSubcategory
      : existingSubcategory;
    const resolvedInfo = {
      ...(info || {}),
      deviceCategory: resolvedCategory,
      subcategory: resolvedSubcategory
    };
    const preferredName = typeof name === 'string' && name.trim()
      ? name.trim()
      : `Insteon Device ${this._formatInsteonAddress(normalizedAddress)}`;
    const now = new Date();
    const inferredType = this._mapInsteonTypeToDeviceType(resolvedInfo);
    const descriptor = [
      insteonType,
      resolvedInfo?.productKey,
      preferredName,
      existingDevice?.name
    ]
      .filter((value) => typeof value === 'string' && value.trim())
      .join(' ')
      .toLowerCase();
    const inferredSupportsBrightness = (
      resolvedCategory === 0x01
      || existingProperties.supportsBrightness === true
      || existingDevice?.type === 'light'
      || /\bdimmer\b/.test(descriptor)
    );

    const mergedProperties = {
      ...existingProperties,
      source: 'insteon',
      insteonAddress: normalizedAddress,
      deviceCategory: resolvedCategory,
      subcategory: resolvedSubcategory
    };

    if (Number.isInteger(group)) {
      mergedProperties.insteonGroup = group;
    }
    if (insteonType) {
      mergedProperties.insteonType = insteonType;
    }
    if (markLinkedToCurrentPlm) {
      mergedProperties.linkedToCurrentPlm = true;
      mergedProperties.lastLinkedAt = now;
    }
    if (inferredSupportsBrightness) {
      mergedProperties.supportsBrightness = true;
    }

    if (existingDevice) {
      existingDevice.properties = mergedProperties;
      existingDevice.brand = existingDevice.brand || 'Insteon';
      if (typeof resolvedInfo.productKey === 'string' && resolvedInfo.productKey.trim()) {
        existingDevice.model = resolvedInfo.productKey.trim();
      }
      if (!existingDevice.type) {
        existingDevice.type = inferredSupportsBrightness && inferredType === 'switch'
          ? 'light'
          : inferredType;
      } else if (existingDevice.type === 'switch' && inferredType !== 'switch') {
        existingDevice.type = inferredType;
      } else if (existingDevice.type === 'switch' && inferredSupportsBrightness) {
        existingDevice.type = 'light';
      } else if (existingDevice.type === 'sensor' && inferredType === 'light') {
        existingDevice.type = inferredType;
      }
      existingDevice.room = existingDevice.room || 'Unassigned';
      existingDevice.isOnline = true;
      existingDevice.lastSeen = now;

      if (preferredName && (
        !existingDevice.name
        || /^Insteon Device\b/i.test(existingDevice.name)
        || this._isAddressLikeISYName(existingDevice.name)
      )) {
        existingDevice.name = preferredName;
      }

      await existingDevice.save();
      this.devices.set(normalizedAddress, existingDevice);

      return {
        action: 'updated',
        device: existingDevice
      };
    }

    const createdDevice = await Device.create({
      name: preferredName,
      type: inferredSupportsBrightness && inferredType === 'switch'
        ? 'light'
        : inferredType,
      room: 'Unassigned',
      status: false,
      brand: 'Insteon',
      model: resolvedInfo.productKey || 'Unknown',
      properties: mergedProperties,
      isOnline: true,
      lastSeen: now
    });

    this.devices.set(normalizedAddress, createdDevice);

    return {
      action: 'created',
      device: createdDevice
    };
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
      let serialPortModule = null;
      let runtimeTransport = connection.transport;
      let bridgeConnection = null;

      if (connection.transport === 'serial') {
        validatedSerial = await this._validateSerialEndpoint(connection.serialPath);
        connection.serialPath = validatedSerial.serialPath;
        connection.label = validatedSerial.serialPath;

        serialPortModule = this._loadSerialPortModule();
        if (serialPortModule) {
          if (this._isLocalSerialBridgeActive()) {
            await this._stopLocalSerialBridge({ reason: 'native serial transport available' });
          }
        } else {
          try {
            bridgeConnection = await this._ensureLocalSerialBridge(validatedSerial.serialPath, {
              baudRate: INSTEON_SERIAL_OPTIONS.baudRate
            });
            runtimeTransport = 'tcp';
            connection.host = bridgeConnection.host;
            connection.port = bridgeConnection.port;
            console.log(
              `InsteonService: Serial transport unavailable, using local TCP bridge at ${bridgeConnection.host}:${bridgeConnection.port}`
            );
          } catch (bridgeError) {
            throw new Error(this._buildSerialTransportUnavailableMessage(validatedSerial.serialPath, bridgeError));
          }
        }

        if (validatedSerial.stablePath && validatedSerial.serialPath.startsWith('/dev/tty')) {
          console.log(`InsteonService: Serial port ${validatedSerial.serialPath} also available as stable path ${validatedSerial.stablePath}`);
        }
        if (runtimeTransport === 'serial') {
          console.log(`InsteonService: Connecting to PLM on serial port ${connection.serialPath}`);
        }
      } else {
        if (this._isLocalSerialBridgeActive()) {
          await this._stopLocalSerialBridge({ reason: 'TCP endpoint selected' });
        }
        console.log(`InsteonService: Connecting to PLM over TCP at ${connection.label}`);
      }

      const targetIdentity = connection.transport === 'serial'
        ? connection.serialPath
        : connection.label;

      if (this.isConnected && this.hub) {
        const alreadyConnectedToTarget =
          this.connectionTransport === connection.transport &&
          this.connectionTarget === targetIdentity;

        if (alreadyConnectedToTarget) {
          console.log('InsteonService: Already connected to PLM');
          const response = {
            success: true,
            message: 'Already connected to Insteon PLM',
            port: this.connectionTarget || targetIdentity,
            transport: this.connectionTransport || connection.transport,
            runtimeTransport
          };
          if (connection.transport === 'serial' && runtimeTransport === 'tcp' && this._isLocalSerialBridgeActive()) {
            response.bridge = {
              host: this._localSerialBridge.host,
              port: this._localSerialBridge.port,
              serialPath: this._localSerialBridge.serialPath
            };
            response.runtimeEndpoint = `${this._localSerialBridge.host}:${this._localSerialBridge.port}`;
          }
          return response;
        }

        console.log(`InsteonService: Endpoint changed (${this.connectionTarget || 'unknown'} -> ${targetIdentity}), reconnecting`);
        await this.disconnect();
      }

      this.hub = new Insteon();
      if (runtimeTransport === 'serial' && serialPortModule) {
        this.hub.SerialPort = serialPortModule;
      }
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
          this.connectionTarget = targetIdentity;
          console.log('InsteonService: Successfully connected to PLM');
          const response = {
            success: true,
            message: 'Successfully connected to Insteon PLM',
            port: targetIdentity,
            transport: connection.transport,
            runtimeTransport
          };
          if (validatedSerial && validatedSerial.stablePath) {
            response.recommendedStablePort = validatedSerial.stablePath;
          }
          if (connection.transport === 'serial' && runtimeTransport === 'tcp' && bridgeConnection) {
            response.bridge = {
              host: bridgeConnection.host,
              port: bridgeConnection.port,
              serialPath: bridgeConnection.serialPath
            };
            response.runtimeEndpoint = `${bridgeConnection.host}:${bridgeConnection.port}`;
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
          if (runtimeTransport === 'tcp') {
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
      await this._stopLocalSerialBridge({ reason: 'manual disconnect' });

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
            resolve(this._normalizeInsteonInfoPayload(info));
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
            console.log(`InsteonService: Found ${links.length} link records`);

            const deviceMap = new Map();
            links.forEach((link) => {
              if (!link || link.isInUse === false) {
                return;
              }

              const rawAddress = typeof link.id === 'string'
                ? link.id
                : (typeof link.at === 'string' ? link.at : null);

              if (!rawAddress) {
                return;
              }

              let normalizedAddress;
              try {
                normalizedAddress = this._normalizeInsteonAddress(rawAddress);
              } catch (error) {
                return;
              }

              if (!deviceMap.has(normalizedAddress)) {
                deviceMap.set(normalizedAddress, {
                  address: normalizedAddress,
                  displayAddress: this._formatInsteonAddress(normalizedAddress),
                  group: Number.isInteger(link.group) ? link.group : 1,
                  controller: Boolean(link.controller),
                  data: link.data
                });
              }
            });

            const devices = Array.from(deviceMap.values());
            console.log(`InsteonService: Processed ${devices.length} unique linked devices`);
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
          const address = this._normalizeInsteonAddress(device.address);
          const existingDevice = await this._findExistingInsteonDeviceByAddress(address);

          if (existingDevice) {
            console.log(`InsteonService: Device ${this._formatInsteonAddress(address)} already exists, skipping`);
            skippedDevices.push(address);
            continue;
          }

          const deviceInfo = await this.getDeviceInfo(address);
          const upsertResult = await this._upsertInsteonDevice({
            address,
            group: device.group,
            insteonType: device.type,
            deviceInfo
          });

          console.log(`InsteonService: Imported device ${this._formatInsteonAddress(address)} as ${upsertResult.device._id}`);
          importedDevices.push(upsertResult.device);
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
   * Import devices from ISY device IDs and link them to the current PLM.
   * @param {Object} payload - ISY import payload
   * @returns {Promise<Object>} Import/link results
   */
  async importDevicesFromISY(payload = {}, runtime = {}) {
    console.log('InsteonService: Starting ISY device import/link workflow');

    try {
      const onProgress = runtime && typeof runtime.onProgress === 'function'
        ? runtime.onProgress
        : null;
      const shouldCancel = runtime && typeof runtime.shouldCancel === 'function'
        ? runtime.shouldCancel
        : null;
      const reportProgress = (message, details = {}) => {
        if (!onProgress || typeof message !== 'string' || !message.trim()) {
          return;
        }
        onProgress({
          timestamp: new Date().toISOString(),
          stage: 'devices',
          message: message.trim(),
          ...details
        });
      };
      const throwIfCancelled = (message = 'ISY migration cancelled during device replay.') => {
        this._throwIfISYSyncCancelled(shouldCancel, message);
      };

      throwIfCancelled();
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const parsed = this._parseISYImportPayload(payload);
      const { invalidEntries, duplicateCount, options } = parsed;
      const targetDevices = [];

      (Array.isArray(parsed.devices) ? parsed.devices : []).forEach((entry, index) => {
        const resolvedAddress = this._normalizePossibleInsteonAddress(
          entry?.address || entry?.id || entry?.deviceId || entry?.insteonAddress
        );

        if (!resolvedAddress) {
          invalidEntries.push({
            source: `parsed.devices[${index}]`,
            value: entry?.address,
            reason: `Invalid INSTEON address "${entry?.address}"`
          });
          return;
        }

        targetDevices.push({
          ...entry,
          address: resolvedAddress,
          displayAddress: this._formatInsteonAddress(resolvedAddress),
          name: typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : null
        });
      });

      if (targetDevices.length === 0) {
        reportProgress('Device replay skipped: no valid INSTEON IDs in payload', { level: 'warn', progress: 100 });
        throw new Error('No valid INSTEON device IDs were found in the request payload');
      }

      const plmInfo = await this.getPLMInfo();
      const normalizedPlmId = this._normalizePossibleInsteonAddress(plmInfo?.deviceId);

      const results = {
        success: true,
        message: '',
        requested: targetDevices.length + invalidEntries.length + duplicateCount,
        accepted: targetDevices.length,
        invalid: invalidEntries.length,
        duplicates: duplicateCount,
        group: options.group,
        linkMode: options.linkMode,
        skipLinking: options.skipLinking,
        ensureControllerLinks: options.ensureControllerLinks,
        linked: 0,
        alreadyLinked: 0,
        linkWriteAttempts: 0,
        linkWriteSucceeded: 0,
        linkWriteFailed: 0,
        imported: 0,
        updated: 0,
        failed: 0,
        devices: [],
        invalidEntries,
        errors: [],
        warnings: []
      };

      if (!options.skipLinking && options.checkExistingLinks && !normalizedPlmId) {
        results.warnings.push('PLM device ID unavailable from modem info; skipping pre-link checks and attempting link operations directly.');
      }

      reportProgress(`Starting replay for ${targetDevices.length} device ID(s)`, { progress: 0 });
      for (let index = 0; index < targetDevices.length; index += 1) {
        throwIfCancelled(`ISY migration cancelled before device ${index + 1}/${targetDevices.length}.`);
        const entry = targetDevices[index];
        const progress = Math.round(((index + 1) / targetDevices.length) * 100);
        const detail = {
          address: entry.address,
          displayAddress: entry.displayAddress,
          name: entry.name
        };

        try {
          reportProgress(
            `Processing device ${index + 1}/${targetDevices.length}: ${entry.displayAddress}`,
            { progress }
          );

          const shouldCheckExistingLinks = !options.skipLinking && options.checkExistingLinks && Boolean(normalizedPlmId);
          let isAlreadyLinked = false;

          if (shouldCheckExistingLinks) {
            isAlreadyLinked = await this._deviceHasLinkToPLM(entry.address, options.group, normalizedPlmId, {
              requireControllerLinks: options.ensureControllerLinks
            });
          }

          if (options.skipLinking) {
            detail.linkStatus = 'skipped';
          } else if (isAlreadyLinked) {
            detail.linkStatus = 'already-linked';
            results.alreadyLinked += 1;
          } else {
            results.linkWriteAttempts += 1;
            const linkRequest = {
              group: options.group,
              timeoutMs: options.timeoutMs,
              ensureControllerLinks: options.ensureControllerLinks
            };
            let linkError = null;
            let linkResult = null;

            for (let attempt = 0; attempt <= options.retries; attempt += 1) {
              throwIfCancelled(`ISY migration cancelled while linking ${entry.displayAddress}.`);
              try {
                if (options.linkMode === 'manual') {
                  await this._linkDeviceManual(entry.address, linkRequest);
                } else {
                  linkResult = await this._linkDeviceRemote(entry.address, linkRequest);
                }
                linkError = null;
                break;
              } catch (error) {
                linkError = error;
                if (attempt < options.retries) {
                  throwIfCancelled(`ISY migration cancelled while retrying ${entry.displayAddress}.`);
                  await this._sleep(500);
                }
              }
            }

            if (linkError) {
              results.linkWriteFailed += 1;
              throw linkError;
            }

            if (normalizedPlmId) {
              const responderLinkVerified = await this._deviceHasResponderLinkToController(
                entry.address,
                options.group,
                normalizedPlmId
              );
              if (!responderLinkVerified) {
                results.linkWriteFailed += 1;
                throw new Error(`Responder link verification failed for ${entry.displayAddress} (group ${options.group})`);
              }
              detail.responderLinkVerified = true;
            }

            detail.linkStatus = options.linkMode === 'manual' ? 'linked-manual' : 'linked-remote';
            results.linked += 1;
            results.linkWriteSucceeded += 1;
            if (linkResult?.controllerLinkError) {
              detail.controllerLinkStatus = 'warning';
              detail.controllerLinkWarning = `Device-to-PLM controller link failed (${linkResult.controllerLinkError.message}); this device may require polling for state updates.`;
              results.warnings.push(`${entry.displayAddress}: ${detail.controllerLinkWarning}`);
              reportProgress(
                `Controller link warning for ${entry.displayAddress}: ${linkResult.controllerLinkError.message}`,
                { level: 'warn', progress }
              );
            } else if (options.ensureControllerLinks && options.linkMode !== 'manual') {
              detail.controllerLinkStatus = 'linked';
            }
          }

          let deviceInfo;
          try {
            deviceInfo = await this.getDeviceInfo(entry.address);
          } catch (infoError) {
            const infoErrorMessage = infoError instanceof Error ? infoError.message : String(infoError || 'Unknown error');
            deviceInfo = {
              deviceId: entry.address,
              deviceCategory: 0,
              subcategory: 0,
              firmwareVersion: 'Unknown'
            };
            detail.infoStatus = 'fallback';
            detail.infoWarning = `Device metadata unavailable (${infoErrorMessage}); imported with basic metadata.`;
            results.warnings.push(`${entry.displayAddress}: ${detail.infoWarning}`);
            reportProgress(
              `Info unavailable for ${entry.displayAddress}; continuing with basic metadata`,
              { level: 'warn', progress }
            );
          }

          const upsertResult = await this._upsertInsteonDevice({
            address: entry.address,
            group: options.group,
            name: entry.name,
            deviceInfo,
            markLinkedToCurrentPlm: !options.skipLinking
          });

          detail.deviceId = upsertResult.device._id;
          detail.importStatus = upsertResult.action;

          if (upsertResult.action === 'created') {
            results.imported += 1;
          } else {
            results.updated += 1;
          }

          results.devices.push(detail);
          reportProgress(
            `Completed ${entry.displayAddress}: ${detail.linkStatus || 'processed'}, ${detail.importStatus || 'updated'}`,
            { progress }
          );
        } catch (error) {
          detail.error = error.message;
          results.failed += 1;
          results.errors.push({
            address: entry.address,
            error: error.message
          });
          results.devices.push(detail);
          reportProgress(
            `Failed ${entry.displayAddress}: ${error.message}`,
            { level: 'error', progress }
          );
        }

        if (index < targetDevices.length - 1 && options.pauseBetweenMs > 0) {
          throwIfCancelled(`ISY migration cancelled during replay pause after ${entry.displayAddress}.`);
          await this._sleep(options.pauseBetweenMs);
        }
      }

      results.success = results.failed === 0;
      results.message = [
        `Processed ${results.accepted} ISY device IDs`,
        `${results.linked} linked`,
        `${results.linkWriteSucceeded}/${results.linkWriteAttempts} link writes succeeded`,
        `${results.alreadyLinked} already linked`,
        `${results.imported} imported`,
        `${results.updated} updated`,
        `${results.failed} failed`
      ].join(', ');

      console.log(`InsteonService: ISY import complete - ${results.message}`);
      reportProgress(results.message, {
        level: results.success ? 'info' : 'warn',
        progress: 100
      });
      return results;
    } catch (error) {
      if (this._isISYSyncCancelledError(error)) {
        throw error;
      }
      console.error('InsteonService: ISY import failed:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to import ISY devices: ${error.message}`);
    }
  }

  /**
   * Recreate ISY scene topology against the currently connected PLM.
   * @param {Object} payload - Scene topology payload
   * @returns {Promise<Object>} Sync results
   */
  async applyISYSceneTopology(payload = {}, runtime = {}) {
    console.log('InsteonService: Starting ISY scene topology sync');

    try {
      const onProgress = runtime && typeof runtime.onProgress === 'function'
        ? runtime.onProgress
        : null;
      const shouldCancel = runtime && typeof runtime.shouldCancel === 'function'
        ? runtime.shouldCancel
        : null;
      const reportProgress = (message, details = {}) => {
        if (!onProgress || typeof message !== 'string' || !message.trim()) {
          return;
        }
        onProgress({
          timestamp: new Date().toISOString(),
          stage: 'topology',
          message: message.trim(),
          ...details
        });
      };
      const throwIfCancelled = (message = 'ISY migration cancelled during topology replay.') => {
        this._throwIfISYSyncCancelled(shouldCancel, message);
      };

      throwIfCancelled();
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const parsed = this._parseISYTopologyPayload(payload);
      const { scenes, invalidEntries, options } = parsed;
      const topologyDevices = this._collectTopologyDevices(scenes);

      const results = {
        success: true,
        dryRun: options.dryRun,
        message: '',
        sceneCount: scenes.length,
        invalid: invalidEntries.length,
        plannedLinkOperations: scenes.reduce((sum, scene) => sum + scene.responders.length, 0),
        appliedScenes: 0,
        partialScenes: 0,
        fallbackScenes: 0,
        skippedExistingScenes: 0,
        failedScenes: 0,
        imported: 0,
        updated: 0,
        devices: topologyDevices.length,
        scenes: [],
        invalidEntries,
        errors: [],
        warnings: []
      };

      if (options.dryRun) {
        results.scenes = scenes.map((scene) => ({
          name: scene.name,
          group: scene.group,
          controller: scene.controller,
          responders: scene.responders.length,
          status: 'planned'
        }));
        results.message = `Dry run: ${scenes.length} scenes parsed (${results.plannedLinkOperations} responder links planned)`;
        console.log(`InsteonService: ${results.message}`);
        reportProgress(results.message, { progress: 100 });
        return results;
      }

      let normalizedPlmId = null;
      if (options.checkExistingSceneLinks) {
        throwIfCancelled();
        try {
          const plmInfo = await this.getPLMInfo();
          normalizedPlmId = this._normalizePossibleInsteonAddress(plmInfo?.deviceId);
        } catch (error) {
          results.warnings.push(`Unable to read PLM ID for existing-link checks: ${error.message}`);
        }
      }

      reportProgress(`Starting topology replay for ${scenes.length} scene(s)`, { progress: 0 });
      for (let index = 0; index < scenes.length; index += 1) {
        throwIfCancelled(`ISY migration cancelled before scene ${index + 1}/${scenes.length}.`);
        const scene = scenes[index];
        const progress = scenes.length > 0
          ? Math.round(((index + 1) / scenes.length) * 100)
          : 100;
        const sceneResult = {
          name: scene.name,
          group: scene.group,
          controller: scene.controller,
          responders: scene.responders.length
        };

        try {
          reportProgress(
            `Processing scene ${index + 1}/${scenes.length}: ${scene.name || `Group ${scene.group}`}`,
            { progress }
          );

          if (options.checkExistingSceneLinks) {
            const alreadyLinked = await this._isTopologySceneAlreadyLinked(scene, { normalizedPlmId });
            if (alreadyLinked) {
              sceneResult.status = scene.remove ? 'already-removed' : 'already-linked';
              results.skippedExistingScenes += 1;
              results.scenes.push(sceneResult);
              reportProgress(
                `Skipped scene ${scene.name || `Group ${scene.group}`}: already in desired state`,
                { level: 'warn', progress }
              );
              if (index < scenes.length - 1 && options.pauseBetweenScenesMs > 0) {
                await this._sleep(options.pauseBetweenScenesMs);
              }
              continue;
            }
          }

          const applyResult = await this._applyTopologyScene(scene, {
            timeoutMs: options.sceneTimeoutMs,
            responderFallback: options.responderFallback !== false,
            onFallbackProgress: (message, details = {}) => reportProgress(message, {
              ...details,
              progress
            }),
            shouldCancel
          });

          if (applyResult?.fallbackUsed) {
            sceneResult.fallbackUsed = true;
            sceneResult.fullSceneError = applyResult.fullSceneError || null;
            sceneResult.appliedResponders = Array.isArray(applyResult.appliedResponders)
              ? applyResult.appliedResponders.map((responderId) => this._formatInsteonAddress(responderId))
              : [];
            sceneResult.failedResponders = Array.isArray(applyResult.failedResponders)
              ? applyResult.failedResponders.map((entry) => ({
                  ...entry,
                  displayAddress: this._formatInsteonAddress(entry?.id)
                }))
              : [];
            results.fallbackScenes += 1;

            if (sceneResult.failedResponders.length > 0) {
              sceneResult.status = 'applied-partial';
              sceneResult.warning = `${sceneResult.failedResponders.length} responder${sceneResult.failedResponders.length === 1 ? '' : 's'} failed during fallback`;
              results.partialScenes += 1;
              results.warnings.push(
                `${scene.name || `Group ${scene.group}`}: fallback applied with ${sceneResult.failedResponders.length} responder failure${sceneResult.failedResponders.length === 1 ? '' : 's'}.`
              );
              reportProgress(
                `Applied scene ${scene.name || `Group ${scene.group}`} with responder fallback (${sceneResult.failedResponders.length} responder failure${sceneResult.failedResponders.length === 1 ? '' : 's'})`,
                { level: 'warn', progress }
              );
            } else {
              sceneResult.status = 'applied-fallback';
              reportProgress(
                `Applied scene ${scene.name || `Group ${scene.group}`} via responder fallback`,
                { level: 'warn', progress }
              );
            }
          } else {
            sceneResult.status = 'applied';
            reportProgress(
              `Applied scene ${scene.name || `Group ${scene.group}`}`,
              { progress }
            );
          }

          results.appliedScenes += 1;
        } catch (error) {
          if (this._isISYSyncCancelledError(error)) {
            throw error;
          }
          sceneResult.status = 'failed';
          sceneResult.error = error.message;
          results.failedScenes += 1;
          results.errors.push({
            scene: scene.name,
            group: scene.group,
            error: error.message
          });
          reportProgress(
            `Failed scene ${scene.name || `Group ${scene.group}`}: ${error.message}`,
            { level: 'error', progress }
          );

          if (!options.continueOnError) {
            results.scenes.push(sceneResult);
            break;
          }
        }

        results.scenes.push(sceneResult);

        if (index < scenes.length - 1 && options.pauseBetweenScenesMs > 0) {
          throwIfCancelled(`ISY migration cancelled during topology pause after scene ${scene.name || `Group ${scene.group}`}.`);
          await this._sleep(options.pauseBetweenScenesMs);
        }
      }

      if (options.upsertDevices) {
        for (const device of topologyDevices) {
          throwIfCancelled();
          try {
            const upsertResult = await this._upsertInsteonDevice({
              address: device.address,
              group: device.group,
              name: device.name,
              markLinkedToCurrentPlm: true
            });

            if (upsertResult.action === 'created') {
              results.imported += 1;
            } else {
              results.updated += 1;
            }
          } catch (error) {
            results.errors.push({
              address: device.address,
              error: `Database upsert failed: ${error.message}`
            });
          }
        }
      }

      results.success = results.failedScenes === 0;
      results.message = [
        `Processed ${results.sceneCount} scenes`,
        `${results.appliedScenes} applied`,
        `${results.partialScenes} partial`,
        `${results.fallbackScenes} via fallback`,
        `${results.skippedExistingScenes} already in desired state`,
        `${results.failedScenes} failed`,
        `${results.imported} imported`,
        `${results.updated} updated`
      ].join(', ');

      console.log(`InsteonService: ISY topology sync complete - ${results.message}`);
      reportProgress(results.message, {
        level: results.success ? 'info' : 'warn',
        progress: 100
      });
      return results;
    } catch (error) {
      if (this._isISYSyncCancelledError(error)) {
        throw error;
      }
      console.error('InsteonService: ISY topology sync failed:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to sync ISY topology: ${error.message}`);
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
              deviceId: this._normalizePossibleInsteonAddress(address),
              deviceCategory: 0,
              subcategory: 0,
              firmwareVersion: 'Unknown'
            });
          } else {
            console.log(`InsteonService: Device ${address} info retrieved`);
            resolve(this._normalizeInsteonInfoPayload(info, address));
          }
        });
      });
    } catch (error) {
      console.error(`InsteonService: Failed to get device info for ${address}:`, error.message);
      // Return basic info instead of throwing
      return {
        deviceId: this._normalizePossibleInsteonAddress(address),
        deviceCategory: 0,
        subcategory: 0,
        firmwareVersion: 'Unknown'
      };
    }
  }

  async _queryDeviceLevelByAddress(address, timeoutMs = 5000) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const timeoutValue = Number.isFinite(Number(timeoutMs)) ? Math.max(500, Number(timeoutMs)) : 5000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Timeout getting device status for ${this._formatInsteonAddress(normalizedAddress)}`);
        error.code = 'INSTEON_LEVEL_TIMEOUT';
        error.details = {
          insteonAddress: this._formatInsteonAddress(normalizedAddress)
        };
        reject(error);
      }, timeoutValue);

      this.hub.level(normalizedAddress, (error, level) => {
        clearTimeout(timeout);

        if (error) {
          reject(error);
          return;
        }

        const numericLevel = Number(level);
        if (!Number.isFinite(numericLevel)) {
          reject(new Error(`Invalid level response for ${this._formatInsteonAddress(normalizedAddress)}`));
          return;
        }

        // home-controller light.level() returns percentage (0-100).
        // Some adapters may still surface raw 0-255 values; normalize both.
        const normalizedPercent = numericLevel > 100
          ? Math.round((Math.max(0, Math.min(255, numericLevel)) / 255) * 100)
          : Math.round(numericLevel);

        resolve(Math.max(0, Math.min(100, normalizedPercent)));
      });
    });
  }

  async _confirmDeviceStateByAddress(address, options = {}) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const attempts = Number.isFinite(Number(options.attempts))
      ? Math.max(1, Math.min(5, Number(options.attempts)))
      : 2;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(500, Number(options.timeoutMs))
      : 4000;
    const pauseBetweenMs = Number.isFinite(Number(options.pauseBetweenMs))
      ? Math.max(0, Number(options.pauseBetweenMs))
      : 150;
    const persistState = options.persistState !== false;

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const level = await this._queryDeviceLevelByAddress(normalizedAddress, timeoutMs);
        const state = this._stateFromInsteonLevel(level);
        if (persistState) {
          await this._persistDeviceRuntimeStateByAddress(normalizedAddress, state);
        }
        return state;
      } catch (error) {
        lastError = error;
        if (attempt < attempts && pauseBetweenMs > 0) {
          await this._sleep(pauseBetweenMs);
        }
      }
    }

    throw lastError || new Error(`Unable to confirm device state for ${this._formatInsteonAddress(normalizedAddress)}`);
  }

  async _confirmExpectedDeviceStateByAddress(address, expectedStatus, options = {}) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const attempts = Number.isFinite(Number(options.attempts))
      ? Math.max(1, Math.min(8, Number(options.attempts)))
      : 4;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(500, Number(options.timeoutMs))
      : 4000;
    const pauseBetweenMs = Number.isFinite(Number(options.pauseBetweenMs))
      ? Math.max(0, Number(options.pauseBetweenMs))
      : 200;
    const settleBetweenMatchesMs = Number.isFinite(Number(options.settleBetweenMatchesMs))
      ? Math.max(0, Number(options.settleBetweenMatchesMs))
      : 250;
    const requiredMatches = Number.isFinite(Number(options.requiredMatches))
      ? Math.max(1, Math.min(3, Number(options.requiredMatches)))
      : 2;
    const persistState = options.persistState !== false;

    let consecutiveMatches = 0;
    let lastState = null;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const level = await this._queryDeviceLevelByAddress(normalizedAddress, timeoutMs);
        const state = this._stateFromInsteonLevel(level);
        lastState = state;

        if (persistState) {
          await this._persistDeviceRuntimeStateByAddress(normalizedAddress, state);
        }

        if (state.status === Boolean(expectedStatus)) {
          consecutiveMatches += 1;
          if (consecutiveMatches >= requiredMatches) {
            return {
              ...state,
              confirmedReads: consecutiveMatches
            };
          }

          if (attempt < attempts && settleBetweenMatchesMs > 0) {
            await this._sleep(settleBetweenMatchesMs);
          }
          continue;
        }

        consecutiveMatches = 0;
        lastError = new Error(
          `Expected ${Boolean(expectedStatus) ? 'ON' : 'OFF'} but observed ${state.status ? 'ON' : 'OFF'}`
        );
      } catch (error) {
        consecutiveMatches = 0;
        lastError = error;
      }

      if (attempt < attempts && pauseBetweenMs > 0) {
        await this._sleep(pauseBetweenMs);
      }
    }

    const lastObservedText = lastState
      ? ` Last observed ${lastState.status ? 'ON' : 'OFF'} at ${lastState.brightness}% brightness.`
      : '';
    const error = new Error(
      `Unable to confirm a stable ${Boolean(expectedStatus) ? 'ON' : 'OFF'} state for ${this._formatInsteonAddress(normalizedAddress)}.${lastObservedText}${lastError?.message ? ` ${lastError.message}` : ''}`.trim()
    );
    error.details = {
      expectedStatus: Boolean(expectedStatus),
      lastObservedState: lastState ? { ...lastState } : null,
      lastErrorCode: lastError?.code || null
    };

    if (lastState && lastState.status === Boolean(expectedStatus)) {
      error.code = 'INSTEON_STATE_CONFIRMATION_UNCERTAIN';
    } else if (!lastState && lastError?.code === 'INSTEON_LEVEL_TIMEOUT') {
      error.code = 'INSTEON_STATE_CONFIRMATION_TIMEOUT';
    } else if (lastState && lastState.status !== Boolean(expectedStatus)) {
      error.code = 'INSTEON_STATE_MISMATCH';
    } else {
      error.code = 'INSTEON_STATE_CONFIRMATION_FAILED';
    }

    throw error;
  }

  _buildOptimisticCommandState(expectedStatus, brightness = null) {
    const targetStatus = Boolean(expectedStatus);
    const numericBrightness = Number(brightness);
    const normalizedBrightness = targetStatus
      ? (Number.isFinite(numericBrightness) ? Math.max(1, Math.min(100, Math.round(numericBrightness))) : 100)
      : 0;

    return {
      status: targetStatus,
      brightness: normalizedBrightness,
      level: normalizedBrightness,
      isOnline: true,
      lastSeen: new Date()
    };
  }

  _getExpectedStateConfirmationOptions(expectedStatus, options = {}) {
    const verificationMode = String(options?.verificationMode || 'stable').trim().toLowerCase();
    if (verificationMode === 'fast') {
      return {
        attempts: Boolean(expectedStatus) ? 2 : 2,
        timeoutMs: 1500,
        pauseBetweenMs: 120,
        settleBetweenMatchesMs: 0,
        requiredMatches: 1,
        persistState: true
      };
    }

    return {
      attempts: 4,
      timeoutMs: 4200,
      pauseBetweenMs: 220,
      settleBetweenMatchesMs: 250,
      requiredMatches: 2,
      persistState: true
    };
  }

  _isRecoverableStateConfirmationError(error, expectedStatus) {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = String(error.code || '').trim().toUpperCase();
    if (!['INSTEON_STATE_CONFIRMATION_TIMEOUT', 'INSTEON_STATE_CONFIRMATION_UNCERTAIN'].includes(code)) {
      return false;
    }

    const lastObservedStatus = error?.details?.lastObservedState?.status;
    return lastObservedStatus == null || lastObservedStatus === Boolean(expectedStatus);
  }

  async _executeHubCommandWithTimeout(invoke, timeoutMessage, timeoutMs = 5000) {
    const boundedTimeoutMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(500, Number(timeoutMs))
      : 5000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(timeoutMessage);
        error.code = 'INSTEON_COMMAND_TIMEOUT';
        reject(error);
      }, boundedTimeoutMs);

      invoke((error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async _recoverCommandStateAfterTimeout(address, expectedStatus) {
    try {
      return await this._confirmExpectedDeviceStateByAddress(address, expectedStatus, {
        attempts: 2,
        timeoutMs: 2500,
        pauseBetweenMs: 150,
        settleBetweenMatchesMs: 0,
        requiredMatches: 1,
        persistState: true
      });
    } catch (error) {
      console.warn(
        `InsteonService: Unable to recover device state for ${this._formatInsteonAddress(address)} after command timeout: ${error.message}`
      );
      return null;
    }
  }

  _buildInsteonControlDetails(device, address, action, confirmedState = null, extra = {}) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const formattedAddress = this._formatInsteonAddress(normalizedAddress);
    return {
      controlMethod: 'insteon_plm_direct',
      action: String(action || '').trim().toLowerCase() || null,
      insteonAddress: formattedAddress,
      insteonAddressNormalized: normalizedAddress,
      deviceModel: device?.model || null,
      deviceCategory: device?.properties?.deviceCategory ?? null,
      deviceSubcategory: device?.properties?.subcategory ?? null,
      confirmedStatus: confirmedState?.status ?? null,
      confirmedBrightness: confirmedState?.brightness ?? null,
      confirmedLevel: confirmedState?.level ?? null,
      confirmedReads: confirmedState?.confirmedReads ?? null,
      ...extra
    };
  }

  async _queryDeviceInfoByAddress(address, timeoutMs = 5000) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const timeoutValue = Number.isFinite(Number(timeoutMs)) ? Math.max(500, Number(timeoutMs)) : 5000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout getting device info for ${this._formatInsteonAddress(normalizedAddress)}`));
      }, timeoutValue);

      this.hub.info(normalizedAddress, (error, info) => {
        clearTimeout(timeout);

        if (error) {
          reject(error);
          return;
        }

        resolve(this._normalizeInsteonInfoPayload(info, normalizedAddress));
      });
    });
  }

  async _queryDevicePingByAddress(address, timeoutMs = 3000) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const timeoutValue = Number.isFinite(Number(timeoutMs)) ? Math.max(500, Number(timeoutMs)) : 3000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout pinging ${this._formatInsteonAddress(normalizedAddress)}`));
      }, timeoutValue);

      try {
        this.hub.ping(normalizedAddress, (error, response) => {
          clearTimeout(timeout);

          if (error) {
            reject(error);
            return;
          }

          if (!response) {
            reject(new Error(`No ping response from ${this._formatInsteonAddress(normalizedAddress)}`));
            return;
          }

          resolve(response);
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async queryLinkedDevicesStatus(payload = {}, runtime = {}) {
    console.log('InsteonService: Querying linked PLM devices for live status');

    const request = payload && typeof payload === 'object' ? payload : {};
    const onProgress = runtime && typeof runtime.onProgress === 'function'
      ? runtime.onProgress
      : null;
    const shouldCancel = runtime && typeof runtime.shouldCancel === 'function'
      ? runtime.shouldCancel
      : null;
    const reportProgress = (message, details = {}) => {
      if (!onProgress) {
        return;
      }

      try {
        onProgress({
          timestamp: new Date().toISOString(),
          message,
          ...details
        });
      } catch (error) {
        console.warn(`InsteonService: Failed to publish linked-query progress update: ${error.message}`);
      }
    };
    const throwIfCancelled = () => {
      if (shouldCancel && shouldCancel()) {
        const cancellationError = new Error('Query cancelled by user.');
        cancellationError.code = 'QUERY_CANCELLED';
        cancellationError.isCancelled = true;
        throw cancellationError;
      }
    };

    try {
      throwIfCancelled();

      if (!this.isConnected || !this.hub) {
        reportProgress('Connecting to PLM runtime', { stage: 'connect', progress: 1 });
        await this.connect();
      }

      reportProgress('Connected to PLM; loading linked-device table', { stage: 'query', progress: 3 });

      const levelTimeoutMs = Number.isFinite(Number(request.levelTimeoutMs))
        ? Math.max(500, Number(request.levelTimeoutMs))
        : 3000;
      const pingTimeoutMs = Number.isFinite(Number(request.pingTimeoutMs))
        ? Math.max(500, Number(request.pingTimeoutMs))
        : 3000;
      const infoTimeoutMs = Number.isFinite(Number(request.infoTimeoutMs))
        ? Math.max(500, Number(request.infoTimeoutMs))
        : 3000;
      const pauseBetweenMs = Number.isFinite(Number(request.pauseBetweenMs))
        ? Math.max(0, Number(request.pauseBetweenMs))
        : 120;

      const linkedDevices = await this.getAllLinkedDevices();
      const sortedLinkedDevices = linkedDevices
        .slice()
        .sort((a, b) => String(a?.displayAddress || a?.address || '').localeCompare(String(b?.displayAddress || b?.address || '')));
      const totalDevices = sortedLinkedDevices.length;

      reportProgress(
        `Loaded ${totalDevices} linked device ID${totalDevices === 1 ? '' : 's'} from PLM`,
        { stage: 'query', progress: 5 }
      );

      throwIfCancelled();
      const plmInfo = await this.getPLMInfo().catch((error) => ({
        deviceId: null,
        firmwareVersion: 'Unknown',
        deviceCategory: 0,
        subcategory: 0,
        error: error.message
      }));

      const queriedDevices = [];
      const warnings = [];
      if (plmInfo?.error) {
        warnings.push(`PLM metadata query warning: ${plmInfo.error}`);
        reportProgress(`PLM metadata query warning: ${plmInfo.error}`, { stage: 'query', level: 'warn' });
      }

      const dbDevicesByAddress = new Map();
      try {
        const dbDevices = await Device.find({ 'properties.source': 'insteon' });
        dbDevices.forEach((device) => {
          const normalized = this._normalizePossibleInsteonAddress(device?.properties?.insteonAddress || '');
          if (normalized) {
            dbDevicesByAddress.set(normalized, device);
          }
        });
      } catch (dbError) {
        warnings.push(`Device-name lookup warning: ${dbError.message}`);
        reportProgress(`Device-name lookup warning: ${dbError.message}`, { stage: 'query', level: 'warn' });
      }

      if (totalDevices === 0) {
        const emptyResult = {
          success: true,
          message: 'No linked devices were found in the PLM database.',
          scannedAt: new Date().toISOString(),
          plmInfo,
          summary: {
            linkedDevices: 0,
            reachable: 0,
            unreachable: 0,
            statusKnown: 0,
            statusUnknown: 0
          },
          warnings,
          devices: []
        };
        reportProgress(emptyResult.message, { stage: 'complete', progress: 100 });
        return emptyResult;
      }

      for (let index = 0; index < sortedLinkedDevices.length; index += 1) {
        throwIfCancelled();
        const linkedDevice = sortedLinkedDevices[index];
        const progressStart = 5 + Math.floor((index / totalDevices) * 90);
        const fallbackDisplayAddress = String(linkedDevice?.displayAddress || linkedDevice?.address || 'Unknown');
        reportProgress(`Processing device ${index + 1}/${totalDevices}: ${fallbackDisplayAddress}`, {
          stage: 'devices',
          progress: progressStart
        });

        let normalizedAddress = null;
        try {
          normalizedAddress = this._normalizeInsteonAddress(linkedDevice.address);
        } catch (normalizeError) {
          const errorMessage = `Invalid linked-device address "${linkedDevice?.address}": ${normalizeError.message}`;
          queriedDevices.push({
            address: null,
            displayAddress: linkedDevice?.displayAddress || linkedDevice?.address || 'Unknown',
            name: linkedDevice?.name || 'Unknown Insteon Device',
            databaseDeviceId: null,
            group: Number.isInteger(linkedDevice?.group) ? linkedDevice.group : null,
            controller: linkedDevice?.controller === true,
            reachable: false,
            isOnline: false,
            status: null,
            level: null,
            brightness: null,
            respondedVia: 'none',
            error: errorMessage,
            deviceInfo: null
          });

          reportProgress(`Failed ${fallbackDisplayAddress}: ${errorMessage}`, {
            stage: 'devices',
            level: 'warn',
            progress: 5 + Math.floor(((index + 1) / totalDevices) * 90)
          });

          if (index < sortedLinkedDevices.length - 1 && pauseBetweenMs > 0) {
            throwIfCancelled();
            await this._sleep(pauseBetweenMs);
          }
          continue;
        }

        const displayAddress = this._formatInsteonAddress(normalizedAddress);
        const dbDevice = dbDevicesByAddress.get(normalizedAddress);
        const detail = {
          address: normalizedAddress,
          displayAddress,
          name: dbDevice?.name || linkedDevice?.name || `Insteon Device ${displayAddress}`,
          databaseDeviceId: dbDevice?._id?.toString() || null,
          group: Number.isInteger(linkedDevice?.group) ? linkedDevice.group : null,
          controller: linkedDevice?.controller === true,
          reachable: false,
          isOnline: false,
          status: null,
          level: null,
          brightness: null,
          respondedVia: 'none',
          error: null,
          deviceInfo: null
        };

        try {
          throwIfCancelled();
          const level = await this._queryDeviceLevelByAddress(normalizedAddress, levelTimeoutMs);
          detail.reachable = true;
          detail.isOnline = true;
          detail.status = level > 0;
          detail.level = level;
          detail.brightness = level;
          detail.respondedVia = 'level';
        } catch (levelError) {
          const levelMessage = levelError?.message || 'Unknown level-query error';
          try {
            throwIfCancelled();
            await this._queryDevicePingByAddress(normalizedAddress, pingTimeoutMs);
            detail.reachable = true;
            detail.isOnline = true;
            detail.respondedVia = 'ping';
            detail.error = `Status read unavailable via level query: ${levelMessage}`;
          } catch (pingError) {
            const pingMessage = pingError?.message || 'Unknown ping-query error';
            try {
              throwIfCancelled();
              const info = await this._queryDeviceInfoByAddress(normalizedAddress, infoTimeoutMs);
              detail.reachable = true;
              detail.isOnline = true;
              detail.respondedVia = 'info';
              detail.error = `Status read unavailable via level query: ${levelMessage}; ping failed: ${pingMessage}`;
              detail.deviceInfo = {
                firmwareVersion: info?.firmwareVersion ?? null,
                deviceCategory: info?.deviceCategory ?? null,
                subcategory: info?.subcategory ?? null
              };
            } catch (infoError) {
              const infoMessage = infoError?.message || 'Unknown info-query error';
              detail.reachable = false;
              detail.isOnline = false;
              detail.respondedVia = 'none';
              detail.error = `Level query failed: ${levelMessage}; ping failed: ${pingMessage}; info query failed: ${infoMessage}`;
            }
          }
        }

        queriedDevices.push(detail);
        const progressEnd = 5 + Math.floor(((index + 1) / totalDevices) * 90);
        const statusMessage = detail.reachable
          ? (detail.status === null
            ? `Completed ${displayAddress}: reachable (${detail.respondedVia}), status unavailable`
            : `Completed ${displayAddress}: ${detail.status ? 'On' : 'Off'} via ${detail.respondedVia}`)
          : `Failed ${displayAddress}: ${detail.error || 'unreachable'}`;
        reportProgress(statusMessage, {
          stage: 'devices',
          level: detail.reachable ? 'info' : 'warn',
          progress: progressEnd
        });

        if (index < sortedLinkedDevices.length - 1 && pauseBetweenMs > 0) {
          throwIfCancelled();
          await this._sleep(pauseBetweenMs);
        }
      }

      const reachable = queriedDevices.filter((device) => device.reachable).length;
      const unreachable = queriedDevices.length - reachable;
      const statusKnown = queriedDevices.filter((device) => device.status !== null).length;
      const statusUnknown = queriedDevices.length - statusKnown;

      const result = {
        success: true,
        message: `Queried ${queriedDevices.length} linked device${queriedDevices.length === 1 ? '' : 's'}: ${reachable} reachable, ${unreachable} unreachable.`,
        scannedAt: new Date().toISOString(),
        plmInfo,
        summary: {
          linkedDevices: queriedDevices.length,
          reachable,
          unreachable,
          statusKnown,
          statusUnknown
        },
        warnings,
        devices: queriedDevices
      };

      reportProgress(result.message, {
        stage: 'complete',
        level: unreachable > 0 ? 'warn' : 'info',
        progress: 100
      });
      return result;
    } catch (error) {
      if (error?.code === 'QUERY_CANCELLED' || error?.isCancelled === true) {
        throw error;
      }
      console.error('InsteonService: Linked-device query failed:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to query linked PLM devices: ${error.message}`);
    }
  }

  /**
   * Get device status
   * @param {String} deviceId - Database device ID
   * @returns {Promise<Object>} Device status
   */
  async getDeviceStatus(deviceId) {
    console.log(`InsteonService: Getting status for device ${deviceId}`);

    let device = null;
    try {
      device = await Device.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      if (!device.properties.insteonAddress) {
        throw new Error('Not an Insteon device');
      }

      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const address = this._normalizeInsteonAddress(device.properties.insteonAddress);
      const level = await this._queryDeviceLevelByAddress(address, 5000);
      const state = this._stateFromInsteonLevel(level);
      await this._persistDeviceRuntimeState(device, state);

      console.log(`InsteonService: Device ${address} status - Level: ${state.level}, Brightness: ${state.brightness}%`);

      return {
        status: state.status,
        level: state.level,
        brightness: state.brightness,
        isOnline: true
      };
    } catch (error) {
      if (device) {
        try {
          await this._persistDeviceRuntimeState(device, {
            isOnline: false
          });
        } catch (persistError) {
          console.warn(`InsteonService: Failed to mark ${device._id} offline after status error: ${persistError.message}`);
        }
      }
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
  async turnOn(deviceId, brightness = 100, options = {}) {
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

      const address = this._normalizeInsteonAddress(device.properties.insteonAddress);
      const numericBrightness = Number(brightness);
      const boundedBrightness = Number.isFinite(numericBrightness)
        ? Math.max(0, Math.min(100, Math.round(numericBrightness)))
        : 100;
      try {
        await this._executeHubCommandWithTimeout(
          (callback) => this.hub.turnOn(address, boundedBrightness, callback),
          'Timeout turning on device',
          5000
        );
      } catch (error) {
        const recoveredState = await this._recoverCommandStateAfterTimeout(address, true);
        if (recoveredState) {
          const details = this._buildInsteonControlDetails(device, address, 'turn_on', recoveredState, {
            requestedBrightness: boundedBrightness,
            commandAcknowledged: false,
            commandWarning: error.message,
            verificationRecovered: true
          });
          return {
            success: true,
            message: `Device turned on via Insteon PLM ${details.insteonAddress} (command acknowledgement timed out, but status confirmed ON)`,
            status: recoveredState.status,
            brightness: recoveredState.brightness,
            level: recoveredState.level,
            confirmed: true,
            warning: error.message,
            details
          };
        }
        throw error;
      }

      console.log(`InsteonService: Device ${address} turned on at ${boundedBrightness}%`);
      const optimisticState = this._buildOptimisticCommandState(true, boundedBrightness);
      await this._persistDeviceRuntimeState(device, optimisticState);
      const confirmOptions = this._getExpectedStateConfirmationOptions(true, options);

      let confirmedState = null;
      try {
        confirmedState = await this._confirmExpectedDeviceStateByAddress(address, true, confirmOptions);
      } catch (error) {
        if (!this._isRecoverableStateConfirmationError(error, true)) {
          throw error;
        }

        const details = this._buildInsteonControlDetails(device, address, 'turn_on', optimisticState, {
          requestedBrightness: boundedBrightness,
          commandAcknowledged: true,
          verificationMode: String(options?.verificationMode || 'stable').trim().toLowerCase(),
          confirmationWarning: error.message,
          confirmationCode: error.code || null,
          confirmed: false
        });

        return {
          success: true,
          message: `Device turned on via Insteon PLM ${details.insteonAddress} (command acknowledged; status verification pending)`,
          status: optimisticState.status,
          brightness: optimisticState.brightness,
          level: optimisticState.level,
          confirmed: false,
          warning: error.message,
          details
        };
      }

      const details = this._buildInsteonControlDetails(device, address, 'turn_on', confirmedState, {
        requestedBrightness: boundedBrightness,
        commandAcknowledged: true,
        verificationMode: String(options?.verificationMode || 'stable').trim().toLowerCase()
      });

      return {
        success: true,
        message: `Device turned on via Insteon PLM ${details.insteonAddress} (confirmed ON with ${confirmedState.confirmedReads || 1} read${(confirmedState.confirmedReads || 1) === 1 ? '' : 's'})`,
        status: confirmedState.status,
        brightness: confirmedState.brightness,
        level: confirmedState.level,
        confirmed: true,
        details
      };
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
  async turnOff(deviceId, options = {}) {
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

      const address = this._normalizeInsteonAddress(device.properties.insteonAddress);

      try {
        await this._executeHubCommandWithTimeout(
          (callback) => this.hub.turnOff(address, callback),
          'Timeout turning off device',
          5000
        );
      } catch (error) {
        const recoveredState = await this._recoverCommandStateAfterTimeout(address, false);
        if (recoveredState) {
          const details = this._buildInsteonControlDetails(device, address, 'turn_off', recoveredState, {
            commandAcknowledged: false,
            commandWarning: error.message,
            verificationRecovered: true
          });
          return {
            success: true,
            message: `Device turned off via Insteon PLM ${details.insteonAddress} (command acknowledgement timed out, but status confirmed OFF)`,
            status: recoveredState.status,
            brightness: recoveredState.brightness,
            level: recoveredState.level,
            confirmed: true,
            warning: error.message,
            details
          };
        }
        throw error;
      }

      console.log(`InsteonService: Device ${address} turned off`);
      const optimisticState = this._buildOptimisticCommandState(false);
      await this._persistDeviceRuntimeState(device, optimisticState);
      const confirmOptions = this._getExpectedStateConfirmationOptions(false, options);

      let confirmedState = null;
      try {
        confirmedState = await this._confirmExpectedDeviceStateByAddress(address, false, confirmOptions);
      } catch (error) {
        if (!this._isRecoverableStateConfirmationError(error, false)) {
          throw error;
        }

        const details = this._buildInsteonControlDetails(device, address, 'turn_off', optimisticState, {
          commandAcknowledged: true,
          verificationMode: String(options?.verificationMode || 'stable').trim().toLowerCase(),
          confirmationWarning: error.message,
          confirmationCode: error.code || null,
          confirmed: false
        });

        return {
          success: true,
          message: `Device turned off via Insteon PLM ${details.insteonAddress} (command acknowledged; status verification pending)`,
          status: optimisticState.status,
          brightness: optimisticState.brightness,
          level: optimisticState.level,
          confirmed: false,
          warning: error.message,
          details
        };
      }

      const details = this._buildInsteonControlDetails(device, address, 'turn_off', confirmedState, {
        commandAcknowledged: true,
        verificationMode: String(options?.verificationMode || 'stable').trim().toLowerCase()
      });

      return {
        success: true,
        message: `Device turned off via Insteon PLM ${details.insteonAddress} (confirmed OFF with ${confirmedState.confirmedReads || 1} read${(confirmedState.confirmedReads || 1) === 1 ? '' : 's'})`,
        status: confirmedState.status,
        brightness: confirmedState.brightness,
        level: confirmedState.level,
        confirmed: true,
        details
      };
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
  async setBrightness(deviceId, brightness, options = {}) {
    console.log(`InsteonService: Setting device ${deviceId} brightness to ${brightness}%`);

    if (brightness === 0) {
      return this.turnOff(deviceId, options);
    } else {
      return this.turnOn(deviceId, brightness, options);
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
      lastConnectionError: this.lastConnectionError,
      localSerialBridge: this._localSerialBridge
        ? {
            active: this._isLocalSerialBridgeActive(),
            host: this._localSerialBridge.host,
            port: this._localSerialBridge.port,
            serialPath: this._localSerialBridge.serialPath,
            startedAt: this._localSerialBridge.startedAt
          }
        : null
    };
  }
}

module.exports = new InsteonService();
