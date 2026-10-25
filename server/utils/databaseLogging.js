const ERROR_NAMES = new Set([
  'Error', 'MongoError', 'MongoServerError', 'MongoNetworkError',
  'MongoNetworkTimeoutError', 'MongoParseError', 'MongoServerSelectionError',
  'MongooseServerSelectionError', 'MongoTopologyClosedError'
]);

function describeDatabaseError(error) {
  // Driver messages, stacks and nested causes can contain connection secrets.
  const name = ERROR_NAMES.has(error?.name) ? error.name : 'DatabaseError';
  return Number.isSafeInteger(error?.code) ? `${name} (code ${error.code})` : name;
}

module.exports = { describeDatabaseError };
