const axios = require('axios');
const {
  buildAcceptGrantResponse,
  buildControlResponse,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildStateReportResponse
} = require('../../shared/alexa/messages');
const { parseEndpointId } = require('../../shared/alexa/contracts');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBrokerBaseUrl() {
  const value = trimString(process.env.HOMEBRAIN_BROKER_BASE_URL).replace(/\/+$/, '');
  if (!value) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL is required');
  }
  return value;
}

function getDefaultHubId() {
  return trimString(process.env.HOMEBRAIN_BROKER_HUB_ID);
}

function getDirectiveEnvelope(event = {}) {
  return event?.directive ? event : { directive: event };
}

function getDirectiveScopeToken(envelope = {}) {
  return trimString(
    envelope.directive?.endpoint?.scope?.token
    || envelope.directive?.payload?.scope?.token
    || envelope.directive?.payload?.grantee?.token
  );
}

function getDirectiveMetadata(event = {}) {
  const envelope = getDirectiveEnvelope(event);
  const directive = envelope.directive || {};
  const header = directive.header || {};
  const endpoint = directive.endpoint || null;
  const endpointId = trimString(endpoint?.endpointId);
  const parsedEndpoint = endpointId ? parseEndpointId(endpointId) : null;

  return {
    envelope,
    directive,
    header,
    endpoint,
    payload: directive.payload || {},
    namespace: trimString(header.namespace),
    name: trimString(header.name),
    endpointId,
    parsedEndpoint,
    bearerToken: getDirectiveScopeToken(envelope)
  };
}

async function postToBroker(pathname, payload, options = {}) {
  const response = await axios.post(`${getBrokerBaseUrl()}${pathname}`, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {})
    }
  });
  return response.data;
}

async function getFromBroker(pathname, options = {}) {
  const response = await axios.get(`${getBrokerBaseUrl()}${pathname}`, {
    timeout: 10000,
    headers: {
      ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {})
    }
  });
  return response.data;
}

async function resolveLinkedAccount(bearerToken) {
  if (!trimString(bearerToken)) {
    return null;
  }

  return postToBroker('/api/oauth/alexa/resolve', { token: bearerToken }, { bearerToken });
}

async function resolveDirectiveHub(directive, options = {}) {
  const resolvedAccount = directive.bearerToken ? await resolveLinkedAccount(directive.bearerToken) : null;
  const tokenHubId = trimString(resolvedAccount?.hubId);
  const endpointHubId = trimString(directive.parsedEndpoint?.hubId);
  const defaultHubId = options.allowDefaultHubId === false ? '' : getDefaultHubId();
  const hubId = endpointHubId || tokenHubId || defaultHubId;

  if (!hubId) {
    throw new Error('Unable to resolve HomeBrain hub for Alexa directive');
  }

  if (endpointHubId && tokenHubId && endpointHubId !== tokenHubId) {
    throw new Error('Alexa endpoint does not belong to the linked HomeBrain hub');
  }

  return {
    hubId,
    resolvedAccount
  };
}

async function handler(event) {
  const directive = getDirectiveMetadata(event);

  try {
    if (directive.namespace === 'Alexa.Authorization' && directive.name === 'AcceptGrant') {
      const grantCode = trimString(directive.payload?.grant?.code);
      const granteeToken = trimString(directive.payload?.grantee?.token);
      if (!grantCode || !granteeToken) {
        throw new Error('AcceptGrant requires grant.code and grantee.token');
      }

      await postToBroker('/api/alexa/grants/accept', {
        grantCode,
        granteeToken
      }, {
        bearerToken: granteeToken
      });

      return buildAcceptGrantResponse(event);
    }

    if (directive.namespace === 'Alexa.Discovery' && directive.name === 'Discover') {
      const { hubId } = await resolveDirectiveHub(directive, {
        allowDefaultHubId: true
      });
      const response = await getFromBroker(`/api/alexa/hubs/${hubId}/catalog`);
      return buildDiscoveryResponse({
        directive: event,
        endpoints: response.endpoints || []
      });
    }

    if (directive.namespace === 'Alexa' && directive.name === 'ReportState') {
      if (!directive.endpointId) {
        throw new Error('ReportState requires endpointId');
      }

      const { hubId } = await resolveDirectiveHub(directive, {
        allowDefaultHubId: true
      });
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
      if (!directive.endpointId) {
        throw new Error('Control directives require endpointId');
      }

      const { hubId } = await resolveDirectiveHub(directive, {
        allowDefaultHubId: true
      });
      const result = await postToBroker('/api/alexa/directives/execute', {
        hubId,
        directive: directive.directive
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
    const message = error.response?.data?.error || error.message || 'Alexa request failed';
    const lowerMessage = message.toLowerCase();
    const errorType = lowerMessage.includes('invalid')
      || lowerMessage.includes('unsupported')
      || lowerMessage.includes('required')
      || lowerMessage.includes('mismatch')
      ? 'INVALID_DIRECTIVE'
      : 'INTERNAL_ERROR';

    return buildErrorResponse({
      directive: event,
      type: errorType,
      message
    });
  }
}

module.exports = {
  handler,
  getDirectiveMetadata,
  resolveDirectiveHub
};
