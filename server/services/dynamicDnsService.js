const net = require('net');
const axios = require('axios');

const Settings = require('../models/Settings');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const { createAzureDnsError } = require('./azureDnsError');

const AZURE_API_VERSION = '2018-05-01';
const DEFAULT_PUBLIC_IP_URLS = [
  'https://api.ipify.org?format=json',
  'https://checkip.amazonaws.com/',
  'https://icanhazip.com/'
];

function trimString(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeHostname(value) {
  return trimString(value).toLowerCase().replace(/\.$/, '');
}

function normalizeIntervalMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return 60 * 1000;
  }
  return Math.max(60, Math.min(3600, Math.trunc(seconds))) * 1000;
}

function extractIpAddress(responseBody) {
  if (typeof responseBody === 'string') {
    const candidate = responseBody.trim().match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    return candidate || '';
  }

  if (responseBody && typeof responseBody === 'object') {
    for (const key of ['ip', 'address', 'query', 'origin']) {
      const candidate = extractIpAddress(responseBody[key]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return '';
}

function getDefaultPrimaryHostname() {
  const explicitHost = normalizeHostname(process.env.HOMEBRAIN_PUBLIC_HOST);
  if (explicitHost) {
    return explicitHost.replace(/^www\./, '');
  }

  const baseUrl = trimString(process.env.HOMEBRAIN_PUBLIC_BASE_URL);
  if (!baseUrl) {
    return '';
  }

  try {
    const parsed = new URL(baseUrl);
    return normalizeHostname(parsed.hostname).replace(/^www\./, '');
  } catch (_error) {
    return '';
  }
}

function getAzureRecordName(hostname, zoneName) {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedZone = normalizeHostname(zoneName);

  if (!normalizedHostname) {
    throw new Error('Dynamic DNS hostname is required');
  }

  if (!normalizedZone) {
    throw new Error('Azure DNS zone name is required');
  }

  if (normalizedHostname === normalizedZone) {
    return '@';
  }

  const suffix = `.${normalizedZone}`;
  if (!normalizedHostname.endsWith(suffix)) {
    throw new Error(`${hostname} is not inside Azure DNS zone ${zoneName}`);
  }

  return normalizedHostname.slice(0, -suffix.length);
}

function encodeAzurePathSegment(value) {
  return encodeURIComponent(String(value));
}

function getMissingAzureSettings(settings = {}) {
  const missing = [];
  if (!trimString(settings.dynamicDnsAzureTenantId)) missing.push('tenant ID');
  if (!trimString(settings.dynamicDnsAzureClientId)) missing.push('client ID');
  if (!trimString(settings.dynamicDnsAzureClientSecret)) missing.push('client secret');
  if (!trimString(settings.dynamicDnsAzureSubscriptionId)) missing.push('subscription ID');
  if (!trimString(settings.dynamicDnsAzureResourceGroup)) missing.push('resource group');
  if (!normalizeHostname(settings.dynamicDnsAzureZoneName)) missing.push('zone name');
  return missing;
}

class DynamicDnsService {
  constructor() {
    this.timer = null;
    this.inFlight = null;
    this.nextCheckAt = null;
  }

  async initialize() {
    const settings = await Settings.getSettings();
    this.configureFromSettings(settings);
  }

  configureFromSettings(settings) {
    this.stop();

    if (!settings?.dynamicDnsEnabled) {
      return;
    }

    const missing = getMissingAzureSettings(settings);
    if (missing.length > 0) {
      console.error(`Dynamic DNS is enabled but Azure settings are incomplete: missing ${missing.join(', ')}`);
      return;
    }

    const intervalMs = normalizeIntervalMs(settings.dynamicDnsCheckIntervalSeconds);
    this.nextCheckAt = new Date(Date.now() + intervalMs);
    this.timer = setInterval(() => {
      this.nextCheckAt = new Date(Date.now() + intervalMs);
      this.runBackgroundCheck({ reason: 'scheduled' });
    }, intervalMs);

    if (typeof this.timer?.unref === 'function') {
      this.timer.unref();
    }

    this.runBackgroundCheck({ reason: 'startup' });
  }

  runBackgroundCheck(options = {}) {
    const reason = trimString(options.reason, 'background');
    void this.checkAndUpdate(options).catch((error) => {
      console.error(`Dynamic DNS ${reason} check failed: ${error.message || error}`);
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextCheckAt = null;
  }

  async pushNow(actor = 'system') {
    return this.checkAndUpdate({ force: true, reason: 'manual', actor });
  }

  async checkAndUpdate(options = {}) {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.performCheckAndUpdate(options)
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async performCheckAndUpdate({ force = false, reason = 'scheduled', actor = 'system' } = {}) {
    const settings = await Settings.getSettings();
    if (!force && !settings.dynamicDnsEnabled) {
      return {
        success: true,
        skipped: true,
        reason: 'disabled',
        records: []
      };
    }

    try {
      const publicIp = await this.fetchPublicIp(settings);
      const previousIp = trimString(settings.dynamicDnsLastPublicIp);
      const shouldUpdate = force || previousIp !== publicIp;
      const records = await this.getDesiredRecords(settings);
      if (records.length === 0) {
        throw new Error('No Dynamic DNS records are configured');
      }

      if (!shouldUpdate) {
        await Settings.updateSettings({
          dynamicDnsLastCheckedAt: new Date(),
          dynamicDnsLastStatus: 'unchanged',
          dynamicDnsLastError: '',
          dynamicDnsLastPublicIp: publicIp
        });

        return {
          success: true,
          updated: false,
          publicIp,
          previousIp,
          records,
          reason
        };
      }

      const updates = [];
      const errors = [];
      for (const record of records) {
        try {
          updates.push(await this.updateRecord(settings, record, publicIp));
        } catch (error) {
          errors.push({
            hostname: record.hostname,
            error: error.message || 'Dynamic DNS update failed',
            status: error.status,
            code: error.code
          });
        }
      }

      if (errors.length > 0) {
        const aggregateError = new Error(errors.map((entry) => `${entry.hostname}: ${entry.error}`).join('; '));
        const firstTypedError = errors.find((entry) => Number.isFinite(Number(entry.status)) || entry.code);
        if (firstTypedError) {
          aggregateError.status = firstTypedError.status;
          aggregateError.code = firstTypedError.code;
        }
        throw aggregateError;
      }

      await Settings.updateSettings({
        dynamicDnsLastCheckedAt: new Date(),
        dynamicDnsLastUpdatedAt: new Date(),
        dynamicDnsLastStatus: 'updated',
        dynamicDnsLastError: '',
        dynamicDnsLastPublicIp: publicIp
      });

      return {
        success: true,
        updated: true,
        publicIp,
        previousIp,
        records,
        updates,
        reason,
        actor
      };
    } catch (error) {
      await Settings.updateSettings({
        dynamicDnsLastCheckedAt: new Date(),
        dynamicDnsLastStatus: 'failed',
        dynamicDnsLastError: error.message || 'Dynamic DNS update failed'
      });
      throw error;
    }
  }

  async fetchPublicIp(settings) {
    const configuredUrl = trimString(settings.dynamicDnsPublicIpUrl);
    const urls = configuredUrl
      ? [configuredUrl, ...DEFAULT_PUBLIC_IP_URLS.filter((url) => url !== configuredUrl)]
      : DEFAULT_PUBLIC_IP_URLS;

    const errors = [];
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          timeout: 10000
        });
        const publicIp = extractIpAddress(response.data);
        if (net.isIP(publicIp) === 4) {
          return publicIp;
        }
        errors.push(`${url}: no IPv4 address found`);
      } catch (error) {
        errors.push(`${url}: ${error.message || 'lookup failed'}`);
      }
    }

    throw new Error(`Unable to discover public IPv4 address (${errors.join('; ')})`);
  }

  async getDesiredRecords(settings) {
    const records = [];
    const primaryHostname = normalizeHostname(settings.dynamicDnsPrimaryHostname || getDefaultPrimaryHostname());
    if (primaryHostname) {
      records.push({ hostname: primaryHostname, source: 'primary' });
    }

    const routes = await ReverseProxyRoute.find({
      enabled: true,
      dynamicDnsEnabled: true
    }).sort({ hostname: 1 }).lean();

    for (const route of routes) {
      const hostname = normalizeHostname(route.hostname);
      if (hostname) {
        records.push({ hostname, routeId: String(route._id), source: 'reverse-proxy' });
      }
    }

    const seen = new Set();
    return records.filter((record) => {
      if (seen.has(record.hostname)) {
        return false;
      }
      seen.add(record.hostname);
      return true;
    });
  }

  async updateRecord(settings, record, publicIp) {
    const provider = trimString(settings.dynamicDnsProvider, 'azure').toLowerCase();
    if (provider !== 'azure') {
      throw new Error(`Unsupported Dynamic DNS provider: ${provider}`);
    }

    return this.updateAzureRecord(settings, record, publicIp);
  }

  async updateAzureRecord(settings, record, publicIp) {
    const tenantId = trimString(settings.dynamicDnsAzureTenantId);
    const clientId = trimString(settings.dynamicDnsAzureClientId);
    const clientSecret = trimString(settings.dynamicDnsAzureClientSecret);
    const subscriptionId = trimString(settings.dynamicDnsAzureSubscriptionId);
    const resourceGroup = trimString(settings.dynamicDnsAzureResourceGroup);
    const zoneName = normalizeHostname(settings.dynamicDnsAzureZoneName);
    const ttl = Math.max(30, Math.min(86400, Number(settings.dynamicDnsAzureTtlSeconds || 60)));

    const missing = getMissingAzureSettings(settings);
    if (missing.length > 0) {
      throw new Error(`Azure Dynamic DNS settings missing ${missing.join(', ')}`);
    }

    const token = await this.getAzureAccessToken({
      tenantId,
      clientId,
      clientSecret,
      settings
    });
    const recordName = getAzureRecordName(record.hostname, zoneName);
    const url = [
      'https://management.azure.com/subscriptions',
      encodeAzurePathSegment(subscriptionId),
      'resourceGroups',
      encodeAzurePathSegment(resourceGroup),
      'providers/Microsoft.Network/dnsZones',
      encodeAzurePathSegment(zoneName),
      'A',
      encodeAzurePathSegment(recordName)
    ].join('/') + `?api-version=${AZURE_API_VERSION}`;

    try {
      await axios.put(url, {
        properties: {
          TTL: ttl,
          ARecords: [{ ipv4Address: publicIp }]
        }
      }, {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      throw createAzureDnsError(error, {
        settings,
        operation: 'write the Azure DNS A record',
        hostname: record.hostname
      });
    }

    return {
      provider: 'azure',
      hostname: record.hostname,
      recordName,
      zoneName,
      publicIp,
      source: record.source,
      routeId: record.routeId || null
    };
  }

  async getAzureAccessToken({ tenantId, clientId, clientSecret, settings = {} }) {
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
    params.set('scope', 'https://management.azure.com/.default');
    params.set('grant_type', 'client_credentials');

    let response;
    try {
      response = await axios.post(
        `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
        params.toString(),
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
    } catch (error) {
      throw createAzureDnsError(error, {
        authentication: true,
        operation: 'authenticate to Azure',
        settings: {
          ...settings,
          dynamicDnsAzureTenantId: tenantId,
          dynamicDnsAzureClientId: clientId
        }
      });
    }

    const token = response.data?.access_token;
    if (!token) {
      const tokenError = new Error('Azure token response did not include an access token');
      tokenError.status = 502;
      throw tokenError;
    }
    return token;
  }
}

module.exports = new DynamicDnsService();