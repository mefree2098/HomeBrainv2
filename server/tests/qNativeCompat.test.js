const test = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../vendor/q-native-compat');

test('Q compatibility promises preserve chaining and nodeify success callbacks', async () => {
  const deferred = Q.defer();
  const chained = deferred.promise.then((value) => value + 1);

  const callbackResult = new Promise((resolve, reject) => {
    const nodeifyResult = chained.nodeify((error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
    assert.equal(nodeifyResult, undefined);
  });

  deferred.resolve(41);
  assert.equal(await chained, 42);
  assert.equal(await callbackResult, 42);
});

test('Q compatibility nodeify forwards rejections and returns itself without a callback', async () => {
  const error = new Error('expected failure');
  const rejected = Q.reject(error);
  assert.equal(rejected.nodeify(), rejected);

  const callbackError = await new Promise((resolve) => {
    rejected.nodeify((receivedError) => resolve(receivedError));
  });
  assert.equal(callbackError, error);
});

test('Q compatibility supports fcall, assimilation, and value-preserving delay', async () => {
  assert.equal(await Q.fcall((left, right) => left + right, 20, 22), 42);

  const deferred = Q.defer();
  deferred.resolve(Promise.resolve('assimilated'));
  assert.equal(await deferred.promise.delay(1), 'assimilated');
});
