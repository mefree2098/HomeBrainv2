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
    payloadVersion
  };

  if (messageId) {
    header.messageId = messageId;
  }

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
      type,
      message
    }
  });
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
  responseHeader
};
