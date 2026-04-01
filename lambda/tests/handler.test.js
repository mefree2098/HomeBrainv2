const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { handler } = require('../src/handler');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('lambda handler resolves Discover, AcceptGrant, ReportState, and control directives through broker APIs', async (t) => {
  const calls = [];

  const brokerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : {};

    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body
    });

    if (req.url === '/api/oauth/alexa/resolve' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        brokerAccountId: 'acct-1',
        hubId: 'hub-test',
        scopes: ['smart_home'],
        account: {
          brokerAccountId: 'acct-1',
          status: 'linked'
        }
      }));
      return;
    }

    if (req.url === '/api/alexa/grants/accept' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true
      }));
      return;
    }

    if (req.url === '/api/alexa/hubs/hub-test/catalog' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        endpoints: [{
          endpointId: 'hb:hub-test:device:lamp-1',
          friendlyName: 'Lamp',
          description: 'Living room lamp',
          manufacturerName: 'HomeBrain',
          displayCategories: ['LIGHT'],
          cookie: {
            entityType: 'device',
            entityId: 'lamp-1'
          },
          capabilities: [],
          state: {
            properties: []
          }
        }]
      }));
      return;
    }

    if (req.url === '/api/alexa/directives/state' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        states: [{
          endpointId: 'hb:hub-test:device:lamp-1',
          properties: [{
            namespace: 'Alexa.PowerController',
            name: 'powerState',
            value: 'ON'
          }]
        }]
      }));
      return;
    }

    if (req.url === '/api/alexa/directives/execute' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        properties: [{
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: 'ON'
        }]
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Unhandled broker route ${req.method} ${req.url}`
    }));
  });

  const broker = await listen(brokerServer);
  const previousBrokerUrl = process.env.HOMEBRAIN_BROKER_BASE_URL;
  const previousHubId = process.env.HOMEBRAIN_BROKER_HUB_ID;
  process.env.HOMEBRAIN_BROKER_BASE_URL = broker.baseUrl;
  process.env.HOMEBRAIN_BROKER_HUB_ID = '';

  t.after(async () => {
    process.env.HOMEBRAIN_BROKER_BASE_URL = previousBrokerUrl;
    process.env.HOMEBRAIN_BROKER_HUB_ID = previousHubId;
    await close(broker.server);
  });

  const acceptGrantResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'AcceptGrant',
        payloadVersion: '3',
        messageId: 'msg-1'
      },
      payload: {
        grant: {
          type: 'OAuth2.AuthorizationCode',
          code: 'grant-123'
        },
        grantee: {
          type: 'BearerToken',
          token: 'access-123'
        }
      }
    }
  });

  assert.equal(acceptGrantResponse.event.header.name, 'AcceptGrant.Response');

  const discoverResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'Discover',
        payloadVersion: '3',
        messageId: 'msg-2'
      },
      payload: {
        scope: {
          type: 'BearerToken',
          token: 'access-123'
        }
      }
    }
  });

  assert.equal(discoverResponse.event.header.name, 'Discover.Response');
  assert.equal(discoverResponse.event.payload.endpoints.length, 1);

  const stateResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa',
        name: 'ReportState',
        payloadVersion: '3',
        messageId: 'msg-3',
        correlationToken: 'corr-1'
      },
      endpoint: {
        endpointId: 'hb:hub-test:device:lamp-1',
        scope: {
          type: 'BearerToken',
          token: 'access-123'
        }
      },
      payload: {}
    }
  });

  assert.equal(stateResponse.event.header.name, 'StateReport');
  assert.equal(stateResponse.context.properties[0].value, 'ON');

  const controlResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        payloadVersion: '3',
        messageId: 'msg-4',
        correlationToken: 'corr-2'
      },
      endpoint: {
        endpointId: 'hb:hub-test:device:lamp-1',
        scope: {
          type: 'BearerToken',
          token: 'access-123'
        }
      },
      payload: {}
    }
  });

  assert.equal(controlResponse.event.header.name, 'Response');
  assert.equal(controlResponse.context.properties[0].value, 'ON');

  assert.ok(calls.some((entry) => entry.url === '/api/alexa/grants/accept'));
  assert.ok(calls.some((entry) => entry.url === '/api/oauth/alexa/resolve'));
  assert.ok(calls.some((entry) => entry.url === '/api/alexa/directives/execute'));
  assert.equal(
    calls.filter((entry) => entry.url === '/api/alexa/hubs/hub-test/catalog')[0]?.authorization,
    'Bearer access-123'
  );
  assert.equal(
    calls.filter((entry) => entry.url === '/api/alexa/directives/state')[0]?.authorization,
    'Bearer access-123'
  );
  assert.equal(
    calls.filter((entry) => entry.url === '/api/alexa/directives/execute')[0]?.authorization,
    'Bearer access-123'
  );
});

test('lambda maps broker authorization and endpoint failures into Alexa error responses', async (t) => {
  const brokerServer = http.createServer(async (req, res) => {
    if (req.url === '/api/oauth/alexa/resolve' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        brokerAccountId: 'acct-1',
        hubId: 'hub-test',
        scopes: ['smart_home'],
        account: {
          brokerAccountId: 'acct-1',
          status: 'linked'
        }
      }));
      return;
    }

    if (req.url === '/api/alexa/directives/execute' && req.method === 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Alexa endpoint not found'
      }));
      return;
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Access token is invalid or expired'
    }));
  });

  const broker = await listen(brokerServer);
  const previousBrokerUrl = process.env.HOMEBRAIN_BROKER_BASE_URL;
  const previousHubId = process.env.HOMEBRAIN_BROKER_HUB_ID;
  process.env.HOMEBRAIN_BROKER_BASE_URL = broker.baseUrl;
  process.env.HOMEBRAIN_BROKER_HUB_ID = '';

  t.after(async () => {
    process.env.HOMEBRAIN_BROKER_BASE_URL = previousBrokerUrl;
    process.env.HOMEBRAIN_BROKER_HUB_ID = previousHubId;
    await close(broker.server);
  });

  const endpointMissingResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        payloadVersion: '3',
        messageId: 'msg-404',
        correlationToken: 'corr-404'
      },
      endpoint: {
        endpointId: 'hb:hub-test:device:missing-1',
        scope: {
          type: 'BearerToken',
          token: 'access-123'
        }
      },
      payload: {}
    }
  });

  assert.equal(endpointMissingResponse.event.payload.type, 'NO_SUCH_ENDPOINT');

  const unauthorizedResponse = await handler({
    directive: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'Discover',
        payloadVersion: '3',
        messageId: 'msg-401'
      },
      payload: {
        scope: {
          type: 'BearerToken',
          token: 'bad-token'
        }
      }
    }
  });

  assert.equal(
    ['INVALID_AUTHORIZATION_CREDENTIAL', 'EXPIRED_AUTHORIZATION_CREDENTIAL'].includes(unauthorizedResponse.event.payload.type),
    true
  );
});
