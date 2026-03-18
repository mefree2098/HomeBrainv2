const test = require('node:test');
const assert = require('node:assert/strict');

const { isApiRequest, sendNotFound, sendUnhandledError } = require('../utils/apiErrorResponses');

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('isApiRequest detects API paths from originalUrl', () => {
  assert.equal(isApiRequest({ originalUrl: '/api/users', path: '/users' }), true);
  assert.equal(isApiRequest({ originalUrl: '/users', path: '/users' }), false);
});

test('sendNotFound returns JSON for API requests', () => {
  const res = createMockResponse();

  sendNotFound({ method: 'GET', path: '/api/users', originalUrl: '/api/users' }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    success: false,
    message: 'API route not found: GET /api/users'
  });
});

test('sendNotFound returns plain text for non-API routes', () => {
  const res = createMockResponse();

  sendNotFound({ method: 'GET', path: '/users', originalUrl: '/users' }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body, 'Page not found.');
});

test('sendUnhandledError returns JSON for API requests', () => {
  const res = createMockResponse();

  sendUnhandledError(new Error('Boom'), { path: '/api/users', originalUrl: '/api/users' }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Boom'
  });
});
