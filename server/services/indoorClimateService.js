const mongoose = require('mongoose');
const sensorNodeService = require('./sensorNodeService');
const goveeAirQualityService = require('./goveeAirQualityService');
const TelemetrySample = require('../models/TelemetrySample');
const { describeAirQuality } = require('../utils/indoorAirQuality');

const SENSOR_MODULE_ID = 'homebrain-sensors';
const GOVEE_MODULE_ID = 'govee-indoor-air';

async function getPreference() {
  return require('./integrationRegistryService').getCapabilityPreference('indoor_climate');
}

function selectedModule(preference) {
  // Keep existing households on their configured Govee monitor until they choose a source.
  return preference?.mode === 'selected' && preference.moduleId ? preference.moduleId : GOVEE_MODULE_ID;
}

async function listClimateSensors() {
  if (mongoose.connection.readyState !== 1) return [];
  const nodes = await sensorNodeService.listNodes();
  return nodes.filter((node) => node.capabilities.includes('climate') || ['air-station', 'climate', 'presence'].includes(node.profile));
}

function snapshotFromSensor(node, readings = node.latestReading?.readings, observedAt = node.lastReadingAt) {
  if (!readings || !observedAt) return null;
  const value = (key) => typeof readings[key] === 'number' && Number.isFinite(readings[key]) ? readings[key] : null;
  const temperatureC = value('temperature_c') ?? (value('temperature_f') === null ? null : (value('temperature_f') - 32) * 5 / 9);
  const temperatureF = value('temperature_f') ?? (temperatureC === null ? null : temperatureC * 9 / 5 + 32);
  return {
    id: node.id,
    moduleId: SENSOR_MODULE_ID,
    resourceId: node.id,
    sourceId: node.deviceId,
    sourceKey: node.deviceId ? `device:${node.deviceId}` : '',
    device: node.id,
    deviceName: node.name,
    deviceType: 'indoor_climate_sensor',
    source: 'homebrain-sensor',
    room: node.room,
    isOnline: node.status === 'online',
    observedAt: new Date(observedAt).toISOString(),
    temperatureC,
    temperatureF,
    humidityPct: value('humidity_pct'),
    pm25UgM3: value('pm2_5_ugm3'),
    co2Ppm: value('co2_ppm'),
    // A gas resistance or VOC trend score is not a measured TVOC concentration.
    tvocPpb: value('tvoc_ppb'),
    ...describeAirQuality(null, value('pm2_5_ugm3')),
    metrics: readings
  };
}

async function getSelectedSensor(preference) {
  const nodes = await listClimateSensors();
  if (preference.resourceId) return nodes.find((node) => node.id === preference.resourceId) || null;
  return nodes.sort((left, right) =>
    Number(right.status === 'online') - Number(left.status === 'online')
    || Number(right.profile === 'air-station') - Number(left.profile === 'air-station')
    || left.name.localeCompare(right.name))[0] || null;
}

async function getLatestSnapshot(preference) {
  const selection = preference || await getPreference();
  if (selectedModule(selection) === SENSOR_MODULE_ID) {
    const node = await getSelectedSensor(selection);
    return node ? snapshotFromSensor(node) : null;
  }
  if (selectedModule(selection) !== GOVEE_MODULE_ID) return null;
  const snapshot = await goveeAirQualityService.getLatestSnapshot();
  if (!snapshot) return null;
  const resourceId = [snapshot.sku, snapshot.device].filter(Boolean).join(':');
  if (selection.mode === 'selected' && selection.resourceId && selection.resourceId !== resourceId) return null;
  return { ...snapshot, moduleId: GOVEE_MODULE_ID, resourceId };
}

async function getDashboardData({ preference, ...options } = {}) {
  const selection = preference || await getPreference();
  if (selectedModule(selection) === GOVEE_MODULE_ID) {
    const data = await goveeAirQualityService.getDashboardData(options);
    const resourceId = [data.monitor?.sku, data.monitor?.device].filter(Boolean).join(':');
    if (selection.mode !== 'selected' || !selection.resourceId || selection.resourceId === resourceId) return data;
    return { available: false, monitor: null, samples: [], health: null };
  }
  const node = selectedModule(selection) === SENSOR_MODULE_ID ? await getSelectedSensor(selection) : null;
  const monitor = node ? snapshotFromSensor(node) : null;
  if (!monitor) return { available: false, monitor: null, samples: [], health: null };
  const hours = Math.max(1, Math.min(24 * 365, Number(options.hours) || 24));
  const limit = Math.max(1, Math.min(720, Math.floor(Number(options.limit) || 720)));
  const samples = node.deviceId ? await TelemetrySample.aggregate([
    { $match: {
      sourceKey: monitor.sourceKey,
      sourceType: 'device',
      streamType: 'device_state',
      recordedAt: { $gte: new Date(Date.now() - hours * 60 * 60 * 1000) },
      'metrics.online': { $ne: 0 }
    } },
    { $sort: { recordedAt: 1 } },
    { $bucketAuto: { groupBy: '$recordedAt', buckets: limit, output: { sample: { $last: '$$ROOT' } } } },
    { $replaceRoot: { newRoot: '$sample' } },
    { $sort: { recordedAt: 1 } }
  ]) : [];
  return {
    available: true,
    monitor,
    samples: samples.map((sample) => ({
      ...snapshotFromSensor(node, sample.metrics instanceof Map ? Object.fromEntries(sample.metrics) : sample.metrics, sample.recordedAt),
      id: String(sample._id)
    })),
    health: { isConnected: monitor.isOnline, lastSampleAt: monitor.observedAt }
  };
}

module.exports = { SENSOR_MODULE_ID, GOVEE_MODULE_ID, selectedModule, listClimateSensors, getLatestSnapshot, getDashboardData, snapshotFromSensor };
