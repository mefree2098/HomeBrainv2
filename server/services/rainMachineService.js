const axios = require('axios');
const dgram = require('dgram');
const https = require('https');
const Device = require('../models/Device');
const RainMachineIntegration = require('../models/RainMachineIntegration');
const RainMachineDailyStat = require('../models/RainMachineDailyStat');
const RainMachineWateringDay = require('../models/RainMachineWateringDay');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const telemetryService = require('./telemetryService');
const {
  buildRainMachineControllerIdentityQuery,
  buildRainMachineZoneIdentityQuery,
  selectCanonicalDevice,
  mergeDuplicateDeviceGroups,
  describeDevices
} = require('./deviceIdentityService');

const DEFAULT_HTTP_TIMEOUT_MS = Math.max(4000, Number(process.env.RAINMACHINE_HTTP_TIMEOUT_MS || 12000));
const DEFAULT_POLL_INTERVAL_MINUTES = Math.max(1, Number(process.env.RAINMACHINE_POLL_INTERVAL_MINUTES || 5));
const DEFAULT_REPORT_SYNC_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.RAINMACHINE_REPORT_SYNC_INTERVAL_MS || 12 * 60 * 60 * 1000)
);
const DEFAULT_WATERING_LOG_DAYS = Math.max(1, Number(process.env.RAINMACHINE_WATERING_LOG_DAYS || 30));
const DEFAULT_DISCOVERY_TIMEOUT_MS = Math.max(1000, Number(process.env.RAINMACHINE_DISCOVERY_TIMEOUT_MS || 2500));
const DISCOVERY_PORT = 15800;
const DISCOVERY_RESPONSE_PORT = 15900;
const MAX_ZONE_DURATION_SECONDS = 6 * 60 * 60;
const MAX_RAIN_DELAY_DAYS = 30;
const ZONE_STATE = Object.freeze({
  idle: 0,
  running: 1,
  pending: 2
});
const PROGRAM_STATUS = Object.freeze({
  idle: 0,
  running: 1,
  pending: 2
});

const trimString = (value, fallback = '') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (value == null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed || fallback;
};

const normalizeProtocol = (value, fallback = 'https') => (
  trimString(value, fallback).toLowerCase() === 'http' ? 'http' : 'https'
);

const clampInteger = (value, fallback, minimum, maximum) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const rounded = Math.trunc(numeric);
  return Math.max(minimum, Math.min(maximum, rounded));
};

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const roundNumber = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
};

const normalizeHost = (value) => {
  let host = trimString(value);
  if (!host) {
    return '';
  }

  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '');

  if (host.includes('/')) {
    [host] = host.split('/');
  }

  const bracketedIpv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1].trim().toLowerCase();
  }

  const colonCount = (host.match(/:/g) || []).length;
  if (colonCount === 1 && host.includes(':')) {
    const [hostname, port] = host.split(':');
    if (/^\d+$/.test(port)) {
      host = hostname;
    }
  }

  return host.trim().toLowerCase();
};

function parseHostInput(value, fallbackProtocol = 'https', fallbackPort = 8080) {
  const raw = trimString(value);
  if (!raw) {
    return {
      host: '',
      protocol: normalizeProtocol(fallbackProtocol),
      port: fallbackPort
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return {
        host: normalizeHost(parsed.hostname),
        protocol: normalizeProtocol(parsed.protocol.replace(':', ''), fallbackProtocol),
        port: clampInteger(parsed.port, fallbackPort, 1, 65535)
      };
    } catch (_error) {
      // Fall through to relaxed parsing.
    }
  }

  const protocol = normalizeProtocol(
    raw.startsWith('http://') ? 'http' : raw.startsWith('https://') ? 'https' : fallbackProtocol,
    fallbackProtocol
  );
  const normalizedHost = normalizeHost(raw);
  const hostSegment = trimString(raw)
    .replace(/^https?:\/\//i, '')
    .split('/')[0];
  const portMatch = hostSegment.match(/:(\d+)$/);
  const port = clampInteger(
    portMatch?.[1],
    fallbackPort,
    1,
    65535
  );

  return {
    host: normalizedHost,
    protocol,
    port
  };
}

const mostRecentDate = (...values) => {
  let latest = null;

  values.forEach((value) => {
    if (!value) {
      return;
    }

    const candidate = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(candidate.getTime())) {
      return;
    }

    if (!latest || candidate > latest) {
      latest = candidate;
    }
  });

  return latest;
};

const toIsoDate = (value) => {
  if (!value) {
    return '';
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toISOString().slice(0, 10);
};

const parseDayDate = (value) => {
  const day = toIsoDate(value);
  if (!day) {
    return null;
  }

  const parsed = new Date(`${day}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const safeArray = (value) => Array.isArray(value) ? value : [];

const asPlainObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const getNested = (input, path) => {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  return path.split('.').reduce((acc, segment) => {
    if (acc == null || typeof acc !== 'object') {
      return undefined;
    }
    return acc[segment];
  }, input);
};

const coerceJson = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return value;
  }
};

const buildRequestPayload = (data) => {
  if (data === undefined) {
    return {
      payload: undefined,
      headers: {}
    };
  }

  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    return {
      payload: data,
      headers: {
        'Content-Type': 'text/plain'
      }
    };
  }

  return {
    payload: JSON.stringify(data),
    headers: {
      'Content-Type': 'application/json'
    }
  };
};

const ensureApiSuccess = (payload, path) => {
  const body = coerceJson(payload);

  if (!body || typeof body !== 'object') {
    return body;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'statusCode')) {
    const statusCode = Number(body.statusCode);
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      const message = trimString(body.message, trimString(body.statusText, `RainMachine API error on ${path}`));
      const error = new Error(message || `RainMachine API error on ${path}`);
      error.statusCode = statusCode;
      throw error;
    }
  }

  return body;
};

const findFirstArray = (payload, candidateKeys = []) => {
  if (Array.isArray(payload)) {
    return payload;
  }

  const body = asPlainObject(payload);
  for (const key of candidateKeys) {
    const value = getNested(body, key);
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
};

const isActiveRainMachineState = (value) => {
  const normalized = trimString(value).toLowerCase();
  return normalized === 'running' || normalized === 'pending';
};

const snapshotShowsActiveZone = (snapshot, zoneId) => {
  const normalizedZoneId = trimString(zoneId);
  if (!normalizedZoneId) {
    return false;
  }

  const body = asPlainObject(snapshot);
  const activeZone = asPlainObject(body?.runtime?.activeZone);
  const activeZoneId = pickFirstNumber(activeZone.uid, activeZone.id, activeZone.zoneId, activeZone.valveId);
  if (activeZoneId !== null && String(activeZoneId) === normalizedZoneId && isActiveRainMachineState(activeZone.stateLabel)) {
    return true;
  }

  return safeArray(body?.zones).some((entry) => {
    const item = asPlainObject(entry);
    const entryZoneId = pickFirstNumber(item.uid, item.id, item.zoneId, item.valveId);
    return entryZoneId !== null
      && String(entryZoneId) === normalizedZoneId
      && isActiveRainMachineState(item.stateLabel);
  });
};

const normalizeZoneStateLabel = (state) => {
  switch (Number(state)) {
    case ZONE_STATE.running:
      return 'running';
    case ZONE_STATE.pending:
      return 'pending';
    default:
      return 'idle';
  }
};

const normalizeProgramStatusLabel = (status) => {
  switch (Number(status)) {
    case PROGRAM_STATUS.running:
      return 'running';
    case PROGRAM_STATUS.pending:
      return 'pending';
    default:
      return 'idle';
  }
};

const booleanFromValue = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value > 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'running', 'pending', 'active'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off', 'idle', 'inactive'].includes(normalized)) {
      return false;
    }
  }

  return false;
};

const pickFirstString = (...values) => {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
};

const pickFirstNumber = (...values) => {
  for (const value of values) {
    const numeric = toNumber(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
};

const sumNumbers = (values = []) => values.reduce((sum, value) => (
  Number.isFinite(Number(value)) ? sum + Number(value) : sum
), 0);

function normalizeWateringTime(entry = {}) {
  const item = asPlainObject(entry);
  return {
    id: pickFirstNumber(item.id, item.uid, item.zoneId),
    active: booleanFromValue(item.active),
    order: pickFirstNumber(item.order, item.index),
    durationSeconds: pickFirstNumber(item.duration, item.time, item.seconds, item.wateringTime)
  };
}

function normalizePrograms(rawPrograms = [], nextRunMap = {}) {
  return safeArray(rawPrograms).map((program) => {
    const item = asPlainObject(program);
    const wateringTimes = safeArray(item.wateringTimes)
      .map((entry) => normalizeWateringTime(entry))
      .filter((entry) => entry.id !== null);
    const programId = pickFirstNumber(item.uid, item.id);
    const mergedNextRun = pickFirstString(
      nextRunMap[String(programId || '')]?.nextRun,
      item.nextRun
    );

    return {
      uid: programId,
      name: pickFirstString(item.name, `Program ${programId || ''}`),
      active: booleanFromValue(item.active),
      status: pickFirstNumber(item.status) ?? 0,
      statusLabel: normalizeProgramStatusLabel(item.status),
      nextRun: mergedNextRun || null,
      startTime: pickFirstString(item.startTime, ''),
      frequencyType: pickFirstNumber(item.frequency?.type, item.frequencyType, item.freqType),
      frequencyParam: pickFirstString(item.frequency?.param, item.frequencyParam, item.freqParam),
      cycles: pickFirstNumber(item.cycles, item.noOfCycles) ?? 0,
      soak: pickFirstNumber(item.soak) ?? 0,
      delay: pickFirstNumber(item.delay) ?? 0,
      ignoreInternetWeather: booleanFromValue(item.ignoreInternetWeather),
      useWaterSense: booleanFromValue(item.useWaterSense),
      totalConfiguredDurationSeconds: sumNumbers(wateringTimes
        .filter((entry) => entry.active)
        .map((entry) => entry.durationSeconds)),
      zoneIds: wateringTimes
        .filter((entry) => entry.active && entry.id !== null)
        .map((entry) => entry.id),
      wateringTimes
    };
  });
}

function buildProgramNextRunMap(rawNextRuns = [], programs = []) {
  const map = {};
  const nextRuns = safeArray(rawNextRuns);

  nextRuns.forEach((entry) => {
    const item = asPlainObject(entry);
    const programId = pickFirstNumber(item.uid, item.id, item.programId);
    const nextRun = pickFirstString(item.nextRun, item.date);
    if (programId === null || !nextRun) {
      return;
    }

    map[String(programId)] = {
      programId,
      nextRun
    };
  });

  safeArray(programs).forEach((program) => {
    const item = asPlainObject(program);
    const programId = pickFirstNumber(item.uid, item.id);
    const nextRun = pickFirstString(item.nextRun);
    if (programId === null || !nextRun || map[String(programId)]) {
      return;
    }

    map[String(programId)] = {
      programId,
      nextRun
    };
  });

  return map;
}

function buildZoneNextRunMap(programs = []) {
  const zoneMap = {};

  safeArray(programs).forEach((program) => {
    const nextRun = trimString(program?.nextRun);
    if (!nextRun) {
      return;
    }

    safeArray(program?.wateringTimes)
      .filter((entry) => entry.active && entry.id !== null)
      .forEach((entry) => {
        const key = String(entry.id);
        const candidateDate = parseDayDate(nextRun);
        const existingDate = parseDayDate(zoneMap[key]?.nextRun);

        if (existingDate && candidateDate && existingDate <= candidateDate) {
          return;
        }

        zoneMap[key] = {
          nextRun,
          programId: program.uid,
          programName: program.name,
          configuredDurationSeconds: entry.durationSeconds
        };
      });
  });

  return zoneMap;
}

function normalizeZones(rawZones = [], rawZoneProperties = [], zoneNextRunMap = {}) {
  const propertiesById = new Map();
  safeArray(rawZoneProperties).forEach((entry) => {
    const item = asPlainObject(entry);
    const zoneId = pickFirstNumber(item.uid, item.id, item.valveid);
    if (zoneId !== null) {
      propertiesById.set(zoneId, item);
    }
  });

  return safeArray(rawZones).map((zone) => {
    const item = asPlainObject(zone);
    const zoneId = pickFirstNumber(item.uid, item.id, item.valveid);
    const properties = zoneId !== null ? asPlainObject(propertiesById.get(zoneId)) : {};
    const nextRun = zoneNextRunMap[String(zoneId || '')] || null;

    return {
      uid: zoneId,
      valveId: pickFirstNumber(item.valveid, properties.valveid, zoneId),
      name: pickFirstString(item.name, properties.name, `Zone ${zoneId || ''}`),
      active: booleanFromValue(item.active ?? properties.active),
      master: booleanFromValue(item.master ?? properties.master),
      state: pickFirstNumber(item.state) ?? 0,
      stateLabel: normalizeZoneStateLabel(item.state),
      restriction: booleanFromValue(item.restriction),
      userDurationSeconds: pickFirstNumber(item.userDuration, item.userDurationSeconds) ?? 0,
      machineDurationSeconds: pickFirstNumber(item.machineDuration, item.computedWateringTime, item.realDuration) ?? 0,
      remainingSeconds: pickFirstNumber(item.remaining, item.remainingSeconds) ?? 0,
      cycle: pickFirstNumber(item.cycle) ?? 0,
      cycleCount: pickFirstNumber(item.noOfCycles, item.cycles) ?? 0,
      type: pickFirstNumber(properties.type, item.type),
      internet: booleanFromValue(properties.internet),
      history: booleanFromValue(properties.history),
      soil: pickFirstNumber(properties.soil),
      slope: pickFirstNumber(properties.slope),
      sun: pickFirstNumber(properties.sun),
      sprinkler: pickFirstNumber(properties.group_id, properties.groupId),
      savings: pickFirstNumber(properties.savings),
      nextRun: nextRun?.nextRun || null,
      nextRunProgramId: nextRun?.programId ?? null,
      nextRunProgramName: nextRun?.programName || '',
      nextRunDurationSeconds: nextRun?.configuredDurationSeconds ?? null,
      waterSense: asPlainObject(properties.waterSense),
      raw: {
        zone: item,
        properties
      }
    };
  });
}

function normalizeRestrictions(rawCurrently, rawGlobal, rawHourly, rawRainDelay) {
  const current = asPlainObject(rawCurrently);
  const global = asPlainObject(rawGlobal);
  const hourly = findFirstArray(rawHourly, ['hourlyRestrictions', 'restrictions', 'items']);
  const rainDelay = asPlainObject(rawRainDelay);
  const delaySeconds = pickFirstNumber(rainDelay.delayCounter, rainDelay.rainDelayCounter, global.rainDelayDuration) ?? 0;

  const currentFlags = {
    hourly: booleanFromValue(current.hourly),
    freeze: booleanFromValue(current.freeze),
    month: booleanFromValue(current.month),
    weekDay: booleanFromValue(current.weekDay),
    rainDelay: booleanFromValue(current.rainDelay),
    rainSensor: booleanFromValue(current.rainSensor),
    lastLeakDetected: booleanFromValue(current.lastLeakDetected)
  };

  return {
    currently: {
      ...currentFlags,
      activeCount: Object.values(currentFlags).filter(Boolean).length
    },
    global: {
      hotDaysExtraWatering: booleanFromValue(global.hotDaysExtraWatering),
      freezeProtectEnabled: booleanFromValue(global.freezeProtectEnabled),
      freezeProtectTemp: pickFirstNumber(global.freezeProtectTemp),
      noWaterInWeekDays: pickFirstString(global.noWaterInWeekDays),
      noWaterInMonths: pickFirstString(global.noWaterInMonths),
      rainDelayStartTime: pickFirstNumber(global.rainDelayStartTime),
      rainDelayDuration: pickFirstNumber(global.rainDelayDuration),
      carryOverInRestriction: booleanFromValue(global.carryOverInRestriction),
      maxWateringCoef: pickFirstNumber(global.maxWateringCoef)
    },
    hourly: hourly.map((entry) => {
      const item = asPlainObject(entry);
      return {
        uid: pickFirstNumber(item.uid, item.id),
        start: pickFirstNumber(item.start),
        duration: pickFirstNumber(item.duration),
        interval: pickFirstString(item.interval),
        weekDays: pickFirstString(item.weekDays, item.weekdays)
      };
    }),
    rainDelay: {
      startTime: pickFirstNumber(rainDelay.delayStartTime, rainDelay.rainDelayStartTime),
      secondsRemaining: delaySeconds,
      hoursRemaining: roundNumber(delaySeconds / 3600, 1) || 0,
      daysRemaining: roundNumber(delaySeconds / (24 * 3600), 1) || 0
    }
  };
}

function normalizeQueueEntries(rawQueue = [], zoneNameMap = {}) {
  return safeArray(rawQueue).map((entry) => {
    const item = asPlainObject(entry);
    const zoneId = pickFirstNumber(item.uid, item.id, item.zoneId, item.zoneUID);
    return {
      uid: zoneId,
      name: pickFirstString(item.name, zoneNameMap[String(zoneId || '')], `Zone ${zoneId || ''}`),
      state: pickFirstNumber(item.state) ?? 0,
      stateLabel: normalizeZoneStateLabel(item.state),
      remainingSeconds: pickFirstNumber(item.remaining, item.remainingSeconds) ?? 0,
      userDurationSeconds: pickFirstNumber(item.userDuration, item.userDurationSeconds) ?? 0,
      machineDurationSeconds: pickFirstNumber(item.machineDuration, item.realDuration, item.machineDurationSeconds) ?? 0,
      cycle: pickFirstNumber(item.cycle) ?? 0,
      cycleCount: pickFirstNumber(item.noOfCycles, item.cycles) ?? 0
    };
  });
}

function normalizeWateringPrograms(rawPrograms = [], programNameMap = {}) {
  return safeArray(rawPrograms).map((entry) => {
    const item = asPlainObject(entry);
    const programId = pickFirstNumber(item.uid, item.id, item.programId);
    return {
      uid: programId,
      name: pickFirstString(item.name, programNameMap[String(programId || '')], `Program ${programId || ''}`),
      status: pickFirstNumber(item.status) ?? 0,
      statusLabel: normalizeProgramStatusLabel(item.status),
      nextRun: pickFirstString(item.nextRun) || null
    };
  });
}

function normalizeControllerSnapshot({
  integration,
  endpoint,
  apiVer,
  provision,
  provisionWifi,
  provisionCloud,
  diag,
  zones,
  programs,
  restrictions,
  queue,
  activeZone,
  activePrograms
}) {
  const provisionData = asPlainObject(provision);
  const wifi = asPlainObject(provisionWifi);
  const cloud = asPlainObject(provisionCloud);
  const diagnostics = asPlainObject(diag);
  const system = asPlainObject(provisionData.system);
  const location = asPlainObject(provisionData.location);
  const ethernet = asPlainObject(provisionData.ethernet);
  const api = asPlainObject(apiVer);
  const resolvedControllerId = pickFirstString(
    wifi.macAddress,
    ethernet.macAddress,
    integration?.controllerId,
    endpoint.host
  );
  const resolvedControllerName = pickFirstString(
    system.netName,
    location.name,
    integration?.controllerName,
    'RainMachine'
  );
  const activeZoneEntries = queue.filter((entry) => entry.stateLabel === 'running' || entry.stateLabel === 'pending');
  const runningProgramEntries = activePrograms.length > 0
    ? activePrograms
    : programs.filter((program) => program.statusLabel === 'running' || program.statusLabel === 'pending');

  return {
    controller: {
      id: resolvedControllerId,
      name: resolvedControllerName,
      host: endpoint.host,
      protocol: endpoint.protocol,
      port: endpoint.port,
      apiVersion: pickFirstString(api.apiVer, integration?.apiVersion),
      hardwareVersion: pickFirstNumber(api.hwVer, integration?.hardwareVersion),
      softwareVersion: pickFirstString(api.swVer, integration?.softwareVersion),
      room: trimString(integration?.room, 'Irrigation'),
      network: {
        wifi: {
          mode: pickFirstString(wifi.mode),
          hasClientLink: booleanFromValue(wifi.hasClientLink),
          ipAddress: pickFirstString(wifi.ipAddress),
          macAddress: pickFirstString(wifi.macAddress),
          ssid: pickFirstString(wifi.ssid)
        },
        ethernet: {
          hasClientLink: booleanFromValue(ethernet.hasClientLink),
          ipAddress: pickFirstString(ethernet.ipAddress),
          macAddress: pickFirstString(ethernet.macAddress)
        },
        gatewayAddress: pickFirstString(diagnostics.gatewayAddress)
      },
      system: {
        netName: pickFirstString(system.netName),
        dedicatedMasterValve: booleanFromValue(system.dedicatedMasterValve),
        masterValveBefore: pickFirstNumber(system.masterValveBefore),
        masterValveAfter: pickFirstNumber(system.masterValveAfter),
        maxWateringCoef: pickFirstNumber(system.maxWateringCoef),
        carryOverInRestriction: booleanFromValue(system.carryOverInRestriction),
        useFlowSensor: booleanFromValue(system.useFlowSensor)
      },
      location: {
        name: pickFirstString(location.name),
        latitude: pickFirstNumber(location.lat, location.latitude),
        longitude: pickFirstNumber(location.lon, location.longitude),
        timezone: pickFirstString(location.timezone)
      },
      cloud: {
        enabled: booleanFromValue(cloud.enable),
        pendingEmail: pickFirstString(cloud.pendingEmail),
        email: pickFirstString(cloud.email)
      },
      diagnostics: {
        cpuUsagePct: pickFirstNumber(diagnostics.cpuUsage),
        memUsageKb: pickFirstNumber(diagnostics.memUsage),
        uptime: pickFirstString(diagnostics.uptime),
        cloudStatus: pickFirstNumber(diagnostics.cloudStatus)
      }
    },
    runtime: {
      queue,
      activeZone: activeZone || null,
      activePrograms,
      queueLength: queue.length,
      activeZoneCount: activeZoneEntries.length,
      runningProgramCount: runningProgramEntries.length,
      activeRestrictionsCount: restrictions.currently.activeCount,
      rainDelayHours: restrictions.rainDelay.hoursRemaining,
      zoneCount: zones.length,
      programCount: programs.length
    },
    zones,
    programs,
    restrictions
  };
}

function normalizeDailyStatDetails(rawDetails = []) {
  return safeArray(rawDetails).map((entry) => {
    const day = asPlainObject(entry);
    const programs = safeArray(day.programs).map((program) => {
      const programItem = asPlainObject(program);
      const zones = safeArray(programItem.zones).map((zone) => {
        const zoneItem = asPlainObject(zone);
        return {
          uid: pickFirstNumber(zoneItem.uid, zoneItem.id, zoneItem.zoneId),
          scheduledDurationSeconds: pickFirstNumber(zoneItem.scheduledWateringTime, zoneItem.userDuration, zoneItem.userDurationSeconds) ?? 0,
          computedDurationSeconds: pickFirstNumber(zoneItem.computedWateringTime, zoneItem.machineDuration, zoneItem.machineDurationSeconds) ?? 0,
          wateringFlag: pickFirstNumber(zoneItem.wateringFlag, zoneItem.flag) ?? 0
        };
      });

      return {
        id: pickFirstNumber(programItem.id, programItem.uid),
        zones
      };
    });

    return {
      day: toIsoDate(day.day),
      programs
    };
  }).filter((entry) => entry.day);
}

function normalizeDailyStats(rawStats, rawDetails, controller) {
  const stats = findFirstArray(rawStats, [
    'dailyStats',
    'DailyStats',
    'days',
    'items'
  ]);
  const details = normalizeDailyStatDetails(findFirstArray(rawDetails, [
    'DailyStatsDetails',
    'dailyStatsDetails',
    'days',
    'items'
  ]));
  const detailMap = new Map(details.map((entry) => [entry.day, entry]));
  const rawMap = new Map(safeArray(stats).map((entry) => [toIsoDate(entry?.day || entry?.date), asPlainObject(entry)]));
  const allDays = new Set([
    ...detailMap.keys(),
    ...Array.from(rawMap.keys()).filter(Boolean)
  ]);

  return Array.from(allDays)
    .map((day) => {
      const detail = detailMap.get(day) || { day, programs: [] };
      const rawStat = rawMap.get(day) || {};
      const dayDate = parseDayDate(day);
      if (!dayDate) {
        return null;
      }

      const programCount = detail.programs.length;
      const zoneCount = detail.programs.reduce((sum, program) => sum + safeArray(program.zones).length, 0);
      const scheduledDurationSeconds = detail.programs.reduce((sum, program) => (
        sum + safeArray(program.zones).reduce((zoneSum, zone) => zoneSum + (Number(zone.scheduledDurationSeconds) || 0), 0)
      ), 0);
      const machineDurationSeconds = detail.programs.reduce((sum, program) => (
        sum + safeArray(program.zones).reduce((zoneSum, zone) => zoneSum + (Number(zone.computedDurationSeconds) || 0), 0)
      ), 0);
      const adjustmentPct = scheduledDurationSeconds > 0
        ? roundNumber((machineDurationSeconds / scheduledDurationSeconds) * 100, 1)
        : null;
      const waterSavedPct = scheduledDurationSeconds > 0
        ? roundNumber(Math.max(0, 100 - ((machineDurationSeconds / scheduledDurationSeconds) * 100)), 1)
        : null;

      return {
        controllerId: controller.id,
        controllerName: controller.name,
        day,
        dayDate,
        metrics: {
          program_count: programCount,
          zone_count: zoneCount,
          scheduled_duration_sec: scheduledDurationSeconds,
          machine_duration_sec: machineDurationSeconds,
          adjustment_pct: adjustmentPct,
          water_saved_pct: waterSavedPct,
          min_temp_c: pickFirstNumber(rawStat.minTemp, rawStat.minTempC, rawStat.tempMin),
          max_temp_c: pickFirstNumber(rawStat.maxTemp, rawStat.maxTempC, rawStat.tempMax)
        },
        details: detail,
        raw: {
          summary: rawStat,
          detail
        }
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.day.localeCompare(right.day));
}

function normalizeWateringLogDays(rawWatering = [], controller, { simulated = false } = {}) {
  const days = findFirstArray(rawWatering, [
    'waterLog.days',
    'wateringLog.days',
    'days',
    'items'
  ]);

  return safeArray(days)
    .map((entry) => {
      const dayItem = asPlainObject(entry);
      const day = toIsoDate(dayItem.date || dayItem.day);
      const dayDate = parseDayDate(day);
      if (!dayDate) {
        return null;
      }

      let scheduledDurationSeconds = 0;
      let wateredDurationSeconds = 0;
      let machineDurationSeconds = 0;
      let cycleCount = 0;
      let zoneCount = 0;

      const programs = safeArray(dayItem.programs).map((programEntry) => {
        const program = asPlainObject(programEntry);
        let programScheduled = 0;
        let programWatered = 0;
        let programMachine = 0;
        let programCycles = 0;

        const zones = safeArray(program.zones).map((zoneEntry) => {
          const zone = asPlainObject(zoneEntry);
          let zoneScheduled = 0;
          let zoneWatered = 0;
          let zoneMachine = 0;

          const cycles = safeArray(zone.cycles).map((cycleEntry) => {
            const cycle = asPlainObject(cycleEntry);
            const userDuration = pickFirstNumber(cycle.userDuration, cycle.userDurationSeconds) ?? 0;
            const realDuration = pickFirstNumber(cycle.realDuration, cycle.realDurationSeconds) ?? 0;
            const machineDuration = pickFirstNumber(cycle.machineDuration, cycle.machineDurationSeconds) ?? 0;

            zoneScheduled += userDuration;
            zoneWatered += realDuration;
            zoneMachine += machineDuration;
            programCycles += 1;

            return {
              startTime: pickFirstString(cycle.startTime),
              userDurationSeconds: userDuration,
              realDurationSeconds: realDuration,
              machineDurationSeconds: machineDuration,
              flowClicks: pickFirstNumber(cycle.flowclicks, cycle.flowClicks) ?? 0
            };
          });

          programScheduled += zoneScheduled;
          programWatered += zoneWatered;
          programMachine += zoneMachine;
          zoneCount += 1;

          return {
            uid: pickFirstNumber(zone.uid, zone.id, zone.zoneId),
            flag: pickFirstNumber(zone.flag, zone.wateringFlag) ?? 0,
            scheduledDurationSeconds: zoneScheduled,
            wateredDurationSeconds: zoneWatered,
            machineDurationSeconds: zoneMachine,
            cycles
          };
        });

        scheduledDurationSeconds += programScheduled;
        wateredDurationSeconds += programWatered;
        machineDurationSeconds += programMachine;
        cycleCount += programCycles;

        return {
          id: pickFirstNumber(program.id, program.uid),
          scheduledDurationSeconds: programScheduled,
          wateredDurationSeconds: programWatered,
          machineDurationSeconds: programMachine,
          cycleCount: programCycles,
          zones
        };
      });

      const waterSavedPct = scheduledDurationSeconds > 0
        ? roundNumber(Math.max(0, 100 - ((wateredDurationSeconds / scheduledDurationSeconds) * 100)), 1)
        : null;

      return {
        controllerId: controller.id,
        controllerName: controller.name,
        day,
        dayDate,
        simulated,
        summary: {
          program_count: programs.length,
          zone_count: zoneCount,
          cycle_count: cycleCount,
          scheduled_duration_sec: scheduledDurationSeconds,
          watered_duration_sec: wateredDurationSeconds,
          machine_duration_sec: machineDurationSeconds,
          water_saved_pct: waterSavedPct
        },
        programs,
        raw: dayItem
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.day.localeCompare(right.day));
}

class RainMachineService {
  constructor() {
    this.backgroundEnabled = process.env.NODE_ENV !== 'test';
    this.initialized = false;
    this.initializing = null;
    this.syncPromise = null;
    this.pollTimer = null;
    this.pollIntervalMs = 0;
    this.endpointCache = null;
    this.authSession = null;
    this.reportSyncIntervalMs = DEFAULT_REPORT_SYNC_INTERVAL_MS;
    this.defaultTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS;
  }

  async initialize() {
    if (!this.backgroundEnabled) {
      return;
    }

    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      await this.refreshRuntime({ reason: 'initialize', forceReports: true });
      await this.ensurePollTimer();
      this.initialized = true;
      this.initializing = null;
    })().catch((error) => {
      this.initializing = null;
      throw error;
    });

    return this.initializing;
  }

  async shutdown() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.pollIntervalMs = 0;
    this.endpointCache = null;
    this.authSession = null;
    this.initialized = false;
    this.initializing = null;
    this.syncPromise = null;
  }

  async ensurePollTimer() {
    if (!this.backgroundEnabled) {
      return;
    }

    const integration = await RainMachineIntegration.getIntegration();
    const enabled = integration.enabled === true && trimString(integration.host);
    const nextIntervalMs = Math.max(
      60 * 1000,
      clampInteger(
        integration.pollIntervalMinutes,
        DEFAULT_POLL_INTERVAL_MINUTES,
        1,
        1440
      ) * 60 * 1000
    );

    if (!enabled) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.pollIntervalMs = 0;
      return;
    }

    if (this.pollTimer && this.pollIntervalMs === nextIntervalMs) {
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.pollIntervalMs = nextIntervalMs;
    this.pollTimer = setInterval(() => {
      this.refreshRuntime({ reason: 'scheduled-sync' }).catch((error) => {
        console.warn(`RainMachineService: scheduled sync failed: ${error.message}`);
      });
    }, nextIntervalMs);

    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  async refreshRuntime({ reason = 'manual', forceReports = false } = {}) {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.performSync({ reason, forceReports })
      .finally(async () => {
        this.syncPromise = null;
        try {
          await this.ensurePollTimer();
        } catch (error) {
          console.warn(`RainMachineService: failed to refresh poll timer: ${error.message}`);
        }
      });

    return this.syncPromise;
  }

  async performSync({ reason = 'manual', forceReports = false } = {}) {
    const integration = await RainMachineIntegration.getIntegration();
    const persistedIntegration = integration._id
      ? integration
      : await RainMachineIntegration.findOne() || new RainMachineIntegration(RainMachineIntegration.getDefaultIntegration());

    if (!persistedIntegration.enabled) {
      persistedIntegration.isConnected = false;
      persistedIntegration.lastError = '';
      persistedIntegration.snapshot = persistedIntegration.snapshot || {};
      await persistedIntegration.save();

      return {
        success: true,
        skipped: true,
        reason: 'integration-disabled'
      };
    }

    if (!trimString(persistedIntegration.host)) {
      persistedIntegration.isConnected = false;
      persistedIntegration.lastError = 'RainMachine host is required.';
      await persistedIntegration.save();

      return {
        success: false,
        skipped: true,
        reason: 'missing-host'
      };
    }

    if (!trimString(persistedIntegration.password)) {
      persistedIntegration.isConnected = false;
      persistedIntegration.lastError = 'RainMachine password is required.';
      await persistedIntegration.save();

      return {
        success: false,
        skipped: true,
        reason: 'missing-password'
      };
    }

    try {
      const endpoint = await this.resolveEndpoint(persistedIntegration);
      const [
        apiVer,
        provision,
        provisionWifi,
        provisionCloud,
        diag,
        rawZones,
        rawZoneProperties,
        rawPrograms,
        rawNextRuns,
        rawRestrictionsCurrently,
        rawRestrictionsGlobal,
        rawRestrictionsHourly,
        rawRestrictionsRainDelay,
        rawQueue,
        rawActiveZone,
        rawWateringPrograms
      ] = await Promise.all([
        this.request(endpoint, { integration: persistedIntegration, path: 'apiVer', authenticated: false }),
        this.request(endpoint, { integration: persistedIntegration, path: 'provision' }),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'provision/wifi' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'provision/cloud' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'diag' }, {}),
        this.request(endpoint, { integration: persistedIntegration, path: 'zone' }),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'zone/properties' }, {}),
        this.request(endpoint, { integration: persistedIntegration, path: 'program' }),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'program/nextrun' }, []),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'restrictions/currently' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'restrictions/global' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'restrictions/hourly' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'restrictions/raindelay' }, {}),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'watering/queue' }, []),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'watering/zone' }, null),
        this.requestSafe(endpoint, { integration: persistedIntegration, path: 'watering/program' }, [])
      ]);

      const rawProgramsList = findFirstArray(rawPrograms, ['programs', 'items']);
      const rawNextRunsList = findFirstArray(rawNextRuns, ['programs', 'items', 'nextRuns']);
      const nextRunMap = buildProgramNextRunMap(rawNextRunsList, rawProgramsList);
      const programs = normalizePrograms(rawProgramsList, nextRunMap);
      const zoneNextRunMap = buildZoneNextRunMap(programs);
      const zones = normalizeZones(
        findFirstArray(rawZones, ['zones', 'items']),
        findFirstArray(rawZoneProperties, ['zones', 'items']),
        zoneNextRunMap
      );
      const zoneNameMap = zones.reduce((acc, zone) => {
        if (zone?.uid !== null && zone?.uid !== undefined) {
          acc[String(zone.uid)] = zone.name;
        }
        return acc;
      }, {});
      const programNameMap = programs.reduce((acc, program) => {
        if (program?.uid !== null && program?.uid !== undefined) {
          acc[String(program.uid)] = program.name;
        }
        return acc;
      }, {});
      const queue = normalizeQueueEntries(
        findFirstArray(rawQueue, ['queue', 'zones', 'items']),
        zoneNameMap
      );
      const activePrograms = normalizeWateringPrograms(
        findFirstArray(rawWateringPrograms, ['programs', 'items']),
        programNameMap
      );
      const activeZoneCandidates = normalizeQueueEntries(
        findFirstArray(rawActiveZone, ['zones', 'queue', 'items']),
        zoneNameMap
      );
      const activeZone = activeZoneCandidates.find((entry) => entry.stateLabel === 'running')
        || activeZoneCandidates[0]
        || queue.find((entry) => entry.stateLabel === 'running')
        || null;
      const restrictions = normalizeRestrictions(
        rawRestrictionsCurrently,
        rawRestrictionsGlobal,
        rawRestrictionsHourly,
        rawRestrictionsRainDelay
      );
      const snapshot = normalizeControllerSnapshot({
        integration: persistedIntegration,
        endpoint,
        apiVer,
        provision,
        provisionWifi,
        provisionCloud,
        diag,
        zones,
        programs,
        restrictions,
        queue,
        activeZone,
        activePrograms
      });

      const deviceSync = await this.syncDevices(snapshot, persistedIntegration);
      const reportSync = await this.syncReports({
        endpoint,
        integration: persistedIntegration,
        snapshot,
        force: forceReports || reason === 'manual-sync' || reason === 'configure'
      });

      persistedIntegration.host = endpoint.host;
      persistedIntegration.protocol = endpoint.protocol;
      persistedIntegration.port = endpoint.port;
      persistedIntegration.controllerId = snapshot.controller.id;
      persistedIntegration.controllerName = snapshot.controller.name;
      persistedIntegration.apiVersion = snapshot.controller.apiVersion || '';
      persistedIntegration.hardwareVersion = snapshot.controller.hardwareVersion;
      persistedIntegration.softwareVersion = snapshot.controller.softwareVersion || '';
      persistedIntegration.isConnected = true;
      persistedIntegration.lastConnectedAt = new Date();
      persistedIntegration.lastSyncAt = new Date();
      if (reportSync.synced) {
        persistedIntegration.lastReportSyncAt = new Date();
      }
      persistedIntegration.lastError = '';
      persistedIntegration.snapshot = {
        ...snapshot,
        syncedAt: new Date().toISOString(),
        reportSync: {
          synced: reportSync.synced,
          dailyStatsCount: reportSync.dailyStatsCount,
          wateringDayCount: reportSync.wateringDayCount,
          simulatedWateringDayCount: reportSync.simulatedWateringDayCount
        }
      };
      await persistedIntegration.save();

      return {
        success: true,
        reason,
        integration: persistedIntegration,
        snapshot: persistedIntegration.snapshot,
        devices: deviceSync,
        reports: reportSync
      };
    } catch (error) {
      persistedIntegration.isConnected = false;
      persistedIntegration.lastError = error.message || 'RainMachine sync failed';
      await persistedIntegration.save();
      throw error;
    }
  }

  async resolveEndpoint(integration) {
    const normalizedHost = normalizeHost(integration?.host);
    if (!normalizedHost) {
      throw new Error('RainMachine host is required.');
    }

    const configuredProtocol = normalizeProtocol(integration?.protocol, 'https');
    const configuredPort = clampInteger(
      integration?.port,
      configuredProtocol === 'http' ? 8081 : 8080,
      1,
      65535
    );
    const cacheKey = `${normalizedHost}:${configuredProtocol}:${configuredPort}`;

    if (this.endpointCache?.key === cacheKey) {
      return this.endpointCache.endpoint;
    }

    const candidates = [];
    const seen = new Set();
    const addCandidate = (protocol, port) => {
      const key = `${protocol}:${port}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({
        host: normalizedHost,
        protocol,
        port,
        baseUrl: `${protocol}://${normalizedHost}:${port}/api/4`
      });
    };

    addCandidate(configuredProtocol, configuredPort);
    addCandidate('https', 8080);
    addCandidate('http', 8081);
    if (configuredProtocol === 'http') {
      addCandidate('http', 8080);
    } else {
      addCandidate('https', 8081);
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const apiVer = await this.probeEndpoint(candidate);
        const endpoint = {
          ...candidate,
          apiVersion: pickFirstString(apiVer?.apiVer)
        };
        this.endpointCache = {
          key: cacheKey,
          endpoint
        };
        return endpoint;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(lastError?.message || `Unable to reach RainMachine at ${normalizedHost}.`);
  }

  async probeEndpoint(endpoint) {
    const response = await axios.get(`${endpoint.baseUrl}/apiVer`, {
      timeout: this.defaultTimeoutMs,
      httpsAgent: endpoint.protocol === 'https'
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      validateStatus: () => true
    });

    if (response.status >= 400) {
      throw new Error(`RainMachine probe failed for ${endpoint.protocol}://${endpoint.host}:${endpoint.port}`);
    }

    return ensureApiSuccess(response.data, 'apiVer');
  }

  async authenticate(endpoint, integration) {
    const password = trimString(integration?.password);
    if (!password) {
      throw new Error('RainMachine password is required.');
    }

    const sessionKey = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}|${password}`;
    if (this.authSession?.key === sessionKey && trimString(this.authSession.token)) {
      return this.authSession.token;
    }

    const loginPayload = buildRequestPayload({ pwd: password, remember: true });
    const response = await axios.post(
      `${endpoint.baseUrl}/auth/login`,
      loginPayload.payload,
      {
        timeout: this.defaultTimeoutMs,
        headers: loginPayload.headers,
        httpsAgent: endpoint.protocol === 'https'
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
        validateStatus: () => true
      }
    );

    if (response.status >= 400) {
      throw new Error('RainMachine authentication failed. Verify the local password.');
    }

    const payload = ensureApiSuccess(response.data, 'auth/login');
    const token = trimString(payload?.access_token);
    if (!token) {
      throw new Error('RainMachine authentication failed. Missing access token.');
    }

    this.authSession = {
      key: sessionKey,
      token,
      authenticatedAt: new Date()
    };

    if (integration?._id) {
      await RainMachineIntegration.updateOne(
        { _id: integration._id },
        {
          $set: {
            lastAuthenticatedAt: new Date(),
            lastError: ''
          }
        }
      );
    }

    return token;
  }

  clearAuthSession() {
    this.authSession = null;
  }

  async request(endpoint, {
    integration,
    path,
    method = 'GET',
    data = undefined,
    authenticated = true,
    retryAuth = true,
    timeout = this.defaultTimeoutMs
  } = {}) {
    const token = authenticated
      ? await this.authenticate(endpoint, integration)
      : '';
    const url = authenticated && token
      ? `${endpoint.baseUrl}/${path}?access_token=${encodeURIComponent(token)}`
      : `${endpoint.baseUrl}/${path}`;
    const requestPayload = buildRequestPayload(data);
    const response = await axios({
      method,
      url,
      data: requestPayload.payload,
      timeout,
      headers: requestPayload.headers,
      httpsAgent: endpoint.protocol === 'https'
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      validateStatus: () => true
    });

    if ((response.status === 401 || response.status === 403) && authenticated && retryAuth) {
      this.clearAuthSession();
      return this.request(endpoint, {
        integration,
        path,
        method,
        data,
        authenticated,
        retryAuth: false,
        timeout
      });
    }

    if (response.status >= 400) {
      const responseMessage = trimString(response.data?.message, trimString(response.statusText));
      throw new Error(responseMessage || `RainMachine request failed for ${path}`);
    }

    return ensureApiSuccess(response.data, path);
  }

  async requestSafe(endpoint, options, fallback) {
    try {
      return await this.request(endpoint, options);
    } catch (_error) {
      return fallback;
    }
  }

  async discoverControllers({ timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
    const socket = dgram.createSocket('udp4');
    const results = new Map();

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;

        try {
          socket.removeAllListeners();
          socket.close();
        } catch (_error) {
          // Ignore close errors during discovery.
        }

        resolve(Array.from(results.values()).sort((left, right) => left.name.localeCompare(right.name)));
      };

      socket.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.removeAllListeners();
          socket.close();
        } catch (_closeError) {
          // Ignore close errors during discovery.
        }
        reject(error);
      });

      socket.on('message', (buffer, rinfo) => {
        const parsed = parseDiscoveryResponse(buffer, rinfo);
        if (!parsed) {
          return;
        }

        const key = parsed.macAddress || parsed.host;
        if (!key) {
          return;
        }

        results.set(key, parsed);
      });

      socket.bind(DISCOVERY_RESPONSE_PORT, () => {
        try {
          socket.setBroadcast(true);
          socket.send(Buffer.from('homebrain discover', 'utf8'), DISCOVERY_PORT, '255.255.255.255');
        } catch (error) {
          reject(error);
          return;
        }

        setTimeout(finish, timeoutMs);
      });
    });
  }

  async testConnection({
    host,
    password,
    protocol,
    port
  } = {}) {
    const integration = await RainMachineIntegration.getIntegration();
    const parsed = parseHostInput(
      host || integration.host,
      protocol || integration.protocol || 'https',
      port || integration.port || 8080
    );
    const probeIntegration = {
      ...integration.toObject?.() || integration,
      host: parsed.host,
      protocol: normalizeProtocol(protocol || parsed.protocol || integration.protocol || 'https'),
      port: clampInteger(port ?? parsed.port ?? integration.port, 8080, 1, 65535),
      password: trimString(password, trimString(integration.password))
    };

    if (!probeIntegration.host) {
      throw new Error('RainMachine host is required.');
    }
    if (!probeIntegration.password) {
      throw new Error('RainMachine password is required.');
    }

    const endpoint = await this.resolveEndpoint(probeIntegration);
    const [apiVer, provision, wifi, diag] = await Promise.all([
      this.request(endpoint, { integration: probeIntegration, path: 'apiVer', authenticated: false }),
      this.request(endpoint, { integration: probeIntegration, path: 'provision' }),
      this.requestSafe(endpoint, { integration: probeIntegration, path: 'provision/wifi' }, {}),
      this.requestSafe(endpoint, { integration: probeIntegration, path: 'diag' }, {})
    ]);

    const system = asPlainObject(provision?.system);

    return {
      success: true,
      endpoint: {
        host: endpoint.host,
        protocol: endpoint.protocol,
        port: endpoint.port
      },
      controller: {
        name: pickFirstString(system.netName, provision?.location?.name, 'RainMachine'),
        controllerId: pickFirstString(wifi?.macAddress, endpoint.host),
        apiVersion: pickFirstString(apiVer?.apiVer),
        hardwareVersion: pickFirstNumber(apiVer?.hwVer),
        softwareVersion: pickFirstString(apiVer?.swVer),
        ipAddress: pickFirstString(wifi?.ipAddress),
        ssid: pickFirstString(wifi?.ssid),
        cpuUsagePct: pickFirstNumber(diag?.cpuUsage),
        uptime: pickFirstString(diag?.uptime)
      }
    };
  }

  async configureIntegration(configuration = {}) {
    const integration = await RainMachineIntegration.findOne() || new RainMachineIntegration(RainMachineIntegration.getDefaultIntegration());
    const currentHost = normalizeHost(integration.host);
    const currentProtocol = normalizeProtocol(integration.protocol, 'https');
    const currentPort = clampInteger(integration.port, currentProtocol === 'http' ? 8081 : 8080, 1, 65535);

    if (Object.prototype.hasOwnProperty.call(configuration, 'host')) {
      const parsed = parseHostInput(
        configuration.host,
        integration.protocol || 'https',
        integration.port || 8080
      );
      integration.host = parsed.host;
      if (!Object.prototype.hasOwnProperty.call(configuration, 'protocol')) {
        integration.protocol = parsed.protocol;
      }
      if (!Object.prototype.hasOwnProperty.call(configuration, 'port')) {
        integration.port = parsed.port;
      }
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'protocol')) {
      integration.protocol = normalizeProtocol(configuration.protocol, integration.protocol || 'https');
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'port')) {
      integration.port = clampInteger(
        configuration.port,
        integration.protocol === 'http' ? 8081 : 8080,
        1,
        65535
      );
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'password')) {
      integration.password = trimString(configuration.password, integration.password || '');
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'enabled')) {
      integration.enabled = configuration.enabled === true;
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'room')) {
      integration.room = trimString(configuration.room, 'Irrigation');
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'pollIntervalMinutes')) {
      integration.pollIntervalMinutes = clampInteger(
        configuration.pollIntervalMinutes,
        integration.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES,
        1,
        1440
      );
    }

    if (Object.prototype.hasOwnProperty.call(configuration, 'defaultZoneDurationSeconds')) {
      integration.defaultZoneDurationSeconds = clampInteger(
        configuration.defaultZoneDurationSeconds,
        integration.defaultZoneDurationSeconds || 600,
        60,
        MAX_ZONE_DURATION_SECONDS
      );
    }

    const nextHost = normalizeHost(integration.host);
    const nextProtocol = normalizeProtocol(integration.protocol, 'https');
    const nextPort = clampInteger(integration.port, nextProtocol === 'http' ? 8081 : 8080, 1, 65535);
    if (currentHost !== nextHost || currentProtocol !== nextProtocol || currentPort !== nextPort) {
      this.endpointCache = null;
      this.clearAuthSession();
    }

    if (!integration.enabled) {
      integration.isConnected = false;
      integration.lastError = '';
    }

    await integration.save();
    await this.ensurePollTimer();

    if (integration.enabled && trimString(integration.host) && trimString(integration.password)) {
      try {
        await this.refreshRuntime({ reason: 'configure', forceReports: true });
      } catch (error) {
        integration.isConnected = false;
        integration.lastError = error.message || 'RainMachine configuration test failed';
        await integration.save();
      }
    }

    return this.getStatus();
  }

  async syncReports({ endpoint, integration, snapshot, force = false } = {}) {
    const controller = snapshot?.controller;
    if (!controller?.id) {
      return {
        synced: false,
        dailyStatsCount: 0,
        wateringDayCount: 0,
        simulatedWateringDayCount: 0
      };
    }

    const now = Date.now();
    const lastReportSyncAt = integration?.lastReportSyncAt ? new Date(integration.lastReportSyncAt).getTime() : 0;
    if (!force && lastReportSyncAt && now - lastReportSyncAt < this.reportSyncIntervalMs) {
      return {
        synced: false,
        dailyStatsCount: 0,
        wateringDayCount: 0,
        simulatedWateringDayCount: 0
      };
    }

    const startDate = toIsoDate(new Date());
    const wateringDays = DEFAULT_WATERING_LOG_DAYS;
    const [rawDailyStats, rawDailyStatsDetails, rawWateringLog, rawSimulatedWateringLog] = await Promise.all([
      this.requestSafe(endpoint, { integration, path: 'dailystats' }, {}),
      this.requestSafe(endpoint, { integration, path: 'dailystats/details' }, {}),
      this.requestSafe(endpoint, { integration, path: `watering/log/details/${startDate}/${wateringDays}` }, {}),
      this.requestSafe(endpoint, { integration, path: `watering/log/simulated/details/${startDate}/${wateringDays}` }, {})
    ]);

    const dailyStats = normalizeDailyStats(rawDailyStats, rawDailyStatsDetails, controller);
    const wateringDaysActual = normalizeWateringLogDays(rawWateringLog, controller, { simulated: false });
    const wateringDaysSimulated = normalizeWateringLogDays(rawSimulatedWateringLog, controller, { simulated: true });

    for (const stat of dailyStats) {
      // eslint-disable-next-line no-await-in-loop
      await RainMachineDailyStat.updateOne(
        {
          controllerId: stat.controllerId,
          day: stat.day
        },
        {
          $set: {
            controllerName: stat.controllerName,
            dayDate: stat.dayDate,
            metrics: stat.metrics,
            details: stat.details,
            raw: stat.raw
          }
        },
        { upsert: true }
      );

      try {
        // eslint-disable-next-line no-await-in-loop
        await telemetryService.recordRainMachineDailyStat(controller, stat);
      } catch (error) {
        console.warn(`RainMachineService: failed to record daily stat telemetry: ${error.message}`);
      }
    }

    for (const wateringDay of [...wateringDaysActual, ...wateringDaysSimulated]) {
      // eslint-disable-next-line no-await-in-loop
      await RainMachineWateringDay.updateOne(
        {
          controllerId: wateringDay.controllerId,
          day: wateringDay.day,
          simulated: wateringDay.simulated
        },
        {
          $set: {
            controllerName: wateringDay.controllerName,
            dayDate: wateringDay.dayDate,
            summary: wateringDay.summary,
            programs: wateringDay.programs,
            raw: wateringDay.raw
          }
        },
        { upsert: true }
      );

      try {
        // eslint-disable-next-line no-await-in-loop
        await telemetryService.recordRainMachineWateringDay(controller, wateringDay);
      } catch (error) {
        console.warn(`RainMachineService: failed to record watering-day telemetry: ${error.message}`);
      }
    }

    return {
      synced: true,
      dailyStatsCount: dailyStats.length,
      wateringDayCount: wateringDaysActual.length,
      simulatedWateringDayCount: wateringDaysSimulated.length
    };
  }

  buildControllerDevicePayload(snapshot, integration, existingDevice) {
    const runtime = asPlainObject(snapshot.runtime);
    const controller = asPlainObject(snapshot.controller);
    const existingRainMachine = asPlainObject(existingDevice?.properties?.rainmachine);

    return {
      name: controller.name || 'RainMachine',
      type: 'sensor',
      room: trimString(integration?.room, existingDevice?.room || 'Irrigation'),
      status: Number(runtime.activeZoneCount || 0) > 0 || Number(runtime.queueLength || 0) > 0,
      temperature: existingDevice?.temperature,
      properties: {
        ...(existingDevice?.properties || {}),
        source: 'rainmachine',
        rainmachine: {
          ...existingRainMachine,
          entityType: 'controller',
          controllerId: controller.id,
          controllerName: controller.name,
          host: controller.host,
          protocol: controller.protocol,
          port: controller.port,
          apiVersion: controller.apiVersion,
          hardwareVersion: controller.hardwareVersion,
          softwareVersion: controller.softwareVersion,
          queueLength: runtime.queueLength || 0,
          activeZoneCount: runtime.activeZoneCount || 0,
          runningProgramCount: runtime.runningProgramCount || 0,
          activeRestrictionsCount: runtime.activeRestrictionsCount || 0,
          rainDelayHours: runtime.rainDelayHours || 0,
          programCount: runtime.programCount || 0,
          zoneCount: runtime.zoneCount || 0,
          diagnostics: controller.diagnostics || {},
          network: controller.network || {},
          location: controller.location || {}
        }
      },
      brand: 'RainMachine',
      model: controller.hardwareVersion ? `RainMachine HW ${controller.hardwareVersion}` : 'RainMachine',
      isOnline: integration?.isConnected !== false,
      lastSeen: new Date()
    };
  }

  buildZoneDevicePayload(zone, snapshot, integration, existingDevice) {
    const controller = asPlainObject(snapshot.controller);
    const existingRainMachine = asPlainObject(existingDevice?.properties?.rainmachine);
    const zoneStateActive = zone.stateLabel === 'running' || (zone.stateLabel === 'pending' && zone.remainingSeconds > 0);

    return {
      name: zone.name || `Zone ${zone.uid || ''}`,
      type: zone.master ? 'sensor' : 'switch',
      room: trimString(integration?.room, existingDevice?.room || 'Irrigation'),
      status: zoneStateActive,
      temperature: existingDevice?.temperature,
      properties: {
        ...(existingDevice?.properties || {}),
        source: 'rainmachine',
        rainmachine: {
          ...existingRainMachine,
          entityType: 'zone',
          controllerId: controller.id,
          controllerName: controller.name,
          host: controller.host,
          zoneId: zone.uid,
          valveId: zone.valveId,
          zoneName: zone.name,
          master: zone.master === true,
          active: zone.active === true,
          state: zone.state,
          stateLabel: zone.stateLabel,
          restriction: zone.restriction === true,
          userDurationSeconds: zone.userDurationSeconds,
          machineDurationSeconds: zone.machineDurationSeconds,
          remainingSeconds: zone.remainingSeconds,
          cycle: zone.cycle,
          cycleCount: zone.cycleCount,
          internet: zone.internet === true,
          history: zone.history === true,
          nextRun: zone.nextRun,
          nextRunProgramId: zone.nextRunProgramId,
          nextRunProgramName: zone.nextRunProgramName,
          nextRunDurationSeconds: zone.nextRunDurationSeconds
        }
      },
      brand: 'RainMachine',
      model: zone.master ? 'Master Valve' : 'Irrigation Zone',
      isOnline: integration?.isConnected !== false,
      lastSeen: new Date()
    };
  }

  async upsertControllerDevice(snapshot, integration) {
    const controller = asPlainObject(snapshot.controller);
    const identityQuery = buildRainMachineControllerIdentityQuery({
      controllerId: controller.id,
      host: controller.host
    });
    const matchingDevices = identityQuery ? await Device.find(identityQuery) : [];
    const existingDevice = selectCanonicalDevice(matchingDevices);
    const duplicateDevices = matchingDevices.filter((candidate) => (
      String(candidate?._id || '') !== String(existingDevice?._id || '')
    ));
    const payload = this.buildControllerDevicePayload(snapshot, integration, existingDevice);

    let device = existingDevice;
    let deduped = 0;

    if (device) {
      mergeDuplicateDeviceGroups(device, duplicateDevices);
      device.name = payload.name;
      device.type = payload.type;
      device.room = payload.room;
      device.status = payload.status;
      device.temperature = payload.temperature;
      device.properties = payload.properties;
      device.brand = payload.brand;
      device.model = payload.model;
      device.isOnline = payload.isOnline;
      device.lastSeen = payload.lastSeen;
      await device.save();

      const duplicateIds = duplicateDevices
        .map((candidate) => String(candidate?._id || ''))
        .filter(Boolean);
      if (duplicateIds.length > 0) {
        await Device.deleteMany({ _id: { $in: duplicateIds } });
        deduped = duplicateIds.length;
        console.warn(
          `RainMachineService: removed ${duplicateIds.length} duplicate controller device row(s): ${describeDevices(duplicateDevices)}`
        );
      }
    } else {
      device = await Device.create(payload);
    }

    const normalized = deviceUpdateEmitter.normalizeDevices([device]);
    if (normalized.length > 0) {
      deviceUpdateEmitter.emit('devices:update', normalized);
    }

    return {
      device,
      deduped
    };
  }

  async upsertZoneDevices(snapshot, integration) {
    const controller = asPlainObject(snapshot.controller);
    const results = [];

    for (const zone of safeArray(snapshot.zones)) {
      if (zone.uid === null || zone.uid === undefined) {
        continue;
      }

      const identityQuery = buildRainMachineZoneIdentityQuery({
        controllerId: controller.id,
        zoneId: zone.uid
      });
      const matchingDevices = identityQuery ? await Device.find(identityQuery) : [];
      const existingDevice = selectCanonicalDevice(matchingDevices);
      const duplicateDevices = matchingDevices.filter((candidate) => (
        String(candidate?._id || '') !== String(existingDevice?._id || '')
      ));
      const payload = this.buildZoneDevicePayload(zone, snapshot, integration, existingDevice);

      let device = existingDevice;
      let deduped = 0;

      if (device) {
        mergeDuplicateDeviceGroups(device, duplicateDevices);
        device.name = payload.name;
        device.type = payload.type;
        device.room = payload.room;
        device.status = payload.status;
        device.temperature = payload.temperature;
        device.properties = payload.properties;
        device.brand = payload.brand;
        device.model = payload.model;
        device.isOnline = payload.isOnline;
        device.lastSeen = payload.lastSeen;
        // eslint-disable-next-line no-await-in-loop
        await device.save();

        const duplicateIds = duplicateDevices
          .map((candidate) => String(candidate?._id || ''))
          .filter(Boolean);
        if (duplicateIds.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          await Device.deleteMany({ _id: { $in: duplicateIds } });
          deduped = duplicateIds.length;
          console.warn(
            `RainMachineService: removed ${duplicateIds.length} duplicate zone device row(s): ${describeDevices(duplicateDevices)}`
          );
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        device = await Device.create(payload);
      }

      const normalized = deviceUpdateEmitter.normalizeDevices([device]);
      if (normalized.length > 0) {
        deviceUpdateEmitter.emit('devices:update', normalized);
      }

      results.push({
        device,
        deduped
      });
    }

    return results;
  }

  async syncDevices(snapshot, integration) {
    const controllerResult = await this.upsertControllerDevice(snapshot, integration);
    const zoneResults = await this.upsertZoneDevices(snapshot, integration);

    return {
      controllerDeviceId: controllerResult?.device?._id?.toString?.() || String(controllerResult?.device?._id || ''),
      zoneDeviceCount: zoneResults.length,
      deduped: (controllerResult?.deduped || 0) + zoneResults.reduce((sum, entry) => sum + (entry?.deduped || 0), 0)
    };
  }

  async getStatus() {
    const integration = await RainMachineIntegration.getIntegration();
    const sanitizedIntegration = integration.toSanitized
      ? integration.toSanitized()
      : { ...integration };
    const snapshot = asPlainObject(integration.snapshot);
    const controller = asPlainObject(snapshot.controller);

    return {
      integration: sanitizedIntegration,
      health: {
        isConnected: integration.isConnected === true,
        lastAuthenticatedAt: integration.lastAuthenticatedAt || null,
        lastConnectedAt: integration.lastConnectedAt || null,
        lastSyncAt: integration.lastSyncAt || null,
        lastReportSyncAt: integration.lastReportSyncAt || null,
        lastError: integration.lastError || ''
      },
      controller: controller.id ? controller : null,
      runtime: snapshot.runtime || null
    };
  }

  async getDailyStats({ days = 30 } = {}) {
    const integration = await RainMachineIntegration.getIntegration();
    const controllerId = trimString(integration.controllerId, trimString(integration.snapshot?.controller?.id));
    if (!controllerId) {
      return [];
    }

    const limit = clampInteger(days, 30, 1, 365);
    return RainMachineDailyStat.find({ controllerId })
      .sort({ dayDate: -1 })
      .limit(limit)
      .lean();
  }

  async getWateringHistory({ days = 30, simulated = false } = {}) {
    const integration = await RainMachineIntegration.getIntegration();
    const controllerId = trimString(integration.controllerId, trimString(integration.snapshot?.controller?.id));
    if (!controllerId) {
      return [];
    }

    const limit = clampInteger(days, 30, 1, 365);
    return RainMachineWateringDay.find({
      controllerId,
      simulated: simulated === true
    })
      .sort({ dayDate: -1 })
      .limit(limit)
      .lean();
  }

  async getDashboard({ dailyDays = 14, wateringDays = 14 } = {}) {
    const integration = await RainMachineIntegration.getIntegration();
    const sanitizedIntegration = integration.toSanitized
      ? integration.toSanitized()
      : { ...integration };
    const snapshot = asPlainObject(integration.snapshot);
    const dailyStats = await this.getDailyStats({ days: dailyDays });
    const [wateringHistory, simulatedWateringHistory] = await Promise.all([
      this.getWateringHistory({ days: wateringDays, simulated: false }),
      this.getWateringHistory({ days: wateringDays, simulated: true })
    ]);
    const controllerId = trimString(integration.controllerId, trimString(snapshot?.controller?.id));

    return {
      generatedAt: new Date().toISOString(),
      integration: sanitizedIntegration,
      health: {
        isConnected: integration.isConnected === true,
        lastSyncAt: integration.lastSyncAt || null,
        lastReportSyncAt: integration.lastReportSyncAt || null,
        lastError: integration.lastError || ''
      },
      controller: snapshot.controller || null,
      runtime: snapshot.runtime || null,
      zones: safeArray(snapshot.zones),
      programs: safeArray(snapshot.programs),
      restrictions: snapshot.restrictions || null,
      dailyStats,
      wateringHistory,
      simulatedWateringHistory,
      telemetrySources: controllerId
        ? {
            dailyStatsSourceKey: `rainmachine_report:${controllerId}:daily_stats`,
            wateringLogSourceKey: `rainmachine_report:${controllerId}:watering_log`
          }
        : null
    };
  }

  async startZone(zoneId, durationSeconds = null) {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);
    const effectiveDuration = clampInteger(
      durationSeconds,
      integration.defaultZoneDurationSeconds || 600,
      60,
      MAX_ZONE_DURATION_SECONDS
    );

    await this.request(endpoint, {
      integration,
      path: `zone/${encodeURIComponent(zoneId)}/start`,
      method: 'POST',
      data: { time: effectiveDuration }
    });

    try {
      await this.refreshRuntime({ reason: 'post-zone-start' });
    } catch (error) {
      console.warn(`RainMachineService: post-zone-start refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }

  async stopZone(zoneId) {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);
    const shouldFallbackToStopAll = snapshotShowsActiveZone(integration?.snapshot, zoneId);

    try {
      await this.request(endpoint, {
        integration,
        path: `zone/${encodeURIComponent(zoneId)}/stop`,
        method: 'POST'
      });
    } catch (error) {
      if (!shouldFallbackToStopAll) {
        throw error;
      }

      console.warn(`RainMachineService: direct stop failed for zone ${zoneId}, falling back to stop-all: ${error.message}`);
      await this.request(endpoint, {
        integration,
        path: 'watering/stopall',
        method: 'POST'
      });
    }

    try {
      await this.refreshRuntime({ reason: 'post-zone-stop' });
    } catch (error) {
      console.warn(`RainMachineService: post-zone-stop refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }

  async startProgram(programId) {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);

    await this.request(endpoint, {
      integration,
      path: `program/${encodeURIComponent(programId)}/start`,
      method: 'POST',
      data: {}
    });

    try {
      await this.refreshRuntime({ reason: 'post-program-start' });
    } catch (error) {
      console.warn(`RainMachineService: post-program-start refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }

  async stopProgram(programId) {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);

    await this.request(endpoint, {
      integration,
      path: `program/${encodeURIComponent(programId)}/stop`,
      method: 'POST'
    });

    try {
      await this.refreshRuntime({ reason: 'post-program-stop' });
    } catch (error) {
      console.warn(`RainMachineService: post-program-stop refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }

  async stopAll() {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);

    await this.request(endpoint, {
      integration,
      path: 'watering/stopall',
      method: 'POST'
    });

    try {
      await this.refreshRuntime({ reason: 'post-stop-all' });
    } catch (error) {
      console.warn(`RainMachineService: post-stop-all refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }

  async setRainDelay(days = 0) {
    const integration = await RainMachineIntegration.getIntegration();
    const endpoint = await this.resolveEndpoint(integration);
    const rainDelay = clampInteger(days, 0, 0, MAX_RAIN_DELAY_DAYS);

    await this.request(endpoint, {
      integration,
      path: 'restrictions/raindelay',
      method: 'POST',
      data: { rainDelay }
    });

    try {
      await this.refreshRuntime({ reason: 'post-rain-delay' });
    } catch (error) {
      console.warn(`RainMachineService: post-rain-delay refresh failed after successful command: ${error.message}`);
    }
    return this.getDashboard();
  }
}

function parseDiscoveryResponse(buffer, rinfo = {}) {
  const text = trimString(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer);
  if (!text || !text.includes('||')) {
    return null;
  }

  const parts = text.split('||').map((entry) => trimString(entry));
  if (parts.length < 4) {
    return null;
  }

  const [, macAddress, name, httpHost, wizard = '1'] = parts;
  const parsedHost = normalizeHost(httpHost || rinfo.address);
  if (!parsedHost) {
    return null;
  }

  const hostInput = parseHostInput(httpHost || parsedHost, 'https', 8080);
  return {
    name: pickFirstString(name, parsedHost),
    host: hostInput.host || parsedHost,
    protocol: hostInput.protocol || 'https',
    port: hostInput.port || (hostInput.protocol === 'http' ? 8081 : 8080),
    macAddress: trimString(macAddress),
    configured: trimString(wizard, '1') === '1',
    address: trimString(rinfo.address, parsedHost)
  };
}

const rainMachineService = new RainMachineService();

module.exports = rainMachineService;
module.exports.RainMachineService = RainMachineService;
module.exports.__private__ = {
  buildRequestPayload,
  buildProgramNextRunMap,
  buildZoneNextRunMap,
  snapshotShowsActiveZone,
  normalizeDailyStats,
  normalizePrograms,
  normalizeQueueEntries,
  normalizeRestrictions,
  normalizeWateringLogDays,
  normalizeZones,
  parseDiscoveryResponse,
  parseHostInput
};
