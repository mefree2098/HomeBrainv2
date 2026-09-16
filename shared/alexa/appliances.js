const MODE_INTERFACE = 'Alexa.ModeController';
const TOGGLE_INTERFACE = 'Alexa.ToggleController';

function acControllers(device) {
  if (device?.properties?.source !== 'midea') return [];
  const state = device.properties.appliance || {};
  const caps = state.capabilities || {};
  return [
    { instance: 'HomeBrain.AC.Mode', label: 'operating mode', action: 'set_mode', values: caps.modes, current: state.mode },
    { instance: 'HomeBrain.AC.Fan', label: 'fan speed', action: 'set_fan_speed', values: caps.fanSpeeds, current: state.fanSpeed },
    { instance: 'HomeBrain.AC.Swing', label: 'swing', action: 'set_swing', values: caps.swings, current: state.swing },
    ...['eco', 'turbo', 'sleep'].filter((key) => caps[key]).map((key) => ({ instance: `HomeBrain.AC.${key}`, label: key, action: `set_${key}`, toggle: true, current: state[key] }))
  ].filter((entry) => entry.toggle || (Array.isArray(entry.values) && entry.values.length >= 2));
}

const friendlyNames = (text) => [{ '@type': 'text', value: { text: text.replaceAll('_', ' '), locale: 'en-US' } }];

function acCapabilities(device) {
  return acControllers(device).map((entry) => ({
    type: 'AlexaInterface', interface: entry.toggle ? TOGGLE_INTERFACE : MODE_INTERFACE,
    version: '3', instance: entry.instance,
    properties: { supported: [{ name: entry.toggle ? 'toggleState' : 'mode' }], proactivelyReported: true, retrievable: true },
    capabilityResources: { friendlyNames: friendlyNames(entry.label) },
    ...(entry.toggle ? {} : { configuration: { ordered: false, supportedModes: entry.values.map((value) => ({ value, modeResources: { friendlyNames: friendlyNames(value) } })) } })
  }));
}

function acProperties(device) {
  return acControllers(device).filter((entry) => entry.current !== undefined && entry.current !== null && (entry.toggle || entry.values.includes(entry.current))).map((entry) => ({
    namespace: entry.toggle ? TOGGLE_INTERFACE : MODE_INTERFACE, instance: entry.instance,
    name: entry.toggle ? 'toggleState' : 'mode', value: entry.toggle ? (entry.current ? 'ON' : 'OFF') : entry.current,
    timeOfSample: device.properties.appliance.observedAt || device.lastSeen || new Date().toISOString(), uncertaintyInMilliseconds: 60000
  }));
}

function resolveAcDirective(device, namespace, name, instance, payload) {
  const controller = acControllers(device).find((entry) => entry.instance === instance);
  if (!controller || namespace !== (controller.toggle ? TOGGLE_INTERFACE : MODE_INTERFACE)) throw new Error('Unsupported AC control instance');
  if (controller.toggle && ['TurnOn', 'TurnOff'].includes(name)) return { action: controller.action, value: name === 'TurnOn' };
  if (!controller.toggle && name === 'SetMode' && controller.values.includes(payload.mode)) return { action: controller.action, value: payload.mode };
  throw new Error('Unsupported AC mode or directive');
}

function temperatureInFahrenheit(temperature, { delta = false } = {}) {
  if (temperature?.value == null || typeof temperature.value !== 'number' || !Number.isFinite(temperature.value)) throw new Error('A finite temperature is required');
  if (temperature.scale === 'CELSIUS') return temperature.value * 1.8 + (delta ? 0 : 32);
  if (temperature.scale === 'FAHRENHEIT') return temperature.value;
  throw new Error('Unsupported temperature scale');
}

module.exports = { acCapabilities, acProperties, resolveAcDirective, temperatureInFahrenheit };
