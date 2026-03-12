const express = require('express');

const { requireUser } = require('./middlewares/auth');
const { ROLES } = require('../../shared/config/roles');
const reverseProxyService = require('../services/reverseProxyService');

const router = express.Router();

router.use(requireUser([ROLES.ADMIN]));

router.get('/routes', async (req, res) => {
  try {
    const routes = await reverseProxyService.listRoutes();
    return res.status(200).json({
      success: true,
      routes
    });
  } catch (error) {
    console.error('GET /api/admin/reverse-proxy/routes - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to list reverse-proxy routes'
    });
  }
});

router.post('/routes', async (req, res) => {
  try {
    const route = await reverseProxyService.createRoute(req.body || {}, req.user?.email || req.user?._id || 'unknown');
    return res.status(201).json({
      success: true,
      route
    });
  } catch (error) {
    console.error('POST /api/admin/reverse-proxy/routes - Error:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to create reverse-proxy route'
    });
  }
});

router.put('/routes/:id', async (req, res) => {
  try {
    const route = await reverseProxyService.updateRoute(req.params.id, req.body || {}, req.user?.email || req.user?._id || 'unknown');
    return res.status(200).json({
      success: true,
      route
    });
  } catch (error) {
    console.error(`PUT /api/admin/reverse-proxy/routes/${req.params.id} - Error:`, error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update reverse-proxy route'
    });
  }
});

router.delete('/routes/:id', async (req, res) => {
  try {
    const result = await reverseProxyService.deleteRoute(req.params.id, req.user?.email || req.user?._id || 'unknown');
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error(`DELETE /api/admin/reverse-proxy/routes/${req.params.id} - Error:`, error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to delete reverse-proxy route'
    });
  }
});

router.post('/validate', async (req, res) => {
  try {
    const routes = await reverseProxyService.validateAllRoutes(req.user?.email || req.user?._id || 'unknown');
    return res.status(200).json({
      success: true,
      routes
    });
  } catch (error) {
    console.error('POST /api/admin/reverse-proxy/validate - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to validate reverse-proxy routes'
    });
  }
});

router.post('/apply', async (req, res) => {
  try {
    const result = await reverseProxyService.applyConfig(req.user?.email || req.user?._id || 'unknown');
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('POST /api/admin/reverse-proxy/apply - Error:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to apply reverse-proxy config'
    });
  }
});

router.get('/status', async (_req, res) => {
  try {
    const status = await reverseProxyService.getStatus();
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('GET /api/admin/reverse-proxy/status - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch reverse-proxy status'
    });
  }
});

router.get('/certificates', async (_req, res) => {
  try {
    const certificates = await reverseProxyService.getCertificates();
    return res.status(200).json({
      success: true,
      certificates
    });
  } catch (error) {
    console.error('GET /api/admin/reverse-proxy/certificates - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch reverse-proxy certificate status'
    });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const settings = await reverseProxyService.updateSettings(req.body || {}, req.user?.email || req.user?._id || 'unknown');
    return res.status(200).json({
      success: true,
      settings
    });
  } catch (error) {
    console.error('PUT /api/admin/reverse-proxy/settings - Error:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update reverse-proxy settings'
    });
  }
});

router.get('/audit', async (_req, res) => {
  try {
    const auditLogs = await reverseProxyService.listAuditLogs(50);
    return res.status(200).json({
      success: true,
      auditLogs
    });
  } catch (error) {
    console.error('GET /api/admin/reverse-proxy/audit - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch reverse-proxy audit logs'
    });
  }
});

module.exports = router;
