const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { handler } = require('../src/customSkillHandler');

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

test('custom skill handler proxies linked requests to the broker dispatch endpoint', async (t) => {
  const calls = [];

  const brokerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: 'Movie night is ready.'
        },
        shouldEndSession: true
      }
    }));
  });

  const broker = await listen(brokerServer);
  const previousBrokerUrl = process.env.HOMEBRAIN_BROKER_BASE_URL;
  process.env.HOMEBRAIN_BROKER_BASE_URL = broker.baseUrl;

  t.after(async () => {
    process.env.HOMEBRAIN_BROKER_BASE_URL = previousBrokerUrl;
    await close(broker.server);
  });

  const response = await handler({
    session: {
      user: {
        userId: 'amzn1.ask.account.test-user',
        accessToken: 'skill-access-token'
      }
    },
    request: {
      type: 'IntentRequest',
      requestId: 'req-1',
      locale: 'en-US',
      intent: {
        name: 'HomeBrainSceneIntent',
        slots: {
          sceneName: {
            name: 'sceneName',
            value: 'Movie Night'
          }
        }
      }
    }
  });

  assert.equal(response.response.outputSpeech.text, 'Movie night is ready.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/alexa/custom/dispatch');
  assert.equal(calls[0].authorization, 'Bearer skill-access-token');
  assert.equal(calls[0].body.envelope.request.intent.name, 'HomeBrainSceneIntent');
});

test('custom skill handler asks the user to link HomeBrain when no access token is present', async () => {
  const response = await handler({
    session: {
      user: {
        userId: 'amzn1.ask.account.test-user'
      }
    },
    request: {
      type: 'LaunchRequest',
      requestId: 'req-2',
      locale: 'en-US'
    }
  });

  assert.equal(response.response.card.type, 'LinkAccount');
  assert.equal(response.response.shouldEndSession, true);
});
