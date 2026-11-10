const SECRET_KEY = /authorization|password|passwd|secret|token|api.?key|cookie|private.?key/i;
const PRIVATE_HTTP_FIELDS = new Set(['url', 'headers', 'basicAuth', 'auth', 'body', 'data', 'query']);

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"<>]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        let changed = Boolean(url.username || url.password);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        for (const key of url.searchParams.keys()) {
          if (SECRET_KEY.test(key)) { url.searchParams.set(key, '[REDACTED]'); changed = true; }
        }
        return changed ? url.toString() : candidate;
      } catch { return candidate; }
    });
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== 'object' || value instanceof Date) return value;
  if (typeof value.toObject === 'function') value = value.toObject();
  if (value._bsontype === 'ObjectId') return value.toString();
  const http = value.type === 'http_request' || value.actionType === 'http_request';
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (http && key === 'target') return [key, '[HTTP endpoint stored securely]'];
    if (http && ['message', 'error'].includes(key) && typeof entry === 'string') {
      return [key, entry.replace(/https?:\/\/[^\s"<>]+/gi, (url) => { try { return new URL(url).origin; } catch { return '[HTTP endpoint]'; } })];
    }
    if (SECRET_KEY.test(key) && key !== 'credentialRef') return [key, '[REDACTED]'];
    if (http && key === 'parameters' && entry && typeof entry === 'object') {
      return [key, Object.fromEntries(Object.entries(entry).map(([name, field]) => [
        name, PRIVATE_HTTP_FIELDS.has(name) ? '[REDACTED]' : redactSecrets(field)
      ]))];
    }
    return [key, redactSecrets(entry)];
  }));
}

function redactJsonResponses(_req, res, next) {
  const json = res.json.bind(res);
  res.json = (value) => json(redactSecrets(value));
  next();
}

module.exports = { redactSecrets, redactJsonResponses, PRIVATE_HTTP_FIELDS };
