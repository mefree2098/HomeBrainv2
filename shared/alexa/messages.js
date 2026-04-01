const crypto = require('crypto');
const {
  ALEXA_ERROR_TYPES,
  normalizeAlexaErrorType
} = require('./contracts');

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

function buildAcceptGrantResponse(directive = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Authorization',
      name: 'AcceptGrant.Response',
      messageId: directive?.directive?.header?.messageId
    }),
    payload: {}
  });
}

function buildDiscoveryResponse({ directive = {}, endpoints = [] } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa.Discovery',
      name: 'Discover.Response',
      messageId: directive?.directive?.header?.messageId
    }),
    payload: {
      endpoints: Array.isArray(endpoints) ? endpoints : []
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
        messageId: directive?.directive?.header?.messageId,
        correlationToken: directive?.directive?.header?.correlationToken
      }),
      endpoint,
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
        messageId: directive?.directive?.header?.messageId,
        correlationToken: directive?.directive?.header?.correlationToken
      }),
      endpoint,
      payload: {}
    }
  };
}

function buildErrorResponse({ directive = {}, type = 'INTERNAL_ERROR', message = 'Alexa request failed' } = {}) {
  return buildEventEnvelope({
    header: responseHeader({
      namespace: 'Alexa',
      name: 'ErrorResponse',
      messageId: directive?.directive?.header?.messageId,
      correlationToken: directive?.directive?.header?.correlationToken
    }),
    endpoint: directive?.directive?.endpoint || null,
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
  const message = String(
    errorLike?.message
    || errorLike?.error
    || errorLike?.response?.data?.error
    || errorLike?.response?.data?.message
    || ''
  ).trim();
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('expired authorization')) {
    return ALEXA_ERROR_TYPES.EXPIRED_AUTHORIZATION_CREDENTIAL;
  }

  if (statusCode === 401 || lowerMessage.includes('authorization failed') || lowerMessage.includes('access token')) {
    return lowerMessage.includes('expired')
      ? ALEXA_ERROR_TYPES.EXPIRED_AUTHORIZATION_CREDENTIAL
      : ALEXA_ERROR_TYPES.INVALID_AUTHORIZATION_CREDENTIAL;
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
    return lowerMessage.includes('bridge')
      ? ALEXA_ERROR_TYPES.BRIDGE_UNREACHABLE
      : ALEXA_ERROR_TYPES.ENDPOINT_UNREACHABLE;
  }

  if (lowerMessage.includes('unreachable') || lowerMessage.includes('timed out') || lowerMessage.includes('timeout') || lowerMessage.includes('offline')) {
    return lowerMessage.includes('bridge')
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
      endpoints,
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
  buildAddOrUpdateReport,
  buildChangeReport,
  buildControlResponse,
  buildDeleteReport,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildStateReportResponse,
  buildContext,
  buildEventEnvelope,
  inferAlexaErrorType,
  responseHeader
};
