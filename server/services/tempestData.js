const SENSOR_STATUS_FLAGS = [
  { mask: 1, label: 'Lightning sensor failure' },
  { mask: 2, label: 'Lightning noise detected' },
  { mask: 4, label: 'Lightning disturber detected' },
  { mask: 8, label: 'Pressure sensor failure' },
  { mask: 16, label: 'Temperature sensor failure' },
  { mask: 32, label: 'Humidity sensor failure' },
  { mask: 64, label: 'Wind sensor failure' },
  { mask: 128, label: 'Precipitation sensor failure' },
  { mask: 256, label: 'Light and UV sensor failure' }
];

const DEVICE_TYPE_LABELS = {
  HB: 'Tempest Hub',
  ST: 'Tempest Weather Station',
  AR: 'AIR',
  SK: 'SKY'
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const roundNumber = (value, precision = 2) => {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  const factor = 10 ** precision;
  return Math.round(numeric * factor) / factor;
};

const epochToDate = (value, fallback = new Date()) => {
  const numeric = toNumber(value);
  if (numeric === null) {
    return fallback;
  }

  return new Date(numeric * 1000);
};

const cToF = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber((numeric * 9) / 5 + 32, 1);
};

const mpsToMph = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber(numeric * 2.2369362921, 1);
};

const mmToIn = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber(numeric / 25.4, 3);
};

const kmToMiles = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber(numeric * 0.6213711922, 1);
};

const milesToKm = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber(numeric / 0.6213711922, 1);
};

const mbToInHg = (value) => {
  const numeric = toNumber(value);
  return numeric === null ? null : roundNumber(numeric * 0.0295299831, 2);
};

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const decodeSensorStatus = (value) => {
  const numeric = Math.max(0, Math.trunc(toNumber(value) || 0));
  if (numeric === 0) {
    return [];
  }

  return SENSOR_STATUS_FLAGS
    .filter((flag) => (numeric & flag.mask) === flag.mask)
    .map((flag) => flag.label);
};

const normalizeCalibration = (calibration = {}) => ({
  tempOffsetC: toNumber(calibration.tempOffsetC) || 0,
  humidityOffsetPct: toNumber(calibration.humidityOffsetPct) || 0,
  pressureOffsetMb: toNumber(calibration.pressureOffsetMb) || 0,
  windSpeedMultiplier: toNumber(calibration.windSpeedMultiplier) || 1,
  rainMultiplier: toNumber(calibration.rainMultiplier) || 1
});

const calculateDewPointC = (tempC, humidityPct) => {
  const temp = toNumber(tempC);
  const humidity = toNumber(humidityPct);
  if (temp === null || humidity === null || humidity <= 0) {
    return null;
  }

  const a = 17.27;
  const b = 237.7;
  const alpha = ((a * temp) / (b + temp)) + Math.log(humidity / 100);
  return roundNumber((b * alpha) / (a - alpha), 1);
};

const calculateHeatIndexF = (tempF, humidityPct) => {
  const temperature = toNumber(tempF);
  const humidity = toNumber(humidityPct);
  if (temperature === null || humidity === null || temperature < 80 || humidity < 40) {
    return null;
  }

  const result =
    -42.379 +
    2.04901523 * temperature +
    10.14333127 * humidity -
    0.22475541 * temperature * humidity -
    0.00683783 * temperature * temperature -
    0.05481717 * humidity * humidity +
    0.00122874 * temperature * temperature * humidity +
    0.00085282 * temperature * humidity * humidity -
    0.00000199 * temperature * temperature * humidity * humidity;

  return roundNumber(result, 1);
};

const calculateWindChillF = (tempF, windMph) => {
  const temperature = toNumber(tempF);
  const wind = toNumber(windMph);
  if (temperature === null || wind === null || temperature > 50 || wind < 3) {
    return null;
  }

  const result =
    35.74 +
    0.6215 * temperature -
    35.75 * (wind ** 0.16) +
    0.4275 * temperature * (wind ** 0.16);

  return roundNumber(result, 1);
};

const calculateFeelsLikeC = ({ tempC, humidityPct, windAvgMps }) => {
  const tempF = cToF(tempC);
  const windMph = mpsToMph(windAvgMps);

  const heatIndexF = calculateHeatIndexF(tempF, humidityPct);
  if (heatIndexF !== null) {
    return roundNumber((heatIndexF - 32) * (5 / 9), 1);
  }

  const windChillF = calculateWindChillF(tempF, windMph);
  if (windChillF !== null) {
    return roundNumber((windChillF - 32) * (5 / 9), 1);
  }

  return roundNumber(tempC, 1);
};

const classifyPressureTrend = (currentMb, previousMb) => {
  const current = toNumber(currentMb);
  const previous = toNumber(previousMb);
  if (current === null || previous === null) {
    return null;
  }

  const delta = roundNumber(current - previous, 2);
  if (delta >= 0.75) {
    return 'rising';
  }
  if (delta <= -0.75) {
    return 'falling';
  }
  return 'steady';
};

const applyCalibration = (metrics, calibration = {}) => {
  const normalizedCalibration = normalizeCalibration(calibration);
  const calibrated = { ...metrics };

  if (toNumber(calibrated.temp_c) !== null) {
    calibrated.temp_c = roundNumber(calibrated.temp_c + normalizedCalibration.tempOffsetC, 2);
  }

  if (toNumber(calibrated.humidity_pct) !== null) {
    calibrated.humidity_pct = roundNumber(
      Math.max(0, Math.min(100, calibrated.humidity_pct + normalizedCalibration.humidityOffsetPct)),
      1
    );
  }

  if (toNumber(calibrated.pressure_mb) !== null) {
    calibrated.pressure_mb = roundNumber(calibrated.pressure_mb + normalizedCalibration.pressureOffsetMb, 2);
  }

  ['wind_lull_mps', 'wind_avg_mps', 'wind_gust_mps', 'wind_rapid_mps'].forEach((key) => {
    if (toNumber(calibrated[key]) !== null) {
      calibrated[key] = roundNumber(calibrated[key] * normalizedCalibration.windSpeedMultiplier, 2);
    }
  });

  ['rain_mm_last_minute', 'rain_mm_today', 'rain_mm_last_minute_final', 'rain_mm_today_final'].forEach((key) => {
    if (toNumber(calibrated[key]) !== null) {
      calibrated[key] = roundNumber(calibrated[key] * normalizedCalibration.rainMultiplier, 3);
    }
  });

  return calibrated;
};

const buildDerivedMetrics = (metrics, previousMetrics = {}) => ({
  dew_point_c: calculateDewPointC(metrics.temp_c, metrics.humidity_pct),
  feels_like_c: calculateFeelsLikeC({
    tempC: metrics.temp_c,
    humidityPct: metrics.humidity_pct,
    windAvgMps: metrics.wind_avg_mps ?? metrics.wind_rapid_mps
  }),
  rain_rate_mm_per_hr: toNumber(metrics.rain_mm_last_minute) === null
    ? null
    : roundNumber(metrics.rain_mm_last_minute * 60, 2),
  pressure_trend: classifyPressureTrend(metrics.pressure_mb, previousMetrics.pressure_mb)
});

const buildDisplayMetrics = (metrics = {}, derived = {}) => ({
  temperatureF: cToF(metrics.temp_c),
  feelsLikeF: cToF(derived.feels_like_c),
  dewPointF: cToF(derived.dew_point_c),
  humidityPct: roundNumber(metrics.humidity_pct, 0),
  windLullMph: mpsToMph(metrics.wind_lull_mps),
  windAvgMph: mpsToMph(metrics.wind_avg_mps),
  windGustMph: mpsToMph(metrics.wind_gust_mps),
  windRapidMph: mpsToMph(metrics.wind_rapid_mps),
  windDirectionDeg: roundNumber(metrics.wind_direction_deg, 0),
  pressureMb: roundNumber(metrics.pressure_mb, 1),
  pressureInHg: mbToInHg(metrics.pressure_mb),
  pressureTrend: trimString(derived.pressure_trend, ''),
  rainLastMinuteIn: mmToIn(metrics.rain_mm_last_minute),
  rainTodayIn: mmToIn(metrics.rain_mm_today),
  rainRateInPerHr: mmToIn(derived.rain_rate_mm_per_hr),
  illuminanceLux: roundNumber(metrics.illuminance_lux, 0),
  uvIndex: roundNumber(metrics.uv_index, 1),
  solarRadiationWm2: roundNumber(metrics.solar_radiation_wm2, 0),
  lightningAvgDistanceKm: roundNumber(metrics.lightning_avg_distance_km, 1),
  lightningAvgDistanceMiles: kmToMiles(metrics.lightning_avg_distance_km),
  lightningCount: roundNumber(metrics.lightning_count, 0),
  batteryVolts: roundNumber(metrics.battery_volts, 2)
});

const parseObservationArray = (type, values) => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  if (type === 'obs_st') {
    return {
      observedAt: epochToDate(values[0]),
      metrics: {
        wind_lull_mps: toNumber(values[1]),
        wind_avg_mps: toNumber(values[2]),
        wind_gust_mps: toNumber(values[3]),
        wind_direction_deg: toNumber(values[4]),
        wind_sample_interval_s: toNumber(values[5]),
        pressure_mb: toNumber(values[6]),
        temp_c: toNumber(values[7]),
        humidity_pct: toNumber(values[8]),
        illuminance_lux: toNumber(values[9]),
        uv_index: toNumber(values[10]),
        solar_radiation_wm2: toNumber(values[11]),
        rain_mm_last_minute: toNumber(values[12]),
        precip_type: toNumber(values[13]),
        lightning_avg_distance_km: toNumber(values[14]),
        lightning_count: toNumber(values[15]),
        battery_volts: toNumber(values[16]),
        report_interval_min: toNumber(values[17]),
        rain_mm_today: toNumber(values[18]),
        rain_mm_last_minute_final: toNumber(values[19]),
        rain_mm_today_final: toNumber(values[20]),
        precip_analysis_type: toNumber(values[21])
      }
    };
  }

  if (type === 'obs_air') {
    return {
      observedAt: epochToDate(values[0]),
      metrics: {
        pressure_mb: toNumber(values[1]),
        temp_c: toNumber(values[2]),
        humidity_pct: toNumber(values[3]),
        lightning_count: toNumber(values[4]),
        lightning_avg_distance_km: toNumber(values[5]),
        battery_volts: toNumber(values[6]),
        report_interval_min: toNumber(values[7])
      }
    };
  }

  if (type === 'obs_sky') {
    return {
      observedAt: epochToDate(values[0]),
      metrics: {
        illuminance_lux: toNumber(values[1]),
        uv_index: toNumber(values[2]),
        rain_mm_last_minute: toNumber(values[3]),
        wind_lull_mps: toNumber(values[4]),
        wind_avg_mps: toNumber(values[5]),
        wind_gust_mps: toNumber(values[6]),
        wind_direction_deg: toNumber(values[7]),
        battery_volts: toNumber(values[8]),
        report_interval_min: toNumber(values[9]),
        solar_radiation_wm2: toNumber(values[10]),
        rain_mm_today: toNumber(values[11]),
        precip_type: toNumber(values[12]),
        wind_sample_interval_s: toNumber(values[13]),
        rain_mm_last_minute_final: toNumber(values[14]),
        rain_mm_today_final: toNumber(values[15]),
        precip_analysis_type: toNumber(values[16])
      }
    };
  }

  return null;
};

const parseRapidWind = (values) => {
  if (!Array.isArray(values) || values.length < 3) {
    return null;
  }

  return {
    observedAt: epochToDate(values[0]),
    metrics: {
      wind_rapid_mps: toNumber(values[1]),
      wind_direction_deg: toNumber(values[2])
    }
  };
};

const normalizeObservationPayload = ({
  type,
  values,
  deviceId,
  stationId,
  stationName,
  source,
  raw,
  calibration,
  previousMetrics
}) => {
  const parsed = type === 'rapid_wind'
    ? parseRapidWind(values)
    : parseObservationArray(type, values);

  if (!parsed) {
    return null;
  }

  const metrics = applyCalibration(parsed.metrics, calibration);
  const derived = buildDerivedMetrics(metrics, previousMetrics);

  return {
    stationId,
    deviceId,
    stationName,
    observationType: type,
    source,
    observedAt: parsed.observedAt,
    metrics,
    derived,
    display: buildDisplayMetrics(metrics, derived),
    raw
  };
};

const normalizeEventPayload = ({
  type,
  values,
  deviceId,
  stationId,
  stationName,
  source,
  raw,
  receivedAt = new Date()
}) => {
  if (type === 'evt_strike') {
    return {
      stationId,
      deviceId,
      stationName,
      eventType: 'lightning_strike',
      source,
      eventAt: epochToDate(values?.[0], receivedAt),
      payload: {
        distanceKm: roundNumber(values?.[1], 1),
        distanceMiles: kmToMiles(values?.[1]),
        energy: toNumber(values?.[2])
      },
      raw
    };
  }

  if (type === 'evt_precip') {
    return {
      stationId,
      deviceId,
      stationName,
      eventType: 'precip_start',
      source,
      eventAt: epochToDate(values?.[0], receivedAt),
      payload: {},
      raw
    };
  }

  return null;
};

const normalizeDiscoveryStation = (station = {}) => {
  const devices = Array.isArray(station.devices) ? station.devices : [];
  const normalizedDevices = devices.map((device) => ({
    deviceId: toNumber(device.device_id),
    serialNumber: trimString(device.serial_number, ''),
    type: trimString(device.device_type, ''),
    label: DEVICE_TYPE_LABELS[trimString(device.device_type, '')] || trimString(device.device_type, 'Unknown'),
    hardwareRevision: trimString(device.hardware_revision, ''),
    firmwareRevision: trimString(device.firmware_revision, ''),
    meta: typeof device.device_meta === 'object' && device.device_meta ? device.device_meta : {}
  }));

  const sensorDevices = normalizedDevices.filter((device) => device.type !== 'HB' && device.deviceId !== null);
  const hubDevice = normalizedDevices.find((device) => device.type === 'HB') || null;
  const preferredSensor = sensorDevices.find((device) => device.type === 'ST')
    || sensorDevices.find((device) => device.type === 'SK')
    || sensorDevices.find((device) => device.type === 'AR')
    || sensorDevices[0]
    || null;

  return {
    stationId: toNumber(station.station_id),
    name: trimString(station.name, trimString(station.public_name, 'Tempest Station')),
    publicName: trimString(station.public_name, ''),
    latitude: toNumber(station.latitude),
    longitude: toNumber(station.longitude),
    timezone: trimString(station.timezone, ''),
    elevationM: toNumber(station?.station_meta?.elevation),
    isLocalMode: station.is_local_mode === true,
    createdEpoch: toNumber(station.created_epoch),
    lastModifiedEpoch: toNumber(station.last_modified_epoch),
    stationItems: Array.isArray(station.station_items) ? station.station_items : [],
    devices: normalizedDevices,
    sensorDeviceIds: sensorDevices.map((device) => device.deviceId),
    sensorSerialNumbers: sensorDevices.map((device) => device.serialNumber).filter(Boolean),
    hubDeviceId: hubDevice?.deviceId ?? null,
    hubSerialNumber: hubDevice?.serialNumber ?? '',
    primaryDeviceId: preferredSensor?.deviceId ?? hubDevice?.deviceId ?? null,
    primaryDeviceType: preferredSensor?.type ?? hubDevice?.type ?? ''
  };
};

const normalizeDiscoveryResponse = (payload) => {
  const stations = Array.isArray(payload?.stations) ? payload.stations : [];
  return stations
    .map((station) => normalizeDiscoveryStation(station))
    .filter((station) => station.stationId !== null);
};

const summarizeLightningMetrics = (recentLightning = {}, fallbackMetrics = {}) => {
  const recentCount = toNumber(recentLightning.count);
  const recentAverageDistanceMiles = toNumber(recentLightning.averageDistanceMiles);
  const recentLastStrikeDistanceMiles = toNumber(recentLightning.lastStrikeDistanceMiles);
  const fallbackCount = toNumber(fallbackMetrics.lightningCount);
  const fallbackAverageDistanceMiles = toNumber(fallbackMetrics.lightningAvgDistanceMiles);
  const fallbackAverageDistanceKm = toNumber(fallbackMetrics.lightningAvgDistanceKm);
  const hasRecentLightning = recentCount !== null && recentCount > 0;
  const resolvedCount = hasRecentLightning
    ? roundNumber(recentCount, 0)
    : fallbackCount;
  const resolvedAverageDistanceMiles = hasRecentLightning
    ? recentAverageDistanceMiles ?? recentLastStrikeDistanceMiles ?? fallbackAverageDistanceMiles
    : fallbackAverageDistanceMiles;
  const roundedAverageDistanceMiles = resolvedAverageDistanceMiles === null
    ? null
    : roundNumber(resolvedAverageDistanceMiles, 1);

  return {
    lightningCount: resolvedCount,
    lightningAvgDistanceMiles: roundedAverageDistanceMiles,
    lightningAvgDistanceKm: roundedAverageDistanceMiles !== null
      ? milesToKm(roundedAverageDistanceMiles)
      : fallbackAverageDistanceKm,
    lastLightningStrikeAt: recentLightning.lastStrikeAt || null
  };
};

module.exports = {
  DEVICE_TYPE_LABELS,
  applyCalibration,
  buildDerivedMetrics,
  buildDisplayMetrics,
  cToF,
  decodeSensorStatus,
  kmToMiles,
  milesToKm,
  mbToInHg,
  mmToIn,
  mpsToMph,
  normalizeCalibration,
  normalizeDiscoveryResponse,
  normalizeEventPayload,
  normalizeObservationPayload,
  parseObservationArray,
  parseRapidWind,
  roundNumber,
  summarizeLightningMetrics,
  toNumber
};
