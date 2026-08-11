const net = require('net');

const DEFAULT_MAX_URL_LENGTH = 2048;

function trimTrailingSlashes(value) {
  const text = String(value || '');
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') {
    end -= 1;
  }
  return text.slice(0, end);
}

function trimLeadingSlashes(value) {
  const text = String(value || '');
  let start = 0;
  while (start < text.length && text[start] === '/') {
    start += 1;
  }
  return text.slice(start);
}

function normalizeHostname(hostname) {
  let normalized = String(hostname || '').trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

function isPrivateIpv6(hostname) {
  return hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:');
}

function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  return normalized === '::1' || normalized.startsWith('127.');
}

function isCloudMetadataHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return normalized === '169.254.169.254'
    || normalized === '169.254.170.2'
    || normalized === '100.100.100.200'
    || normalized === 'metadata.google.internal'
    || normalized === 'metadata.google.internal.';
}

function isAllowedLocalHostname(hostname, { allowPublic = false } = {}) {
  if (allowPublic) {
    return true;
  }

  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  if (isLoopbackHostname(normalized) || normalized.endsWith('.local')) {
    return true;
  }
  if (!normalized.includes('.') && !normalized.includes(':')) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }
  return false;
}

function parseHttpUrl(value, label = 'URL', options = {}) {
  const {
    defaultProtocol = '',
    maxLength = DEFAULT_MAX_URL_LENGTH,
    allowCredentials = false,
    allowHash = false
  } = options;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long`);
  }

  const withProtocol = defaultProtocol && !trimmed.includes('://')
    ? `${defaultProtocol}://${trimmed}`
    : trimmed;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (_error) {
    throw new Error(`${label} must be a valid HTTP URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (!allowCredentials && (parsed.username || parsed.password)) {
    throw new Error(`${label} must not include credentials in the URL`);
  }
  if (!allowHash) {
    parsed.hash = '';
  }
  return parsed;
}

function parseLocalHttpUrl(value, label = 'URL', options = {}) {
  const parsed = parseHttpUrl(value, label, {
    defaultProtocol: 'http',
    ...options
  });
  const allowPublic = options.allowPublic === true
    || String(process.env.HOMEBRAIN_ALLOW_PUBLIC_LOCAL_PROVIDERS || '').toLowerCase() === 'true';
  if (isCloudMetadataHostname(parsed.hostname)) {
    throw new Error(`${label} must not target a cloud metadata service`);
  }
  if (!isAllowedLocalHostname(parsed.hostname, { allowPublic })) {
    throw new Error(`${label} must target a local or private network host`);
  }
  return parsed;
}

function appendUrlPath(baseUrl, suffix) {
  const parsed = baseUrl instanceof URL ? new URL(baseUrl.toString()) : parseHttpUrl(baseUrl);
  const basePath = trimTrailingSlashes(parsed.pathname || '/');
  const nextSegment = trimLeadingSlashes(suffix);
  parsed.pathname = `${basePath === '/' ? '' : basePath}/${nextSegment}`;
  parsed.hash = '';
  return parsed;
}

function parseServiceOrigin(value, label = 'Service URL', options = {}) {
  const parsed = parseHttpUrl(value, label, options);
  if (parsed.protocol !== 'https:' && !isAllowedLocalHostname(parsed.hostname)) {
    throw new Error(`${label} must use https unless it targets a local or private host`);
  }
  return parsed.origin;
}

function buildSameOriginUrl(pathOrUrl, baseUrl, label = 'URL') {
  const base = parseHttpUrl(baseUrl, `${label} base`);
  const resolved = new URL(String(pathOrUrl || ''), `${trimTrailingSlashes(base.toString())}/`);
  if (resolved.origin !== base.origin) {
    throw new Error(`${label} must use the configured service origin`);
  }
  if (resolved.username || resolved.password) {
    throw new Error(`${label} must not include credentials in the URL`);
  }
  resolved.hash = '';
  return resolved;
}

module.exports = {
  appendUrlPath,
  buildSameOriginUrl,
  isAllowedLocalHostname,
  isCloudMetadataHostname,
  isLoopbackHostname,
  isPrivateIpv4,
  isPrivateIpv6,
  normalizeHostname,
  parseHttpUrl,
  parseLocalHttpUrl,
  parseServiceOrigin,
  trimLeadingSlashes,
  trimTrailingSlashes
};
