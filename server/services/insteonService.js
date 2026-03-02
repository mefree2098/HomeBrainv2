const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const axios = require('axios');
const Insteon = require('home-controller').Insteon;
const Device = require('../models/Device');
const Settings = require('../models/Settings');
const Workflow = require('../models/Workflow');
const workflowService = require('./workflowService');

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
          const rawAddress = entry.address || entry.id || entry.deviceId || entry.insteonAddress;
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

    const seen = new Set();
    const parsedDevices = [];
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

      if (seen.has(normalizedAddress)) {
        duplicateCount += 1;
        return;
      }
      seen.add(normalizedAddress);

      const name = typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : null;

      parsedDevices.push({
        address: normalizedAddress,
        displayAddress: this._formatInsteonAddress(normalizedAddress),
        name
      });
    });

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
        checkExistingLinks: request.checkExistingLinks !== false
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

    return {
      scenes,
      invalidEntries,
      options: {
        dryRun: request.dryRun !== false,
        upsertDevices: request.upsertDevices !== false,
        continueOnError: request.continueOnError !== false,
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
    const password = String(connectionInput.isyPassword ?? connectionInput.password ?? settingsConnection.password ?? '').trim();
    if (!username || !password) {
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
    try {
      return this._normalizeInsteonAddress(String(rawValue));
    } catch (error) {
      return null;
    }
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
      const normalizedAddress = this._normalizePossibleInsteonAddress(rawAddress);

      devices.push({
        address: rawAddress,
        normalizedAddress,
        name: this._extractXmlTagValue(body, 'name', ''),
        family: this._extractXmlTagValue(body, 'family', ''),
        type: this._extractXmlTagValue(body, 'type', ''),
        parent: this._extractXmlTagValue(body, 'parent', ''),
        pnode: this._extractXmlTagValue(body, 'pnode', ''),
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

      programs.push({
        id,
        name,
        enabled,
        runAtStartup,
        status,
        parentId,
        lastRunTime,
        lastFinishTime
      });
    }

    return programs;
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
      const detail = status ? `HTTP ${status}` : error.message;
      throw new Error(`ISY request failed for ${sanitizedPath}: ${detail}`);
    }
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

    const [nodesXml, programsXml] = await Promise.all([
      fetchWithFallback('/rest/nodes?members=false', '/rest/nodes'),
      fetchWithFallback('/rest/programs?subfolders=true', '/rest/programs')
    ]);

    const nodeData = this._parseISYNodesXml(nodesXml);
    const programs = this._parseISYProgramsXml(programsXml);
    const deviceIds = nodeData.devices
      .map((device) => device.normalizedAddress)
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
      devices: nodeData.devices,
      groups: nodeData.groups,
      programs,
      deviceIds: uniqueDeviceIds,
      topologyScenes,
      counts: {
        nodes: nodeData.devices.length,
        groups: nodeData.groups.length,
        programs: programs.length,
        uniqueDeviceIds: uniqueDeviceIds.length,
        topologyScenes: topologyScenes.length
      }
    };
  }

  _isyProgramMarker(programId) {
    return `[ISY_PROGRAM_ID:${programId}]`;
  }

  async importISYProgramsAsWorkflows(programs = [], options = {}) {
    const isDryRun = options.dryRun !== false;
    const enableWorkflows = options.enableWorkflows === true;
    const results = {
      success: true,
      dryRun: isDryRun,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      workflows: [],
      errors: []
    };

    for (const program of programs) {
      if (!program || !program.id) {
        continue;
      }

      results.processed += 1;
      const marker = this._isyProgramMarker(program.id);
      const baseName = `ISY Program ${program.id}: ${program.name || 'Unnamed'}`;
      const descriptionLines = [
        marker,
        'Imported from ISY program metadata.',
        'Original ISY IF/THEN/ELSE logic is not auto-translated; this is a workflow placeholder.',
        `Enabled on ISY: ${program.enabled ? 'yes' : 'no'}`,
        `Run at startup: ${program.runAtStartup ? 'yes' : 'no'}`,
        `Status: ${program.status ? 'true' : 'false'}`,
        program.lastRunTime ? `Last run: ${program.lastRunTime}` : '',
        program.lastFinishTime ? `Last finish: ${program.lastFinishTime}` : ''
      ].filter(Boolean);
      const workflowPayload = {
        name: baseName,
        description: descriptionLines.join('\n'),
        source: 'import',
        enabled: enableWorkflows,
        category: 'custom',
        priority: 5,
        cooldown: 0,
        trigger: {
          type: 'manual',
          conditions: {
            source: 'isy_program',
            isyProgramId: program.id
          }
        },
        actions: [
          {
            type: 'notification',
            target: null,
            parameters: {
              message: `ISY program "${program.name || program.id}" placeholder executed`,
              isyProgramId: program.id
            }
          }
        ]
      };

      try {
        const existing = await Workflow.findOne({
          description: { $regex: new RegExp(`\\[ISY_PROGRAM_ID:${program.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`) }
        }).lean();

        if (isDryRun) {
          results.workflows.push({
            programId: program.id,
            name: baseName,
            status: existing ? 'would-update' : 'would-create'
          });
          if (existing) {
            results.updated += 1;
          } else {
            results.created += 1;
          }
          continue;
        }

        if (existing) {
          const updated = await workflowService.updateWorkflow(existing._id.toString(), workflowPayload);
          results.updated += 1;
          results.workflows.push({
            programId: program.id,
            workflowId: updated._id,
            name: updated.name,
            status: 'updated'
          });
        } else {
          const created = await workflowService.createWorkflow(workflowPayload, { source: 'import' });
          results.created += 1;
          results.workflows.push({
            programId: program.id,
            workflowId: created._id,
            name: created.name,
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

  async testISYConnection(payload = {}) {
    try {
      const connection = await this._resolveISYConnection(payload);
      await this._requestISYResource(connection, '/rest/ping');

      return {
        success: true,
        message: 'ISY connection successful',
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

  async syncFromISY(payload = {}) {
    console.log('InsteonService: Starting automated ISY extraction/sync workflow');

    const request = payload && typeof payload === 'object' ? payload : {};
    const options = {
      dryRun: request.dryRun !== false,
      importDevices: request.importDevices !== false,
      importTopology: request.importTopology !== false,
      importPrograms: request.importPrograms !== false,
      enableProgramWorkflows: request.enableProgramWorkflows === true,
      continueOnError: request.continueOnError !== false
    };

    const extraction = await this.extractISYData(request);
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
        nodes: extraction.devices.length,
        groups: extraction.groups.length,
        programs: extraction.programs.length,
        uniqueDeviceIds: extraction.deviceIds.length,
        topologyScenes: extraction.topologyScenes.length
      },
      devices: null,
      topology: null,
      programs: null,
      errors: []
    };

    if (options.dryRun) {
      if (options.importTopology) {
        results.topology = await this.applyISYSceneTopology({
          scenes: extraction.topologyScenes,
          dryRun: true
        });
      }
      if (options.importPrograms) {
        results.programs = await this.importISYProgramsAsWorkflows(extraction.programs, {
          dryRun: true,
          enableWorkflows: options.enableProgramWorkflows
        });
      }

      results.message = [
        `Dry run complete`,
        options.importDevices ? `${extraction.deviceIds.length} devices available for import` : 'device import skipped',
        options.importTopology ? `${extraction.topologyScenes.length} topology scenes parsed` : 'topology import skipped',
        options.importPrograms ? `${extraction.programs.length} programs parsed` : 'program import skipped'
      ].join(', ');

      return results;
    }

    if (options.importDevices && extraction.deviceIds.length > 0) {
      try {
        results.devices = await this.importDevicesFromISY({
          deviceIds: extraction.deviceIds,
          group: request.group ?? DEFAULT_ISY_IMPORT_GROUP,
          linkMode: request.linkMode || 'remote',
          perDeviceTimeoutMs: request.perDeviceTimeoutMs,
          retries: request.retries,
          pauseBetweenMs: request.pauseBetweenMs,
          checkExistingLinks: request.checkExistingLinks !== false,
          skipLinking: request.skipLinking === true
        });
      } catch (error) {
        results.success = false;
        results.errors.push({
          stage: 'devices',
          error: error.message
        });
        if (!options.continueOnError) {
          throw error;
        }
      }
    }

    if (options.importTopology && extraction.topologyScenes.length > 0) {
      try {
        results.topology = await this.applyISYSceneTopology({
          scenes: extraction.topologyScenes,
          dryRun: false,
          upsertDevices: false,
          continueOnError: request.continueOnError !== false,
          sceneTimeoutMs: request.sceneTimeoutMs,
          pauseBetweenScenesMs: request.pauseBetweenScenesMs
        });

        if (!results.topology.success) {
          results.success = false;
        }
      } catch (error) {
        results.success = false;
        results.errors.push({
          stage: 'topology',
          error: error.message
        });
        if (!options.continueOnError) {
          throw error;
        }
      }
    }

    if (options.importPrograms && extraction.programs.length > 0) {
      try {
        results.programs = await this.importISYProgramsAsWorkflows(extraction.programs, {
          dryRun: false,
          enableWorkflows: options.enableProgramWorkflows
        });
        if (!results.programs.success) {
          results.success = false;
        }
      } catch (error) {
        results.success = false;
        results.errors.push({
          stage: 'programs',
          error: error.message
        });
        if (!options.continueOnError) {
          throw error;
        }
      }
    }

    results.message = [
      `ISY sync complete`,
      results.devices ? `${results.devices.imported || 0} devices imported` : 'devices skipped',
      results.topology ? `${results.topology.appliedScenes || 0} scenes applied` : 'topology skipped',
      results.programs ? `${results.programs.created || 0} workflows created` : 'programs skipped'
    ].join(', ');

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

  async _applyTopologyScene(scene, { timeoutMs }) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    await this._cancelLinkingSafe();

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timeout applying scene "${scene.name}"`));
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
        this.hub.scene(
          scene.controller,
          scene.responders.map(({ id, level, ramp, data }) => ({ id, level, ramp, data })),
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

  async _linkDeviceRemote(address, { group, timeoutMs }) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    await this._cancelLinkingSafe();

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timeout linking device ${this._formatInsteonAddress(normalizedAddress)}`));
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
        this.hub.link(normalizedAddress, { group }, (error, link) => {
          if (error) {
            rejectOnce(new Error(`Failed to link ${this._formatInsteonAddress(normalizedAddress)}: ${error.message}`));
            return;
          }
          resolveOnce(link || null);
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
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

  async _deviceHasLinkToPLM(address, group, plmId) {
    if (!this.isConnected || !this.hub) {
      await this.connect();
    }

    const normalizedAddress = this._normalizeInsteonAddress(address);
    const normalizedPlmId = this._normalizeInsteonAddress(plmId);

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

        return Number(link.group) === group && normalizedLinkedId === normalizedPlmId;
      });
    } catch (error) {
      console.warn(
        `InsteonService: Could not inspect existing links for ${this._formatInsteonAddress(normalizedAddress)}: ${error.message}`
      );
      return false;
    }
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

  async _upsertInsteonDevice({ address, group, insteonType, name, deviceInfo, markLinkedToCurrentPlm = false }) {
    const normalizedAddress = this._normalizeInsteonAddress(address);
    const existingDevice = await this._findExistingInsteonDeviceByAddress(normalizedAddress);
    const info = deviceInfo || await this.getDeviceInfo(normalizedAddress);
    const preferredName = typeof name === 'string' && name.trim()
      ? name.trim()
      : `Insteon Device ${this._formatInsteonAddress(normalizedAddress)}`;
    const now = new Date();

    const mergedProperties = {
      ...(existingDevice ? (existingDevice.properties || {}) : {}),
      source: 'insteon',
      insteonAddress: normalizedAddress,
      deviceCategory: info.deviceCategory || 0,
      subcategory: info.subcategory || 0
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

    if (existingDevice) {
      existingDevice.properties = mergedProperties;
      existingDevice.brand = existingDevice.brand || 'Insteon';
      if (typeof info.productKey === 'string' && info.productKey.trim()) {
        existingDevice.model = info.productKey.trim();
      }
      existingDevice.type = existingDevice.type || this._mapInsteonTypeToDeviceType(info);
      existingDevice.room = existingDevice.room || 'Unassigned';
      existingDevice.isOnline = true;
      existingDevice.lastSeen = now;

      if (preferredName && (!existingDevice.name || /^Insteon Device\b/i.test(existingDevice.name))) {
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
      type: this._mapInsteonTypeToDeviceType(info),
      room: 'Unassigned',
      status: false,
      brand: 'Insteon',
      model: info.productKey || 'Unknown',
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
  async importDevicesFromISY(payload = {}) {
    console.log('InsteonService: Starting ISY device import/link workflow');

    try {
      if (!this.isConnected || !this.hub) {
        await this.connect();
      }

      const parsed = this._parseISYImportPayload(payload);
      const targetDevices = parsed.devices;
      const { invalidEntries, duplicateCount, options } = parsed;

      if (targetDevices.length === 0) {
        throw new Error('No valid INSTEON device IDs were found in the request payload');
      }

      const plmInfo = await this.getPLMInfo();
      const normalizedPlmId = this._normalizeInsteonAddress(plmInfo.deviceId);

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
        linked: 0,
        alreadyLinked: 0,
        imported: 0,
        updated: 0,
        failed: 0,
        devices: [],
        invalidEntries,
        errors: []
      };

      for (let index = 0; index < targetDevices.length; index += 1) {
        const entry = targetDevices[index];
        const detail = {
          address: entry.address,
          displayAddress: entry.displayAddress,
          name: entry.name
        };

        try {
          const shouldCheckExistingLinks = !options.skipLinking && options.checkExistingLinks;
          let isAlreadyLinked = false;

          if (shouldCheckExistingLinks) {
            isAlreadyLinked = await this._deviceHasLinkToPLM(entry.address, options.group, normalizedPlmId);
          }

          if (options.skipLinking) {
            detail.linkStatus = 'skipped';
          } else if (isAlreadyLinked) {
            detail.linkStatus = 'already-linked';
            results.alreadyLinked += 1;
          } else {
            const linkRequest = {
              group: options.group,
              timeoutMs: options.timeoutMs
            };
            let linkError = null;

            for (let attempt = 0; attempt <= options.retries; attempt += 1) {
              try {
                if (options.linkMode === 'manual') {
                  await this._linkDeviceManual(entry.address, linkRequest);
                } else {
                  await this._linkDeviceRemote(entry.address, linkRequest);
                }
                linkError = null;
                break;
              } catch (error) {
                linkError = error;
                if (attempt < options.retries) {
                  await this._sleep(500);
                }
              }
            }

            if (linkError) {
              throw linkError;
            }

            detail.linkStatus = options.linkMode === 'manual' ? 'linked-manual' : 'linked-remote';
            results.linked += 1;
          }

          const deviceInfo = await this.getDeviceInfo(entry.address);
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
        } catch (error) {
          detail.error = error.message;
          results.failed += 1;
          results.errors.push({
            address: entry.address,
            error: error.message
          });
          results.devices.push(detail);
        }

        if (index < targetDevices.length - 1 && options.pauseBetweenMs > 0) {
          await this._sleep(options.pauseBetweenMs);
        }
      }

      results.success = results.failed === 0;
      results.message = [
        `Processed ${results.accepted} ISY device IDs`,
        `${results.linked} linked`,
        `${results.alreadyLinked} already linked`,
        `${results.imported} imported`,
        `${results.updated} updated`,
        `${results.failed} failed`
      ].join(', ');

      console.log(`InsteonService: ISY import complete - ${results.message}`);
      return results;
    } catch (error) {
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
  async applyISYSceneTopology(payload = {}) {
    console.log('InsteonService: Starting ISY scene topology sync');

    try {
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
        failedScenes: 0,
        imported: 0,
        updated: 0,
        devices: topologyDevices.length,
        scenes: [],
        invalidEntries,
        errors: []
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
        return results;
      }

      for (let index = 0; index < scenes.length; index += 1) {
        const scene = scenes[index];
        const sceneResult = {
          name: scene.name,
          group: scene.group,
          controller: scene.controller,
          responders: scene.responders.length
        };

        try {
          await this._applyTopologyScene(scene, { timeoutMs: options.sceneTimeoutMs });
          sceneResult.status = 'applied';
          results.appliedScenes += 1;
        } catch (error) {
          sceneResult.status = 'failed';
          sceneResult.error = error.message;
          results.failedScenes += 1;
          results.errors.push({
            scene: scene.name,
            group: scene.group,
            error: error.message
          });

          if (!options.continueOnError) {
            results.scenes.push(sceneResult);
            break;
          }
        }

        results.scenes.push(sceneResult);

        if (index < scenes.length - 1 && options.pauseBetweenScenesMs > 0) {
          await this._sleep(options.pauseBetweenScenesMs);
        }
      }

      if (options.upsertDevices) {
        for (const device of topologyDevices) {
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
        `${results.failedScenes} failed`,
        `${results.imported} imported`,
        `${results.updated} updated`
      ].join(', ');

      console.log(`InsteonService: ISY topology sync complete - ${results.message}`);
      return results;
    } catch (error) {
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
