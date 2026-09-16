const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplianceService, _test: { stateUpdate, validateLocalIp } } = require('../services/applianceService');
const { acCapabilities, acProperties, resolveAcDirective, temperatureInFahrenheit } = require('../../shared/alexa/appliances');
const { AlexaBridgeService, normalizeDirectivePayload } = require('../services/alexaBridgeService');
const deviceService = require('../services/deviceService');

const ac = { _id: 'ac-1', name: 'TheaterAC', type: 'thermostat', properties: { source: 'midea', appliance: {
  mode: 'dry', fanSpeed: 'high', swing: 'off', eco: true, capabilities: { modes: ['off', 'auto', 'cool', 'dry', 'heat', 'fan'], fanSpeeds: ['auto', 'high', 'low'], swings: ['off', 'vertical'], eco: true }
} } };

test('offline appliance readings preserve the last observed power and temperature without advancing lastSeen', () => {
  const changes = stateUpdate('midea', { id: '123', online: false, error: 'timeout' }, { status: true, targetTemperature: 74 });
  assert.equal(changes.isOnline, false);
  for (const key of ['status', 'lastSeen', 'targetTemperature', 'properties.appliance']) assert.equal(changes[key], undefined);
});

test('LAN discovery rejects public, loopback, malformed, and metadata addresses', () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '8.8.8.8', 'localhost', '192.168.1.1; echo bad']) assert.throws(() => validateLocalIp(ip));
  assert.equal(validateLocalIp('192.168.2.63'), '192.168.2.63');
});

test('polling and commands serialize per appliance provider, including after a failure', async () => {
  const service = new ApplianceService();
  const seen = [];
  let release;
  const first = service.serial('midea', async () => { seen.push('poll'); await new Promise((resolve) => { release = resolve; }); throw new Error('offline'); });
  const observedFailure = assert.rejects(first, /offline/);
  const second = service.serial('midea', async () => { seen.push('command'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['poll']);
  release(); await observedFailure; await second;
  assert.deepEqual(seen, ['poll', 'command']);
});

test('Alexa exposes and reports exact dry/fan modes and only supported appliance settings', () => {
  const caps = acCapabilities(ac);
  assert.equal(caps.length, 4);
  assert.ok(caps[0].configuration.supportedModes.some((m) => m.value === 'dry'));
  assert.ok(caps[0].configuration.supportedModes.some((m) => m.value === 'fan'));
  assert.equal(acProperties(ac)[0].value, 'dry');
  assert.deepEqual(resolveAcDirective(ac, 'Alexa.ModeController', 'SetMode', 'HomeBrain.AC.Mode', { mode: 'fan' }), { action: 'set_mode', value: 'fan' });
  assert.throws(() => resolveAcDirective(ac, 'Alexa.ModeController', 'SetMode', 'HomeBrain.AC.Mode', { mode: 'steam' }));
  assert.throws(() => resolveAcDirective(ac, 'Alexa.ToggleController', 'TurnOn', 'HomeBrain.AC.turbo', {}));
});

test('Alexa converts Celsius absolute and relative temperatures and preserves the controller instance', () => {
  assert.equal(temperatureInFahrenheit({ value: 20, scale: 'CELSIUS' }), 68);
  assert.equal(temperatureInFahrenheit({ value: 2, scale: 'CELSIUS' }, { delta: true }), 3.6);
  assert.equal(temperatureInFahrenheit({ value: 72, scale: 'FAHRENHEIT' }), 72);
  assert.throws(() => temperatureInFahrenheit({ value: null, scale: 'FAHRENHEIT' }));
  assert.equal(normalizeDirectivePayload({ directive: { header: { instance: 'HomeBrain.AC.Fan' } } }).instance, 'HomeBrain.AC.Fan');
});

test('Alexa routes AC mode, fan, power, and temperature directives to the shared device control path', async (t) => {
  const original = deviceService.controlDevice;
  t.after(() => { deviceService.controlDevice = original; });
  const received = [];
  deviceService.controlDevice = async (id, action, value) => received.push({ id, action, value });
  const bridge = new AlexaBridgeService();
  const record = { exposure: { entityId: 'ac-1' }, entity: ac, endpoint: { state: { properties: [] } } };
  await bridge.executeDeviceDirective(record, 'Alexa.PowerController', 'TurnOff', {});
  await bridge.executeDeviceDirective(record, 'Alexa.ThermostatController', 'SetTargetTemperature', { targetSetpoint: { value: 20, scale: 'CELSIUS' } });
  await bridge.executeDeviceDirective(record, 'Alexa.ModeController', 'SetMode', { mode: 'fan' }, 'HomeBrain.AC.Mode');
  await bridge.executeDeviceDirective(record, 'Alexa.ModeController', 'SetMode', { mode: 'low' }, 'HomeBrain.AC.Fan');
  assert.deepEqual(received, [
    { id: 'ac-1', action: 'turn_off', value: undefined }, { id: 'ac-1', action: 'set_temperature', value: 68 },
    { id: 'ac-1', action: 'set_mode', value: 'fan' }, { id: 'ac-1', action: 'set_fan_speed', value: 'low' }
  ]);
});
