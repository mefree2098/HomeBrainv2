const axios = require('axios');
const ReverseProxySettings = require('../models/ReverseProxySettings');

function normalizeAdminUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'http://127.0.0.1:2019';
  }

  return trimmed.replace(/\/+$/, '');
}

function buildClient(baseUrl) {
  return axios.create({
    baseURL: normalizeAdminUrl(baseUrl),
    timeout: 5_000,
    validateStatus: (status) => status >= 200 && status < 500,
    headers: {
      Accept: 'application/json'
    }
  });
}

function formatAdminError(action, response) {
  const status = response?.status;
  const body = response?.data;
  if (body && typeof body === 'string' && body.trim()) {
    return `${action} failed (${status}): ${body.trim()}`;
  }
  if (body && typeof body === 'object' && body.error) {
    return `${action} failed (${status}): ${body.error}`;
  }
  return `${action} failed${status ? ` (${status})` : ''}`;
}

class CaddyAdminService {
  async getSettings() {
    return ReverseProxySettings.getSettings();
  }

  async ping(settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const client = buildClient(settings.caddyAdminUrl);

    try {
      const response = await client.get('/config/');
      if (response.status >= 200 && response.status < 300) {
        return {
          reachable: true,
          status: response.status,
          config: response.data
        };
      }

      return {
        reachable: false,
        status: response.status,
        error: formatAdminError('Caddy admin status check', response)
      };
    } catch (error) {
      return {
        reachable: false,
        status: null,
        error: error.message
      };
    }
  }

  async getConfig(settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const client = buildClient(settings.caddyAdminUrl);
    const response = await client.get('/config/');

    if (response.status < 200 || response.status >= 300) {
      throw new Error(formatAdminError('Reading Caddy config', response));
    }

    return response.data;
  }

  async getUpstreams(settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const client = buildClient(settings.caddyAdminUrl);

    try {
      const response = await client.get('/reverse_proxy/upstreams');
      if (response.status < 200 || response.status >= 300) {
        return null;
      }
      return response.data;
    } catch (_error) {
      return null;
    }
  }

  async adaptCaddyfile(caddyfile, settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const client = buildClient(settings.caddyAdminUrl);
    const response = await client.post('/adapt', caddyfile, {
      headers: {
        'Content-Type': 'text/caddyfile',
        Accept: 'application/json'
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(formatAdminError('Adapting Caddy config', response));
    }

    return response.data;
  }

  async loadCaddyfile(caddyfile, settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const client = buildClient(settings.caddyAdminUrl);
    const response = await client.post('/load', caddyfile, {
      headers: {
        'Content-Type': 'text/caddyfile',
        Accept: 'application/json'
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(formatAdminError('Loading Caddy config', response));
    }

    return {
      success: true,
      status: response.status
    };
  }
}

module.exports = new CaddyAdminService();
