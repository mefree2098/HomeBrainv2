const {
  buildAcceptGrantResponse,
  buildAcceptGrantErrorResponse,
  buildControlResponse,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildSceneActivationResponse,
  buildSceneDeactivationResponse,
  inferAlexaErrorType,
  buildStateReportResponse
} = require('../../shared/alexa/messages');
const { parseEndpointId } = require('../../shared/alexa/contracts');
const { createBrokerClient } = require('./brokerClient');

const CONTROL_NAMESPACES = new Set([
  'Alexa.PowerController',
  'Alexa.BrightnessController',
  'Alexa.ColorController',
  'Alexa.ColorTemperatureController',
  'Alexa.ThermostatController',
  'Alexa.LockController',
  'Alexa.SceneController'
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

async function resolveLinkedAccount(brokerClient, bearerToken) {
  if (!trimString(bearerToken)) {
    return null;
  }

  return brokerClient.post('/api/oauth/alexa/resolve', {}, { bearerToken });
}

async function resolveDirectiveHub(directive, options = {}) {
  const endpointHubId = trimString(directive.parsedEndpoint?.hubId);
  const defaultHubId = options.allowDefaultHubId === false ? '' : getDefaultHubId();
  const immediateHubId = endpointHubId || defaultHubId;

  // State and control routes authenticate the bearer token against this hub at
  // the broker. Avoid a redundant resolve request when the endpoint already
  // identifies the hub.
  if (immediateHubId) {
    return {
      hubId: immediateHubId,
      resolvedAccount: null
    };
  }

  const brokerClient = options.brokerClient || createBrokerClient(options.context);
  const resolvedAccount = directive.bearerToken
    ? await resolveLinkedAccount(brokerClient, directive.bearerToken)
    : null;
  const hubId = trimString(resolvedAccount?.hubId);

  if (!hubId) {
    throw new Error('Unable to resolve HomeBrain hub for Alexa directive');
  }

  return {
    hubId,
    resolvedAccount
  };
}

function sanitizeDirectiveForBroker(directive = {}) {
  const source = directive && typeof directive === 'object' && !Array.isArray(directive)
    ? directive
    : {};
  const endpoint = source.endpoint && typeof source.endpoint === 'object'
    ? source.endpoint
    : null;
  const payload = source.payload && typeof source.payload === 'object'
    ? source.payload
    : {};
  const safeEndpoint = { ...(endpoint || {}) };
  const safePayload = { ...payload };
  const grantee = safePayload.grantee;
  delete safeEndpoint.scope;
  delete safePayload.scope;
  delete safePayload.grantee;
  const safeGrantee = grantee && typeof grantee === 'object'
    ? Object.fromEntries(Object.entries(grantee).filter(([key]) => key !== 'token'))
    : grantee;

  return {
    ...source,
    ...(endpoint ? { endpoint: safeEndpoint } : {}),
    payload: {
      ...safePayload,
      ...(safeGrantee && Object.keys(safeGrantee).length > 0 ? { grantee: safeGrantee } : {})
    }
  };
}

function getPublicErrorMessage(errorType) {
  switch (errorType) {
    case 'INVALID_AUTHORIZATION_CREDENTIAL':
    case 'EXPIRED_AUTHORIZATION_CREDENTIAL':
      return 'The HomeBrain account authorization is invalid or expired.';
    case 'INSUFFICIENT_PERMISSIONS':
      return 'The linked HomeBrain account does not have the required permission.';
    case 'NO_SUCH_ENDPOINT':
      return 'The requested HomeBrain endpoint could not be found.';
    case 'BRIDGE_UNREACHABLE':
      return 'The HomeBrain bridge could not be reached.';
    case 'ENDPOINT_UNREACHABLE':
      return 'The requested HomeBrain endpoint could not be reached.';
    case 'ENDPOINT_BUSY':
      return 'The requested HomeBrain endpoint is busy.';
    case 'RATE_LIMIT_EXCEEDED':
      return 'HomeBrain is temporarily receiving too many requests.';
    case 'INVALID_DIRECTIVE':
      return 'Alexa sent a directive that HomeBrain could not process.';
    default:
      return 'HomeBrain could not complete the Alexa request.';
  }
}

function logFailure(error, directive, context, startedAt, errorType) {
  const statusCode = Number(error?.response?.status || error?.statusCode || error?.status || 0);
  console.error(JSON.stringify({
    event: 'homebrain_alexa_lambda_failure',
    awsRequestId: trimString(context?.awsRequestId),
    directive: `${directive.namespace || 'unknown'}.${directive.name || 'unknown'}`,
    endpointId: directive.endpointId || undefined,
    alexaErrorType: errorType,
    statusCode: statusCode || undefined,
    errorCode: trimString(error?.code) || undefined,
    durationMs: Date.now() - startedAt
  }));
}

async function handler(event, context = {}) {
  const directive = getDirectiveMetadata(event);
  const startedAt = Date.now();

  try {
    const brokerClient = createBrokerClient(context);

    if (directive.namespace === 'Alexa.Authorization' && directive.name === 'AcceptGrant') {
      const grantCode = trimString(directive.payload?.grant?.code);
      const granteeToken = trimString(directive.payload?.grantee?.token);
      if (!grantCode || !granteeToken) {
        throw new Error('AcceptGrant requires grant.code and grantee.token');
      }

      await brokerClient.post('/api/alexa/grants/accept', {
        grantCode,
        eventRegion: trimString(process.env.AWS_REGION || process.env.HOMEBRAIN_ALEXA_EVENT_REGION || 'NA')
      }, {
        bearerToken: granteeToken
      });

      return buildAcceptGrantResponse(event);
    }

    if (directive.namespace === 'Alexa.Discovery' && directive.name === 'Discover') {
      const { hubId } = await resolveDirectiveHub(directive, {
        allowDefaultHubId: true,
        brokerClient,
        context
      });
      const response = await brokerClient.get(`/api/alexa/hubs/${encodeURIComponent(hubId)}/catalog`, {
        bearerToken: directive.bearerToken
      });
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
        allowDefaultHubId: true,
        brokerClient,
        context
      });
      const state = await brokerClient.post('/api/alexa/directives/state', {
        hubId,
        endpointIds: [directive.endpointId]
      }, {
        bearerToken: directive.bearerToken
      });
      const snapshot = Array.isArray(state?.states) ? state.states[0] : null;
      if (!snapshot || (trimString(snapshot.endpointId) && trimString(snapshot.endpointId) !== directive.endpointId)) {
        const error = new Error('HomeBrain did not return state for the requested Alexa endpoint');
        error.alexaErrorType = 'NO_SUCH_ENDPOINT';
        throw error;
      }
      return buildStateReportResponse({
        directive: event,
        endpoint: directive.endpoint,
        properties: snapshot?.properties || []
      });
    }

    if (CONTROL_NAMESPACES.has(directive.namespace)) {
      if (!directive.endpointId) {
        throw new Error('Control directives require endpointId');
      }

      const { hubId } = await resolveDirectiveHub(directive, {
        allowDefaultHubId: true,
        brokerClient,
        context
      });
      const result = await brokerClient.post('/api/alexa/directives/execute', {
        hubId,
        directive: sanitizeDirectiveForBroker(directive.directive)
      }, {
        bearerToken: directive.bearerToken
      });

      if (directive.namespace === 'Alexa.SceneController') {
        if (directive.name === 'Activate') {
          return buildSceneActivationResponse({
            directive: event,
            endpoint: directive.endpoint
          });
        }

        if (directive.name === 'Deactivate') {
          return buildSceneDeactivationResponse({
            directive: event,
            endpoint: directive.endpoint
          });
        }
      }

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
    if (directive.namespace === 'Alexa.Authorization' && directive.name === 'AcceptGrant') {
      logFailure(error, directive, context, startedAt, 'ACCEPT_GRANT_FAILED');
      return buildAcceptGrantErrorResponse({
        message: 'HomeBrain could not store Alexa event permissions. Please retry account linking.'
      });
    }
    const errorType = inferAlexaErrorType(error);
    logFailure(error, directive, context, startedAt, errorType);

    return buildErrorResponse({
      directive: event,
      type: errorType,
      message: getPublicErrorMessage(errorType)
    });
  }
}

module.exports = {
  handler,
  getDirectiveMetadata,
  resolveDirectiveHub,
  sanitizeDirectiveForBroker
};
