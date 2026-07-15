const express = require('express');
const { extractToken, verifyAccessToken } = require('./middlewares/auth');
const reviewSandboxService = require('../services/reviewSandboxService');

const router = express.Router();

async function reviewSandboxGate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return next();
  }

  let user;
  try {
    user = await verifyAccessToken(token, undefined, req);
  } catch (_error) {
    // Let the destination route apply its own authentication or webhook policy.
    return next();
  }

  if (user?.isReviewSandbox !== true) {
    return next();
  }

  req.user = user;
  if (reviewSandboxService.isPassThroughPath(
    reviewSandboxService.canonicalApiPath(req),
    String(req.method || '').toUpperCase()
  )) {
    return next();
  }

  return reviewSandboxService.handleRequest(req, res);
}

router.use(reviewSandboxGate);

module.exports = router;
module.exports.reviewSandboxGate = reviewSandboxGate;
