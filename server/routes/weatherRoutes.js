const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const weatherService = require('../services/weatherService');

const auth = requireUser();
const LEGACY_WEATHER_CLIENT_TYPES = new Set(['ios', 'watchos', 'web']);

const getWeatherInput = (req) => (req.method === 'GET' ? req.query : (req.body || {}));

const requireLegacyWeatherClient = (req, res, next) => {
  const clientType = String(req.get('X-HomeBrain-Client-Type') || '').trim().toLowerCase();
  if (!LEGACY_WEATHER_CLIENT_TYPES.has(clientType)) {
    res.set('Allow', 'POST');
    return res.status(405).json({
      success: false,
      message: 'Weather location requests must use POST so addresses and coordinates stay out of request URLs.'
    });
  }

  res.set('Deprecation', 'true');
  res.set('Cache-Control', 'private, no-store');
  return next();
};

const handleCurrentWeather = async (req, res) => {
  try {
    const input = getWeatherInput(req);
    const weather = await weatherService.fetchDashboardWeather({
      // codeql[js/sensitive-get-query] Authenticated legacy clients require GET until installed/open builds migrate; current clients send this field in a POST body.
      latitude: input.latitude,
      // codeql[js/sensitive-get-query] Authenticated legacy clients require GET until installed/open builds migrate; current clients send this field in a POST body.
      longitude: input.longitude,
      address: input.address,
      label: input.label,
      forceTempestSync: input.forceTempestSync,
      forceIndoorAirSync: input.forceIndoorAirSync,
      includeModuleTelemetry: input.includeModuleTelemetry,
      refreshIndoorAir: input.refreshIndoorAir
    });

    res.set('Cache-Control', 'private, no-store');
    res.status(200).json({
      success: true,
      weather
    });
  } catch (error) {
    const statusCode = /No weather location|Unable to resolve weather location/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load weather data'
    });
  }
};

const handleWeatherDashboard = async (req, res) => {
  try {
    const input = getWeatherInput(req);
    const dashboard = await weatherService.fetchWeatherDashboard({
      // codeql[js/sensitive-get-query] Authenticated legacy clients require GET until installed/open builds migrate; current clients send this field in a POST body.
      latitude: input.latitude,
      // codeql[js/sensitive-get-query] Authenticated legacy clients require GET until installed/open builds migrate; current clients send this field in a POST body.
      longitude: input.longitude,
      address: input.address,
      label: input.label,
      clientType: req.get('X-HomeBrain-Client-Type'),
      tempestHistoryHours: input.tempestHistoryHours,
      indoorAirHistoryHours: input.indoorAirHistoryHours,
      historyPointLimit: input.historyPointLimit,
      compact: input.compact,
      forceTempestSync: input.forceTempestSync,
      forceIndoorAirSync: input.forceIndoorAirSync,
      includeModuleTelemetry: input.includeModuleTelemetry,
      refreshIndoorAir: input.refreshIndoorAir
    });

    res.set('Cache-Control', 'private, no-store');
    res.status(200).json({
      success: true,
      dashboard
    });
  } catch (error) {
    const statusCode = /No weather location|Unable to resolve weather location/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load weather dashboard'
    });
  }
};

// POST keeps precise addresses and coordinates out of request URLs and access logs.
// Authenticated GET remains temporarily for installed/open client builds that predate POST support.
router.get('/current', auth, requireLegacyWeatherClient, handleCurrentWeather);
router.post('/current', auth, handleCurrentWeather);
router.get('/dashboard', auth, requireLegacyWeatherClient, handleWeatherDashboard);
router.post('/dashboard', auth, handleWeatherDashboard);

module.exports = router;
module.exports.__private__ = {
  getWeatherInput,
  requireLegacyWeatherClient
};
