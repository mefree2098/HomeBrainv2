const axios = require('axios');
const {
  buildAcceptGrantResponse,
  buildControlResponse,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildStateReportResponse
} = require('../../shared/alexa/messages');

function getBrokerBaseUrl() {
  const value = String(process.env.HOMEBRAIN_BROKER_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL is required');
  }
  return value;
}

function getDefaultHubId() {
  return String(process.env.HOMEBRAIN_BROKER_HUB_ID || '').trim();
}

function getDirectiveEnvelope(event = {}) {
  return event?.directive ? event : { directive: event };
}

function getDirectiveMetadata(event = {}) {
  const envelope = getDirectiveEnvelope(event);
  const header = envelope.directive?.header || {};
  const endpoint = envelope.directive?.endpoint || null;
  return {
    envelope,
    header,
    endpoint,
    namespace: header.namespace || '',
    name: header.name || '',
    endpointId: endpoint?.endpointId || '',
    hubId: getDefaultHubId()
  };
}

async function postToBroker(pathname, payload) {
  const response = await axios.post(`${getBrokerBaseUrl()}${pathname}`, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json'
    }
  });
  return response.data;
}

async function handler(event) {
  const directive = getDirectiveMetadata(event);

  try {
    if (directive.namespace === 'Alexa.Authorization' && directive.name === 'AcceptGrant') {
      return buildAcceptGrantResponse(event);
    }

    if (directive.namespace === 'Alexa.Discovery' && directive.name === 'Discover') {
      const hubId = directive.hubId;
      if (!hubId) {
        throw new Error('HOMEBRAIN_BROKER_HUB_ID is required for Discover handling');
      }

      const response = await axios.get(`${getBrokerBaseUrl()}/api/alexa/hubs/${hubId}/catalog`, {
        timeout: 10000
      });
      return buildDiscoveryResponse({
        directive: event,
        endpoints: response.data?.endpoints || []
      });
    }

    if (directive.namespace === 'Alexa' && directive.name === 'ReportState') {
      const hubId = directive.hubId;
      if (!hubId || !directive.endpointId) {
        throw new Error('ReportState requires HOMEBRAIN_BROKER_HUB_ID and endpointId');
      }

      const state = await postToBroker('/api/alexa/directives/state', {
        hubId,
        endpointIds: [directive.endpointId]
      });
      const snapshot = Array.isArray(state?.states) ? state.states[0] : null;
      return buildStateReportResponse({
        directive: event,
        endpoint: directive.endpoint,
        properties: snapshot?.properties || []
      });
    }

    const controlNamespaces = new Set([
      'Alexa.PowerController',
      'Alexa.BrightnessController',
      'Alexa.ColorController',
      'Alexa.ColorTemperatureController',
      'Alexa.ThermostatController',
      'Alexa.LockController',
      'Alexa.SceneController'
    ]);

    if (controlNamespaces.has(directive.namespace)) {
      const hubId = directive.hubId;
      if (!hubId) {
        throw new Error('HOMEBRAIN_BROKER_HUB_ID is required for control directives');
      }

      const result = await postToBroker('/api/alexa/directives/execute', {
        hubId,
        directive: event.directive
      });

      return buildControlResponse({
        directive: event,
        endpoint: directive.endpoint,
        properties: result?.properties || []
      });
    }

    return buildErrorResponse({
      directive: event,
      type: 'INVALID_DIRECTIVE',
      message: `Unsupported directive ${directive.namespace}.${directive.name}`
    });
  } catch (error) {
    return buildErrorResponse({
      directive: event,
      type: 'INTERNAL_ERROR',
      message: error.response?.data?.error || error.message || 'Alexa request failed'
    });
  }
}

module.exports = {
  handler
};
