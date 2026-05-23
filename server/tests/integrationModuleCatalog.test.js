const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decorateTelemetrySourceSummary,
  getModuleDefinition,
  getModulesForCapability
} = require('../services/integrationModuleCatalog');
const integrationRegistryService = require('../services/integrationRegistryService');

test('integration catalog maps climate capabilities to provider modules', () => {
  const outdoorProviders = getModulesForCapability('outdoor_climate');
  const indoorProviders = getModulesForCapability('indoor_climate');

  assert.equal(outdoorProviders.some((module) => module.id === 'tempest'), true);
  assert.equal(indoorProviders.some((module) => module.id === 'govee-indoor-air'), true);
  assert.deepEqual(getModuleDefinition('govee-indoor-air').deviceTypes, [
    'indoor_climate_sensor',
    'air_quality_monitor'
  ]);
});

test('telemetry summaries are decorated with owning module metadata', () => {
  const decorated = decorateTelemetrySourceSummary({
    sourceKey: 'govee_air_quality:abc123',
    sourceType: 'govee_air_quality',
    sourceId: 'abc123',
    name: 'Kitchen Air',
    category: 'Indoor Air',
    room: 'Kitchen',
    origin: 'govee',
    streamType: 'govee_air_quality_sample',
    sampleCount: 42,
    streamCounts: {},
    metricCount: 3,
    lastSampleAt: null,
    availableMetrics: [],
    featuredMetricKeys: [],
    lastValues: {}
  });

  assert.equal(decorated.integrationModuleId, 'govee-indoor-air');
  assert.equal(decorated.integrationCategory, 'Climate');
  assert.equal(decorated.capabilities.includes('indoor_climate'), true);
  assert.equal(decorated.deviceTypes.includes('air_quality_monitor'), true);
});

test('integration preferences normalize selected and auto modes safely', () => {
  assert.deepEqual(integrationRegistryService.normalizeIntegrationPreferences({
    capabilities: {
      indoor_climate: {
        mode: 'selected',
        moduleId: 'govee-indoor-air',
        resourceId: 'H5106:AA'
      },
      outdoor_climate: {
        mode: 'surprise',
        moduleId: 'tempest',
        resourceId: '123'
      }
    }
  }), {
    capabilities: {
      indoor_climate: {
        mode: 'selected',
        moduleId: 'govee-indoor-air',
        resourceId: 'H5106:AA',
        updatedAt: null
      },
      outdoor_climate: {
        mode: 'auto',
        moduleId: '',
        resourceId: '',
        updatedAt: null
      }
    }
  });
});
