const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const weatherService = require('../services/weatherService');

const auth = requireUser();

router.get('/current', auth, async (req, res) => {
  try {
    const weather = await weatherService.fetchDashboardWeather({
      latitude: req.query.latitude,
      longitude: req.query.longitude,
      address: req.query.address,
      label: req.query.label
    });

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
});

module.exports = router;
