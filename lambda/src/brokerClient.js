const http = require('http');
const https = require('https');

const axios = require('axios');

const DEFAULT_BROKER_TIMEOUT_MS = 7000;
const MAX_BROKER_TIMEOUT_MS = 7500;
const MIN_CONFIGURED_TIMEOUT_MS = 1000;
const MIN_DEADLINE_TIMEOUT_MS = 250;
const RESPONSE_RESERVE_MS = 750;

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 4,
  maxFreeSockets: 2
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  maxFreeSockets: 2
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isLoopbackHostname(hostname) {
  const normalized = trimString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function getBrokerBaseUrl() {
  const configured = trimString(process.env.HOMEBRAIN_BROKER_BASE_URL);
  if (!configured) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL is required');
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL must be a valid absolute URL');
  }

  if (parsed.username || parsed.password) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL must not contain credentials');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL must contain only the broker origin');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL must use HTTPS');
  }

  return parsed.origin;
}

function getConfiguredBrokerTimeoutMs() {
  const configured = Number(process.env.HOMEBRAIN_BROKER_TIMEOUT_MS || DEFAULT_BROKER_TIMEOUT_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_BROKER_TIMEOUT_MS;
  }
  return Math.min(MAX_BROKER_TIMEOUT_MS, Math.max(MIN_CONFIGURED_TIMEOUT_MS, Math.floor(configured)));
}

function createDeadlineError() {
  const error = new Error('Not enough Lambda execution time remains to call the HomeBrain broker');
  error.code = 'HOMEBRAIN_LAMBDA_DEADLINE';
  error.alexaErrorType = 'BRIDGE_UNREACHABLE';
  return error;
}

function getBrokerTimeoutMs(context = {}) {
  const configuredTimeout = getConfiguredBrokerTimeoutMs();
  if (typeof context?.getRemainingTimeInMillis !== 'function') {
    return configuredTimeout;
  }

  const remainingMs = Number(context.getRemainingTimeInMillis());
  if (!Number.isFinite(remainingMs)) {
    return configuredTimeout;
  }

  const availableMs = Math.floor(remainingMs - RESPONSE_RESERVE_MS);
  if (availableMs < MIN_DEADLINE_TIMEOUT_MS) {
    throw createDeadlineError();
  }

  return Math.min(configuredTimeout, availableMs);
}

function normalizeBrokerPath(pathname) {
  const value = trimString(pathname);
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('Broker request path must be an absolute path on the configured broker origin');
  }
  return value;
}

function createBrokerClient(context = {}) {
  const baseUrl = getBrokerBaseUrl();

  async function request(method, pathname, payload, options = {}) {
    const target = new URL(normalizeBrokerPath(pathname), `${baseUrl}/`);
    if (target.origin !== baseUrl || target.hash) {
      throw new Error('Broker request cannot leave the configured broker origin');
    }

    const bearerToken = trimString(options.bearerToken);
    const response = await axios.request({
      method,
      url: target.toString(),
      ...(payload === undefined ? {} : { data: payload }),
      timeout: getBrokerTimeoutMs(context),
      maxRedirects: 0,
      httpAgent,
      httpsAgent,
      headers: {
        Accept: 'application/json',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
      }
    });
    return response.data;
  }

  return {
    get(pathname, options = {}) {
      return request('GET', pathname, undefined, options);
    },
    post(pathname, payload = {}, options = {}) {
      return request('POST', pathname, payload, options);
    }
  };
}

module.exports = {
  createBrokerClient,
  getBrokerBaseUrl,
  getBrokerTimeoutMs
};
