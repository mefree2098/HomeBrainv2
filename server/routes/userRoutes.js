const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const UserService = require('../services/userService.js');
const reviewSandboxService = require('../services/reviewSandboxService.js');
const HomeBrainNotification = require('../models/HomeBrainNotification');
const PushSubscription = require('../models/PushSubscription');
const UserSession = require('../models/UserSession');
const { requireAdmin } = require('./middlewares/auth.js');
const { USER_PLATFORMS, normalizeUserPlatforms } = require('../utils/userPlatforms');
const { ROLES } = require('../../shared/config/roles');

const { ipKeyGenerator } = rateLimit;
const adminUserRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_ADMIN_USER_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)),
  limit: Math.max(30, Number(process.env.HOMEBRAIN_ADMIN_USER_RATE_LIMIT_MAX || 240)),
  keyGenerator: (req) => typeof ipKeyGenerator === 'function'
    ? ipKeyGenerator(req.ip)
    : (req.ip || req.socket?.remoteAddress || 'unknown'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many user-management requests. Please retry shortly.'
  }
});

router.use(adminUserRateLimit);
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
    console.error('%s', `GET /api/users/${req.params.id} - Error:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch user'
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      email,
      password,
      name = '',
      role = 'user',
      isActive = true,
      isReadOnly = false,
      platforms
    } = req.body || {};
    const user = await UserService.create({ email, password, name, role, isActive, isReadOnly, platforms });

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

    if (currentUserId === userId && updateData.isReadOnly === true) {
      return res.status(400).json({
        success: false,
        message: 'You cannot make your own account read-only'
      });
    }

    if (currentUserId === userId && Object.prototype.hasOwnProperty.call(updateData, 'role') && updateData.role !== req.user?.role) {
      return res.status(400).json({
        success: false,
        message: 'You cannot change your own role'
      });
    }

    if (currentUserId === userId && Object.prototype.hasOwnProperty.call(updateData, 'platforms')) {
      const nextPlatforms = normalizeUserPlatforms(updateData.platforms);
      if (!nextPlatforms[USER_PLATFORMS.HOMEBRAIN]) {
        return res.status(400).json({
          success: false,
          message: 'You cannot remove your own HomeBrain access'
        });
      }
    }

    const user = await UserService.updateUserDetails(userId, updateData);
    return res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user
    });
  } catch (error) {
    console.error('%s', `PUT /api/users/${req.params.id} - Error:`, error.message);
    const statusCode = error.message?.includes('not found')
      ? 404
      : error.message?.includes('already exists')
        || error.message?.includes('required')
        || error.message?.includes('boolean')
        || error.message?.includes('Role must')
        || error.message?.includes('At least one active HomeBrain admin account is required')
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
    console.error('%s', `POST /api/users/${req.params.id}/reset-password - Error:`, error.message);
    const statusCode = error.message?.includes('not found') ? 404 : error.message?.includes('required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to reset password'
    });
  }
});

router.get('/:id/review-sandbox', async (req, res) => {
  try {
    const user = await UserService.get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const sandbox = user.isReviewSandbox
      ? await reviewSandboxService.provisionForUser(user)
      : null;
    return res.status(200).json({
      success: true,
      enabled: user.isReviewSandbox === true,
      readOnly: user.isReadOnly === true,
      sandbox
    });
  } catch (error) {
    console.error('GET /api/users/:id/review-sandbox - Error:', error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to inspect review sandbox' });
  }
});

router.post('/:id/review-sandbox/reset', async (req, res) => {
  try {
    const user = await UserService.get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (String(user._id) === String(req.user?._id)) {
      return res.status(400).json({ success: false, message: 'You cannot convert your own administrator account into a review sandbox' });
    }
    if (user.role === ROLES.ADMIN) {
      return res.status(400).json({ success: false, message: 'Create a standard user account for the review sandbox' });
    }

    user.role = ROLES.USER;
    user.isActive = false;
    user.isReadOnly = true;
    user.isReviewSandbox = true;
    user.platforms = normalizeUserPlatforms({ homebrain: true, axiom: false });
    await user.save();

    await Promise.all([
      HomeBrainNotification.deleteMany({ userId: user._id }).exec(),
      PushSubscription.deleteMany({ userId: user._id }).exec(),
      UserSession.deleteMany({ userId: user._id }).exec()
    ]);
    const sandbox = await reviewSandboxService.provisionForUser(user, { reset: true });
    user.isActive = true;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Apple App Review sandbox reset successfully',
      user,
      sandbox
    });
  } catch (error) {
    console.error('POST /api/users/:id/review-sandbox/reset - Error:', error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to reset review sandbox' });
  }
});

router.delete('/:id/review-sandbox', async (req, res) => {
  try {
    const user = await UserService.get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    user.isReviewSandbox = false;
    user.isActive = false;
    user.isReadOnly = true;
    user.platforms = normalizeUserPlatforms({ homebrain: false, axiom: false });
    await user.save();
    await Promise.all([
      reviewSandboxService.deleteForUser(user._id),
      UserSession.deleteMany({ userId: user._id }).exec(),
      HomeBrainNotification.deleteMany({ userId: user._id }).exec(),
      PushSubscription.deleteMany({ userId: user._id }).exec()
    ]);
    return res.status(200).json({
      success: true,
      message: 'Review sandbox and account access disabled'
    });
  } catch (error) {
    console.error('DELETE /api/users/:id/review-sandbox - Error:', error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to disable review sandbox' });
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
    console.error('%s', `DELETE /api/users/${req.params.id} - Error:`, error.message);
    const statusCode = error.message?.includes('At least one active HomeBrain admin account is required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to delete user'
    });
  }
});

module.exports = router;
