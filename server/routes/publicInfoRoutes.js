const express = require('express');
const crypto = require('node:crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const PublicSupportRequest = require('../models/PublicSupportRequest');
const notificationService = require('../services/notificationService');
const { ROLES } = require('../../shared/config/roles');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router({ strict: true });
const publicInfoRoot = path.join(__dirname, '..', 'public', 'app-info');
const supportRequestJson = express.json({ limit: '12kb', strict: true });
const supportRequestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many support requests. Please wait 15 minutes and try again.'
  }
});
const requireSupportAdmin = requireAdmin();
const SUPPORT_REQUEST_STATUSES = new Set(['open', 'in_progress', 'resolved']);

const SUPPORT_REQUEST_FIELDS = new Set([
  'name',
  'email',
  'subject',
  'message',
  'appVersion',
  'device',
  'website'
]);

function parseSupportRequestJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({
      success: false,
      message: 'Support requests must be sent as JSON.'
    });
  }

  return supportRequestJson(req, res, (error) => {
    if (!error) return next();

    const tooLarge = error.type === 'entity.too.large';
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      message: tooLarge
        ? 'The support request is too large.'
        : 'The support request could not be read.'
    });
  });
}

function readTextField(body, field, options = {}) {
  const {
    required = false,
    minLength = 0,
    maxLength,
    multiline = false
  } = options;
  const rawValue = body[field];

  if (rawValue === undefined || rawValue === null || rawValue === '') {
    if (required) return { error: `${field} is required.` };
    return { value: '' };
  }
  if (typeof rawValue !== 'string') {
    return { error: `${field} must be text.` };
  }

  let value = rawValue.replace(/\r\n?/g, '\n').trim();
  if (multiline) {
    value = value.replace(/\t/g, ' ');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      return { error: `${field} contains unsupported characters.` };
    }
  } else if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { error: `${field} must be a single line.` };
  }

  if (required && value.length === 0) {
    return { error: `${field} is required.` };
  }
  if (value.length < minLength) {
    return { error: `${field} must be at least ${minLength} characters.` };
  }
  if (Number.isFinite(maxLength) && value.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or fewer.` };
  }
  return { value };
}

function validateSupportRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'The support request must be a JSON object.' };
  }

  const unexpectedField = Object.keys(body).find((field) => !SUPPORT_REQUEST_FIELDS.has(field));
  if (unexpectedField) {
    return { error: `Unexpected field: ${unexpectedField}.` };
  }

  const fieldRules = {
    name: { maxLength: 80 },
    email: { required: true, maxLength: 254 },
    subject: { required: true, minLength: 3, maxLength: 120 },
    message: { required: true, minLength: 20, maxLength: 1400, multiline: true },
    appVersion: { maxLength: 40 },
    device: { maxLength: 100 },
    website: { maxLength: 200 }
  };
  const request = {};

  for (const [field, rules] of Object.entries(fieldRules)) {
    const result = readTextField(body, field, rules);
    if (result.error) return result;
    request[field] = result.value;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email)) {
    return { error: 'email must be a valid email address.' };
  }
  request.email = request.email.toLowerCase();

  return { request };
}

async function submitSupportRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.body && typeof req.body === 'object' && typeof req.body.website === 'string' && req.body.website.trim()) {
    return res.status(202).json({
      success: true,
      message: 'Your support request was sent.'
    });
  }

  const validation = validateSupportRequest(req.body);
  if (validation.error) {
    return res.status(400).json({
      success: false,
      message: validation.error
    });
  }

  const supportRequest = validation.request;
  const submittedAt = new Date();
  const requestId = crypto.randomUUID();
  const supportRequestPath = `/api/public/support-requests/${requestId}`;

  try {
    const admins = await User.find({
      role: ROLES.ADMIN,
      isActive: true,
      isReviewSandbox: { $ne: true }
    }).select('_id').lean();

    const userIds = admins.map((admin) => admin._id).filter(Boolean);
    if (userIds.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'Support is temporarily unavailable. Please try again later.'
      });
    }

    await PublicSupportRequest.create({
      requestId,
      name: supportRequest.name,
      email: supportRequest.email,
      subject: supportRequest.subject,
      message: supportRequest.message,
      appVersion: supportRequest.appVersion,
      device: supportRequest.device,
      submittedAt
    });

    const notifications = await notificationService.createSystemNotification({
      userIds,
      channel: 'normal',
      severity: 'info',
      category: 'system',
      eventType: 'support.request.created',
      eventKey: `support-request:${requestId}`,
      source: 'public-support',
      title: 'New private support request',
      message: `An unauthenticated user submitted a private support request. An authenticated administrator can retrieve it at ${supportRequestPath}.`,
      metadata: {
        requestId,
        submittedAt: submittedAt.toISOString(),
        supportRequestPath
      },
      occurredAt: submittedAt
    });

    if (!Array.isArray(notifications) || notifications.length === 0) {
      await PublicSupportRequest.deleteOne({ requestId });
      return res.status(503).json({
        success: false,
        message: 'Support is temporarily unavailable. Please try again later.'
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Your support request was sent.'
    });
  } catch (error) {
    logSupportRouteError('POST /api/public/support-requests', error);
    return res.status(500).json({
      success: false,
      message: 'Your support request could not be sent. Please try again later.'
    });
  }
}

function logSupportRouteError(routeLabel, error) {
  const errorName = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const errorCode = typeof error?.code === 'number' || typeof error?.code === 'string'
    ? ` (${String(error.code).slice(0, 32)})`
    : '';
  console.error(`${routeLabel} - ${errorName}${errorCode}`);
}

function rejectReviewSandboxAdmin(req, res, next) {
  if (!req.user?.isReviewSandbox) return next();
  return res.status(403).json({
    success: false,
    message: 'App Review sandbox accounts cannot access support requests.'
  });
}

function parseSupportRequestId(rawRequestId) {
  const requestId = String(rawRequestId || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
    ? requestId
    : null;
}

function toSupportRequestResponse(supportRequest, includeDetails = false) {
  const response = {
    requestId: supportRequest.requestId,
    subject: supportRequest.subject,
    status: supportRequest.status || 'open',
    submittedAt: supportRequest.submittedAt,
    expiresAt: supportRequest.expiresAt,
    handledAt: supportRequest.handledAt || null
  };

  if (includeDetails) {
    response.name = supportRequest.name || '';
    response.email = supportRequest.email;
    response.message = supportRequest.message;
    response.appVersion = supportRequest.appVersion || '';
    response.device = supportRequest.device || '';
    response.internalNote = supportRequest.internalNote || '';
    response.resolvedAt = supportRequest.resolvedAt || null;
  }

  return response;
}

async function listSupportRequests(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (status && !SUPPORT_REQUEST_STATUSES.has(status)) {
    return res.status(400).json({
      success: false,
      message: 'status must be open, in_progress, or resolved.'
    });
  }
  const parsedLimit = Number.parseInt(String(req.query.limit || ''), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;

  try {
    const supportRequests = await PublicSupportRequest.find(status ? { status } : {})
      .select('requestId subject status submittedAt expiresAt handledAt')
      .sort({ submittedAt: -1 })
      .limit(limit)
      .lean();
    return res.status(200).json({
      success: true,
      supportRequests: supportRequests.map((supportRequest) => toSupportRequestResponse(supportRequest)),
      count: supportRequests.length
    });
  } catch (error) {
    logSupportRouteError('GET /api/public/support-requests', error);
    return res.status(500).json({
      success: false,
      message: 'Support requests could not be loaded.'
    });
  }
}

async function getSupportRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const requestId = parseSupportRequestId(req.params.requestId);
  if (!requestId) {
    return res.status(400).json({
      success: false,
      message: 'Invalid support request ID.'
    });
  }

  try {
    const supportRequest = await PublicSupportRequest.findOne({ requestId }).lean();
    if (!supportRequest) {
      return res.status(404).json({
        success: false,
        message: 'Support request not found.'
      });
    }

    return res.status(200).json({
      success: true,
      supportRequest: toSupportRequestResponse(supportRequest, true)
    });
  } catch (error) {
    logSupportRouteError('GET /api/public/support-requests/:requestId', error);
    return res.status(500).json({
      success: false,
      message: 'The support request could not be loaded.'
    });
  }
}

function validateSupportRequestUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'The update must be a JSON object.' };
  }
  const fields = Object.keys(body);
  if (fields.length === 0) return { error: 'Provide a status or internalNote update.' };
  const unexpectedField = fields.find((field) => !['status', 'internalNote'].includes(field));
  if (unexpectedField) return { error: `Unexpected field: ${unexpectedField}.` };

  const update = {};
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (typeof body.status !== 'string' || !SUPPORT_REQUEST_STATUSES.has(body.status.trim())) {
      return { error: 'status must be open, in_progress, or resolved.' };
    }
    update.status = body.status.trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, 'internalNote')) {
    const result = readTextField(body, 'internalNote', { maxLength: 1000, multiline: true });
    if (result.error) return result;
    update.internalNote = result.value;
  }
  return { update };
}

async function updateSupportRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const requestId = parseSupportRequestId(req.params.requestId);
  if (!requestId) {
    return res.status(400).json({
      success: false,
      message: 'Invalid support request ID.'
    });
  }
  const validation = validateSupportRequestUpdate(req.body);
  if (validation.error) {
    return res.status(400).json({
      success: false,
      message: validation.error
    });
  }

  const now = new Date();
  const changes = {
    ...validation.update,
    handledAt: now,
    lastHandledBy: req.user?._id || req.user?.id
  };
  if (validation.update.status === 'resolved') changes.resolvedAt = now;
  if (validation.update.status && validation.update.status !== 'resolved') changes.resolvedAt = null;

  try {
    const supportRequest = await PublicSupportRequest.findOneAndUpdate(
      { requestId },
      { $set: changes },
      { new: true, runValidators: true }
    ).lean();
    if (!supportRequest) {
      return res.status(404).json({
        success: false,
        message: 'Support request not found.'
      });
    }
    return res.status(200).json({
      success: true,
      supportRequest: toSupportRequestResponse(supportRequest, true)
    });
  } catch (error) {
    logSupportRouteError('PATCH /api/public/support-requests/:requestId', error);
    return res.status(500).json({
      success: false,
      message: 'The support request could not be updated.'
    });
  }
}

function sendPublicPage(filename) {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(publicInfoRoot, filename), (error) => {
      if (error) {
        next(error);
      }
    });
  };
}

router.get('/privacy/', (_req, res) => res.redirect(308, '/privacy'));
router.get('/support/', (_req, res) => res.redirect(308, '/support'));
router.post(
  '/api/public/support-requests',
  supportRequestRateLimit,
  parseSupportRequestJson,
  submitSupportRequest
);
router.get(
  '/api/public/support-requests',
  requireSupportAdmin,
  rejectReviewSandboxAdmin,
  listSupportRequests
);
router.get(
  '/api/public/support-requests/:requestId',
  requireSupportAdmin,
  rejectReviewSandboxAdmin,
  getSupportRequest
);
router.patch(
  '/api/public/support-requests/:requestId',
  requireSupportAdmin,
  rejectReviewSandboxAdmin,
  parseSupportRequestJson,
  updateSupportRequest
);
router.get('/privacy', sendPublicPage('privacy.html'));
router.get('/support', sendPublicPage('support.html'));
router.use('/app-info', express.static(publicInfoRoot, {
  fallthrough: false,
  immutable: false,
  maxAge: '1h'
}));

module.exports = router;
