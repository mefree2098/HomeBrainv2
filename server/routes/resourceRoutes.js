const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const resourceMonitorService = require('../services/resourceMonitorService');

// Description: Get current system resource utilization
// Endpoint: GET /api/resources/utilization
// Request: {}
// Response: { cpu: object, memory: object, disk: object, gpu: object, temperature: object, uptime: object, systemInfo: object }
router.get('/utilization', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/utilization - Fetching system utilization');

    const utilization = await resourceMonitorService.getUtilization();

    res.status(200).json(utilization);
  } catch (error) {
    console.error('Error fetching system utilization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get historical resource data
// Endpoint: GET /api/resources/history
// Request: { limit?: number }
// Response: { history: Array<{ timestamp: Date, cpu: object, memory: object, disk: object, ... }> }
router.get('/history', requireUser, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    console.log(`GET /api/resources/history - Fetching resource history (limit: ${limit})`);

    const history = resourceMonitorService.getHistory(limit);

    res.status(200).json({ history });
  } catch (error) {
    console.error('Error fetching resource history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get CPU usage
// Endpoint: GET /api/resources/cpu
// Request: {}
// Response: { usagePercent: number, cores: number, model: string, speed: number }
router.get('/cpu', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/cpu - Fetching CPU usage');

    const cpu = await resourceMonitorService.getCPUUsage();

    res.status(200).json(cpu);
  } catch (error) {
    console.error('Error fetching CPU usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get memory usage
// Endpoint: GET /api/resources/memory
// Request: {}
// Response: { total: number, used: number, free: number, usagePercent: number, totalGB: number, usedGB: number, freeGB: number }
router.get('/memory', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/memory - Fetching memory usage');

    const memory = resourceMonitorService.getMemoryUsage();

    res.status(200).json(memory);
  } catch (error) {
    console.error('Error fetching memory usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get disk usage
// Endpoint: GET /api/resources/disk
// Request: {}
// Response: { total: string, used: string, available: string, usagePercent: number, totalGB: number, usedGB: number, availableGB: number }
router.get('/disk', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/disk - Fetching disk usage');

    const disk = await resourceMonitorService.getDiskUsage();

    res.status(200).json(disk);
  } catch (error) {
    console.error('Error fetching disk usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get GPU usage (Jetson devices)
// Endpoint: GET /api/resources/gpu
// Request: {}
// Response: { available: boolean, usagePercent: number, type: string }
router.get('/gpu', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/gpu - Fetching GPU usage');

    const gpu = await resourceMonitorService.getGPUUsage();

    res.status(200).json(gpu);
  } catch (error) {
    console.error('Error fetching GPU usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get system temperature
// Endpoint: GET /api/resources/temperature
// Request: {}
// Response: { available: boolean, zones: Array, average: number, maximum: number, unit: string }
router.get('/temperature', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/temperature - Fetching system temperature');

    const temperature = await resourceMonitorService.getTemperature();

    res.status(200).json(temperature);
  } catch (error) {
    console.error('Error fetching temperature:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get system information
// Endpoint: GET /api/resources/system-info
// Request: {}
// Response: { platform: string, arch: string, hostname: string, release: string, type: string }
router.get('/system-info', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/system-info - Fetching system information');

    const systemInfo = await resourceMonitorService.getSystemInfo();

    res.status(200).json(systemInfo);
  } catch (error) {
    console.error('Error fetching system info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get process information
// Endpoint: GET /api/resources/process
// Request: {}
// Response: { pid: number, uptime: number, memory: object, cpuUsage: object }
router.get('/process', requireUser, async (req, res) => {
  try {
    console.log('GET /api/resources/process - Fetching process information');

    const processInfo = await resourceMonitorService.getProcessInfo();

    res.status(200).json(processInfo);
  } catch (error) {
    console.error('Error fetching process info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Clear resource history
// Endpoint: DELETE /api/resources/history
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/history', requireUser, async (req, res) => {
  try {
    console.log('DELETE /api/resources/history - Clearing resource history');

    const result = resourceMonitorService.clearHistory();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error clearing history:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
