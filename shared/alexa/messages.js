const crypto = require('crypto');
const {
  ALEXA_ERROR_TYPES,
  normalizeAlexaErrorType
} = require('./contracts');

const MAX_DISCOVERY_ENDPOINTS = 300;
const MAX_ENDPOINT_CAPABILITIES = 100;

function responseHeader({
  namespace = 'Alexa',
  name = 'Response',
  messageId = null,
  correlationToken = null,
  payloadVersion = '3'
} = {}) {
  const header = {
    namespace,
    name,
    payloadVersion,
    messageId: messageId || crypto.randomUUID()
  };

  if (correlationToken) {
    header.correlationToken = correlationToken;
  }

  return header;
}

function buildEventEnvelope({ header, endpoint = null, payload = {} }) {
  const event = {
    header,
    payload
  };

  if (endpoint) {
    event.endpoint = endpoint;
  }

  return { event };
}

function buildContext(properties = []) {
  return {
    properties: Array.isArray(properties) ? properties : []
  };
}

function sanitizeResponseEndpoint(endpoint = null) {
  const endpointId = typeof endpoint?.endpointId === 'string'
    ? endpoint.endpointId.trim()
    : '';
  return endpointId ? { endpointId } : null;
}

function sanitizeDiscoveryEndpoints(endpoints = []) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  if (list.length > MAX_DISCOVERY_ENDPOINTS) {
    const error = new Error(`Alexa discovery supports at most ${MAX_DISCOVERY_ENDPOINTS} endpoints`);
    error.alexaErrorType = ALEXA_ERROR_TYPES.INTERNAL_ERROR;
    throw error;
  }

  return list.map((endpoint, index) => {
    const source = endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint)
      ? endpoint
      : {};
    const capabilities = Array.isArray(source.capabilities) ? source.capabilities : [];
    if (capabilities.length > MAX_ENDPOINT_CAPABILITIES) {
      const error = new Error(
        `Alexa endpoint ${source.endpointId || index} supports at most ${MAX_ENDPOINT_CAPABILITIES} capabilities`
      );
      error.alexaErrorType = ALEXA_ERROR_TYPES.INTERNAL_ERROR;
      throw error;
    }

    // HomeBrain keeps current state beside each internal catalog record. Alexa's
    // discovery schema does not accept that internal field or a bearer scope.
    const { state, scope, ...sanitized } = source;
    return sanitized;
  });
}

function buildAcceptGrantResponse(directive = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Authorization',
      name: 'AcceptGrant.Response'
    }),
    payload: {}
  });
}

function buildAcceptGrantErrorResponse({ message = 'Failed to store Alexa event-gateway authorization' } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Authorization',
      name: 'ErrorResponse'
    }),
    payload: {
      type: 'ACCEPT_GRANT_FAILED',
      message
    }
  });
}

function buildDiscoveryResponse({ directive = {}, endpoints = [] } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Discovery',
      name: 'Discover.Response'
    }),
    payload: {
      endpoints: sanitizeDiscoveryEndpoints(endpoints)
    }
  });
}

function buildStateReportResponse({ directive = {}, endpoint = null, properties = [] } = {}) {
  return {
    context: buildContext(properties),
    event: {
      header: responseHeader({
        namespace: 'Alexa',
        name: 'StateReport',
        correlationToken: directive?.directive?.header?.correlationToken
      }),
      endpoint: sanitizeResponseEndpoint(endpoint),
      payload: {}
    }
  };
}

function buildControlResponse({ directive = {}, endpoint = null, properties = [] } = {}) {
  return {
    context: buildContext(properties),
    event: {
      header: responseHeader({
        namespace: 'Alexa',
        name: 'Response',
        correlationToken: directive?.directive?.header?.correlationToken
      }),
      endpoint: sanitizeResponseEndpoint(endpoint),
      payload: {}
    }
  };
}

function buildSceneLifecycleResponse({
  directive = {},
  endpoint = null,
  lifecycleName = 'ActivationStarted',
  causeType = 'VOICE_INTERACTION',
  timestamp = new Date().toISOString()
} = {}) {
  return {
    context: buildContext([]),
    event: {
      header: responseHeader({
        namespace: 'Alexa.SceneController',
        name: lifecycleName,
        correlationToken: directive?.directive?.header?.correlationToken
      }),
      endpoint: sanitizeResponseEndpoint(endpoint),
      payload: {
        cause: {
          type: causeType
        },
        timestamp
      }
    }
  };
}

function buildSceneActivationResponse(options = {}) {
  return buildSceneLifecycleResponse({
    ...options,
    lifecycleName: 'ActivationStarted'
  });
}

function buildSceneDeactivationResponse(options = {}) {
  return buildSceneLifecycleResponse({
    ...options,
    lifecycleName: 'DeactivationStarted'
  });
}

function buildErrorResponse({ directive = {}, type = 'INTERNAL_ERROR', message = 'Alexa request failed' } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa',
      name: 'ErrorResponse',
      correlationToken: directive?.directive?.header?.correlationToken
    }),
    endpoint: sanitizeResponseEndpoint(directive?.directive?.endpoint),
    payload: {
      type: normalizeAlexaErrorType(type),
      message
    }
  });
}

function inferAlexaErrorType(errorLike = {}, fallback = ALEXA_ERROR_TYPES.INTERNAL_ERROR) {
  if (typeof errorLike === 'string') {
    return inferAlexaErrorType({ message: errorLike }, fallback);
  }

  const statusCode = Number(
    errorLike?.statusCode
    || errorLike?.status
    || errorLike?.response?.status
    || 0
  );
  const explicitType = String(
    errorLike?.alexaErrorType || errorLike?.response?.data?.alexaErrorType || ''
  ).trim();
  if (explicitType) {
    return normalizeAlexaErrorType(explicitType);
  }
  const errorCode = String(errorLike?.code || errorLike?.cause?.code || '').trim().toUpperCase();
  const message = String(
    errorLike?.response?.data?.error
    || errorLike?.response?.data?.message
    || errorLike?.message
    || errorLike?.error
    || ''
  ).trim();
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('expired authorization')) {
    return ALEXA_ERROR_TYPES.EXPIRED_AUTHORIZATION_CREDENTIAL;
  }

  if (
    statusCode === 403
    && (lowerMessage.includes('permission') || lowerMessage.includes('scope'))
  ) {
    return ALEXA_ERROR_TYPES.INSUFFICIENT_PERMISSIONS;
  }

  if (
    statusCode === 401
    || statusCode === 403
    || lowerMessage.includes('authorization failed')
    || lowerMessage.includes('access token')
  ) {
    return lowerMessage.includes('expired')
      ? ALEXA_ERROR_TYPES.EXPIRED_AUTHORIZATION_CREDENTIAL
      : ALEXA_ERROR_TYPES.INVALID_AUTHORIZATION_CREDENTIAL;
  }

  if (['ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'HOMEBRAIN_LAMBDA_DEADLINE'].includes(errorCode)) {
    return ALEXA_ERROR_TYPES.BRIDGE_UNREACHABLE;
  }

  if (statusCode === 404 || lowerMessage.includes('no such endpoint') || lowerMessage.includes('endpoint not found')) {
    return ALEXA_ERROR_TYPES.NO_SUCH_ENDPOINT;
  }

  if (
    statusCode === 502
    || statusCode === 503
    || statusCode === 504
    || lowerMessage.includes('hub is offline')
    || lowerMessage.includes('bridge unreachable')
  ) {
    return ALEXA_ERROR_TYPES.BRIDGE_UNREACHABLE;
  }

  if (lowerMessage.includes('unreachable') || lowerMessage.includes('timed out') || lowerMessage.includes('timeout') || lowerMessage.includes('offline')) {
    return lowerMessage.includes('bridge') || lowerMessage.includes('hub') || lowerMessage.includes('broker')
      ? ALEXA_ERROR_TYPES.BRIDGE_UNREACHABLE
      : ALEXA_ERROR_TYPES.ENDPOINT_UNREACHABLE;
  }

  if (statusCode === 409 || lowerMessage.includes('busy')) {
    return ALEXA_ERROR_TYPES.ENDPOINT_BUSY;
  }

  if (statusCode === 429 || lowerMessage.includes('rate limit')) {
    return ALEXA_ERROR_TYPES.RATE_LIMIT_EXCEEDED;
  }

  if (lowerMessage.includes('out of range')) {
    return lowerMessage.includes('temperature')
      ? ALEXA_ERROR_TYPES.TEMPERATURE_VALUE_OUT_OF_RANGE
      : ALEXA_ERROR_TYPES.VALUE_OUT_OF_RANGE;
  }

  if (lowerMessage.includes('unsupported thermostat mode')) {
    return ALEXA_ERROR_TYPES.UNSUPPORTED_THERMOSTAT_MODE;
  }

  if (
    lowerMessage.includes('invalid')
    || lowerMessage.includes('unsupported')
    || lowerMessage.includes('required')
    || lowerMessage.includes('mismatch')
    || lowerMessage.includes('malformed')
  ) {
    return ALEXA_ERROR_TYPES.INVALID_DIRECTIVE;
  }

  return normalizeAlexaErrorType(fallback);
}

function buildAddOrUpdateReport({ endpoints = [], scope = null } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Discovery',
      name: 'AddOrUpdateReport'
    }),
    payload: {
      endpoints: sanitizeDiscoveryEndpoints(endpoints),
      scope: scope || undefined
    }
  });
}

function buildDeleteReport({ endpoints = [], scope = null } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Discovery',
      name: 'DeleteReport'
    }),
    payload: {
      endpoints,
      scope: scope || undefined
    }
  });
}

function buildChangeReport({ endpoint = null, properties = [], causeType = 'PHYSICAL_INTERACTION' } = {}) {
  return {
    context: buildContext(properties),
    event: {
      header: responseHeader({
        namespace: 'Alexa',
        name: 'ChangeReport'
      }),
      endpoint,
      payload: {
        change: {
          cause: {
            type: causeType
          },
          properties
        }
      }
    }
  };
}

module.exports = {
  buildAcceptGrantResponse,
  buildAcceptGrantErrorResponse,
  buildAddOrUpdateReport,
  buildChangeReport,
  buildControlResponse,
  buildDeleteReport,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildSceneActivationResponse,
  buildSceneDeactivationResponse,
  buildStateReportResponse,
  buildContext,
  buildEventEnvelope,
  inferAlexaErrorType,
  responseHeader,
  sanitizeDiscoveryEndpoints,
  sanitizeResponseEndpoint
};
