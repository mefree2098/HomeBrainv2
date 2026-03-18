const express = require('express');

const router = express.Router();

const UserService = require('../services/userService.js');
const { requireAdmin } = require('./middlewares/auth.js');

router.use(requireAdmin());

router.get('/', async (_req, res) => {
  try {
    const users = await UserService.list();
    return res.status(200).json({
      success: true,
      users
    });
  } catch (error) {
    console.error('GET /api/users - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch users'
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await UserService.get(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    console.error(`GET /api/users/${req.params.id} - Error:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch user'
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const { email, password, name = '', role = 'user', isActive = true } = req.body || {};
    const user = await UserService.create({ email, password, name, role, isActive });

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      user
    });
  } catch (error) {
    console.error('POST /api/users - Error:', error.message);
    const statusCode = error.message?.includes('already exists')
      || error.message?.includes('required')
      || error.message?.includes('Role must')
      ? 400
      : 500;

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to create user'
    });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const currentUserId = String(req.user?._id || '');
    const updateData = { ...req.body };

    if (currentUserId === userId && updateData.isActive === false) {
      return res.status(400).json({
        success: false,
        message: 'You cannot deactivate your own account'
      });
    }

    const user = await UserService.updateUserDetails(userId, updateData);
    return res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user
    });
  } catch (error) {
    console.error(`PUT /api/users/${req.params.id} - Error:`, error.message);
    const statusCode = error.message?.includes('not found')
      ? 404
      : error.message?.includes('already exists')
        || error.message?.includes('required')
        || error.message?.includes('boolean')
        || error.message?.includes('Role must')
        || error.message?.includes('At least one active admin account is required')
        ? 400
        : 500;

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to update user'
    });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body || {};
    await UserService.setPasswordById(req.params.id, password);

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error(`POST /api/users/${req.params.id}/reset-password - Error:`, error.message);
    const statusCode = error.message?.includes('not found') ? 404 : error.message?.includes('required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to reset password'
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const currentUserId = String(req.user?._id || '');

    if (currentUserId === userId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account'
      });
    }

    const deleted = await UserService.delete(userId);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error(`DELETE /api/users/${req.params.id} - Error:`, error.message);
    const statusCode = error.message?.includes('At least one active admin account is required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to delete user'
    });
  }
});

module.exports = router;
