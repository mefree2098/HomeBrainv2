'use strict';

// Serial-port discovery and Zigbee/Z-Wave adapter scoring, extracted from
// directRadioService.js (Phase 5b). Pure detection logic; no engine state.

const fs = require('fs');
const path = require('path');
const os = require('os');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const FALLBACK_SERIAL_DEVICE_PATTERNS = [
  /^ttyUSB\d+$/i,
  /^ttyACM\d+$/i
];

function resolveLocalSerialById() {
  const byIdDir = '/dev/serial/by-id';
  try {
    return fs.readdirSync(byIdDir)
      .map((entry) => {
        const stablePath = path.join(byIdDir, entry);
        let realPath = '';
        try {
          realPath = fs.realpathSync(stablePath);
        } catch (_error) {
          realPath = '';
        }

        return {
          stablePath,
          realPath,
          label: entry
        };
      });
  } catch (_error) {
    return [];
  }
}

function resolveRealPath(serialPath) {
  const normalizedPath = trimString(serialPath);
  if (!normalizedPath) {
    return '';
  }

  try {
    return fs.realpathSync(normalizedPath);
  } catch (_error) {
    return normalizedPath;
  }
}

function buildFallbackSerialPort(pathValue, stableLink = null) {
  const resolvedPath = resolveRealPath(pathValue);
  const stablePath = trimString(stableLink?.stablePath);
  const label = trimString(stableLink?.label) || (stablePath ? path.basename(stablePath) : path.basename(pathValue));

  return {
    path: resolvedPath || pathValue,
    pnpId: label,
    friendlyName: label,
    description: label,
    stablePath,
    realPath: resolvedPath
  };
}

function hasPortCandidate(candidates, serialPath) {
  const normalizedPath = trimString(serialPath);
  if (!normalizedPath) {
    return true;
  }

  const resolvedPath = resolveRealPath(normalizedPath);
  return candidates.some((candidate) => {
    const candidatePath = trimString(candidate?.path || candidate?.comName || candidate?.device || candidate?.pnpId);
    const candidateStablePath = trimString(candidate?.stablePath);
    const candidateRealPath = resolveRealPath(candidatePath);
    return candidatePath === normalizedPath
      || candidateStablePath === normalizedPath
      || candidateRealPath === resolvedPath
      || (candidateRealPath && resolvedPath && candidateRealPath === resolvedPath);
  });
}

function listFallbackSerialDevicePaths() {
  try {
    return fs.readdirSync('/dev')
      .filter((fileName) => FALLBACK_SERIAL_DEVICE_PATTERNS.some((pattern) => pattern.test(fileName)))
      .map((fileName) => path.join('/dev', fileName))
      .sort((left, right) => left.localeCompare(right));
  } catch (_error) {
    return [];
  }
}

function addFallbackSerialPortCandidates(rawPorts = [], stableLinks = resolveLocalSerialById()) {
  const candidates = Array.isArray(rawPorts) ? [...rawPorts] : [];

  stableLinks.forEach((stableLink) => {
    const candidatePath = stableLink.realPath || stableLink.stablePath;
    if (candidatePath && !hasPortCandidate(candidates, candidatePath)) {
      candidates.push(buildFallbackSerialPort(candidatePath, stableLink));
    }
  });

  listFallbackSerialDevicePaths().forEach((serialPath) => {
    if (!hasPortCandidate(candidates, serialPath)) {
      const stableLink = stableLinks.find((entry) => entry.realPath && resolveRealPath(serialPath) === entry.realPath);
      candidates.push(buildFallbackSerialPort(serialPath, stableLink || null));
    }
  });

  return candidates;
}

function normalizeSerialPort(rawPort = {}, stableLinks = resolveLocalSerialById()) {
  const pathValue = trimString(rawPort.path || rawPort.comName || rawPort.device || rawPort.pnpId);
  let realPath = '';
  if (pathValue) {
    try {
      realPath = fs.realpathSync(pathValue);
    } catch (_error) {
      realPath = pathValue;
    }
  }

  const stableMatch = stableLinks.find((entry) => (
    entry.stablePath === pathValue
      || (entry.realPath && realPath && entry.realPath === realPath)
      || (entry.realPath && pathValue && entry.realPath.endsWith(path.basename(pathValue)))
  ));
  const stablePath = stableMatch?.stablePath || '';
  const text = [
    rawPort.manufacturer,
    rawPort.vendorId,
    rawPort.productId,
    rawPort.serialNumber,
    rawPort.pnpId,
    rawPort.locationId,
    rawPort.friendlyName,
    rawPort.product,
    rawPort.description,
    stableMatch?.label,
    stablePath,
    pathValue
  ].map(trimString).filter(Boolean).join(' ').toLowerCase();

  return {
    path: stablePath || pathValue,
    rawPath: pathValue,
    stablePath: stablePath || null,
    realPath: realPath || null,
    manufacturer: rawPort.manufacturer || null,
    vendorId: rawPort.vendorId || null,
    productId: rawPort.productId || null,
    serialNumber: rawPort.serialNumber || null,
    pnpId: rawPort.pnpId || null,
    friendlyName: rawPort.friendlyName || rawPort.product || rawPort.description || null,
    descriptor: text
  };
}

function serialDescriptorSearchText(port = {}) {
  const descriptor = trimString(port?.descriptor).toLowerCase();
  return `${descriptor} ${descriptor.replace(/[_-]+/g, ' ')}`;
}

function enrichSerialPortForDirectRadios(port) {
  const zigbeeScore = scorePortForProtocol(port, 'zigbee');
  const zwaveScore = scorePortForProtocol(port, 'zwave');
  const likelyZigbee = zigbeeScore >= 8;
  const likelyZWave = zwaveScore >= 8;
  const likelyThread = looksLikeSonoffMg24ThreadStick(port);
  const preferredProtocol = Math.max(zigbeeScore, zwaveScore) > 0
    ? (zigbeeScore > zwaveScore
      ? 'zigbee'
      : zwaveScore > zigbeeScore
        ? 'zwave'
        : null)
    : null;

  return {
    ...port,
    scores: {
      zigbee: zigbeeScore,
      zwave: zwaveScore
    },
    likelyZigbee,
    likelyZWave,
    likelyThread,
    preferredProtocol
  };
}

function looksLikeSonoffMg24ThreadStick(port = {}) {
  const descriptor = serialDescriptorSearchText(port);
  const vendorId = trimString(port?.vendorId).toLowerCase();
  const productId = trimString(port?.productId).toLowerCase();
  return /(?:^|[^a-z0-9])(?:mg24|pmg24|dongle[-_ ]?m|dongle[-_ ]?plus[-_ ]?mg24|efr32mg24)(?=$|[^a-z0-9])/.test(descriptor)
    && (
      /\b(?:sonoff|itead|silicon labs|cp210)\b/.test(descriptor)
        || (vendorId === '10c4' && productId === 'ea60')
    );
}

function scorePortForProtocol(port, protocol) {
  const descriptor = serialDescriptorSearchText(port);
  const vendorId = trimString(port?.vendorId).toLowerCase();
  const productId = trimString(port?.productId).toLowerCase();
  const isThreadCapableMg24 = looksLikeSonoffMg24ThreadStick(port);
  let score = 0;

  if (protocol === 'zigbee') {
    if (/\b(?:zbdongle|zbdongle-p|zbdongle p|zigbee|cc2652|cc1352|z-stack|z stack|zstack)\b/.test(descriptor)) score += 12;
    if (/\b(?:sonoff|itead)\b/.test(descriptor) && /\b(?:zigbee|zbdongle|cc2652|cc1352)\b/.test(descriptor)) score += 2;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (isThreadCapableMg24) score -= 10;
    if (/\b(?:z-wave|z wave|zwave|zst39|zooz|700 series|800 series|uzb)\b/.test(descriptor)) score -= 8;
  } else if (protocol === 'zwave') {
    if (/\b(?:z-wave|z wave|zwave|zst39|zooz|800 series|700 series|uzb|serialapi|serial api)\b/.test(descriptor)) score += 12;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (isThreadCapableMg24) score -= 6;
    if (/\b(?:sonoff|itead|zbdongle|zigbee|cc2652|cc1352|z-stack|z stack|zstack)\b/.test(descriptor)) score -= 8;
  }

  return score;
}

function choosePortForProtocol(ports, protocol, usedPaths = new Set()) {
  const ranked = ports
    .filter((port) => port.path && !usedPaths.has(port.path))
    .map((port) => ({ port, score: scorePortForProtocol(port, protocol) }))
    .sort((left, right) => right.score - left.score);

  const strong = ranked.find((entry) => entry.score >= 8);
  if (strong) {
    return strong.port;
  }

  const weak = ranked.find((entry) => entry.score > 0);
  if (weak && ranked.length === 1) {
    return weak.port;
  }

  if (ranked.length === 1 && /linux/i.test(os.type())) {
    return ranked[0].port;
  }

  return null;
}

function describeSerialEndpoints(ports = []) {
  const visible = ports
    .map((port) => trimString(port?.path || port?.stablePath || port?.rawPath || port?.realPath))
    .filter(Boolean);

  if (visible.length === 0) {
    return 'no serial endpoints';
  }

  const preview = visible.slice(0, 6).join(', ');
  return visible.length > 6
    ? `${preview}, and ${visible.length - 6} more`
    : preview;
}

module.exports = {
  resolveLocalSerialById,
  resolveRealPath,
  buildFallbackSerialPort,
  hasPortCandidate,
  listFallbackSerialDevicePaths,
  addFallbackSerialPortCandidates,
  normalizeSerialPort,
  serialDescriptorSearchText,
  enrichSerialPortForDirectRadios,
  looksLikeSonoffMg24ThreadStick,
  scorePortForProtocol,
  choosePortForProtocol,
  describeSerialEndpoints
};
