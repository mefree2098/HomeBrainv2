const WATCH_SECTIONS = Object.freeze(['security', 'lights', 'power', 'weather']);

const DEFAULT_WATCH_PREFERENCES = Object.freeze({
  sections: WATCH_SECTIONS,
  primaryRoom: '',
  lightDeviceIds: [],
  defaultLightBrightness: 70
});

function normalizeString(value, maxLength = 120) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function normalizeSections(value) {
  const requestedSections = Array.isArray(value) ? value : DEFAULT_WATCH_PREFERENCES.sections;
  const seen = new Set();
  const normalized = [];

  for (const entry of requestedSections) {
    const section = normalizeString(entry, 40).toLowerCase();
    if (!WATCH_SECTIONS.includes(section) || seen.has(section)) {
      continue;
    }

    seen.add(section);
    normalized.push(section);
  }

  return normalized.length > 0 ? normalized : [...DEFAULT_WATCH_PREFERENCES.sections];
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const entry of value) {
    const id = normalizeString(entry, 120);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);
  }

  return normalized.slice(0, 50);
}

function normalizeBrightness(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WATCH_PREFERENCES.defaultLightBrightness;
  }

  return Math.max(1, Math.min(100, Math.round(parsed)));
}

function normalizeWatchPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    sections: normalizeSections(source.sections),
    primaryRoom: normalizeString(source.primaryRoom, 120),
    lightDeviceIds: normalizeIdList(source.lightDeviceIds),
    defaultLightBrightness: normalizeBrightness(source.defaultLightBrightness)
  };
}

module.exports = {
  WATCH_SECTIONS,
  DEFAULT_WATCH_PREFERENCES,
  normalizeWatchPreferences
};
