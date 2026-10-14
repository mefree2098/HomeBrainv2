const POSITIONS = Object.freeze([
  { id: 'topLeft', label: 'Top left', maxLines: 2 },
  { id: 'topCenter', label: 'Top center', maxLines: 1 },
  { id: 'topRight', label: 'Top right', maxLines: 2 },
  { id: 'bottomLeft', label: 'Bottom left', maxLines: 2 },
  { id: 'bottomCenter', label: 'Bottom center', maxLines: 1 },
  { id: 'bottomRight', label: 'Bottom right', maxLines: 2 }
]);

const METRICS = Object.freeze([
  ['time', 'Time'], ['date', 'Date'], ['dateTime', 'Time and date'],
  ['outsideTemperature', 'Outside temperature'], ['insideTemperature', 'Inside temperature'],
  ['outsideAqi', 'Outside air quality (US AQI)'], ['insideAqi', 'Inside air quality (US AQI)'],
  ['alarm', 'Alarm status'], ['forecast', 'Today’s forecast'],
  ['rain24h', 'Rainfall · last 24 hours'], ['lightning', 'Lightning · last 24 hours'],
  ['outsideHumidity', 'Outside humidity'], ['insideHumidity', 'Inside humidity'],
  ['co2', 'Indoor CO₂'], ['pm25', 'Indoor PM2.5'], ['wind', 'Wind'], ['uv', 'UV index'],
  ['sunrise', 'Sunrise'], ['sunset', 'Sunset'], ['text', 'Custom text']
].map(([id, label]) => ({ id, label })));
const metricIds = new Set(METRICS.map((metric) => metric.id));

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
  return value;
}

function number(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) {
    throw invalid(`${name} must be between ${min} and ${max}`);
  }
  return result;
}

function choice(value, fallback, values, name) {
  const result = value === undefined ? fallback : value;
  if (!values.includes(result)) throw invalid(`Unsupported ${name}`);
  return result;
}

function boolean(value, fallback, name) {
  if (value !== undefined && typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value === undefined ? fallback : value;
}

function text(value, fallback, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\r\n\u0000-\u001f]/.test(value)) {
    throw invalid(`${name} must be a single line of at most ${max} characters`);
  }
  return value.trim();
}

function normalizeConfig(input = {}) {
  object(input, 'Configuration');
  const timeZone = text(input.timeZone, 'America/Denver', 80, 'Time zone');
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { throw invalid('Use a valid IANA time zone'); }
  const sleep = object(input.sleep === undefined ? {} : input.sleep, 'Sleep schedule');
  const sleepStart = text(sleep.start, '22:00', 5, 'Sleep start');
  const sleepEnd = text(sleep.end, '07:00', 5, 'Sleep end');
  if (![sleepStart, sleepEnd].every((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw invalid('Sleep times must use HH:mm');
  if (sleepStart === sleepEnd) throw invalid('Sleep start and end must differ');
  const overlays = object(input.overlays === undefined ? {} : input.overlays, 'Overlays');
  if (Object.keys(overlays).some((key) => !POSITIONS.some((position) => position.id === key))) throw invalid('Unsupported overlay position');
  const defaults = { topLeft: ['time', 'date'], topRight: ['outsideTemperature', 'insideTemperature'] };
  const normalizedOverlays = {};
  for (const position of POSITIONS) {
    const slot = object(overlays[position.id] === undefined ? {} : overlays[position.id], position.label);
    const lines = slot.lines === undefined ? (defaults[position.id] || []).map((metric) => ({ metric })) : slot.lines;
    if (!Array.isArray(lines) || lines.length > position.maxLines) throw invalid(`${position.label} allows at most ${position.maxLines} line(s)`);
    const color = text(slot.color, '#ffffff', 7, 'Text color');
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw invalid('Text color must use #rrggbb');
    normalizedOverlays[position.id] = {
      enabled: boolean(slot.enabled, Boolean(defaults[position.id]), 'Overlay enabled'),
      lines: lines.map((line) => {
        object(line, 'Overlay line');
        if (!metricIds.has(line.metric)) throw invalid('Unsupported display information');
        return { metric: line.metric, label: text(line.label, '', 32, 'Label'), text: text(line.text, '', 120, 'Custom text') };
      }),
      font: choice(slot.font, 'sans', ['sans', 'display', 'mono'], 'font'),
      fontSize: number(slot.fontSize, 24, 14, 64, 'Font size'),
      color,
      textOpacity: number(slot.textOpacity, 0.95, 0.2, 1, 'Text opacity'),
      panelOpacity: number(slot.panelOpacity, 0.22, 0, 0.85, 'Background opacity')
    };
  }
  return {
    version: 1,
    timeZone,
    hour12: boolean(input.hour12, true, '12-hour clock'),
    orientation: choice(input.orientation, 'landscape', ['landscape', 'portrait'], 'orientation'),
    intervalSeconds: number(input.intervalSeconds, 30, 5, 86400, 'Photo interval'),
    transition: choice(input.transition, 'fade', ['fade', 'cut', 'slide'], 'transition'),
    transitionSeconds: number(input.transitionSeconds, 1, 0.2, 4, 'Transition duration'),
    fit: choice(input.fit, 'contain', ['contain', 'cover'], 'photo fit'),
    shuffle: boolean(input.shuffle, false, 'Shuffle'),
    paused: boolean(input.paused, false, 'Pause'),
    brightness: number(input.brightness, 100, 10, 100, 'Brightness'),
    margin: number(input.margin, 28, 8, 80, 'Edge margin'),
    sleep: { enabled: boolean(sleep.enabled, false, 'Sleep schedule enabled'), start: sleepStart, end: sleepEnd },
    overlays: normalizedOverlays
  };
}

module.exports = { POSITIONS, METRICS, normalizeConfig, invalid };
