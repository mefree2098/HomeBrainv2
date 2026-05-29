'use strict';

// Unit/value conversions (battery, color, temperature, mireds), extracted from
// directRadioService.js (Phase 5b). Pure functions; no engine state.

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeZWaveBatteryReport(value, options = {}) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return {
      level: null,
      low: false,
      pending: options.pendingWhenMissing === true
    };
  }

  if (numeric === 255) {
    return {
      level: 1,
      low: true,
      pending: false
    };
  }

  if (numeric === 0 && options.zeroIsUnknown === true) {
    return {
      level: null,
      low: false,
      pending: true
    };
  }

  const level = clampPercent(numeric);
  return {
    level,
    low: level !== null && level <= 5,
    pending: false
  };
}

function hexToRgbPercent(color) {
  const normalized = trimString(color).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return null;
  }

  return {
    red: Math.round((parseInt(normalized.slice(0, 2), 16) / 255) * 255),
    green: Math.round((parseInt(normalized.slice(2, 4), 16) / 255) * 255),
    blue: Math.round((parseInt(normalized.slice(4, 6), 16) / 255) * 255)
  };
}

function kelvinToMired(kelvin) {
  const numeric = Number(kelvin);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(1000000 / numeric);
}

function miredToKelvin(mired) {
  const numeric = Number(mired);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.round(1000000 / numeric);
}

function roundTo(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
}

function celsiusToFahrenheit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return roundTo((numeric * 9) / 5 + 32, 1);
}

module.exports = {
  toFiniteNumber,
  clampPercent,
  normalizeZWaveBatteryReport,
  hexToRgbPercent,
  kelvinToMired,
  miredToKelvin,
  roundTo,
  celsiusToFahrenheit
};
