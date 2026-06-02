const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AlexaSessionCaptureService,
  buildAmazonLoginUrl,
  validateCookie
} = require('../services/alexaSessionCaptureService');

test('validateCookie accepts the Alexa cookie pieces required by HomeBrain Native', () => {
  const result = validateCookie(
    'ubid-main=abc; session-id=123; session-id-time=456; session-token=token; at-main=Atza|abc; sess-at-main=session; x-main="quoted"; csrf=csrf-token'
  );

  assert.equal(result.csrf, 'csrf-token');
  assert.equal(result.cookie.includes('session-token=token'), true);
  assert.equal(result.cookieNames.includes('session-id'), true);
  assert.deepEqual(result.warnings, []);
});

test('validateCookie can append an explicit csrf value captured separately', () => {
  const result = validateCookie('session-id=123; session-token=token', 'csrf-token');

  assert.equal(result.csrf, 'csrf-token');
  assert.equal(result.cookie.endsWith('csrf=csrf-token'), true);
});

test('validateCookie rejects a partial browser cookie', () => {
  assert.throws(
    () => validateCookie('session-id=123; ubid-main=abc'),
    /session-token, csrf/
  );
});

test('AlexaSessionCaptureService issues a short-lived capture and completes it with a valid token', () => {
  let currentTime = Date.parse('2026-06-01T12:00:00.000Z');
  const service = new AlexaSessionCaptureService({
    ttlMs: 10 * 60 * 1000,
    clock: () => currentTime
  });

  const started = service.startCapture({
    actor: 'admin@example.com',
    amazonPage: 'amazon.com',
    serviceHost: 'pitangui.amazon.com',
    req: {
      protocol: 'https',
      headers: {
        host: 'homebrain.example.com'
      }
    }
  });

  assert.equal(started.status, 'pending');
  assert.equal(started.capturePageUrl.includes('/alexa-session-capture.html?'), true);
  assert.equal(started.receiverUrl.includes(`/api/alexa/session-capture/${started.captureId}/complete`), true);

  currentTime += 1000;
  const completed = service.completeCapture(started.captureId, {
    token: started.token,
    cookie: 'session-id=123; session-token=token; csrf=csrf-token'
  });

  assert.equal(completed.status, 'captured');
  assert.equal(completed.cookie, 'session-id=123; session-token=token; csrf=csrf-token');
});

test('AlexaSessionCaptureService rejects an invalid capture token', () => {
  const service = new AlexaSessionCaptureService();
  const started = service.startCapture({
    req: {
      protocol: 'https',
      headers: {
        host: 'homebrain.example.com'
      }
    }
  });

  assert.throws(
    () => service.completeCapture(started.captureId, {
      token: 'wrong-token',
      cookie: 'session-id=123; session-token=token; csrf=csrf-token'
    }),
    /token is invalid/
  );
});

test('buildAmazonLoginUrl sends the user directly to Amazon login with Alexa as the return target', () => {
  const loginUrl = buildAmazonLoginUrl('amazon.com');
  const parsed = new URL(loginUrl);

  assert.equal(parsed.hostname, 'www.amazon.com');
  assert.equal(parsed.pathname, '/ap/signin');
  assert.equal(parsed.searchParams.get('openid.return_to'), 'https://alexa.amazon.com/spa/index.html');
});
