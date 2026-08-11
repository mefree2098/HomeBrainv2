const assert = require('node:assert/strict');
const test = require('node:test');

const weatherRouter = require('../routes/weatherRoutes');
const { getWeatherInput, requireLegacyWeatherClient } = weatherRouter.__private__;

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

test('weather input uses POST bodies while retaining query input for installed clients', () => {
  assert.deepEqual(getWeatherInput({ method: 'POST', body: { latitude: 40 } }), { latitude: 40 });
  assert.deepEqual(getWeatherInput({ method: 'GET', query: { latitude: '40' } }), { latitude: '40' });
});

test('legacy weather GET compatibility is limited to identified installed or open clients', () => {
  for (const clientType of ['ios', 'watchos', 'web']) {
    const response = createResponse();
    let continued = false;
    requireLegacyWeatherClient(
      { get: () => clientType },
      response,
      () => { continued = true; }
    );
    assert.equal(continued, true);
    assert.equal(response.headers.Deprecation, 'true');
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
  }

  const response = createResponse();
  let continued = false;
  requireLegacyWeatherClient(
    { get: () => 'unknown' },
    response,
    () => { continued = true; }
  );
  assert.equal(continued, false);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'POST');
});
