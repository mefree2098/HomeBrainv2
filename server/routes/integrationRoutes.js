const express = require('express');
const router = express.Router();
const { requireAdmin, requireUser } = require('./middlewares/auth');
const integrationRegistryService = require('../services/integrationRegistryService');

const user = requireUser();
const admin = requireAdmin();

router.get('/', user, async (req, res) => {
  try {
    const catalog = await integrationRegistryService.getCatalog({
      includeStatus: req.query.includeStatus !== 'false'
    });

    return res.status(200).json({
      success: true,
      catalog
    });
  } catch (error) {
    console.error('IntegrationRoutes: Failed to load integration catalog:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load integration catalog'
    });
  }
});

router.get('/capabilities/:capabilityKey/providers', user, async (req, res) => {
  try {
    const data = await integrationRegistryService.getCapabilityProviders(req.params.capabilityKey);
    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('IntegrationRoutes: Failed to load capability providers:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to load integration providers'
    });
  }
});

router.put('/capabilities/:capabilityKey/preference', admin, async (req, res) => {
  try {
    const preferences = await integrationRegistryService.updateCapabilityPreference(
      req.params.capabilityKey,
      req.body || {}
    );

    const data = await integrationRegistryService.getCapabilityProviders(req.params.capabilityKey);
    return res.status(200).json({
      success: true,
      message: 'Integration preference updated',
      preferences,
      data
    });
  } catch (error) {
    console.error('IntegrationRoutes: Failed to update capability preference:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update integration preference'
    });
  }
});

router.put('/:moduleId/enabled', admin, async (req, res) => {
  try {
    const moduleStatus = await integrationRegistryService.updateModuleEnabled(
      req.params.moduleId,
      req.body?.enabled === true
    );

    return res.status(200).json({
      success: true,
      message: `${moduleStatus.label} ${moduleStatus.enabled ? 'enabled' : 'disabled'}`,
      module: moduleStatus
    });
  } catch (error) {
    console.error('IntegrationRoutes: Failed to update module enabled state:', error.message);
    return res.status(error.status || 400).json({
      success: false,
      message: error.message || 'Failed to update integration module'
    });
  }
});

module.exports = router;
