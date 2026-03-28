const axios = require('axios');
const settingsService = require('./settingsService');
const tempestService = require('./tempestService');

const DEFAULT_FORECAST_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_AIR_QUALITY_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_GEOCODE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const forecastCache = new Map();
const airQualityCache = new Map();
const geocodeCache = new Map();

const US_STATE_ABBREVIATIONS = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia'
});

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

const parsePositiveInteger = (value, fallback) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
};

const FORECAST_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_FORECAST_CACHE_TTL_MS,
  DEFAULT_FORECAST_CACHE_TTL_MS
);
const AIR_QUALITY_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_AIR_QUALITY_CACHE_TTL_MS,
  DEFAULT_AIR_QUALITY_CACHE_TTL_MS
);
const GEOCODE_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_GEOCODE_CACHE_TTL_MS,
  DEFAULT_GEOCODE_CACHE_TTL_MS
);

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

function buildForecastCacheKey(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function buildAirQualityCacheKey(location) {
  return buildForecastCacheKey(location);
}

async function readThroughCache(cache, key, ttlMs, loader) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
      });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, {
    expiresAt: cached?.expiresAt || 0,
    promise,
    value: cached?.value
  });

  return promise;
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

function normalizeLocationQuery(query) {
  return typeof query === 'string'
    ? query
      .trim()
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s{2,}/g, ' ')
    : '';
}

function parseUsCityStateQuery(query) {
  const normalized = normalizeLocationQuery(query);
  const match = normalized.match(/^([^,]+),\s*([A-Za-z]{2})(?:,\s*(?:US|USA|United States))?$/i);
  if (!match) {
    return null;
  }

  const city = match[1]?.trim();
  const stateCode = match[2]?.trim().toUpperCase();
  const stateName = US_STATE_ABBREVIATIONS[stateCode];

  if (!city || !stateName) {
    return null;
  }

  return {
    city,
    stateCode,
    stateName,
    normalizedQuery: `${city}, ${stateName}, United States`
  };
}

function pickUsCityStateResult(results, parsedQuery) {
  if (!Array.isArray(results) || results.length === 0 || !parsedQuery) {
    return null;
  }

  const stateName = parsedQuery.stateName.toLowerCase();
  const stateCode = parsedQuery.stateCode.toLowerCase();

  return results.find((result) => {
    const admin1 = typeof result?.admin1 === 'string' ? result.admin1.trim().toLowerCase() : '';
    return admin1 === stateName || admin1 === stateCode;
  }) || null;
}

async function fetchGeocodeCandidates(params) {
  const response = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
    params: {
      count: 5,
      language: 'en',
      format: 'json',
      ...params
    },
    timeout: 10000
  });

  return Array.isArray(response?.data?.results) ? response.data.results : [];
}

function createWeatherPayload(forecastResponse, airQualityResponse, location) {
  const current = forecastResponse?.current || {};
  const daily = forecastResponse?.daily || {};
  const hourly = forecastResponse?.hourly || {};
  const airQualityCurrent = airQualityResponse?.current || {};
  const todayCode = Array.isArray(daily.weather_code) ? daily.weather_code[0] : current.weather_code;
  const currentDescriptor = describeWeatherCode(current.weather_code);
  const todayDescriptor = describeWeatherCode(todayCode);
  const hourlyTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const hourlyTemperatures = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const hourlyPrecipitation = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
  const hourlyWind = Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m : [];
  const hourlyCodes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];

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
      airQualityIndex: toNumber(airQualityCurrent.us_aqi),
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
    },
    hourlyForecast: hourlyTimes.slice(0, 24).map((time, index) => {
      const descriptor = describeWeatherCode(hourlyCodes[index]);
      return {
        time,
        temperatureF: toNumber(hourlyTemperatures[index]),
        precipitationChance: toNumber(hourlyPrecipitation[index]),
        windSpeedMph: toNumber(hourlyWind[index]),
        weatherCode: toNumber(hourlyCodes[index]),
        condition: descriptor.label,
        icon: descriptor.icon
      };
    })
  };
}

async function geocodeLocation(query, source) {
  const normalizedQuery = normalizeLocationQuery(query);
  const cacheKey = normalizedQuery.toLowerCase();
  const resolvedLocation = await readThroughCache(geocodeCache, cacheKey, GEOCODE_CACHE_TTL_MS, async () => {
    const exactMatches = await fetchGeocodeCandidates({ name: normalizedQuery });
    let result = exactMatches[0] || null;

    if (!result) {
      const parsedUsQuery = parseUsCityStateQuery(normalizedQuery);
      if (parsedUsQuery) {
        const usMatches = await fetchGeocodeCandidates({
          name: parsedUsQuery.city,
          countryCode: 'US'
        });
        result = pickUsCityStateResult(usMatches, parsedUsQuery) || usMatches[0] || null;
      }
    }

    if (!result) {
      throw new Error(`Unable to resolve weather location for "${normalizedQuery || query}".`);
    }

    return {
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone || null,
      name: buildLocationName(result, normalizedQuery || query)
    };
  });

  return {
    ...resolvedLocation,
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
  const forecastCacheKey = buildForecastCacheKey(location);
  const airQualityCacheKey = buildAirQualityCacheKey(location);
  const [forecastResponse, airQualityResponse, tempestStation] = await Promise.all([
    readThroughCache(forecastCache, forecastCacheKey, FORECAST_CACHE_TTL_MS, async () => {
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
          hourly: [
            'temperature_2m',
            'precipitation_probability',
            'weather_code',
            'wind_speed_10m'
          ].join(','),
          temperature_unit: 'fahrenheit',
          wind_speed_unit: 'mph',
          precipitation_unit: 'inch',
          timezone: 'auto',
          forecast_days: 2
        },
        timeout: 10000
      });

      return response.data;
    }),
    readThroughCache(airQualityCache, airQualityCacheKey, AIR_QUALITY_CACHE_TTL_MS, async () => {
      const response = await axios.get('https://air-quality-api.open-meteo.com/v1/air-quality', {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
          current: 'us_aqi',
          timezone: 'auto'
        },
        timeout: 10000
      });

      return response.data;
    }).catch(() => null),
    tempestService.getSelectedStationSnapshot().catch(() => null)
  ]);

  return {
    ...createWeatherPayload(forecastResponse, airQualityResponse, location),
    tempest: tempestStation
      ? {
          available: true,
          station: tempestStation
        }
      : {
          available: false,
          station: null
        }
  };
}

async function fetchWeatherDashboard(options = {}) {
  const [forecast, tempest] = await Promise.all([
    fetchDashboardWeather(options),
    tempestService.getDashboardData({
      hours: options.tempestHistoryHours || 24
    }).catch(() => ({
      available: false,
      station: null,
      observations: [],
      events: []
    }))
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    forecast,
    hourlyForecast: Array.isArray(forecast.hourlyForecast) ? forecast.hourlyForecast : [],
    tempest
  };
}

module.exports = {
  buildLocationName,
  createWeatherPayload,
  describeWeatherCode,
  fetchDashboardWeather,
  fetchWeatherDashboard,
  normalizeCoordinates,
  normalizeLocationQuery,
  parseUsCityStateQuery,
  pickUsCityStateResult
};
