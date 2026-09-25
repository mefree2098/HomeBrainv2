const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const axios = require('axios');
const Settings = require('../models/Settings');
const TelemetrySample = require('../models/TelemetrySample');
const sensorNodeService = require('../services/sensorNodeService');
const goveeAirQualityService = require('../services/goveeAirQualityService');
const tempestService = require('../services/tempestService');
const registry = require('../services/integrationRegistryService');
const indoorClimate = require('../services/indoorClimateService');
const weather = require('../services/weatherService');

const node = {
  id: 'atmosphere-node', deviceId: 'atmosphere-device', name: 'Living Room Atmosphere', room: 'Living Room',
  profile: 'air-station', capabilities: ['climate', 'co2', 'particulate'], status: 'online',
  lastReadingAt: '2026-09-25T00:20:00.000Z',
  latestReading: { readings: { temperature_c: 25, humidity_pct: 30, pm2_5_ugm3: 6, co2_ppm: 413, air_quality_score: 91, voc_trend_index: 89.4 } }
};
const preference = { mode: 'selected', moduleId: 'homebrain-sensors', resourceId: node.id };

function mockSensors(t, nodes = [node]) {
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
  t.after(() => { delete mongoose.connection.readyState; });
  t.mock.method(sensorNodeService, 'listNodes', async () => nodes);
}

test('Atmosphere maps real metrics, derives particulate AQI, and keeps VOC trend separate', () => {
  const snapshot = indoorClimate.snapshotFromSensor(node);
  assert.equal(snapshot.temperatureF, 77);
  assert.equal(snapshot.humidityPct, 30);
  assert.equal(snapshot.co2Ppm, 413);
  assert.equal(snapshot.usAqi, 33);
  assert.equal(snapshot.qualityLabel, 'Good');
  assert.equal(snapshot.tvocPpb, null);
  assert.equal(snapshot.sourceKey, 'device:atmosphere-device');
  assert.equal(snapshot.deviceName, 'Living Room Atmosphere');
  assert.equal(indoorClimate.snapshotFromSensor({ ...node, latestReading: null }), null);
  const climateOnly = indoorClimate.snapshotFromSensor(node, { temperature_c: 0, humidity_pct: 0 });
  assert.equal(climateOnly.temperatureF, 32);
  assert.equal(climateOnly.humidityPct, 0);
  assert.equal(climateOnly.usAqi, null);
});

test('a missing or offline selected sensor never silently substitutes Govee', async (t) => {
  mockSensors(t, [{ ...node, status: 'offline' }]);
  const govee = t.mock.method(goveeAirQualityService, 'getLatestSnapshot', async () => { throw new Error('Wrong provider'); });
  const snapshot = await indoorClimate.getLatestSnapshot(preference);
  assert.equal(snapshot.isOnline, false);
  assert.equal(snapshot.deviceName, node.name);
  assert.equal(await indoorClimate.getLatestSnapshot({ ...preference, resourceId: 'deleted' }), null);
  assert.equal(govee.mock.callCount(), 0);
});

test('Atmosphere history queries only the linked device and uses the same metric mapping', async (t) => {
  mockSensors(t);
  const aggregate = t.mock.method(TelemetrySample, 'aggregate', async () => [{
    _id: 'sample', recordedAt: node.lastReadingAt, metrics: node.latestReading.readings
  }]);
  const dashboard = await indoorClimate.getDashboardData({ preference, hours: 48, limit: 32 });
  const pipeline = aggregate.mock.calls[0].arguments[0];
  assert.equal(pipeline[0].$match.sourceKey, 'device:atmosphere-device');
  assert.equal(pipeline[0].$match.streamType, 'device_state');
  assert.deepEqual(pipeline[0].$match['metrics.online'], { $ne: 0 });
  assert.equal(pipeline[2].$bucketAuto.buckets, 32);
  assert.equal(dashboard.monitor.resourceId, node.id);
  assert.equal(dashboard.samples[0].temperatureF, 77);
  assert.equal(dashboard.samples[0].usAqi, 33);
});

test('provider choices expose climate sensors and reject invalid or unsupported selections before saving', async (t) => {
  mockSensors(t);
  t.mock.method(Settings, 'getSettings', async () => ({ integrationPreferences: { capabilities: {} } }));
  t.mock.method(goveeAirQualityService, 'getStatus', async () => ({ devices: [] }));
  const save = t.mock.method(Settings, 'updateSettings', async (input) => input);
  const providers = await registry.getCapabilityProviders('indoor_climate');
  assert.deepEqual(providers.modules.map((entry) => entry.id), ['homebrain-sensors', 'govee-indoor-air']);
  assert.equal(providers.resources[0].id, node.id);
  assert.equal(providers.resources[0].room, node.room);
  assert.equal(providers.resources[0].ipAddress, undefined);
  await assert.rejects(registry.updateCapabilityPreference('indoor_climate', { ...preference, resourceId: 'missing' }), /Refresh the source list/);
  await assert.rejects(registry.updateCapabilityPreference('indoor_climate', { ...preference, moduleId: 'ecobee' }), /supported indoor climate source/);
  assert.equal(save.mock.callCount(), 0);
  const saved = await registry.updateCapabilityPreference('indoor_climate', preference);
  assert.equal(saved.capabilities.indoor_climate.resourceId, node.id);
});

test('warm weather cache follows source switches and fresh Atmosphere readings without polling Govee', async (t) => {
  mockSensors(t);
  weather.__resetWeatherCachesForTests();
  t.after(() => weather.__resetWeatherCachesForTests());
  let selection = { mode: 'auto', moduleId: '', resourceId: '' };
  t.mock.method(registry, 'getCapabilityPreference', async (key) => key === 'indoor_climate' ? selection : { mode: 'auto' });
  t.mock.method(tempestService, 'getSelectedStationSnapshot', async () => null);
  t.mock.method(axios, 'get', async () => ({ data: {
    timezone: 'America/Denver', current: { temperature_2m: 68, us_aqi: 10 },
    daily: { weather_code: [0], temperature_2m_max: [75], temperature_2m_min: [50] }
  } }));
  t.mock.method(goveeAirQualityService, 'getLatestSnapshot', async () => ({
    sku: 'H5106', device: 'old', deviceName: 'Old monitor', temperatureF: 70, observedAt: new Date().toISOString()
  }));
  const sync = t.mock.method(goveeAirQualityService, 'syncNow', async () => { throw new Error('Wrong provider'); });
  const options = { latitude: 40, longitude: -111, label: 'Test' };
  assert.equal((await weather.fetchDashboardWeather(options)).indoorAir.monitor.temperatureF, 70);
  selection = preference;
  const payload = await weather.fetchDashboardWeather({ ...options, refreshIndoorAir: true });
  assert.equal(payload.indoorAir.monitor.temperatureF, 77);
  assert.equal(payload.sources.indoorClimate.moduleId, 'homebrain-sensors');
  assert.equal(payload.sources.indoorClimate.resourceId, node.id);
  assert.equal(payload.sources.indoorClimate.label, node.name);
  assert.equal(payload.climate.indoor.sourceKey, 'device:atmosphere-device');
  assert.equal(sync.mock.callCount(), 0);
  t.mock.method(sensorNodeService, 'listNodes', async () => [{ ...node, latestReading: { readings: { temperature_c: 26 } } }]);
  assert.equal((await weather.fetchDashboardWeather(options)).indoorAir.monitor.temperatureF, 78.8);
  selection = { ...preference, resourceId: 'deleted' };
  const missing = await weather.fetchDashboardWeather({ ...options, forceIndoorAirSync: true });
  assert.equal(missing.indoorAir.available, false);
  assert.equal(missing.sources.indoorClimate.live, false);
  assert.equal(sync.mock.callCount(), 0);
  selection = { mode: 'auto' };
  assert.equal((await weather.fetchDashboardWeather(options)).indoorAir.monitor.deviceName, 'Old monitor');
});
