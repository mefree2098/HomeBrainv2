const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAddOrUpdateReport,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildStateReportResponse,
  inferAlexaErrorType
} = require('../../shared/alexa/messages');

function directiveWithScope() {
  return {
    directive: {
      header: {
        namespace: 'Alexa',
        name: 'ReportState',
        correlationToken: 'corr-1'
      },
      endpoint: {
        endpointId: 'hb:hub-test:device:lamp-1',
        scope: {
          type: 'BearerToken',
          token: 'secret-token'
        },
        cookie: {
          entityId: 'lamp-1'
        }
      },
      payload: {}
    }
  };
}

test('discovery builders strip HomeBrain-only state and bearer scopes', () => {
  const endpoints = [{
    endpointId: 'hb:hub-test:device:lamp-1',
    friendlyName: 'Lamp',
    capabilities: [],
    scope: {
      type: 'BearerToken',
      token: 'secret-token'
    },
    state: {
      properties: [{ name: 'powerState', value: 'ON' }]
    }
  }];

  const discovery = buildDiscoveryResponse({ endpoints });
  const proactive = buildAddOrUpdateReport({ endpoints });

  for (const response of [discovery, proactive]) {
    assert.deepEqual(response.event.payload.endpoints, [{
      endpointId: 'hb:hub-test:device:lamp-1',
      friendlyName: 'Lamp',
      capabilities: []
    }]);
  }

  assert.equal('state' in endpoints[0], true, 'the internal catalog record is not mutated');
});

test('discovery builders reject payloads above Alexa interface limits', () => {
  assert.throws(
    () => buildDiscoveryResponse({
      endpoints: Array.from({ length: 301 }, (_, index) => ({
        endpointId: `endpoint-${index}`,
        capabilities: []
      }))
    }),
    /at most 300 endpoints/
  );

  assert.throws(
    () => buildDiscoveryResponse({
      endpoints: [{
        endpointId: 'endpoint-1',
        capabilities: Array.from({ length: 101 }, () => ({ type: 'AlexaInterface' }))
      }]
    }),
    /at most 100 capabilities/
  );
});

test('synchronous state and error responses never echo directive credentials', () => {
  const directive = directiveWithScope();
  const state = buildStateReportResponse({
    directive,
    endpoint: directive.directive.endpoint,
    properties: []
  });
  const error = buildErrorResponse({
    directive,
    type: 'NO_SUCH_ENDPOINT',
    message: 'Missing endpoint'
  });

  assert.deepEqual(state.event.endpoint, {
    endpointId: 'hb:hub-test:device:lamp-1'
  });
  assert.deepEqual(error.event.endpoint, {
    endpointId: 'hb:hub-test:device:lamp-1'
  });
});

test('broker transport and authorization failures map to Alexa error types', () => {
  assert.equal(inferAlexaErrorType({ code: 'ETIMEDOUT' }), 'BRIDGE_UNREACHABLE');
  assert.equal(inferAlexaErrorType({ response: { status: 503 } }), 'BRIDGE_UNREACHABLE');
  assert.equal(
    inferAlexaErrorType({ response: { status: 403, data: { error: 'Missing required permission scope' } } }),
    'INSUFFICIENT_PERMISSIONS'
  );
  assert.equal(
    inferAlexaErrorType({
      message: 'Request failed with status code 403',
      response: { status: 403, data: { error: 'Missing required permission scope' } }
    }),
    'INSUFFICIENT_PERMISSIONS'
  );
  assert.equal(
    inferAlexaErrorType({ response: { status: 403, data: { error: 'Authorization failed' } } }),
    'INVALID_AUTHORIZATION_CREDENTIAL'
  );
  assert.equal(
    inferAlexaErrorType({ alexaErrorType: 'NO_SUCH_ENDPOINT' }),
    'NO_SUCH_ENDPOINT'
  );
});
