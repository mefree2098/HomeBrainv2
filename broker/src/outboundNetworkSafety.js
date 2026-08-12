const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const CLOUD_METADATA_HOSTNAMES = new Set([
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.google.internal'
]);

const CLOUD_METADATA_ADDRESSES = new Set([
  '100.100.100.200',
  '169.254.169.254',
  '169.254.170.2',
  'fd00:ec2::254'
]);

const NON_PUBLIC_IPV4_ADDRESSES = new net.BlockList();
[
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
].forEach(([address, prefix]) => NON_PUBLIC_IPV4_ADDRESSES.addSubnet(address, prefix, 'ipv4'));
const NON_PUBLIC_IPV6_ADDRESSES = new net.BlockList();
[
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
].forEach(([address, prefix]) => NON_PUBLIC_IPV6_ADDRESSES.addSubnet(address, prefix, 'ipv6'));

function normalizeHostname(value) {
  let normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, '').split('%')[0];
}

function isCloudMetadataHostname(value) {
  const normalized = normalizeHostname(value);
  return CLOUD_METADATA_HOSTNAMES.has(normalized) || CLOUD_METADATA_ADDRESSES.has(normalized);
}

function isPublicAddress(value) {
  const normalized = normalizeHostname(value);
  const family = net.isIP(normalized);
  if (family === 4) {
    return !NON_PUBLIC_IPV4_ADDRESSES.check(normalized, 'ipv4');
  }
  if (family === 6) {
    return !NON_PUBLIC_IPV6_ADDRESSES.check(normalized, 'ipv6');
  }
  return false;
}

function isPermittedAddress(value, { allowPrivate = false } = {}) {
  const normalized = normalizeHostname(value);
  if (!net.isIP(normalized) || isCloudMetadataHostname(normalized)) {
    return false;
  }
  return allowPrivate || isPublicAddress(normalized);
}

function normalizeResolvedAddresses(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => {
      if (typeof record === 'string') {
        return { address: record, family: net.isIP(record) };
      }
      const address = String(record?.address || '');
      return {
        address,
        family: Number(record?.family || net.isIP(address))
      };
    })
    .filter((record) => record.address && (record.family === 4 || record.family === 6));
}

function createValidatedLookup(hostname, options = {}) {
  const expectedHostname = normalizeHostname(hostname);
  const allowPrivate = options.allowPrivate === true;
  const resolver = options.lookup || dns.lookup;

  if (!expectedHostname) {
    throw new Error('Outbound request hostname is required');
  }
  if (isCloudMetadataHostname(expectedHostname)) {
    throw new Error('Outbound request must not target a cloud metadata service');
  }

  return (requestedHostname, lookupOptions, callback) => {
    if (normalizeHostname(requestedHostname) !== expectedHostname) {
      callback(new Error('Outbound request hostname changed after validation'));
      return;
    }

    const finish = (error, records) => {
      if (error) {
        callback(error);
        return;
      }

      const addresses = normalizeResolvedAddresses(records);
      if (addresses.length === 0) {
        callback(new Error(`No IP addresses resolved for ${expectedHostname}`));
        return;
      }
      if (addresses.some((record) => !isPermittedAddress(record.address, { allowPrivate }))) {
        callback(new Error(`${expectedHostname} resolved outside the permitted network`));
        return;
      }

      const requestedFamily = Number(lookupOptions?.family || 0);
      const compatible = requestedFamily === 4 || requestedFamily === 6
        ? addresses.filter((record) => record.family === requestedFamily)
        : addresses;
      if (compatible.length === 0) {
        callback(new Error(`No compatible IP addresses resolved for ${expectedHostname}`));
        return;
      }

      if (lookupOptions?.all === true) {
        callback(null, compatible);
        return;
      }
      callback(null, compatible[0].address, compatible[0].family);
    };

    if (net.isIP(expectedHostname)) {
      queueMicrotask(() => finish(null, [{
        address: expectedHostname,
        family: net.isIP(expectedHostname)
      }]));
      return;
    }

    resolver(expectedHostname, { all: true, verbatim: true }, finish);
  };
}

function createOutboundAgents(value, options = {}) {
  const parsed = value instanceof URL ? value : new URL(String(value || ''));
  const hostname = normalizeHostname(parsed.hostname);
  if (net.isIP(hostname) && !isPermittedAddress(hostname, options)) {
    throw new Error(`${hostname} is outside the permitted network`);
  }
  const lookup = createValidatedLookup(parsed.hostname, options);
  return {
    // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server -- HTTP is accepted only for an explicitly enabled private/LAN hub; public hubs must use HTTPS.
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup, rejectUnauthorized: true })
  };
}

module.exports = {
  createOutboundAgents,
  createValidatedLookup,
  isCloudMetadataHostname,
  isPermittedAddress,
  isPublicAddress,
  normalizeHostname
};
