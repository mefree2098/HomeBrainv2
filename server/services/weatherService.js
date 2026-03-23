const axios = require('axios');
const settingsService = require('./settingsService');

const WEATHER_LABELS = {
  0: { label: 'Clear', icon: 'sunny' },
  1: { label: 'Mostly Clear', icon: 'partly-cloudy' },
  2: { label: 'Partly Cloudy', icon: 'partly-cloudy' },
  3: { label: 'Overcast', icon: 'cloudy' },
  45: { label: 'Fog', icon: 'fog' },
  48: { label: 'Rime Fog', icon: 'fog' },
  51: { label: 'Light Drizzle', icon: 'drizzle' },
  53: { label: 'Drizzle', icon: 'drizzle' },
  55: { label: 'Heavy Drizzle', icon: 'drizzle' },
  56: { label: 'Freezing Drizzle', icon: 'sleet' },
  57: { label: 'Heavy Freezing Drizzle', icon: 'sleet' },
  61: { label: 'Light Rain', icon: 'rain' },
  63: { label: 'Rain', icon: 'rain' },
  65: { label: 'Heavy Rain', icon: 'rain' },
  66: { label: 'Freezing Rain', icon: 'sleet' },
  67: { label: 'Heavy Freezing Rain', icon: 'sleet' },
  71: { label: 'Light Snow', icon: 'snow' },
  73: { label: 'Snow', icon: 'snow' },
  75: { label: 'Heavy Snow', icon: 'snow' },
  77: { label: 'Snow Grains', icon: 'snow' },
  80: { label: 'Rain Showers', icon: 'rain' },
  81: { label: 'Heavy Showers', icon: 'rain' },
  82: { label: 'Violent Showers', icon: 'rain' },
  85: { label: 'Snow Showers', icon: 'snow' },
  86: { label: 'Heavy Snow Showers', icon: 'snow' },
  95: { label: 'Thunderstorm', icon: 'storm' },
  96: { label: 'Storm and Hail', icon: 'storm' },
  99: { label: 'Severe Storm', icon: 'storm' }
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

function normalizeCoordinates(latitude, longitude) {
  const lat = toNumber(latitude);
  const lon = toNumber(longitude);

  if (lat === null || lon === null) {
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  return { latitude: lat, longitude: lon };
}

function describeWeatherCode(code) {
  const normalizedCode = toNumber(code);
  if (normalizedCode === null) {
    return { label: 'Unknown', icon: 'cloudy' };
  }

  return WEATHER_LABELS[normalizedCode] || { label: 'Unknown', icon: 'cloudy' };
}

function buildLocationName(result, fallback = 'Saved location') {
  const pieces = [
    typeof result?.name === 'string' ? result.name.trim() : '',
    typeof result?.admin1 === 'string' ? result.admin1.trim() : '',
    typeof result?.country === 'string' ? result.country.trim() : ''
  ].filter(Boolean);

  if (pieces.length === 0) {
    return fallback;
  }

  return [...new Set(pieces)].join(', ');
}

function createWeatherPayload(forecastResponse, location) {
  const current = forecastResponse?.current || {};
  const daily = forecastResponse?.daily || {};
  const todayCode = Array.isArray(daily.weather_code) ? daily.weather_code[0] : current.weather_code;
  const currentDescriptor = describeWeatherCode(current.weather_code);
  const todayDescriptor = describeWeatherCode(todayCode);

  return {
    fetchedAt: new Date().toISOString(),
    location: {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: forecastResponse?.timezone || location.timezone || 'auto',
      source: location.source
    },
    current: {
      temperatureF: toNumber(current.temperature_2m),
      apparentTemperatureF: toNumber(current.apparent_temperature),
      humidity: toNumber(current.relative_humidity_2m),
      windSpeedMph: toNumber(current.wind_speed_10m),
      precipitationIn: toNumber(current.precipitation),
      isDay: current.is_day === 1,
      weatherCode: toNumber(current.weather_code),
      condition: currentDescriptor.label,
      icon: currentDescriptor.icon
    },
    today: {
      highF: Array.isArray(daily.temperature_2m_max) ? toNumber(daily.temperature_2m_max[0]) : null,
      lowF: Array.isArray(daily.temperature_2m_min) ? toNumber(daily.temperature_2m_min[0]) : null,
      precipitationChance: Array.isArray(daily.precipitation_probability_max) ? toNumber(daily.precipitation_probability_max[0]) : null,
      sunrise: Array.isArray(daily.sunrise) ? daily.sunrise[0] || null : null,
      sunset: Array.isArray(daily.sunset) ? daily.sunset[0] || null : null,
      weatherCode: toNumber(todayCode),
      condition: todayDescriptor.label,
      icon: todayDescriptor.icon
    }
  };
}

async function geocodeLocation(query, source) {
  const response = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
    params: {
      name: query,
      count: 1,
      language: 'en',
      format: 'json'
    },
    timeout: 10000
  });

  const result = Array.isArray(response?.data?.results) ? response.data.results[0] : null;
  if (!result) {
    throw new Error(`Unable to resolve weather location for "${query}".`);
  }

  return {
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone || null,
    name: buildLocationName(result, query),
    source
  };
}

async function resolveWeatherLocation({ latitude, longitude, address, label }) {
  const coordinates = normalizeCoordinates(latitude, longitude);
  if (coordinates) {
    return {
      ...coordinates,
      timezone: null,
      name: typeof label === 'string' && label.trim() ? label.trim() : 'Current location',
      source: 'auto'
    };
  }

  const trimmedAddress = typeof address === 'string' ? address.trim() : '';
  if (trimmedAddress) {
    return geocodeLocation(trimmedAddress, 'custom');
  }

  const savedLocation = await settingsService.getSetting('location');
  if (typeof savedLocation === 'string' && savedLocation.trim()) {
    return geocodeLocation(savedLocation.trim(), 'saved');
  }

  throw new Error('No weather location is configured. Add an address in Settings or choose a custom/auto weather source.');
}

async function fetchDashboardWeather(options = {}) {
  const location = await resolveWeatherLocation(options);
  const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: location.latitude,
      longitude: location.longitude,
      current: [
        'temperature_2m',
        'relative_humidity_2m',
        'apparent_temperature',
        'is_day',
        'precipitation',
        'weather_code',
        'wind_speed_10m'
      ].join(','),
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'sunrise',
        'sunset'
      ].join(','),
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto',
      forecast_days: 1
    },
    timeout: 10000
  });

  return createWeatherPayload(response.data, location);
}

module.exports = {
  createWeatherPayload,
  describeWeatherCode,
  fetchDashboardWeather,
  normalizeCoordinates
};
