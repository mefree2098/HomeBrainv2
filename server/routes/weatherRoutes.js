const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const weatherService = require('../services/weatherService');

const auth = requireUser();

const getWeatherInput = (req) => (req.method === 'GET' ? req.query : (req.body || {}));

const handleCurrentWeather = async (req, res) => {
  try {
    const input = getWeatherInput(req);
    const weather = await weatherService.fetchDashboardWeather({
      latitude: input.latitude,
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
      latitude: input.latitude,
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
// GET remains for compatibility with older installed HomeBrain clients.
router.get('/current', auth, handleCurrentWeather);
router.post('/current', auth, handleCurrentWeather);
router.get('/dashboard', auth, handleWeatherDashboard);
router.post('/dashboard', auth, handleWeatherDashboard);

module.exports = router;
