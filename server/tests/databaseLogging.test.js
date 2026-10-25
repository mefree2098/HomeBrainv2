const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const mongoose = require('mongoose');
const Device = require('../models/Device');
const dbInit = require('../models/init');
const { describeDatabaseError } = require('../utils/databaseLogging');

const fixtureSecret = 'logging-fixture-credential';
const fixtureUri = `mongodb://fixture-user:${fixtureSecret}@localhost:27017/fixture?authSource=admin`;

function capture(t) {
  const output = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => output.push(util.format(...args)));
  const old = process.env.DATABASE_URL;
  process.env.DATABASE_URL = fixtureUri;
  t.after(() => { if (old === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = old; });
  return output;
}

test('database bootstrap connects without logging its credential-bearing URI', async (t) => {
  const output = capture(t);
  t.mock.method(mongoose, 'connect', async (uri) => { assert.equal(uri, fixtureUri); });
  t.mock.method(Device.collection, 'createIndex', async () => {});
  await dbInit();
  assert.match(output.join('\n'), /Connected to MongoDB/);
  for (const secret of [fixtureSecret, fixtureUri, 'fixture-user']) assert.equal(output.join('\n').includes(secret), false);
});

test('database bootstrap errors and caller-visible exceptions omit driver secrets and causes', async (t) => {
  const output = capture(t);
  const original = new Error(`Cannot connect to ${fixtureUri}`, { cause: new Error(fixtureSecret) });
  original.name = 'MongoServerError'; original.code = 18;
  t.mock.method(mongoose, 'connect', async () => { throw original; });
  await assert.rejects(dbInit(), (error) => {
    assert.equal(error.name, 'DatabaseConnectionError');
    assert.equal(error.code, 18);
    assert.equal(error.cause, undefined);
    const rendered = output.join('\n') + util.inspect(error);
    for (const secret of [fixtureSecret, fixtureUri, 'fixture-user']) assert.equal(rendered.includes(secret), false);
    assert.match(rendered, /MongoServerError \(code 18\)/);
    return true;
  });
});

test('database error descriptions accept only fixed names and numeric codes', () => {
  assert.equal(describeDatabaseError({ name: fixtureUri, message: fixtureSecret, code: fixtureSecret }), 'DatabaseError');
  assert.equal(describeDatabaseError({ name: 'MongoNetworkError', message: fixtureUri, cause: new Error(fixtureSecret) }), 'MongoNetworkError');
});
