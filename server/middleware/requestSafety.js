const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBJECT_DEPTH = 40;
const MAX_OBJECT_NODES = 100_000;

function findUnsafeRequestKey(value, state = null, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return null;
  }

  const context = state || { seen: new WeakSet(), nodes: 0 };
  if (context.seen.has(value)) {
    return null;
  }
  context.seen.add(value);
  context.nodes += 1;

  if (depth > MAX_OBJECT_DEPTH || context.nodes > MAX_OBJECT_NODES) {
    return '[request-too-complex]';
  }

  for (const key of Object.keys(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key) || key.startsWith('$')) {
      return key;
    }
    const nestedUnsafeKey = findUnsafeRequestKey(value[key], context, depth + 1);
    if (nestedUnsafeKey) {
      return nestedUnsafeKey;
    }
  }

  return null;
}

function rejectUnsafeRequestKeys(req, res, next) {
  const unsafeKey = [req.body, req.query, req.params]
    .map((value) => findUnsafeRequestKey(value))
    .find(Boolean);

  if (unsafeKey) {
    return res.status(400).json({
      success: false,
      message: unsafeKey === '[request-too-complex]'
        ? 'Request structure is too complex.'
        : 'Request contains an unsafe object key.'
    });
  }

  return next();
}

module.exports = {
  findUnsafeRequestKey,
  rejectUnsafeRequestKeys
};
