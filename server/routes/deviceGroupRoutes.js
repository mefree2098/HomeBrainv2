const express = require('express');
const router = express.Router();
const deviceGroupService = require('../services/deviceGroupService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

router.use(requireUser());
const admin = requireAdmin();

router.get('/', async (req, res) => {
  try {
    const groups = await deviceGroupService.listGroups();
    return res.status(200).json({
      success: true,
      message: 'Device groups fetched successfully',
      data: { groups }
    });
  } catch (error) {
    console.error('GET /api/device-groups - Error:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch device groups'
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const group = await deviceGroupService.getGroupById(req.params.id);
    return res.status(200).json({
      success: true,
      message: 'Device group fetched successfully',
      data: { group }
    });
  } catch (error) {
    console.error(`GET /api/device-groups/${req.params.id} - Error:`, error.message);
    console.error(error.stack);
    const statusCode = error.message.includes('Invalid')
      ? 400
      : error.message.includes('not found')
        ? 404
        : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch device group'
    });
  }
});

router.post('/', admin, async (req, res) => {
  try {
    const group = await deviceGroupService.createGroup(req.body || {});
    return res.status(201).json({
      success: true,
      message: `Device group "${group.name}" created successfully`,
      data: { group }
    });
  } catch (error) {
    console.error('POST /api/device-groups - Error:', error.message);
    console.error(error.stack);
    const statusCode = error.message.includes('required') || error.message.includes('already exists')
      ? 400
      : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to create device group'
    });
  }
});

router.put('/:id', admin, async (req, res) => {
  try {
    const group = await deviceGroupService.updateGroup(req.params.id, req.body || {});
    return res.status(200).json({
      success: true,
      message: `Device group "${group.name}" updated successfully`,
      data: { group }
    });
  } catch (error) {
    console.error(`PUT /api/device-groups/${req.params.id} - Error:`, error.message);
    console.error(error.stack);
    const statusCode = error.message.includes('Invalid')
      || error.message.includes('required')
      || error.message.includes('already exists')
        ? 400
        : error.message.includes('not found')
          ? 404
          : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update device group'
    });
  }
});

router.put('/:id/devices', admin, async (req, res) => {
  try {
    const group = await deviceGroupService.setGroupDevices(req.params.id, req.body?.deviceIds || []);
    return res.status(200).json({
      success: true,
      message: `Updated device membership for "${group.name}"`,
      data: { group }
    });
  } catch (error) {
    console.error(`PUT /api/device-groups/${req.params.id}/devices - Error:`, error.message);
    console.error(error.stack);
    const statusCode = error.message.includes('Invalid')
      || error.message.includes('Unknown device IDs')
        ? 400
        : error.message.includes('not found')
          ? 404
          : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update device group membership'
    });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await deviceGroupService.deleteGroup(req.params.id);
    return res.status(200).json({
      success: true,
      message: `Device group "${result.group.name}" deleted successfully`,
      data: { group: result.group }
    });
  } catch (error) {
    console.error(`DELETE /api/device-groups/${req.params.id} - Error:`, error.message);
    console.error(error.stack);
    const statusCode = error.message.includes('Invalid')
      || error.message.includes('Cannot delete')
        ? 400
        : error.message.includes('not found')
          ? 404
          : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete device group'
    });
  }
});

module.exports = router;
