'use strict';

/**
 * The unmaintained home-controller package uses a very small subset of Q.
 * Keeping that surface here lets it run on native promises without installing
 * Q or changing home-controller's public callback-and-promise behavior.
 */
class QCompatiblePromise extends Promise {
  nodeify(callback) {
    if (typeof callback !== 'function') {
      return this;
    }

    this.then(
      (value) => callback(null, value),
      (error) => callback(error)
    );
    return undefined;
  }

  delay(timeoutMs) {
    const delayMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Number(timeoutMs))
      : 0;

    return this.then((value) => new QCompatiblePromise((resolve) => {
      setTimeout(resolve, delayMs, value);
    }));
  }
}

function defer() {
  let resolve;
  let reject;
  const promise = new QCompatiblePromise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function fcall(callback, ...args) {
  return QCompatiblePromise.resolve().then(() => callback(...args));
}

module.exports = {
  Promise: QCompatiblePromise,
  all: (values) => QCompatiblePromise.all(values),
  defer,
  fcall,
  reject: (reason) => QCompatiblePromise.reject(reason),
  resolve: (value) => QCompatiblePromise.resolve(value)
};
